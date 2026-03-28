#!/usr/bin/env node
"use strict";

// audit-delete.js — delete a flagged session file after you have reviewed it.
// Usage: node tools/audit-delete.js <sessionId> [--confirm]

const fs   = require("fs");
const path = require("path");
const readline = require("readline");

const sessionId = process.argv[2];
const confirmed = process.argv.includes("--confirm");

if (!sessionId) {
  console.error("Usage: node tools/audit-delete.js <sessionId> [--confirm]");
  process.exit(1);
}

const file = path.join(__dirname, "..", "logs", "sessions", `${sessionId}.json`);

if (!fs.existsSync(file)) {
  console.error(`Session file not found: ${sessionId}`);
  process.exit(1);
}

let entry;
try { entry = JSON.parse(fs.readFileSync(file, "utf8")); }
catch (e) { console.error("Failed to parse session file:", e.message); process.exit(1); }

console.log(`\nSession: ${entry.sessionId}`);
console.log(`Status:  ${entry.status}   Flagged: ${entry.flagged}   Reported: ${entry.reportedByUser}`);
console.log(`Flags:   [${entry.flagReasons.join(", ")}]`);
console.log(`Turns:   ${entry.turnCount}   Started: ${new Date(entry.startedAt).toLocaleString()}`);

if (confirmed) {
  fs.unlinkSync(file);
  console.log(`\nDeleted: ${sessionId}`);
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("\nDelete this session log? (yes / no): ", answer => {
  rl.close();
  if (answer.trim().toLowerCase() === "yes") {
    fs.unlinkSync(file);
    console.log(`Deleted: ${sessionId}`);
  } else {
    console.log("Cancelled.");
  }
});
