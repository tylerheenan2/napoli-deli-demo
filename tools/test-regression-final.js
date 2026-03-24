#!/usr/bin/env node
"use strict";
const { spawnSync } = require("child_process");
const path = require("path");

const CLI  = path.join(__dirname, "run-cli.cjs");
const CWD  = path.join(__dirname, "..");

function run(inputs) {
  const inputStr = inputs.join("\n") + "\n";
  const env = { ...process.env, NODE_ENV: "test" };
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
    failures.push({ label, msgs, out: out.slice(0, 1200) });
    failed++;
  }
}

// Standard flow: [item] → name → format → condiments → "no" (nothing else)
//                → readback confirmation → "yes" → thank you + $price

// ─────────────────────────────────────────────────────────
// SECTION A: ACCEPT-DEFAULT PHRASES (at condiment step)
// ─────────────────────────────────────────────────────────
console.log("\n=== A: ACCEPT-DEFAULT PHRASES ===\n");

test("A1: 'that way is fine' at condiment step",
  ["turkey sandwich", "Alex", "plain roll", "that way is fine", "no", "yes"],
  ["Turkey Sandwich", "7.95"]);

test("A2: 'that way is good' at condiment step",
  ["turkey sandwich", "Alex", "plain roll", "that way is good", "no", "yes"],
  ["Turkey Sandwich", "7.95"]);

test("A3: 'the way it comes' at condiment step",
  ["turkey sandwich", "Alex", "plain roll", "the way it comes", "no", "yes"],
  ["Turkey Sandwich", "7.95"]);

test("A4: 'how it comes' at condiment step",
  ["turkey sandwich", "Alex", "plain roll", "how it comes", "no", "yes"],
  ["Turkey Sandwich", "7.95"]);

test("A5: 'leave it like that' at condiment step",
  ["turkey sandwich", "Alex", "plain roll", "leave it like that", "no", "yes"],
  ["Turkey Sandwich", "7.95"]);

test("A6: 'sounds good' at condiment step",
  ["turkey sandwich", "Alex", "plain roll", "sounds good", "no", "yes"],
  ["Turkey Sandwich", "7.95"]);

test("A7: 'that works for me' at condiment step",
  ["turkey sandwich", "Alex", "plain roll", "that works for me", "no", "yes"],
  ["Turkey Sandwich", "7.95"]);

// ─────────────────────────────────────────────────────────
// SECTION B: ROAST BEEF HOT/COLD
// ─────────────────────────────────────────────────────────
console.log("\n=== B: ROAST BEEF ===\n");

test("B1: roast beef asks hot or cold",
  ["roast beef sandwich", "Jordan"],
  [/hot or cold/i]);

test("B2: roast beef hot confirmed",
  ["roast beef sandwich", "Jordan", "hot", "plain roll", "nothing", "no", "yes"],
  [/hot/i, "Roast Beef"]);

test("B3: roast beef cold confirmed",
  ["roast beef sandwich", "Jordan", "cold", "plain roll", "nothing", "no", "yes"],
  [/cold/i, "Roast Beef"]);

test("B4: turkey + roast beef multi-item",
  ["a turkey sandwich and a roast beef sandwich", "Maria",
   "plain roll", "nothing", "hot", "plain roll", "nothing", "no", "yes"],
  ["Turkey Sandwich", "Roast Beef"]);

test("B5: 2x roast beef - Roast Beef label in early output",
  ["two roast beef sandwiches", "Sam"],
  [/Roast Beef/i]);

// ─────────────────────────────────────────────────────────
// SECTION C: VEGETARIAN ORDERING
// ─────────────────────────────────────────────────────────
console.log("\n=== C: VEGETARIAN ORDERING ===\n");

test("C1: vegetarian inquiry answered",
  ["do you have vegetarian options", "Lisa"],
  [/vegetarian/i]);

