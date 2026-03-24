#!/usr/bin/env node
"use strict";
/**
 * Integration tests for Part 5 hardening fixes.
 * Runs each scenario by piping input to run-cli.cjs and checking output.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const CLI = path.join(__dirname, "run-cli.cjs");
const CWD = path.join(__dirname, "..");

function run(inputs, opts = {}) {
  const inputStr = inputs.join("\n") + "\n";
  const env = { ...process.env, NODE_ENV: "test" };
  if (opts.debug) env.NAPOLI_DEBUG_PROMPTS = "1";
  const result = spawnSync("node", [CLI], {
    input: inputStr,
    cwd: CWD,
    env,
    timeout: 15000,
    encoding: "utf8",
  });
  const out = (result.stdout || "") + (result.stderr || "");
  return out;
}

function check(label, output, expects, notExpects = []) {
  let pass = true;
  const failures = [];
  for (const e of expects) {
    if (typeof e === "string" && !output.includes(e)) {
      pass = false;
      failures.push("MISSING: " + JSON.stringify(e));
    } else if (e instanceof RegExp && !e.test(output)) {
      pass = false;
      failures.push("NO MATCH: " + e);
    }
  }
  for (const ne of notExpects) {
    if (typeof ne === "string" && output.includes(ne)) {
      pass = false;
      failures.push("SHOULD NOT CONTAIN: " + JSON.stringify(ne));
    } else if (ne instanceof RegExp && ne.test(output)) {
      pass = false;
      failures.push("SHOULD NOT MATCH: " + ne);
    }
  }
  if (pass) {
    console.log("  PASS: " + label);
  } else {
    console.log("  FAIL: " + label);
    for (const f of failures) console.log("        " + f);
    if (process.env.VERBOSE) {
      console.log("  --- OUTPUT ---");
      console.log(output.slice(0, 3000));
      console.log("  --- END ---");
    }
  }
  return pass;
}

let passed = 0, failed = 0;
function test(label, inputs, expects, notExpects = []) {
  const out = run(inputs);
  const ok = check(label, out, expects, notExpects);
  if (ok) passed++; else failed++;
}

// ─────────────────────────────────────────────
// TARGETED TESTS (Part 5)
// ─────────────────────────────────────────────
console.log("\n=== TARGETED TESTS (Part 5) ===\n");

// ── Issue 1: Polarity fix (regression from Part 4) ──

// P1: "no cheese and mayo" → cheese removed, mayo added; readback has mayo, no corrupted output
test(
  "P1: 'turkey sandwich no cheese and mayo on a plain roll for Luca' → mayo in readback, not blank",
  ["turkey sandwich no cheese and mayo on a plain roll for Luca", "no", "yes"],
  [/turkey/i, /mayo/i, /plain roll/i, /all set|see you soon|got you|sounds good/i],
  [/SYSTEM:\s*\.\s*\n|SYSTEM:\s*\.\s*$/, /turkey.*cheese|cheese.*turkey/i]
);

// ── Issue 2: DUO "both the same" sentinel ──

// P2a: 2x turkey, "both the same" → custom bread question, no "no rule matched", no "_same_tbd" in output
test(
  "P2a: 2x turkey, 'both the same' → custom bread question, no sentinel leak",
  ["2 turkey sandwiches", "Tyler", "both the same"],
  [/turkey/i, /both|what should/i],
  [/_same_tbd|one at a time|rephrase|didn.t quite|clarify/i]
);

// P2b: 2x ham, "both the same", then "plain rolls" → both ham on plain roll, full flow to confirm
test(
  "P2b: 2x ham, 'both the same', 'plain rolls', condiments, confirm → correct readback",
  ["2 ham sandwiches", "Tyler", "both the same", "plain rolls", "nothing", "no", "thats all", "yes"],
  [/ham/i, /plain roll/i, /all set|see you soon|got you|sounds good/i],
  [/no rule matched|_same_tbd/i]
);

// ── Issue 3: Mid-flow format change at toppings step ──

// P3: turkey on roll, plain bread → "actually make that a sub" at toppings → re-asks sub bread type
test(
  "P3: roll → plain → 'actually make that a sub' at toppings → re-asks sub bread type",
  ["turkey sandwich", "Tyler", "roll", "plain", "actually make that a sub", "plain", "nothing", "no", "yes"],
  [/turkey/i, /plain sub|plain.*sub/i, /all set|see you soon|got you|sounds good/i]
);

// P3b: roll → plain → "make it a wrap" at toppings → re-asks wrap type
test(
  "P3b: roll → plain → 'make it a wrap' at toppings → re-asks wrap type",
  ["turkey sandwich", "Tyler", "roll", "plain", "make it a wrap", "white", "nothing", "no", "yes"],
  [/turkey/i, /wrap/i, /all set|see you soon|got you|sounds good/i]
);

// ── Issue 4: Confirmed-item format change requiring bread-type follow-up ──

// P4: Full one-shot order (roll, plain), then at readback "actually make that a wrap"
//     → system asks wrap type → user answers → updated readback with wrap bread type → confirm
test(
  "P4: order confirmed, 'actually make that a wrap' at readback → asks wrap type → updated readback",
  [
    "turkey sandwich for Chris", "roll", "plain", "nothing", "no",
    "actually make that a wrap",
    "white",
    "yes"
  ],
  [/turkey/i, /wrap/i, /all set|see you soon|got you|sounds good/i]
);

// P4b: one-shot "turkey sandwich on a plain roll for Sam", at readback "make it a sub"
//      → asks sub bread type → "plain" → updated readback → confirm
test(
  "P4b: 'actually make that a sub' at readback → asks sub type → plain sub → confirmed",
  [
    "turkey sandwich for Sam", "roll", "plain", "nothing", "no",
    "actually make that a sub",
    "plain",
    "yes"
  ],
  [/turkey/i, /plain sub|plain.*sub/i, /all set|see you soon|got you|sounds good/i]
);

// ─────────────────────────────────────────────
// REGRESSION TESTS
// ─────────────────────────────────────────────
console.log("\n=== REGRESSION TESTS ===\n");

// R1: Standard turkey sandwich plain roll
test(
  "R1: Standard 'turkey sandwich' → name → plain roll → confirm",
  ["turkey sandwich", "Tyler", "roll", "plain", "nothing", "no", "yes"],
  [/turkey sandwich/i, /plain roll/i, /all set|see you soon|got you|sounds good/i],
);

// R2: Turkey with condiments in readback
test(
  "R2: 'turkey sandwich' with lettuce and tomato → readback includes condiments",
  ["turkey sandwich", "Tyler", "roll", "plain", "lettuce and tomato", "no", "yes"],
  [/turkey/i, /lettuce/i, /tomato/i],
);

// R3: "no cheese" on salami → no "& Cheese" in readback
test(
  "R3: 'salami no cheese on a plain roll for Joe' → no salami & cheese in readback",
  ["salami no cheese on a plain roll for Joe", "nothing on it", "no", "yes"],
  [/salami/i, /plain roll/i, /all set|see you soon|got you|sounds good/i],
  [/salami\s*&\s*cheese/i]
);

// R4: Roast beef asks hot or cold
test(
  "R4: 'roast beef sandwich' → after name, asks hot or cold",
  ["roast beef sandwich", "Tyler"],
  [/hot or cold/i],
);

// R5: Tossed salad asks size
test(
  "R5: 'tossed salad' → after name, asks small or large",
  ["tossed salad", "Tyler"],
  [/small.*dish.*large.*dish|large.*dish.*small.*dish|small or large/i],
);

// R6: "nothing else" at readback = yes
test(
  "R6: 'nothing else' at readback → confirms order",
  ["turkey sandwich", "Tyler", "roll", "plain", "nothing", "no", "nothing else"],
  [/all set|see you soon|got you|sounds good/i],
);

// R7: "ye" at readback → confirm
test(
  "R7: 'ye' at readback → confirms order",
  ["turkey sandwich", "Tyler", "roll", "plain", "nothing", "no", "ye"],
  [/all set|see you soon|got you|sounds good/i],
);

// ─────────────────────────────────────────────
console.log("\n=== SUMMARY ===");
console.log(passed + " passed, " + failed + " failed out of " + (passed + failed));
if (failed > 0) process.exit(1);
