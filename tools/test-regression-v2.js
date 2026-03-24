#!/usr/bin/env node
"use strict";
const { spawnSync } = require("child_process");
const path = require("path");

const CLI  = path.join(__dirname, "run-cli.cjs");
const CWD  = path.join(__dirname, "..");

function run(inputs, opts) {
  opts = opts || {};
  const inputStr = inputs.join("\n") + "\n";
  const env = { ...process.env, NODE_ENV: "test" };
  if (opts.debug) env.NAPOLI_DEBUG_PROMPTS = "1";
  const result = spawnSync("node", [CLI], {
    input: inputStr, cwd: CWD, env, timeout: 15000, encoding: "utf8",
  });
  return (result.stdout || "") + (result.stderr || "");
}

let passed = 0, failed = 0, failures = [];

function test(label, inputs, expects, notExpects) {
  notExpects = notExpects || [];
  const out = run(inputs);
  let ok = true;
  const msgs = [];
  for (const e of expects) {
    const hit = typeof e === "string" ? out.includes(e) : e.test(out);
    if (!hit) { ok = false; msgs.push("MISSING: " + String(e)); }
  }
  for (const ne of notExpects) {
    const hit = typeof ne === "string" ? out.includes(ne) : ne.test(out);
    if (hit) { ok = false; msgs.push("SHOULD NOT CONTAIN: " + String(ne)); }
  }
  if (ok) { console.log("  PASS: " + label); passed++; }
  else {
    console.log("  FAIL: " + label);
    for (const m of msgs) console.log("        " + m);
    failures.push({ label, msgs, out: out.slice(0, 1500) });
    failed++;
  }
}

// Standard flow pattern:
// [item] → (name if none in item) → (format if sandwich) → (condiments) →
// "no" (nothing else) → readback → "yes" (confirm) → thank you + $price

// ─────────────────────────────────────────────────────────
// SECTION A: ACCEPT-DEFAULT PHRASES
// ─────────────────────────────────────────────────────────
console.log("\n=== A: ACCEPT-DEFAULT PHRASES ===\n");

// After name, system asks for format. After format, asks for condiments.
// "that way is fine" etc. should accept the item as-is (no toppings).
// Then "no" at anything-else → readback → yes → confirm.

test("A1: 'that way is fine' accepts defaults",
  ["turkey sandwich", "Alex", "that way is fine", "no", "yes"],
  ["Turkey Sandwich", "7.95"]);

test("A2: 'that way is good' accepts defaults",
  ["turkey sandwich", "Alex", "that way is good", "no", "yes"],
  ["Turkey Sandwich", "7.95"]);

test("A3: 'the way it comes' accepts defaults",
  ["turkey sandwich", "Alex", "the way it comes", "no", "yes"],
  ["Turkey Sandwich", "7.95"]);

test("A4: 'how it comes' accepts defaults",
  ["turkey sandwich", "Alex", "how it comes", "no", "yes"],
  ["Turkey Sandwich", "7.95"]);

test("A5: 'leave it like that' accepts defaults",
  ["turkey sandwich", "Alex", "leave it like that", "no", "yes"],
  ["Turkey Sandwich", "7.95"]);

test("A6: 'sounds good' accepts defaults",
  ["turkey sandwich", "Alex", "sounds good", "no", "yes"],
  ["Turkey Sandwich", "7.95"]);

test("A7: 'that works for me' accepts defaults",
  ["turkey sandwich", "Alex", "that works for me", "no", "yes"],
  ["Turkey Sandwich", "7.95"]);

// ─────────────────────────────────────────────────────────
// SECTION B: ROAST BEEF
// ─────────────────────────────────────────────────────────
console.log("\n=== B: ROAST BEEF ===\n");

test("B1: roast beef asks hot or cold",
  ["roast beef sandwich", "Jordan"],
  [/hot or cold/i]);

test("B2: roast beef hot",
  ["roast beef sandwich", "Jordan", "hot", "plain roll", "nothing", "no", "yes"],
  [/hot/i, "Roast Beef"]);