test("C2: 'i want a veggie sandwich' builds Veggie Sandwich",
  ["i want a veggie sandwich", "Lisa", "plain roll", "nothing", "no", "yes"],
  ["Veggie Sandwich", "7.95"]);

test("C3: 'i want a vegetarian sandwich' recognized",
  ["i want a vegetarian sandwich", "Lisa", "plain roll", "nothing", "no", "yes"],
  [/veggie|vegetarian/i]);

test("C4: veggie sandwich with condiments no duplicates",
  ["i want a veggie sandwich", "Lisa", "plain roll", "lettuce and tomato", "no", "yes"],
  [/veggie/i],
  [/lettuce.*lettuce/i, /tomato.*tomato/i]);

test("C5: veggie roll price 7.95",
  ["i want a veggie sandwich", "Lisa", "plain roll", "nothing", "no", "yes"],
  ["7.95"]);

test("C6: veggie sub price 9.95",
  ["i want a veggie sandwich", "Lisa", "plain sub", "nothing", "no", "yes"],
  ["9.95"]);

// ─────────────────────────────────────────────────────────
// SECTION D: CHEESE PRICING
// ─────────────────────────────────────────────────────────
console.log("\n=== D: CHEESE PRICING ===\n");

test("D1: turkey + american cheese one-shot 8.25",
  ["turkey sandwich with american cheese on a plain roll", "Tom", "nothing", "no", "yes"],
  ["8.25"], ["7.95"]);

test("D2: turkey then add american cheese at condiment step 8.25",
  ["turkey sandwich", "Tom", "plain roll", "add american cheese", "no", "yes"],
  ["8.25"], ["7.95"]);

test("D3: turkey then add mozzarella at condiment step 8.25",
  ["turkey sandwich", "Tom", "plain roll", "add mozzarella", "no", "yes"],
  ["8.25"], ["7.95"]);

test("D4: turkey then add swiss at condiment step 8.25",
  ["turkey sandwich", "Tom", "plain roll", "add swiss cheese", "no", "yes"],
  ["8.25"], ["7.95"]);

test("D5: turkey no cheese 7.95",
  ["turkey sandwich", "Tom", "plain roll", "nothing", "no", "yes"],
  ["7.95"], ["8.25"]);

test("D6: honey ham then add cheese 7.95 (menu price = same as plain)",
  ["honey ham sandwich", "Ben", "plain roll", "add american cheese", "no", "yes"],
  ["7.95"]);

// ─────────────────────────────────────────────────────────
// SECTION E: READBACK CORRECTION FLOW
// ─────────────────────────────────────────────────────────
console.log("\n=== E: CORRECTION AFTER READBACK ===\n");

test("E1: actually make it a sub at readback",
  ["turkey sandwich", "Alex", "plain roll", "nothing", "no", "actually make it a sub", "plain sub", "yes"],
  [/sub/i, "Turkey"]);

test("E2: no add swiss at readback - swiss in updated readback",
  ["turkey sandwich", "Alex", "plain roll", "nothing", "no", "no add swiss", "yes"],
  [/swiss/i, "8.25"]);

test("E3: no add american cheese at readback",
  ["turkey sandwich", "Alex", "plain roll", "nothing", "no", "no add american cheese", "yes"],
  [/american/i, "8.25"]);

test("E4: no add lettuce at readback",
  ["turkey sandwich", "Alex", "plain roll", "nothing", "no", "no add lettuce", "yes"],
  [/lettuce/i]);

