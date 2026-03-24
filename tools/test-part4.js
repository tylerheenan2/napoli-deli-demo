#!/usr/bin/env node
"use strict";
/**
 * Integration tests for Part 4 hardening fixes.
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
// TARGETED TESTS (Part 4)
// ─────────────────────────────────────────────
console.log("\n=== TARGETED TESTS (Part 4) ===\n");

// ── Issue Group 1: Per-position polarity fix ──

// T1: "no cheese" only negates cheese; lettuce/tomato/mayo remain positive additions
test(
  "T1: 'salami no cheese lettuce tomato mayo on a plain roll for Cindy' → lettuce/tomato/mayo in readback",
  ["salami no cheese lettuce tomato mayo on a plain roll for Cindy", "no", "yes"],
  [/salami/i, /lettuce/i, /tomato/i, /mayo/i, /all set|see you soon|got you|sounds good/i],
  [/salami\s*&\s*cheese/i]
);

// T2: "no tomato" only negates tomato; mayo is a positive addition
test(
  "T2: 'turkey sandwich no tomato mayo on a plain roll for Luca' → mayo in readback, tomato not",
  ["turkey sandwich no tomato mayo on a plain roll for Luca", "no", "yes"],
  [/turkey/i, /mayo/i, /all set|see you soon|got you|sounds good/i],
  [/tomato/i]
);

// T3: "remove lettuce and tomato" → both removed (and-conjunction extends scope)
test(
  "T3: 'turkey sandwich remove lettuce and tomato on a plain roll for Sam' → neither in readback",
  ["turkey sandwich remove lettuce and tomato on a plain roll for Sam", "no", "yes"],
  [/turkey/i, /all set|see you soon|got you|sounds good/i],
  [/lettuce/i, /tomato/i]
);

// ── Issue Group 2: Bread typo "foll" → "roll" ──

// T4: "foll" typo → recognized as "roll"; salami not drifting to BLT
test(
  "T4: 'salami on a plain foll for Joe' → recognized as plain roll, not BLT",
  ["salami on a plain foll for Joe", "nothing", "no", "yes"],
  [/salami/i, /plain roll/i, /all set|see you soon|got you|sounds good/i],
  [/BLT/i]
);

// ── Issue Group 3: "both the same" DUO custom message ──

// T5: "both the same" at DUO step → custom bread question, no guardrail
test(
  "T5: 2x turkey, 'both the same' → custom 'what should both be on' message, no guardrail",
  ["2 turkey sandwiches", "Tyler", "both the same"],
  [/turkey/i, /both|what should/i],
  [/one at a time|rephrase|didn.t quite|clarify/i]
);

// T6: After "both the same" + bread choice → both get same bread
test(
  "T6: 2x ham, 'same for both', then 'plain rolls' → both ham on plain roll",
  ["2 ham sandwiches", "Tyler", "same for both", "plain rolls"],
  [/ham/i, /plain roll/i],
  [/one at a time|rephrase|didn.t quite|clarify/i]
);

// ── Issue Group 4: "ye" → confirm ──

// T7: "ye" at readback → confirm_readback_yes
test(
  "T7: 'ye' at readback → confirms order",
  ["turkey sandwich", "Tyler", "roll", "plain", "nothing", "no", "ye"],
  [/all set|see you soon|got you|sounds good/i],
);

// ── Issue Group 5: "thats ll" → finish ──

// T8: "thats ll" at anything-else → finish order
test(
  "T8: 'thats ll' at 'anything else' → finishes order",
  ["turkey sandwich", "Tyler", "roll", "plain", "nothing", "no", "yes", "thats ll"],
  [/all set|see you soon|got you|sounds good/i],
);

// ── Issue Group 6: Deli-mode weight with typos ──

// T9: "one and a hald pound of turkey" at deli mode → 1 1/2 lb
test(
  "T9: deli turkey 'one and a hald pound' → 1 1/2 lb (typo hald→half)",
  ["turkey", "Tyler", "by the pound", "one and a hald pound", "no", "yes"],
  [/1\s*1\/2\s*lb\s*of\s*Turkey/i],
);

// ── Issue Group 7: Mid-flow format change ──

// T10: "actually make that a sub" at bread-type step → re-asks bread type for sub
test(
  "T10: roll selected, 'actually make that a sub' at bread-type step → re-asks sub bread type",
  ["turkey sandwich", "Tyler", "roll", "actually make that a sub", "plain", "nothing", "no", "yes"],
  [/turkey/i, /plain sub|plain.*sub/i, /all set|see you soon|got you|sounds good/i],
);

// T11: "make it a wrap" at bread-type step → re-asks wrap type
test(
  "T11: sub selected, 'make it a wrap' at bread-type → re-asks wrap type",
  ["turkey sandwich", "Tyler", "sub", "make it a wrap", "white", "nothing", "no", "yes"],
  [/turkey/i, /wrap/i, /all set|see you soon|got you|sounds good/i],
);

// T12: One-shot with "no cheese" polarity + extra condiments → correct readback
test(
  "T12: 'ham sandwich no cheese lettuce mayo on a plain roll for Ben' → lettuce/mayo in readback, no cheese",
  ["ham sandwich no cheese lettuce mayo on a plain roll for Ben", "no", "yes"],
  [/ham/i, /lettuce/i, /mayo/i, /all set|see you soon|got you|sounds good/i],
  [/ham.*cheese|cheese.*ham/i]
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

// R3: Multi-item "turkey sandwich and ham sandwich" → 2 items
test(
  "R3: 'a turkey sandwich and a ham sandwich' → 2 items in readback",
  ["a turkey sandwich and a ham sandwich", "Tyler",
   "roll", "plain", "nothing",   // first item
   "roll", "plain", "nothing",   // second item
   "no", "yes"],
  [/turkey/i, /ham/i],
);

// R4: Roast beef asks hot or cold (after name)
test(
  "R4: 'roast beef sandwich' → after name, asks hot or cold",
  ["roast beef sandwich", "Tyler"],
  [/hot or cold/i],
);

// R5: Tossed salad size prompt (after name)
test(
  "R5: 'tossed salad' → after name, asks small or large",
  ["tossed salad", "Tyler"],
  [/small.*dish.*large.*dish|large.*dish.*small.*dish|small or large/i],
);

// R6: "no cheese" removes & Cheese from readback
test(
  "R6: 'salami no cheese on a plain roll for Joe' → no '& Cheese' in readback",
  ["salami no cheese on a plain roll for Joe", "nothing on it", "no", "yes"],
  [/salami/i, /plain roll/i, /all set|see you soon|got you|sounds good/i],
  [/salami\s*&\s*cheese/i]
);

// R7: "nothing else" at readback = yes (confirm)
test(
  "R7: 'nothing else' at readback → confirms order",
  ["turkey sandwich", "Tyler", "roll", "plain", "nothing", "no", "nothing else"],
  [/all set|see you soon|got you|sounds good/i],
);

// ─────────────────────────────────────────────
console.log("\n=== SUMMARY ===");
console.log(passed + " passed, " + failed + " failed out of " + (passed + failed));
if (failed > 0) process.exit(1);
