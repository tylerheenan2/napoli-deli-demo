#!/usr/bin/env node
"use strict";
const { spawnSync } = require("child_process");
const path = require("path");

const CLI  = path.join(__dirname, "run-cli.cjs");
const CWD  = path.join(__dirname, "..");

function run(inputs, opts = {}) {
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
    failures.push({ label, msgs, out: out.slice(0, 1200) });
    failed++;
  }
}

// ─────────────────────────────────────────────────────────
// SECTION A: ACCEPT-DEFAULT PHRASES
// ─────────────────────────────────────────────────────────
console.log("\n=== A: ACCEPT-DEFAULT PHRASES ===\n");

test("A1: 'that way is fine' accepts defaults",
  ["turkey sandwich", "Alex", "that way is fine", "no"],
  ["Turkey Sandwich"]);

test("A2: 'that way is good' accepts defaults",
  ["turkey sandwich", "Alex", "that way is good", "no"],
  ["Turkey Sandwich"]);

test("A3: 'the way it comes' accepts defaults",
  ["turkey sandwich", "Alex", "the way it comes", "no"],
  ["Turkey Sandwich"]);

test("A4: 'how it comes' accepts defaults",
  ["turkey sandwich", "Alex", "how it comes", "no"],
  ["Turkey Sandwich"]);

test("A5: 'leave it like that' accepts defaults",
  ["turkey sandwich", "Alex", "leave it like that", "no"],
  ["Turkey Sandwich"]);

test("A6: 'sounds good' accepts defaults",
  ["turkey sandwich", "Alex", "sounds good", "no"],
  ["Turkey Sandwich"]);

test("A7: 'that works for me' accepts defaults",
  ["turkey sandwich", "Alex", "that works for me", "no"],
  ["Turkey Sandwich"]);

// ─────────────────────────────────────────────────────────
// SECTION B: ROAST BEEF HOT/COLD + MULTI-ITEM ORDINAL
// ─────────────────────────────────────────────────────────
console.log("\n=== B: ROAST BEEF + MULTI-ITEM ORDINAL ===\n");

test("B1: roast beef sandwich asks hot or cold",
  ["roast beef sandwich", "Jordan"],
  [/hot or cold/i]);

test("B2: roast beef hot in readback",
  ["roast beef sandwich", "Jordan", "hot", "plain roll", "nothing", "no"],
  [/hot/i, "Roast Beef"]);

test("B3: roast beef cold in readback",
  ["roast beef sandwich", "Jordan", "cold", "plain roll", "nothing", "no"],
  [/cold/i, "Roast Beef"]);

test("B4: turkey + roast beef -> roast beef prompt has label",
  ["a turkey sandwich and a roast beef sandwich", "Maria", "plain roll", "nothing", "hot", "plain roll", "nothing", "no"],
  [/Roast beef/i]);

test("B5: 2x roast beef first item hot/cold prompt has label",
  ["two roast beef sandwiches", "Sam"],
  [/hot or cold/i, /Roast beef/i]);

// ─────────────────────────────────────────────────────────
// SECTION C: VEGETARIAN ORDERING
// ─────────────────────────────────────────────────────────
console.log("\n=== C: VEGETARIAN ORDERING ===\n");

test("C1: vegetarian inquiry answered",
  ["do you have vegetarian options", "Lisa"],
  [/vegetarian/i]);

test("C2: veggie sandwich on a plain roll builds item",
  ["veggie sandwich on a plain roll", "Lisa", "lettuce tomato", "no"],
  ["Veggie Sandwich"]);

test("C3: veggie no duplicate ingredients in readback",
  ["veggie sandwich on a plain roll with lettuce and tomato", "Lisa", "no"],
  ["Veggie Sandwich"],
  [/lettuce.*lettuce/i, /tomato.*tomato/i]);

test("C4: mozzarella cheese sandwich uses cheese name not Veggie Sandwich",
  ["mozzarella cheese sandwich on a roll with arugula", "Nina", "no"],
  [/mozzarella/i],
  ["Veggie Sandwich"]);

test("C5: fresh mozzarella with arugula no meat required",
  ["fresh mozzarella with arugula and roasted peppers on a roll", "Nina", "no"],
  [/mozzarella/i]);

test("C6: veggie roll price 7.95",
  ["veggie sandwich on a plain roll", "Lisa", "nothing", "no"],
  ["7.95"]);

test("C7: veggie sub price 9.95",
  ["veggie sandwich on a plain sub", "Lisa", "nothing", "no"],
  ["9.95"]);

