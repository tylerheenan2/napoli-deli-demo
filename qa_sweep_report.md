# Napoli Deli QA Sweep Report
Generated: 2026-03-18
Status: IN PROGRESS

## Quick Tracking Log

| ID | Result | Category | Description | Notes |
|----|--------|----------|-------------|-------|
| T001 | PASS | single sandwich | Turkey roll plain roll lettuce tomato | Chris |
| T002 | PASS | single sandwich | Ham sub plain mustard pickles | Ben |
| T003 | PASS | single sandwich | BLT wrap wheat lettuce tomato | Tyler |
| T004 | PASS | single sandwich | Meatball sub seeded no toppings | Sam |
| T005 | PASS | single sandwich | Tuna salad poppy seed roll mayo lettuce | Mia |
| T006 | PASS | single sandwich | Egg salad sandwich tomato basil wrap plain | Luca |
| T007 | PASS | single sandwich | Chicken salad sandwich knot roll lettuce tomato | Ava |
| T008 | PASS | single sandwich | Italian combo sub seeded oil vinegar hot peppers | Jordan |
| T009 | MINOR ISSUE | single sandwich | "turkey club" → Turkey Sandwich (not named Turkey Club) | Alex; system asks sandwich or by pound - fine |
| T010 | PASS | single sandwich | Capicola Portuguese roll plain | Maria |
| T011 | FAIL | single sandwich | "pepper turkey" → asks weight quantity, then goes to wrap without format | Nick; price $0.50 - deli weight misrouting |
| T012 | PASS | single sandwich | Honey ham sub plain no toppings | Zoe |
| T013 | MINOR ISSUE | single sandwich | Salami sandwich — "olives" not included in readback; only "Onion" listed | Marcus |
| T014 | PASS | single sandwich | Ham and cheese roll plain mustard | Leah |
| T015 | PASS | single sandwich | Roast beef hot roll plain lettuce | Tony |
| T016 | MINOR ISSUE | single sandwich | "cold roast beef" → asks sandwich or by pound (correct, but skips temp question) | Nina |
| T017 | PASS | single sandwich | Turkey sandwich spinach wrap plain | Sophia |
| T018 | PASS | single sandwich | Ham sandwich Portuguese roll plain | Dylan |
| T019 | PASS | single sandwich | "no toppings" phrasing works | Emma |
| T020 | PASS | single sandwich | Ham sandwich wheat wrap | Olivia |
| T021 | PASS | single sandwich | Turkey knot roll oil and vinegar | Jay |
| T022 | PASS | single sandwich | Chicken salad white wrap lettuce tomato mayo | Carmen |
| T023 | PASS | single sandwich | BLT plain roll no toppings | Mike |
| T024 | PASS | single sandwich | Turkey seeded sub plain | Rachel |
| T025 | PASS | single sandwich | Egg salad plain roll lettuce | Eric |
| T026 | PASS | single sandwich | Capicola tomato basil wrap plain | Hannah |
| T027 | PASS | single sandwich | Name in first message (turkey sandwich for Daniel) | name captured |
| T028 | FAIL | single sandwich | "meatball sub" → system asks bread sub type then shows "Meatball on a Roll" in readback, readback confirm "no" fails | Ryan |
| T028b | PASS | single sandwich | "meatball" → proper ask roll/sub/wrap flow | Ryan |
| T029 | PASS | single sandwich | Salami spinach wrap plain | Leo |
| T030 | PASS | single sandwich | Turkey plain roll lettuce tomato pickles | Dana |
| T031 | PASS | single sandwich | Ham plain roll lettuce tomato mustard | Ana |
| T032 | PASS | single sandwich | Turkey tomato basil wrap lettuce | Marco |
| T033 | PASS | single sandwich | Pepper turkey wheat wrap plain | Priya |
| T034 | FAIL | single sandwich | "tuna salad" alone → asks weight, bad routing to deli | Mateo |
| T034b | PASS | single sandwich | "tuna salad sandwich" works correctly | Mateo |
| T034c | FAIL | disambiguation | "tuna salad" → deli, then "sandwich" → no rule matched, bad flow | |
| T035 | PASS | single sandwich | Italian combo white wrap plain | Alex |
| T036 | PASS | single sandwich | Honey ham tomato basil wrap plain | Sam |
| T037 | MINOR ISSUE | single sandwich | "turkey club sandwich" resolves to Turkey Sandwich (not "Turkey Club" named item) | Ben |
| T038 | PASS | single sandwich | Ham and cheese spinach wrap mayo tomato | Cindy |
| T039 | FAIL | single sandwich | "everything" as topping → treated as plain | Tyler |
| T039b | FAIL | single sandwich | "everything on it" → treated as plain | Tyler |
| T039c | PASS | single sandwich | Multiple explicit toppings work | Tyler |
| T040 | PASS | single sandwich | Egg salad seeded sub plain | Chris |
| T041 | PASS | two-sandwich | Turkey+ham both plain roll | Ben |
| T042 | FAIL | two-sandwich | "BLT and a chicken salad sandwich" → only chicken salad captured (BLT lost) | Ava |
| T042b | FAIL | two-sandwich | "I'd like a BLT and a chicken salad sandwich" → only chicken salad captured | Ava |
| T042c | PASS | two-sandwich | "a turkey sandwich and ham sandwich" → both captured correctly | Ben |
| T043 | PASS | two-sandwich | Meatball sub and BLT → both captured | Tyler |
| T044 | PASS | two-sandwich | Turkey and egg salad with different formats | Luca |
| T045 | PASS | two-sandwich | Ham and tuna salad | Cindy |
| T046 | FAIL | readback confirm | "yes" fails on chicken salad+meatball 2-item order | Sophia |
| T046b | FAIL | readback confirm | "correct" fails | |
| T046c | FAIL | readback confirm | "yep" fails | |
| T046d | FAIL | readback confirm | "that's right" fails | |
| T046e | FAIL | readback confirm | "looks good" fails | |
| T046f | FAIL | readback confirm | "yes" fails on chicken salad+meatball 2-item (seeded sub) | |
| T046g | FAIL | readback confirm | "all correct" fails | |
| T047 | PASS | single sandwich | "that's correct" works on single-item | Tyler |
| T048 | PASS | two-sandwich | "that's correct" works on turkey+ham | Ben |
| T049 | FAIL | two-sandwich | "turkey sandwich and egg salad" → egg salad routed to deli (needs "egg salad sandwich") | Ben |
| T049b | PASS | two-sandwich | "turkey sandwich and egg salad sandwich" → both captured | Ben |
| T050 | PASS | two-sandwich | Turkey and Italian combo | Alex |

---

