#!/usr/bin/env node
"use strict";
/**
 * Integration tests for Part 2 hardening fixes.
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
// TARGETED TESTS (Part 2)
// ─────────────────────────────────────────────
console.log("\n=== TARGETED TESTS (Part 2) ===\n");

// T1: Weight compound "one and a half pounds" → 1 1/2 lb, not 1/2 lb (Fix 1)
test(
  "T1: 'one and a half pounds of turkey' → 1 1/2 lb (not 1/2 lb)",
  ["one and a half pounds of turkey", "Tyler", "no", "yes"],
  ["1 1/2 lb of Turkey"],
  ["1/2 lb Turkey"]
);

// T2: Weight compound "one and a quarter pounds" → 1 1/4 lb (Fix 1)
test(
  "T2: 'one and a quarter pounds of ham' → 1 1/4 lb",
  ["one and a quarter pounds of ham", "Tyler", "no", "yes"],
  [/1\s*1\/4\s*lb\s*of\s*Ham/i],
);

// T3: Weight compound "one and three quarters of a pound" → 1 3/4 lb (Fix 1)
test(
  "T3: 'one and three quarters of a pound of turkey' → 1 3/4 lb",
  ["one and three quarters of a pound of turkey", "Tyler", "no", "yes"],
  [/1\s*3\/4\s*lb|1\.75\s*lb/i],
);

// T4: One-shot utterance with inline name — no name question asked (Fix 2)
// "turkey sandwich for John" → extracts name "John", goes directly to format
test(
  "T4: 'turkey sandwich for John' → no name question, item built correctly",
  ["turkey sandwich for John", "roll", "plain", "no", "yes"],
  [/turkey sandwich/i, /plain roll/i],
  [/what.*name|name.*order/i]   // system must NOT ask for name
);

// T5: Sub + plain remap → "Plain Sub" not "Plain Roll" (Fix 3)
test(
  "T5: 'turkey on a plain sub' → Plain Sub in readback",
  ["turkey on a plain sub", "Tyler", "nothing", "no", "yes"],
  ["Plain Sub"],
  ["Plain Roll"]
);

// T6: systemSay Rule 4 — condiment confirm merges with "Anything else?" into one line (Fix 4)
// The exact phrasing varies by prompt variant, but they must appear on the same line.
test(
  "T6: no-condiments confirm + anything-else merged into one line",
  ["turkey sandwich for John", "roll", "plain roll", "nothing on it", "no", "yes"],
  [/(Got it|Perfect|You got it|Sure)\s*[—\-].+(Anything else|What else)/i],
);

// T7: Inline name + condiments — no name question
test(
  "T7: 'ham sandwich with mayo for Sarah' → item built, no name question",
  ["ham sandwich with mayo for Sarah", "roll", "no", "yes"],
  [/ham/i],
  [/what.*name|name.*order/i]
);

// T8: Roast beef with inline name — no double-ask for name
test(
  "T8: 'roast beef sandwich for John' → no name question asked",
  ["roast beef sandwich for John", "hot", "roll", "plain", "mustard", "no", "yes"],
  [/roast beef/i],
  [/what.*name|name.*order/i]
);

// T9: Deli by-weight standard: "half pound of turkey" → 1/2 lb (regression on Fix 1)
test(
  "T9: 'half pound of turkey' → 1/2 lb (bare form still works after Fix 1)",
  ["half pound of turkey", "Tyler", "no", "yes"],
  ["1/2 lb of Turkey"],
);

// T10: "a pound and a half of roast beef" → 1 1/2 lb (Fix 1)
test(
  "T10: 'a pound and a half of roast beef' → 1 1/2 lb",
  ["a pound and a half of roast beef", "Tyler", "no", "yes"],
  ["1 1/2 lb of Roast Beef"],
);

// T11: confirm_readback_yes variant — "yea" confirms order
test(
  "T11: 'yea' at readback → confirms order",
  ["turkey sandwich", "Tyler", "roll", "plain", "nothing", "no", "yea"],
  [/all set|see you soon|got you|sounds good/i],
);

// T12: Double-meat breakfast — bacon egg and cheese with sausage
test(
  "T12: 'bacon egg and cheese with sausage' → Bacon Sausage Egg & Cheese",
  ["bacon egg and cheese with sausage", "Tyler", "roll", "no", "yes"],
  [/Bacon.*Sausage.*Egg|Sausage.*Bacon.*Egg/i],
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

// R6: Ham and cheese recognized (system name is "Ham & Cheese")
test(
  "R6: 'ham and cheese' → Ham & Cheese item in readback",
  ["ham and cheese", "Tyler", "roll", "plain", "nothing", "no", "yes"],
  [/[Hh]am.*[Cc]heese/],
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