// ─────────────────────────────────────────────────────────
// SECTION D: TURKEY + CHEESE PRICING
// ─────────────────────────────────────────────────────────
console.log("\n=== D: TURKEY + CHEESE PRICING ===\n");

test("D1: turkey with american cheese one-shot roll 8.25",
  ["turkey sandwich with american cheese on a plain roll", "Tom", "nothing", "no"],
  ["8.25"], ["7.95"]);

test("D2: turkey plain roll then add american cheese at condiment step 8.25",
  ["turkey sandwich", "Tom", "plain roll", "add american cheese", "no"],
  ["8.25"], ["7.95"]);

test("D3: turkey plain roll then add mozzarella at condiment step 8.25",
  ["turkey sandwich", "Tom", "plain roll", "add mozzarella", "no"],
  ["8.25"], ["7.95"]);

test("D4: turkey no cheese 7.95 on roll",
  ["turkey sandwich", "Tom", "plain roll", "nothing", "no"],
  ["7.95"], ["8.25"]);

test("D5: ham with american cheese 8.25",
  ["ham sandwich with american cheese on a plain roll", "Ben", "nothing", "no"],
  ["8.25"], ["7.95"]);

test("D6: baked ham add cheese at condiment step 8.25",
  ["baked ham sandwich", "Ben", "plain roll", "add american cheese", "no"],
  ["8.25"], ["7.95"]);

// ─────────────────────────────────────────────────────────
// SECTION E: CORRECTION AFTER READBACK
// ─────────────────────────────────────────────────────────
console.log("\n=== E: CORRECTION AFTER READBACK ===\n");

test("E1: actually make it a sub at readback updates format",
  ["turkey sandwich", "Alex", "plain roll", "nothing", "actually make it a sub", "plain sub", "yes"],
  [/sub/i]);

test("E2: no add swiss at readback adds swiss",
  ["turkey sandwich", "Alex", "plain roll", "nothing", "no add swiss", "yes"],
  [/swiss/i]);

test("E3: no add american cheese at readback adds cheese",
  ["turkey sandwich", "Alex", "plain roll", "nothing", "no add american cheese", "yes"],
  [/american/i]);

test("E4: no add lettuce at readback adds lettuce",
  ["turkey sandwich", "Alex", "plain roll", "nothing", "no add lettuce", "yes"],
  [/lettuce/i]);

test("E5: yes at readback confirms order",
  ["turkey sandwich", "Alex", "plain roll", "nothing", "yes"],
  [/thank/i]);

test("E6: no at readback asks for correction",
  ["turkey sandwich", "Alex", "plain roll", "nothing", "no"],
  [/change|correct|fix|different/i]);

// ─────────────────────────────────────────────────────────
// SECTION F: MULTI-ITEM FLOWS
// ─────────────────────────────────────────────────────────
console.log("\n=== F: MULTI-ITEM FLOWS ===\n");

test("F1: turkey + ham both in readback",
  ["a turkey sandwich and a ham sandwich", "Maria", "plain roll", "nothing", "plain roll", "nothing", "no"],
  ["Turkey Sandwich", "Ham Sandwich"]);

test("F2: 3 items all in readback",
  ["turkey sandwich ham sandwich and a tossed salad", "Maria", "plain roll", "nothing", "plain roll", "nothing", "small", "no"],
  ["Turkey Sandwich", "Ham Sandwich", "Tossed Salad"]);

test("F3: two turkey sandwiches quantity handled",
  ["two turkey sandwiches", "Sam", "plain roll", "nothing", "no"],
  ["Turkey Sandwich"]);

test("F4: 2x turkey both the same no guardrail",
  ["two turkey sandwiches", "Sam", "both the same", "plain roll", "nothing", "no"],
  ["Turkey Sandwich"], ["Sorry"]);

test("F5: yes and a ham sandwich adds ham",
  ["turkey sandwich", "Tom", "plain roll", "nothing", "yes and a ham sandwich", "plain roll", "nothing", "no"],
  ["Turkey Sandwich", "Ham Sandwich"]);

// ─────────────────────────────────────────────────────────
// SECTION G: BREAKFAST
// ─────────────────────────────────────────────────────────
console.log("\n=== G: BREAKFAST ===\n");

test("G1: bacon egg and cheese",
  ["bacon egg and cheese", "Kim"],
  ["Bacon Egg & Cheese"]);

test("G2: sausage egg and cheese",
  ["sausage egg and cheese", "Kim"],
  ["Sausage Egg & Cheese"]);

test("G3: bacon egg and cheese with sausage",
  ["bacon egg and cheese with sausage", "Kim"],
  ["Bacon Sausage Egg & Cheese"]);

