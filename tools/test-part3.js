#!/usr/bin/env node
"use strict";
/**
 * Integration tests for Part 3 hardening fixes.
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
// TARGETED TESTS (Part 3)
// ─────────────────────────────────────────────
console.log("\n=== TARGETED TESTS (Part 3) ===\n");

// ── Issue Group 1: Single-utterance extraction ──

// T1: Full one-shot: item + condiments + format + inline name → condiments in readback, no re-ask
// "salami no cheese lettuce tomato mayo on a plain roll for Cindy"
// → item added in first turn; "no" ends order; "yes" confirms; readback shows all condiments
test(
  "T1: full one-shot salami order for Cindy → condiments in readback, no re-ask for name or toppings",
  ["salami with lettuce tomato mayo on a plain roll for Cindy", "no", "yes"],
  [/salami/i, /plain roll/i, /lettuce/i, /tomato/i, /mayo/i,
   /all set|see you soon|got you|sounds good/i],
  [/what.*toppings|toppings.*on|condiment|want.*on/i, /what.*name|name.*order/i]
);

// T2: One-shot with inline condiment removal + positive condiments → correct readback, no re-ask
// Uses explicit "with" before positive condiments to set per-position polarity correctly.
test(
  "T2: 'turkey sandwich with lettuce no tomato on a plain roll for Luca' → lettuce yes, tomato no",
  ["turkey sandwich with lettuce no tomato on a plain roll for Luca", "no", "yes"],
  [/turkey/i, /plain roll/i, /lettuce/i, /all set|see you soon|got you|sounds good/i],
  [/tomato/i, /what.*toppings|toppings.*on|condiment/i, /what.*name|name.*order/i]
);

// T3: Item + embedded "nothing on it" + inline name (name mid-utterance) → no format/toppings re-ask
// "for mateo" is in the middle — extractInlineName must stop at "plain" (ordering word)
test(
  "T3: 'turkey sandwich for mateo plain roll nothing on it' → plain roll, no condiment/format re-ask",
  ["turkey sandwich for mateo plain roll nothing on it", "no", "yes"],
  [/turkey/i, /plain roll/i, /all set|see you soon|got you|sounds good/i],
  [/roll.*sub.*wrap|what.*format|what.*bread/i,
   /what.*toppings|toppings.*on|condiment|want.*on/i,
   /what.*name|name.*order/i]
);

// T4: Inline "no cheese" → display name stripped of "& Cheese" in final readback
test(
  "T4: 'salami no cheese on a plain roll for Joe' → readback shows no '& Cheese'",
  ["salami no cheese on a plain roll for Joe", "nothing on it", "no", "yes"],
  [/salami/i, /plain roll/i, /all set|see you soon|got you|sounds good/i],
  [/salami\s*&\s*cheese/i]
);

// T5: "no toppings" embedded in utterance → condiment question skipped entirely
test(
  "T5: 'ham sandwich no toppings on a plain roll for Ben' → no condiment question asked",
  ["ham sandwich no toppings on a plain roll for Ben", "no", "yes"],
  [/ham/i, /all set|see you soon|got you|sounds good/i],
  [/what.*toppings|toppings.*on|condiment|want.*on/i, /what.*name|name.*order/i]
);

// T6: "nothing on it" embedded → condiment question skipped, item goes straight to "anything else?"
test(
  "T6: 'turkey sandwich nothing on it on a plain roll for Sam' → no condiment re-ask",
  ["turkey sandwich nothing on it on a plain roll for Sam", "no", "yes"],
  [/turkey/i, /plain roll/i, /all set|see you soon|got you|sounds good/i],
  [/what.*toppings|toppings.*on|condiment|want.*on/i, /what.*name|name.*order/i]
);

// ── Issue Group 2: "both the same" at DUO format step ──

// T7: "both the same" at DUO step → guardrail does NOT fire (no "one at a time / rephrase" message)
test(
  "T7: 2x turkey sandwich, 'both the same' at DUO step → no guardrail fired",
  ["2 turkey sandwiches", "Tyler", "both the same"],
  [/turkey/i, /roll|sub|wrap|same.*different|both/i],
  [/one at a time|rephrase|didn.t quite|clarify/i]
);

// T8: "same for both" at DUO step → no guardrail
test(
  "T8: 2x ham sandwiches, 'same for both' at DUO step → no guardrail",
  ["2 ham sandwiches", "Tyler", "same for both"],
  [/ham/i, /roll|sub|wrap|same.*different|both/i],
  [/one at a time|rephrase|didn.t quite|clarify/i]
);

// T9: "make them the same" at DUO step → no guardrail
test(
  "T9: 2x roast beef sandwiches, 'make them the same' at DUO step → no guardrail",
  ["2 roast beef sandwiches", "Tyler", "hot", "make them the same"],
  [/roast beef/i, /roll|sub|wrap|same.*different|both/i],
  [/one at a time|rephrase|didn.t quite|clarify/i]
);

// ── Issue Group 3: Weight typo tolerance ──

// T10: "hald" → "half" typo fix → "one and a hald pound" → 1 1/2 lb
test(
  "T10: 'one and a hald pound of turkey' → 1 1/2 lb (typo: hald→half)",
  ["one and a hald pound of turkey", "Tyler", "no", "yes"],
  ["1 1/2 lb of Turkey"],
);

// T11: "qurter" → "quarter" typo fix → "one and a qurter pound" → 1 1/4 lb
test(
  "T11: 'one and a qurter pound of ham' → 1 1/4 lb (typo: qurter→quarter)",
  ["one and a qurter pound of ham", "Tyler", "no", "yes"],
  [/1\s*1\/4\s*lb\s*of\s*Ham/i],
);

// T12: "ona" → "one" typo fix → "ona and a half pound of turkey" → 1 1/2 lb
test(
  "T12: 'ona and a half pound of turkey' → 1 1/2 lb (typo: ona→one)",
  ["ona and a half pound of turkey", "Tyler", "no", "yes"],
  ["1 1/2 lb of Turkey"],
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
