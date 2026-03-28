#!/usr/bin/env node
"use strict";

// audit-prune.js — two jobs:
//   1. Remove clean session summaries from index.ndjson older than N days.
//   2. Convert stale "inactive" session files to "abandoned", then route them
//      (flagged → keep, clean → delete + append to index).
//
// Usage: node tools/audit-prune.js [--days <N>] [--dry-run]

const fs   = require("fs");
const path = require("path");

const LOGS_DIR     = path.join(__dirname, "..", "logs");
const SESSIONS_DIR = path.join(LOGS_DIR, "sessions");
const INDEX_FILE   = path.join(LOGS_DIR, "index.ndjson");

const args    = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const daysIdx = args.indexOf("--days");
const KEEP_DAYS = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) : 14;
const ABANDONED_AFTER_HOURS = 2;

const cutoff         = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
const abandonedCutoff = Date.now() - ABANDONED_AFTER_HOURS * 60 * 60 * 1000;

console.log(`\nNapoli Audit Prune${DRY_RUN ? " [DRY RUN]" : ""}`);
console.log(`  Clean summary retention: ${KEEP_DAYS} days`);
console.log(`  Inactive → abandoned after: ${ABANDONED_AFTER_HOURS} hours\n`);

let prunedIndex = 0;
let abandonedFlagged = 0;
let abandonedClean = 0;

// ── Job 1: prune old clean summaries from index.ndjson ──────────────────────

if (fs.existsSync(INDEX_FILE)) {
  const lines  = fs.readFileSync(INDEX_FILE, "utf8").split("\n").filter(Boolean);
  const kept   = [];
  let dropped  = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const age   = new Date(entry.completedAt || entry.startedAt).getTime();
      if (age < cutoff) { dropped++; prunedIndex++; }
      else kept.push(line);
    } catch (_) { kept.push(line); }
  }
  if (!DRY_RUN && dropped > 0) {
    fs.writeFileSync(INDEX_FILE, kept.join("\n") + (kept.length ? "\n" : ""));
  }
  console.log(`index.ndjson: ${dropped} old entr${dropped === 1 ? "y" : "ies"} pruned, ${kept.length} kept.`);
} else {
  console.log("index.ndjson: not found (no clean sessions recorded yet).");
}

// ── Job 2: convert stale inactive sessions → abandoned ───────────────────────

if (fs.existsSync(SESSIONS_DIR)) {
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));

  for (const file of files) {
    const filePath = path.join(SESSIONS_DIR, file);
    let entry;
    try { entry = JSON.parse(fs.readFileSync(filePath, "utf8")); }
    catch (_) { continue; }

    if (entry.status !== "inactive") continue;

    const lastActivity = new Date(entry.lastActivityAt).getTime();
    if (lastActivity > abandonedCutoff) continue; // not stale enough yet

    entry.status = "abandoned";

    if (entry.flagged) {
      abandonedFlagged++;
      if (!DRY_RUN) fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));
      console.log(`  ${entry.sessionId}: inactive → abandoned [FLAGGED — kept] reasons: [${entry.flagReasons.join(", ")}]`);
    } else {
      abandonedClean++;
      if (!DRY_RUN) {
        // Remove the full file, append a summary line.
        fs.unlinkSync(filePath);
        const summary = {
          sessionId:    entry.sessionId,
          startedAt:    entry.startedAt,
          completedAt:  entry.lastActivityAt,
          turnCount:    entry.turnCount,
          totalCents:   entry.finalOrder?.totalCents   ?? null,
          customerName: entry.finalOrder?.customerName ?? null,
          status:       "abandoned-clean",
        };
        fs.appendFileSync(INDEX_FILE, JSON.stringify(summary) + "\n");
      }
      console.log(`  ${entry.sessionId}: inactive → abandoned [clean — summarised]`);
    }
  }
}

console.log(`\nDone. Index pruned: ${prunedIndex}  Abandoned+flagged kept: ${abandonedFlagged}  Abandoned+clean summarised: ${abandonedClean}`);
if (DRY_RUN) console.log("(dry run — no files were changed)");