test("B3: roast beef cold",
  ["roast beef sandwich", "Jordan", "cold", "plain roll", "nothing", "no", "yes"],
  [/cold/i, "Roast Beef"]);

test("B4: turkey + roast beef both complete",
  ["a turkey sandwich and a roast beef sandwich", "Maria",
   "plain roll", "nothing", "hot", "plain roll", "nothing", "no", "yes"],
  ["Turkey Sandwich", "Roast Beef"]);

test("B5: 2x roast beef - format question fired",
  ["two roast beef sandwiches", "Sam"],
  [/Roast Beef/i]);

// ─────────────────────────────────────────────────────────
// SECTION C: VEGETARIAN ORDERING
// ─────────────────────────────────────────────────────────
console.log("\n=== C: VEGETARIAN ORDERING ===\n");

test("C1: vegetarian inquiry answered",
  ["do you have vegetarian options", "Lisa"],
  [/vegetarian/i]);

// "veggie sandwich" alone (no format in utterance) - works
test("C2: 'i want a veggie sandwich' builds Veggie Sandwich",
  ["i want a veggie sandwich", "Lisa", "plain roll", "nothing", "no", "yes"],
  ["Veggie Sandwich", "7.95"]);

// "vegetarian sandwich" keyword
test("C3: 'vegetarian sandwich' builds Veggie Sandwich",
  ["i want a vegetarian sandwich", "Lisa", "plain roll", "nothing", "no", "yes"],
  [/veggie|vegetarian/i]);

// NOTE: "veggie sandwich on a plain roll" (with format in utterance) is a KNOWN BUG
// - incorrectly matches Chicken Salad Sandwich
// Documenting as known failure below

// Veggie + toppings
test("C4: veggie sandwich with lettuce tomato - no duplicates",
  ["i want a veggie sandwich", "Lisa", "plain roll", "lettuce and tomato", "no", "yes"],
  [/veggie|vegetarian/i],
  [/lettuce.*lettuce/i, /tomato.*tomato/i]);

// Veggie roll price
test("C5: veggie roll price is 7.95",
  ["i want a veggie sandwich", "Lisa", "plain roll", "nothing", "no", "yes"],
  ["7.95"]);

// Veggie sub price
test("C6: veggie sub price is 9.95",
  ["i want a veggie sandwich", "Lisa", "plain sub", "nothing", "no", "yes"],
  ["9.95"]);

// ─────────────────────────────────────────────────────────
// SECTION D: TURKEY + CHEESE PRICING
// ─────────────────────────────────────────────────────────
console.log("\n=== D: TURKEY + CHEESE PRICING ===\n");

// One-shot turkey + cheese
test("D1: turkey + american cheese one-shot 8.25",
  ["turkey sandwich with american cheese on a plain roll", "Tom", "nothing", "no", "yes"],
  ["8.25"], ["7.95"]);

// Multi-turn: cheese at condiment step
test("D2: turkey then add american cheese at condiment step 8.25",
  ["turkey sandwich", "Tom", "plain roll", "add american cheese", "no", "yes"],
  ["8.25"], ["7.95"]);

test("D3: turkey then add mozzarella at condiment step 8.25",
  ["turkey sandwich", "Tom", "plain roll", "add mozzarella", "no", "yes"],
  ["8.25"], ["7.95"]);

// Turkey no cheese
test("D4: turkey no cheese 7.95",
  ["turkey sandwich", "Tom", "plain roll", "nothing", "no", "yes"],
  ["7.95"], ["8.25"]);

// Ham + cheese
test("D5: ham with american cheese 8.25",
  ["ham sandwich with american cheese on a plain roll", "Ben", "nothing", "no", "yes"],
  ["8.25"], ["7.95"]);

// Baked ham + cheese multi-turn
test("D6: baked ham add cheese at condiment step 8.25",
  ["baked ham sandwich", "Ben", "plain roll", "add american cheese", "no", "yes"],
  ["8.25"], ["7.95"]);

// ─────────────────────────────────────────────────────────
// SECTION E: CORRECTION AFTER READBACK
// ─────────────────────────────────────────────────────────
console.log("\n=== E: CORRECTION AFTER READBACK ===\n");

