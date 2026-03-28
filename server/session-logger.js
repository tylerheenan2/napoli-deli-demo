"use strict";

const fs   = require("fs");
const path = require("path");

const LOGS_DIR     = path.join(__dirname, "..", "logs");
const SESSIONS_DIR = path.join(LOGS_DIR, "sessions");
const INDEX_FILE   = path.join(LOGS_DIR, "index.ndjson");

// Inactivity: mark session "inactive" after N minutes of no turns.
// Configurable via env var for testing convenience.
const INACTIVITY_MS       = parseInt(process.env.NAPOLI_INACTIVITY_MINUTES || "5", 10) * 60 * 1000;
const INACTIVITY_CHECK_MS = 5 * 60 * 1000;   // poll every 5 minutes
const ABANDONED_HOURS     = 2;                // prune converts inactive→abandoned after 2h

// Prompt IDs that signal fallback/confusion states.
const REPHRASE_RE = /REPHRASE|FALLBACK|OFF_TOPIC|UNRECOGNIZED|PRANK|PROFANITY|SELF_HARM|THREAT|UNSERIOUS/i;

class SessionLogger {
  constructor() {
    this.logs  = new Map();          // sessionId → log entry (in-memory)
    this._timer = null;              // inactivity interval ref
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  // ── public API ──────────────────────────────────────────────────────────────

  init(sessionId) {
    const entry = {
      sessionId,
      startedAt:        new Date().toISOString(),
      lastActivityAt:   new Date().toISOString(),
      status:           "active",
      flagged:          false,
      flagReasons:      [],
      reportedByUser:   false,
      resets:           0,
      turnCount:        0,
      finalOrder:       null,
      finalState:       null,
      turns:            [],
    };
    this.logs.set(sessionId, entry);
    this._writeFile(entry);
    this._startTimer();
  }

  appendTurn(sessionId, { userText, systemMessages, state, done }) {
    let entry = this.logs.get(sessionId);
    if (!entry) { this.init(sessionId); entry = this.logs.get(sessionId); }

    // Resume: revert inactive → active if user sent another message.
    if (entry.status === "inactive") entry.status = "active";

    const turnState = this._extractTurnState(state);
    const seq       = entry.turnCount + 1;

    const turn = {
      seq,
      ts:             new Date().toISOString(),
      userText,
      systemMessages,
      ...turnState,
      done,
      turnFlags:      [],
    };

    turn.turnFlags = this._evaluateTurnFlags(turn, entry.turns);

    entry.turns.push(turn);
    entry.turnCount        = seq;
    entry.lastActivityAt   = turn.ts;

    // Accumulate session-level flag reasons (distinct set).
    for (const f of turn.turnFlags) {
      if (!entry.flagReasons.includes(f)) entry.flagReasons.push(f);
    }
    if (entry.flagReasons.length > 0) entry.flagged = true;

    this._writeFile(entry);
  }

  markReset(sessionId) {
    const entry = this.logs.get(sessionId);
    if (!entry) return;
    if (entry.turnCount >= 1 && !entry.flagReasons.includes("mid_session_reset")) {
      entry.flagReasons.push("mid_session_reset");
      entry.flagged = true;
    }
    entry.resets  += 1;
    entry.status   = "reset";
    this._routeCompleted(entry);
  }

  markReported(sessionId) {
    const entry = this.logs.get(sessionId);
    if (!entry) return;
    entry.reportedByUser = true;
    if (!entry.flagReasons.includes("user_reported")) {
      entry.flagReasons.push("user_reported");
    }
    entry.flagged = true;
    this._writeFile(entry);
  }

  finalize(sessionId, state) {
    const entry = this.logs.get(sessionId);
    if (!entry) return;
    entry.status     = "complete";
    entry.finalOrder = this._extractFinalOrder(state);
    entry.finalState = this._extractFinalState(state);
    this._routeCompleted(entry);
  }

  // Write all in-memory sessions to disk and stop the background timer.
  // Call on SIGINT/SIGTERM so in-progress sessions survive a restart.
  flush() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    for (const entry of this.logs.values()) {
      this._writeFile(entry);
    }
  }

  // ── internal ─────────────────────────────────────────────────────────────────

