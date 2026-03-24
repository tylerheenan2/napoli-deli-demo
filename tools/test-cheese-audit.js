#!/usr/bin/env node
"use strict";
const { spawnSync } = require("child_process");
const path = require("path");

const CLI = path.join(__dirname, "run-cli.cjs");
const CWD = path.join(__dirname, "..");

function run(inputs) {
  const inputStr = inputs.join("\n") + "\n";
  const env = { ...process.env, NODE_ENV: "test" };
  const r = spawnSync("node", [CLI], { input: inputStr, cwd: CWD, env, timeout: 15000, encoding: "utf8" });
  return (r.stdout || "") + (r.stderr || "");
}

function price(inputs) {
  const out = run(inputs);
  // Match "$7.95." or "$8.25." — the total line ends with a period
  const m = out.match(/\$([0-9]+\.[0-9]+)\./);
  const rb = out.match(/your full order:\s*(.*)/i);
  return {
    price: m ? m[1] : "NOT_FOUND",
    readback: rb ? rb[1].trim() : "NO_READBACK",
    raw: out,
  };
}

let passed = 0, failed = 0;
const bugs = [];

function check(name, inputs, expectPrice) {
  const r = price(inputs);
  const ok = r.price === String(expectPrice);
  const status = ok ? "PASS" : "FAIL";
  const flag = !ok && r.price !== "NOT_FOUND" && Number(r.price) !== Number(expectPrice) ? " ← BUG" : "";
  console.log(
    "  " + status + "  " +
    name.padEnd(32) +
    "  got=$" + r.price +
    "  exp=$" + expectPrice +
    flag
  );
  if (!ok) {
    failed++;
    if (r.price !== "NOT_FOUND") bugs.push({ name, got: r.price, expected: expectPrice, readback: r.readback });
  } else {
    passed++;
  }
}

// ─── KNOWN-GOOD (already in CHEESE_UPGRADE_MAP) ───────────────────────────────
console.log("\n=== KNOWN-GOOD: items in CHEESE_UPGRADE_MAP ===\n");

check("turkey plain",             ["turkey sandwich",  "Joe", "plain roll", "nothing",        "no", "yes"], "7.95");
check("turkey + american cheese", ["turkey sandwich",  "Joe", "plain roll", "add american",   "no", "yes"], "8.25");
check("turkey + swiss cheese",    ["turkey sandwich",  "Joe", "plain roll", "add swiss",       "no", "yes"], "8.25");
check("ham sandwich plain",       ["ham sandwich",     "Joe", "plain roll", "nothing",        "no", "yes"], "7.25");
check("ham + swiss cheese",       ["ham sandwich",     "Joe", "plain roll", "add swiss",       "no", "yes"], "7.95");
check("ham + american cheese",    ["ham sandwich",     "Joe", "plain roll", "add american",   "no", "yes"], "7.95");
check("baked ham plain",          ["baked ham sandwich","Joe","plain roll", "nothing",        "no", "yes"], "7.95");
check("baked ham + cheese",       ["baked ham sandwich","Joe","plain roll", "add american",   "no", "yes"], "7.95");
check("honey ham plain",          ["honey ham sandwich","Joe","plain roll", "nothing",        "no", "yes"], "7.95");
check("honey ham + cheese",       ["honey ham sandwich","Joe","plain roll", "add american",   "no", "yes"], "7.95");

// ─── NOT IN MAP — SAME PRICE (no upgrade needed for price correctness) ─────────
console.log("\n=== NOT IN MAP (zero price delta — no upgrade needed) ===\n");

check("bologna plain",            ["bologna sandwich",         "Joe", "plain roll", "nothing",      "no", "yes"], "7.95");
check("bologna + cheese",         ["bologna sandwich",         "Joe", "plain roll", "add american", "no", "yes"], "7.95");
check("chicken cutlet plain",     ["chicken cutlet sandwich",  "Joe", "plain roll", "nothing",      "no", "yes"], "7.95");
check("chicken cutlet + cheese",  ["chicken cutlet sandwich",  "Joe", "plain roll", "add american", "no", "yes"], "7.95");
check("pepper turkey plain",      ["pepper turkey sandwich",   "Joe", "plain roll", "nothing",      "no", "yes"], "7.95");
check("pepper turkey + cheese",   ["pepper turkey sandwich",   "Joe", "plain roll", "add american", "no", "yes"], "7.95");
check("tuna plain",               ["tuna sandwich",            "Joe", "plain roll", "nothing",      "no", "yes"], "7.95");
check("tuna + cheese",            ["tuna sandwich",            "Joe", "plain roll", "add american", "no", "yes"], "7.95");
check("turkey pastrami plain",    ["turkey pastrami sandwich", "Joe", "plain roll", "nothing",      "no", "yes"], "7.95");
check("turkey pastrami + cheese", ["turkey pastrami sandwich", "Joe", "plain roll", "add american", "no", "yes"], "7.95");

// ─── NOT IN MAP — PRICE DELTA (upgrade needed for correct pricing) ───────────
console.log("\n=== NOT IN MAP (non-zero price delta — upgrade required) ===\n");

check("pastrami plain",           ["pastrami sandwich",  "Joe", "plain roll", "nothing",      "no", "yes"], "7.25");
check("pastrami + american",      ["pastrami sandwich",  "Joe", "plain roll", "add american", "no", "yes"], "7.95");
check("capicola plain",           ["capicola sandwich",  "Joe", "plain roll", "nothing",      "no", "yes"], "7.95");
check("capicola + american",      ["capicola sandwich",  "Joe", "plain roll", "add american", "no", "yes"], "8.50");
check("steak plain",              ["steak sandwich",     "Joe", "plain roll", "nothing",      "no", "yes"], "8.95");
check("steak + american",         ["steak sandwich",     "Joe", "plain roll", "add american", "no", "yes"], "9.25");

// ─── SUMMARY ────────────────────────────────────────────────────────────────
console.log("\n=== SUMMARY ===");
console.log(passed + " passed, " + failed + " failed out of " + (passed + failed));

if (bugs.length) {
  console.log("\n=== PRICING BUGS ===");
  bugs.forEach(b => {
    console.log("  " + b.name + ": got $" + b.got + ", expected $" + b.expected);
    console.log("    readback: " + b.readback);
  });
}