test("E5: yes at readback confirms + shows price",
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

test("F2: two turkey sandwiches",
  ["two turkey sandwiches", "Sam", "plain roll", "nothing", "no", "yes"],
  ["Turkey Sandwich"]);

test("F3: 2x turkey both the same - no guardrail",
  ["two turkey sandwiches", "Sam", "both the same", "plain roll", "nothing", "no", "yes"],
  ["Turkey Sandwich"], ["Sorry"]);

test("F4: yes and a ham sandwich adds ham",
  ["turkey sandwich", "Tom", "plain roll", "nothing", "yes and a ham sandwich",
   "plain roll", "nothing", "no", "yes"],
  ["Turkey Sandwich", "Ham Sandwich"]);

test("F5: 2x ham same for both",
  ["two ham sandwiches", "Sam", "both the same", "plain roll", "nothing", "no", "yes"],
  ["Ham Sandwich"], ["Sorry"]);

test("F6: 2x roast beef same for both",
  ["two roast beef sandwiches", "Sam", "both the same", "hot", "plain roll", "nothing", "no", "yes"],
  ["Roast Beef"], ["Sorry"]);

// ─────────────────────────────────────────────────────────
// SECTION G: BREAKFAST
// ─────────────────────────────────────────────────────────
console.log("\n=== G: BREAKFAST ===\n");

test("G1: bacon egg and cheese",
  ["bacon egg and cheese", "Kim", "plain roll", "no", "yes"],
  ["Bacon Egg & Cheese"]);

test("G2: sausage egg and cheese",
  ["sausage egg and cheese", "Kim", "plain roll", "no", "yes"],
  ["Sausage Egg & Cheese"]);

test("G3: bacon egg and cheese with sausage",
  ["bacon egg and cheese with sausage", "Kim", "plain roll", "no", "yes"],
  ["Bacon Sausage Egg & Cheese"]);

test("G4: steak egg and cheese",
  ["steak egg and cheese on a plain roll", "Kim", "no", "yes"],
  [/steak.*egg|egg.*steak/i]);

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

test("H4: deli plus sandwich",
  ["half pound of turkey and a ham sandwich", "Jay", "plain roll", "nothing", "no", "yes"],
  ["1/2 lb", "Ham Sandwich"]);

test("H5: three quarters pound",
  ["three quarters pound of turkey", "Jay", "no", "yes"],
  [/3\/4|three quarter/i]);

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

test("J2: turkey on white with everything - processes ok",
  ["I want a turkey on white with everything", "Jay", "no", "yes"],
  ["Turkey"], ["Sorry"]);

test("J3: can I get a ham sandwich please",
  ["can I get a ham sandwich please", "Jay", "plain roll", "nothing", "no", "yes"],
  ["Ham"]);

test("J4: all-caps input",
  ["TURKEY SANDWICH", "Sam", "plain roll", "nothing", "no", "yes"],
  ["Turkey Sandwich"]);

test("J5: plain turkey nothing on it",
  ["just a plain turkey nothing on it on a plain roll", "Sam", "no", "yes"],
  ["Turkey Sandwich"]);

test("J6: yeah at readback confirms",
  ["turkey sandwich", "Sam", "plain roll", "nothing", "no", "yeah"],
  [/thank|see you/i]);

test("J7: nope at nothing-else step",
  ["turkey sandwich", "Sam", "plain roll", "nothing", "nope", "yes"],
  [/thank|see you/i]);

test("J8: that is it at nothing-else step",
  ["turkey sandwich", "Sam", "plain roll", "nothing", "that is it", "yes"],
  [/thank|see you/i]);

test("J9: adding topping at condiment step",
  ["turkey sandwich", "Sam", "plain roll", "lettuce and tomato", "no", "yes"],
  [/lettuce|tomato/i]);

test("J10: name embedded in order",
  ["turkey sandwich for Alex", "plain roll", "nothing", "no", "yes"],
  ["Turkey Sandwich"]);

// ─────────────────────────────────────────────────────────
// SECTION K: EDGE CASES
// ─────────────────────────────────────────────────────────
console.log("\n=== K: EDGE CASES ===\n");

test("K1: turkey with no toppings one-shot",
  ["turkey sandwich with no toppings on a plain roll for Sam", "no", "yes"],
  ["Turkey Sandwich"]);

test("K2: roll then actually make that a sub",
  ["turkey sandwich", "Sam", "roll", "actually make that a sub", "plain sub", "nothing", "no", "yes"],
  [/sub/i]);

test("K3: salami and cheese item",
  ["salami and cheese", "Joe"],
  [/salami/i]);

test("K4: quantity two sandwiches",
  ["I'll have 2 turkey sandwiches", "Sam", "plain roll", "nothing", "no", "yes"],
  ["Turkey Sandwich"]);

test("K5: pepper turkey",
  ["pepper turkey sandwich on a plain roll", "Sam", "nothing", "no", "yes"],
  [/pepper turkey/i]);

test("K6: grilled chicken",
  ["grilled chicken sandwich on a plain roll", "Sam", "nothing", "no", "yes"],
  [/grilled chicken/i]);

test("K7: pastrami",
  ["pastrami sandwich on a plain roll", "Sam", "nothing", "no", "yes"],
  [/pastrami/i]);

test("K8: tuna",
  ["tuna sandwich on a plain roll", "Sam", "nothing", "no", "yes"],
  [/tuna/i]);

test("K9: ham no cheese - omits Cheese from name",
  ["ham no cheese on a plain roll", "Joe", "nothing", "no", "yes"],
  [/ham/i], ["Ham & Cheese"]);

test("K10: turkey sandwich name with apostrophe",
  ["turkey sandwich", "O'Brien", "plain roll", "nothing", "no", "yes"],
  ["Turkey Sandwich"]);

// ─────────────────────────────────────────────────────────
// SECTION L: REGRESSION GUARD (all recent fixes)
// ─────────────────────────────────────────────────────────
console.log("\n=== L: REGRESSION GUARD ===\n");

test("L1: 'yea' at readback confirms",
  ["turkey sandwich", "Sam", "plain roll", "nothing", "no", "yea"],
  [/thank|see you/i]);

test("L2: 'thats all' at anything-else finishes",
  ["turkey sandwich", "Sam", "plain roll", "nothing", "thats all", "yes"],
  [/thank|see you/i]);

test("L3: 'nothing else' finishes",
  ["turkey sandwich", "Sam", "plain roll", "nothing", "nothing else", "yes"],
  [/thank|see you/i]);

test("L4: roast beef hot/cold before format",
  ["roast beef sandwich", "Jordan"],
  [/hot or cold/i]);

test("L5: readback correction - add lettuce and tomato",
  ["turkey sandwich", "Alex", "plain roll", "nothing", "no", "no add lettuce and tomato", "yes"],
  [/lettuce/i, /tomato/i]);

test("L6: ham no cheese - no & Cheese in readback",
  ["ham no cheese on a plain roll", "Joe", "nothing", "no", "yes"],
  [/ham/i], ["Ham & Cheese"]);

test("L7: weight compound: one and a half pounds",
  ["one and a half pounds of turkey", "Jay", "no", "yes"],
  ["1 1/2 lb"]);

test("L8: 2x ham both the same - no guardrail",
  ["two ham sandwiches", "Sam", "both the same", "plain roll", "nothing", "no", "yes"],
  ["Ham"], ["Sorry"]);

test("L9: turkey + swiss at condiment step 8.25",
  ["turkey sandwich", "Tom", "plain roll", "add swiss cheese", "no", "yes"],
  ["8.25"], ["7.95"]);

test("L10: turkey with mayo lettuce tomato on plain roll",
  ["turkey sandwich with mayo lettuce and tomato on a plain roll", "Dan", "no", "yes"],
  ["Turkey", /mayo|lettuce|tomato/i]);

// ─────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────
console.log("\n=== SUMMARY ===");
console.log(passed + " passed, " + failed + " failed out of " + (passed + failed));

if (failures.length) {
  console.log("\n=== FAILURES ===");
  for (const f of failures) {
    console.log("\nFAIL: " + f.label);
    for (const m of f.msgs) console.log("  " + m);
  }
}