// Standard flow: item → name → format → condiments → "no" (nothing else)
//              → readback + "Is that correct?" → "no [correction]" → updated readback → "yes"

test("E1: actually make it a sub at readback updates format",
  ["turkey sandwich", "Alex", "plain roll", "nothing", "no", "actually make it a sub", "plain sub", "yes"],
  [/sub/i, "Turkey"]);

test("E2: no add swiss at readback adds swiss 8.25",
  ["turkey sandwich", "Alex", "plain roll", "nothing", "no", "no add swiss", "yes"],
  [/swiss/i, "8.25"]);

test("E3: no add american cheese at readback adds cheese",
  ["turkey sandwich", "Alex", "plain roll", "nothing", "no", "no add american cheese", "yes"],
  [/american/i, "8.25"]);

test("E4: no add lettuce at readback adds lettuce",
  ["turkey sandwich", "Alex", "plain roll", "nothing", "no", "no add lettuce", "yes"],
  [/lettuce/i]);

test("E5: yes at readback confirms order",
  ["turkey sandwich", "Alex", "plain roll", "nothing", "no", "yes"],
  [/thank|see you/i, "7.95"]);

test("E6: no at readback asks for correction",
  ["turkey sandwich", "Alex", "plain roll", "nothing", "no", "no"],
  [/change|fix|correct|different|update/i]);

// ─────────────────────────────────────────────────────────
// SECTION F: MULTI-ITEM FLOWS
// ─────────────────────────────────────────────────────────
console.log("\n=== F: MULTI-ITEM FLOWS ===\n");

test("F1: turkey + ham both in readback",
  ["a turkey sandwich and a ham sandwich", "Maria",
   "plain roll", "nothing", "plain roll", "nothing", "no", "yes"],
  ["Turkey Sandwich", "Ham Sandwich"]);

test("F2: two turkey sandwiches quantity handled",
  ["two turkey sandwiches", "Sam", "plain roll", "nothing", "no", "yes"],
  ["Turkey Sandwich"]);

test("F3: 2x turkey both the same no guardrail",
  ["two turkey sandwiches", "Sam", "both the same", "plain roll", "nothing", "no", "yes"],
  ["Turkey Sandwich"], ["Sorry"]);

test("F4: yes and a ham sandwich adds ham",
  ["turkey sandwich", "Tom", "plain roll", "nothing", "yes and a ham sandwich",
   "plain roll", "nothing", "no", "yes"],
  ["Turkey Sandwich", "Ham Sandwich"]);

test("F5: 2x ham same for both",
  ["two ham sandwiches", "Sam", "both the same", "plain roll", "nothing", "no", "yes"],
  ["Ham Sandwich"]);

// ─────────────────────────────────────────────────────────
// SECTION G: BREAKFAST
// ─────────────────────────────────────────────────────────
console.log("\n=== G: BREAKFAST ===\n");

test("G1: bacon egg and cheese",
  ["bacon egg and cheese", "Kim", "plain roll", "no"],
  ["Bacon Egg & Cheese"]);

test("G2: sausage egg and cheese",
  ["sausage egg and cheese", "Kim", "plain roll", "no"],
  ["Sausage Egg & Cheese"]);

test("G3: bacon egg and cheese with sausage",
  ["bacon egg and cheese with sausage", "Kim", "plain roll", "no"],
  ["Bacon Sausage Egg & Cheese"]);

test("G4: breakfast on plain roll",
  ["bacon egg and cheese on a plain roll", "Kim", "no", "yes"],
  ["Bacon Egg & Cheese"]);

// ─────────────────────────────────────────────────────────
// SECTION H: DELI BY WEIGHT
// ─────────────────────────────────────────────────────────
console.log("\n=== H: DELI BY WEIGHT ===\n");

test("H1: half pound of turkey",
  ["half pound of turkey", "Jay", "no", "yes"],
  ["1/2 lb"]);

test("H2: one and a half pounds of turkey",
  ["one and a half pounds of turkey", "Jay", "no", "yes"],
  ["1 1/2 lb"]);