test("G4: breakfast on plain roll",
  ["bacon egg and cheese on a plain roll", "Kim", "no"],
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

test("H3: quarter pound of ham",
  ["quarter pound of ham", "Jay", "no", "yes"],
  ["1/4 lb"]);

test("H4: deli plus sandwich",
  ["half pound of turkey and a ham sandwich", "Jay", "plain roll", "nothing", "no", "yes"],
  ["1/2 lb", "Ham Sandwich"]);

// ─────────────────────────────────────────────────────────
// SECTION I: SIDES / SALADS
// ─────────────────────────────────────────────────────────
console.log("\n=== I: SIDES / SALADS ===\n");

test("I1: tossed salad small",
  ["tossed salad", "Kim", "small", "no"],
  ["Tossed Salad"]);

test("I2: tossed salad large",
  ["tossed salad", "Kim", "large", "no"],
  ["Tossed Salad"]);

// ─────────────────────────────────────────────────────────
// SECTION J: CASUAL / MESSY PHRASING
// ─────────────────────────────────────────────────────────
console.log("\n=== J: CASUAL / MESSY PHRASING ===\n");

test("J1: lemme get a turkey",
  ["lemme get a turkey", "Jay", "plain roll", "nothing", "no"],
  ["Turkey"]);

test("J2: I want a turkey on white with everything",
  ["I want a turkey on white with everything", "Jay", "no"],
  ["Turkey"], ["Sorry"]);

test("J3: can I get a ham sandwich please",
  ["can I get a ham sandwich please", "Jay", "plain roll", "nothing", "no"],
  ["Ham Sandwich"]);

test("J4: turkey mayo lettuce tomato plain roll one-shot",
  ["turkey with mayo lettuce and tomato on a plain roll for Dan"],
  ["Turkey Sandwich"]);

test("J5: plain turkey nothing on it",
  ["just a plain turkey nothing on it on a plain roll", "Sam", "no"],
  ["Turkey Sandwich"]);

test("J6: yeah confirms",
  ["turkey sandwich", "Sam", "plain roll", "nothing", "yeah"],
  [/thank/i]);

test("J7: nope at anything else finishes",
  ["turkey sandwich", "Sam", "plain roll", "nothing", "yes", "nope"],
  [/thank/i]);

test("J8: thats it finishes",
  ["turkey sandwich", "Sam", "plain roll", "nothing", "yes", "thats it"],
  [/thank/i]);

test("J9: all-caps input",
  ["TURKEY SANDWICH", "Sam", "plain roll", "nothing", "no"],
  ["Turkey Sandwich"]);

test("J10: adding topping mid-flow",
  ["turkey sandwich", "Sam", "plain roll", "lettuce and tomato", "no"],
  [/lettuce|tomato/i]);

// ─────────────────────────────────────────────────────────
// SECTION K: EDGE CASES
// ─────────────────────────────────────────────────────────
console.log("\n=== K: EDGE CASES ===\n");

test("K1: turkey with no toppings no condiment re-ask",
  ["turkey sandwich with no toppings on a plain roll for Sam", "no"],
  ["Turkey Sandwich"]);

test("K2: roll then actually make that a sub",
  ["turkey sandwich", "Sam", "roll", "actually make that a sub", "plain sub", "nothing", "no"],
  [/sub/i]);

test("K3: salami and cheese treated as one item",
  ["salami and cheese", "Joe"],
  [/salami/i]);

test("K4: name with apostrophe",
  ["turkey sandwich", "O'Brien", "plain roll", "nothing", "no"],
  ["Turkey Sandwich"]);

test("K5: quantity two turkey sandwiches",
  ["I'll have 2 turkey sandwiches", "Sam", "plain roll", "nothing", "no"],
  ["Turkey Sandwich"]);

test("K6: nothing at condiments",
  ["turkey sandwich", "Sam", "plain roll", "nothing", "no"],
  ["Turkey Sandwich"]);

test("K7: honey turkey sandwich",
  ["honey turkey sandwich on a plain roll", "Sam", "nothing", "no"],
  [/honey turkey/i]);

test("K8: pepper turkey sandwich",
  ["pepper turkey sandwich on a plain roll", "Sam", "nothing", "no"],
  [/pepper turkey/i]);

test("K9: italian sausage sandwich",
  ["italian sausage sandwich on a plain roll", "Sam", "nothing", "no"],
  [/italian sausage/i]);

test("K10: grilled chicken sandwich",
  ["grilled chicken sandwich on a plain roll", "Sam", "nothing", "no"],
  [/grilled chicken/i]);

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
    if (process.env.VERBOSE) {
      console.log("  OUTPUT EXCERPT:");
      console.log(f.out);
    }
  }
}
