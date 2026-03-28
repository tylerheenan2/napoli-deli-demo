#!/usr/bin/env node
"use strict";

// audit-list.js — list all sessions in logs/sessions/ that need attention.
// Shows flagged, inactive, reported, and abandoned sessions.
// Usage: node tools/audit-list.js [--all]

const fs   = require("fs");
const path = require("path");

const SESSIONS_DIR = path.join(__dirname, "..", "logs", "sessions");
const SHOW_ALL     = process.argv.includes("--all");

if (!fs.existsSync(SESSIONS_DIR)) {
  console.log("No sessions directory found. Run the server first.");
  process.exit(0);
}

const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));

if (files.length === 0) {
  console.log("No session files found. All completed sessions were clean.");
  process.exit(0);
}

const rows = [];

for (const file of files) {
  try {
    const entry = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8"));
    if (!SHOW_ALL && !entry.flagged && entry.status === "active") continue;

    const startedAt = new Date(entry.startedAt).toLocaleString();
    const idle      = entry.status === "inactive"
      ? ` (idle ${_minutesAgo(entry.lastActivityAt)}m)`
      : "";
    const reasons   = entry.flagReasons.length
      ? `[${entry.flagReasons.join(", ")}]`
      : entry.status === "active" ? "[active — not flagged]" : "[]";

    rows.push({
      sessionId:  entry.sessionId,
      status:     entry.status + idle,
      flagged:    entry.flagged,
      reported:   entry.reportedByUser,
      turns:      entry.turnCount,
      reasons,
      startedAt,
    });
  } catch (_) {}
}

if (rows.length === 0) {
  console.log("No flagged or inactive sessions found.");
  if (!SHOW_ALL) console.log("  (use --all to also show active unflagged sessions)");
  process.exit(0);
}

// Sort: reported first, then by start time descending.
rows.sort((a, b) => (b.reported - a.reported) || (b.startedAt < a.startedAt ? -1 : 1));

console.log("\n=== Session Audit List ===\n");
for (const r of rows) {
  const tag = r.reported ? " [REPORTED]" : r.flagged ? " [FLAGGED]" : "";
  console.log(`${r.sessionId}${tag}`);
  console.log(`  Status:  ${r.status}   Turns: ${r.turns}   Started: ${r.startedAt}`);
  console.log(`  Flags:   ${r.reasons}`);
  console.log();
}
console.log(`${rows.length} session(s) listed.`);
if (!SHOW_ALL) console.log("(use --all to also show active unflagged sessions)");

function _minutesAgo(isoTs) {
  return Math.round((Date.now() - new Date(isoTs).getTime()) / 60000);
}