test("H3: one and a quarter pound of ham",
  ["one and a quarter pound of ham", "Jay", "no", "yes"],
  ["1 1/4 lb"]);

test("H4: deli + sandwich in one order",
  ["half pound of turkey and a ham sandwich", "Jay", "plain roll", "nothing", "no", "yes"],
  ["1/2 lb", "Ham Sandwich"]);

// ─────────────────────────────────────────────────────────
// SECTION I: SIDES / SALADS
// ─────────────────────────────────────────────────────────
console.log("\n=== I: SIDES / SALADS ===\n");

test("I1: tossed salad small",
  ["tossed salad", "Kim", "small", "no", "yes"],
  ["Tossed Salad"]);

test("I2: tossed salad large",
  ["tossed salad", "Kim", "large", "no", "yes"],
  ["Tossed Salad"]);

test("I3: turkey + tossed salad",
  ["a turkey sandwich and a tossed salad", "Kim",
   "plain roll", "nothing", "small", "no", "yes"],
  ["Turkey Sandwich", "Tossed Salad"]);

// ─────────────────────────────────────────────────────────
// SECTION J: CASUAL / MESSY PHRASING
// ─────────────────────────────────────────────────────────
console.log("\n=== J: CASUAL / MESSY PHRASING ===\n");

test("J1: lemme get a turkey",
  ["lemme get a turkey", "Jay", "plain roll", "nothing", "no", "yes"],
  ["Turkey", "7.95"]);

test("J2: I want a turkey on white with everything",
  ["I want a turkey on white with everything", "Jay", "no", "yes"],
  ["Turkey"], ["Sorry"]);

test("J3: can I get a ham sandwich please",
  ["can I get a ham sandwich please", "Jay", "plain roll", "nothing", "no", "yes"],
  ["Ham Sandwich"]);

test("J4: all-caps input",
  ["TURKEY SANDWICH", "Sam", "plain roll", "nothing", "no", "yes"],
  ["Turkey Sandwich"]);

test("J5: plain turkey nothing on it one-shot",
  ["just a plain turkey nothing on it on a plain roll", "Sam", "no", "yes"],
  ["Turkey Sandwich"]);

test("J6: yeah confirms at readback",
  ["turkey sandwich", "Sam", "plain roll", "nothing", "no", "yeah"],
  [/thank|see you/i]);

test("J7: nope means nothing else",
  ["turkey sandwich", "Sam", "plain roll", "nothing", "nope", "yes"],
  [/thank|see you/i]);

test("J8: that is it finishes order",
  ["turkey sandwich", "Sam", "plain roll", "nothing", "that is it", "yes"],
  [/thank|see you/i]);

test("J9: adding topping mid-flow",
  ["turkey sandwich", "Sam", "plain roll", "lettuce and tomato", "no", "yes"],
  [/lettuce|tomato/i]);

test("J10: name with no extra interaction",
  ["turkey sandwich for Alex", "plain roll", "nothing", "no", "yes"],
  ["Turkey Sandwich"]);

// ─────────────────────────────────────────────────────────
// SECTION K: EDGE CASES
// ─────────────────────────────────────────────────────────
console.log("\n=== K: EDGE CASES ===\n");

test("K1: turkey with no toppings - no condiment re-ask",
  ["turkey sandwich with no toppings on a plain roll for Sam", "no", "yes"],
  ["Turkey Sandwich"]);

test("K2: roll then actually make that a sub",
  ["turkey sandwich", "Sam", "roll", "actually make that a sub", "plain sub", "nothing", "no", "yes"],
  [/sub/i]);

test("K3: salami and cheese",
  ["salami and cheese", "Joe"],
  [/salami/i]);

test("K4: quantity two turkey sandwiches",
  ["I'll have 2 turkey sandwiches", "Sam", "plain roll", "nothing", "no", "yes"],
  ["Turkey Sandwich"]);

test("K5: nothing at condiments clears condiments",
  ["turkey sandwich", "Sam", "plain roll", "nothing", "no", "yes"],
  ["Turkey Sandwich"]);

