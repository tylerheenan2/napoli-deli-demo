#!/usr/bin/env node
"use strict";

// audit-review.js — pretty-print a full session transcript with flags highlighted.
// Usage: node tools/audit-review.js <sessionId>

const fs   = require("fs");
const path = require("path");

const sessionId = process.argv[2];
if (!sessionId) {
  console.error("Usage: node tools/audit-review.js <sessionId>");
  process.exit(1);
}

const file = path.join(__dirname, "..", "logs", "sessions", `${sessionId}.json`);
if (!fs.existsSync(file)) {
  console.error(`Session not found: ${sessionId}`);
  console.error(`(clean sessions are not retained; check logs/index.ndjson for summary)`);
  process.exit(1);
}

const entry = JSON.parse(fs.readFileSync(file, "utf8"));

const LINE = "─".repeat(60);

// Header
const flagTag  = entry.flagged ? ` — FLAGGED [${entry.flagReasons.join(", ")}]` : " — CLEAN";
const repTag   = entry.reportedByUser ? " [USER-REPORTED]" : "";
const startStr = new Date(entry.startedAt).toLocaleString();
console.log(`\nSESSION ${entry.sessionId}${repTag}${flagTag}`);
console.log(`Started: ${startStr}  |  Turns: ${entry.turnCount}  |  Resets: ${entry.resets}  |  Status: ${entry.status}`);
console.log(LINE);

// Turns
for (const turn of entry.turns) {
  const ts      = new Date(turn.ts).toLocaleTimeString();
  const flagStr = turn.turnFlags.length ? `  ⚑ ${turn.turnFlags.join(", ")}` : "";
  console.log(`\n[T${turn.seq}] ${ts}  intent: ${turn.intent || "-"}  phase: ${turn.phase || "-"}  prompt: ${turn.lastPromptId || "-"}${flagStr}`);
  if (turn.nluConfidence !== null) {
    console.log(`       nlu: confidence=${turn.nluConfidence} success=${turn.nluSuccess}  failedAttempts=${turn.failedAttempts}`);
  }
  console.log(`  User: "${turn.userText}"`);
  for (const msg of (turn.systemMessages || [])) {
    console.log(`  Sys:  "${msg}"`);
  }
  if (turn.done) console.log(`  [ORDER COMPLETE]`);
}

console.log(`\n${LINE}`);

// Final order
if (entry.finalOrder) {
  const fo = entry.finalOrder;
  console.log("Final Order:");
  for (const item of (fo.items || [])) {
    const price = item.totalCents != null ? `$${(item.totalCents / 100).toFixed(2)}` : "?";
    console.log(`  ${item.quantity}x ${item.name}${item.format ? " | " + item.format : ""}  ${price}`);
  }
  const total = fo.totalCents != null ? `$${(fo.totalCents / 100).toFixed(2)}` : "?";
  console.log(`  Total: ${total}${fo.customerName ? "  Customer: " + fo.customerName : ""}`);
}

// Final state
if (entry.finalState) {
  const fs2 = entry.finalState;
  console.log(`Final State: phase=${fs2.phase || "-"}  confirmed=${fs2.confirmed}  awaitingReadback=${fs2.awaitingReadbackConfirmation}`);
}

console.log();