  _startTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => this._checkInactivity(), INACTIVITY_CHECK_MS);
    // Don't keep the process alive just for this timer.
    if (this._timer.unref) this._timer.unref();
  }

  _checkInactivity() {
    const now = Date.now();
    for (const entry of this.logs.values()) {
      if (entry.status !== "active") continue;
      const idle = now - new Date(entry.lastActivityAt).getTime();
      if (idle > INACTIVITY_MS) {
        entry.status = "inactive";
        this._writeFile(entry);
      }
    }
  }

  _routeCompleted(entry) {
    if (entry.flagged) {
      this._writeFile(entry);
    } else {
      // Clean session: discard full file, append lightweight summary to index.
      this._deleteFile(entry.sessionId);
      this._appendIndex({
        sessionId:    entry.sessionId,
        startedAt:    entry.startedAt,
        completedAt:  entry.lastActivityAt,
        turnCount:    entry.turnCount,
        totalCents:   entry.finalOrder?.totalCents   ?? null,
        customerName: entry.finalOrder?.customerName ?? null,
        status:       "clean",
      });
    }
    this.logs.delete(entry.sessionId);
  }

  // ── flag evaluation ───────────────────────────────────────────────────────────

  _evaluateTurnFlags(turn, priorTurns) {
    const flags    = [];
    const allTurns = [...priorTurns, turn];  // full history including current turn

    // Fallback / confusion prompt
    if (turn.lastPromptId && REPHRASE_RE.test(turn.lastPromptId)) {
      flags.push("rephrase_prompt");
    }

    // User made multiple failed attempts this turn
    if (turn.failedAttempts >= 2) {
      flags.push("repeated_failures");
    }

    // User is in a correction flow
    if (turn.phase === "AWAITING_ORDER_CORRECTION") {
      flags.push("correction_behavior");
    }

    // Any moderation field triggered
    if (Object.values(turn.moderationFlags || {}).some(Boolean)) {
      flags.push("moderation_triggered");
    }

    // System flagged session as unserious
    if (turn.unseriousDetected) {
      flags.push("unserious_detected");
    }

    // Low NLU confidence — may indicate silent misparse
    if (turn.nluConfidence < 0.7 || !turn.nluSuccess) {
      flags.push("low_confidence_parse");
    }

    // No-progress loop: conversation is repeating without advancing
    if (allTurns.length >= 3 && !flags.includes("no_progress_loop")) {
      const last3 = allTurns.slice(-3);

      // Same non-null phase repeated across 3 consecutive turns
      const phases = last3.map(t => t.phase);
      if (phases[0] && phases.every(p => p === phases[0])) {
        flags.push("no_progress_loop");
      }

      // Same non-null prompt asked across 3 consecutive turns
      if (!flags.includes("no_progress_loop")) {
        const prompts = last3.map(t => t.lastPromptId);
        if (prompts[0] && prompts.every(p => p === prompts[0])) {
          flags.push("no_progress_loop");
        }
      }

      // Order item count stalled for 3+ turns after session is established
      if (!flags.includes("no_progress_loop") && allTurns.length > 3) {
        const counts = last3.map(t => t.orderItemCount);
        if (counts.every(c => c === counts[0])) {
          flags.push("no_progress_loop");
        }
      }
    }

    return flags;
  }

  // ── state extraction — ONLY named fields, never full state object ─────────────

  _extractTurnState(state) {
    return {
      intent:            state.intent                          ?? null,
      phase:             state.phase                           ?? null,
      lastPromptId:      state.last_prompt_id                  ?? null,
      nluConfidence:     state.nlu?.confidence                 ?? null,
      nluSuccess:        state.nlu?.success                    ?? null,
      failedAttempts:    state.session?.failed_attempts        ?? 0,
      moderationFlags:   { ...(state.moderation || {}) },
      unseriousDetected: state.order?.unserious_detected       ?? false,
      orderItemCount:    state.order?.items?.length            ?? 0,
    };
  }

  _extractFinalOrder(state) {
    if (!state?.order) return null;
    return {
      customerName: state.order.customer_name ?? null,
      items: (state.order.items || []).map(item => ({
        name:       item.name       || item.item_id || null,
        format:     item.format     ?? null,
        quantity:   item.quantity   ?? 1,
        totalCents: item.total_price ?? null,
      })),
      totalCents: state.order.total_before_tax ?? null,
    };
  }

  _extractFinalState(state) {
    return {
      phase:                        state.phase                                    ?? null,
      lastPromptId:                 state.last_prompt_id                           ?? null,
      confirmed:                    state.order?.confirmed                         ?? false,
      awaitingReadbackConfirmation: state.order?.awaiting_readback_confirmation    ?? false,
    };
  }

  // ── file I/O ─────────────────────────────────────────────────────────────────

  _writeFile(entry) {
    const file = path.join(SESSIONS_DIR, `${entry.sessionId}.json`);
    fs.writeFileSync(file, JSON.stringify(entry, null, 2));
  }

  _deleteFile(sessionId) {
    try { fs.unlinkSync(path.join(SESSIONS_DIR, `${sessionId}.json`)); } catch (_) {}
  }

  _appendIndex(summary) {
    fs.appendFileSync(INDEX_FILE, JSON.stringify(summary) + "\n");
  }
}

module.exports = new SessionLogger();