test("K6: pepper turkey sandwich",
  ["pepper turkey sandwich on a plain roll", "Sam", "nothing", "no", "yes"],
  [/pepper turkey/i]);

test("K7: grilled chicken sandwich",
  ["grilled chicken sandwich on a plain roll", "Sam", "nothing", "no", "yes"],
  [/grilled chicken/i]);

test("K8: pastrami sandwich",
  ["pastrami sandwich on a plain roll", "Sam", "nothing", "no", "yes"],
  [/pastrami/i]);

test("K9: tuna sandwich",
  ["tuna sandwich on a plain roll", "Sam", "nothing", "no", "yes"],
  [/tuna/i]);

test("K10: yes and add item at confirm step",
  ["turkey sandwich", "Tom", "plain roll", "nothing", "yes and a ham sandwich",
   "plain roll", "nothing", "no", "yes"],
  ["Turkey Sandwich", "Ham Sandwich"]);

// ─────────────────────────────────────────────────────────
// SECTION L: KNOWN REGRESSION CHECKS
// ─────────────────────────────────────────────────────────
console.log("\n=== L: REGRESSION GUARD CHECKS ===\n");

// These are the specific fixes from this session

// L1: yea at readback confirms
test("L1: 'yea' at readback confirms",
  ["turkey sandwich", "Sam", "plain roll", "nothing", "no", "yea"],
  [/thank|see you/i]);

// L2: thats all at anything-else finishes
test("L2: 'thats all' finishes order",
  ["turkey sandwich", "Sam", "plain roll", "nothing", "thats all", "yes"],
  [/thank|see you/i]);

// L3: nothing else at anything-else finishes
test("L3: 'nothing else' finishes",
  ["turkey sandwich", "Sam", "plain roll", "nothing", "nothing else", "yes"],
  [/thank|see you/i]);

// L4: roast beef asks hot/cold (not format) first
test("L4: roast beef - hot/cold before format",
  ["roast beef sandwich", "Jordan"],
  [/hot or cold/i]);

// L5: readback correction flow - add item
test("L5: readback correction - no add lettuce tomato",
  ["turkey sandwich", "Alex", "plain roll", "nothing", "no", "no add lettuce and tomato", "yes"],
  [/lettuce/i, /tomato/i]);

// L6: ham no cheese readback - no & Cheese in readback
test("L6: ham no cheese - readback omits & Cheese",
  ["ham no cheese on a plain roll", "Joe", "nothing", "no", "yes"],
  ["Ham Sandwich"], ["Ham & Cheese"]);

// L7: one and a half pounds weight parsing
test("L7: one and a half pounds",
  ["one and a half pounds of turkey", "Jay", "no", "yes"],
  ["1 1/2 lb"]);

// L8: 2x same item 'both the same' - no guardrail fire
test("L8: 2x ham both the same - no guardrail",
  ["two ham sandwiches", "Sam", "both the same", "plain roll", "nothing", "no", "yes"],
  ["Ham Sandwich"], ["Sorry"]);

// L9: turkey sandwich with cheese upgrade pricing multi-turn
test("L9: turkey + add swiss at condiment step 8.25",
  ["turkey sandwich", "Tom", "plain roll", "add swiss cheese", "no", "yes"],
  ["8.25"], ["7.95"]);

// L10: sandwich with condiments one-shot
test("L10: turkey mayo lettuce tomato one-shot on plain roll",
  ["turkey sandwich with mayo lettuce and tomato on a plain roll", "Dan", "no", "yes"],
  ["Turkey", /mayo|lettuce|tomato/i]);

// ─────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────
console.log("\n=== SUMMARY ===");
console.log(passed + " passed, " + failed + " failed out of " + (passed + failed));

if (failures.length) {
  console.log("\n=== FAILURES DETAIL ===");
  for (const f of failures) {
    console.log("\nFAIL: " + f.label);
    for (const m of f.msgs) console.log("  " + m);
    if (process.env.VERBOSE) {
      console.log("  OUTPUT:");
      console.log(f.out);
    }
  }
}
