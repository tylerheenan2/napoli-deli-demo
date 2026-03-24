#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Napoli Deli AI Ordering System - Deterministic Runner (Phase 1)
 *
 * JSON configs are authoritative. This runner:
 * - initializes state to match rules.json state_model
 * - performs deterministic (non-LLM) NLU (minimal)
 * - evaluates rules by priority per rules.json.engine
 * - applies actions (set/emit/respond/end)
 * - processes emits inline (so later responds in the same rule see updated state)
 * - renders PromptID templates with {path} placeholders
 *
 * Future LLM usage (Phase 2) is out of scope here.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..");

function loadJson(relPath) {
  const abs = path.join(ROOT, relPath);
  const raw = fs.readFileSync(abs, "utf8");
  return JSON.parse(raw);
}

function safeLoadJson(relPath) {
  try {
    return loadJson(relPath);
  } catch {
    return null;
  }
}

function correctMenuTypos(text) {
  const s = String(text || "");
  // Static table of common deli-vocabulary misspellings → canonical forms.
  // Applied before extractEntities so mistyped words still match the lexicon.
  const _typos = [
    [/\bnayo\b/gi, "mayo"],
    [/\bnayonnaise\b/gi, "mayonnaise"],
    [/\bmustar\b/gi, "mustard"],
    [/\bseseme\b/gi, "seeded"],
    [/\bsesame\b/gi, "seeded"],  // no sesame bread exists; seeded_sub is the closest match
    [/\bpoppye\b/gi, "poppy"],
    [/\bsaueage\b/gi, "sausage"],
    [/\blettce\b/gi, "lettuce"],
    [/\bletuce\b/gi, "lettuce"],
    [/\btomatoe\b/gi, "tomato"],
    [/\bonoin\b/gi, "onion"],
    [/\bavacado\b/gi, "avocado"],
    [/\bprovolon\b/gi, "provolone"],
    [/\bmozerella\b/gi, "mozzarella"],
    [/\bmozarella\b/gi, "mozzarella"],
    [/\bpepperonie\b/gi, "pepperoni"],
    [/\bturke[uo]\b/gi, "turkey"],   // turkeu, turkeo (u/y key-swap typo)
    [/\bturky\b/gi,    "turkey"],    // turky (missing e)
    // Fix Part3-3: deli weight compound word typos.
    [/\bhald\b/gi, "half"],          // "one and a hald pound" → half
    [/\bqurter\b/gi, "quarter"],     // "one and a qurter pound" → quarter
    [/\bqaurter\b/gi, "quarter"],    // "one and a qaurter pound" → quarter
    [/\bquarted\b/gi, "quarter"],    // "one and a quarted pound" → quarter
    [/\bpouund\b/gi, "pound"],       // "pouund" → pound
    [/\bpouns\b/gi, "pound"],        // "pouns" → pound
    [/\bpounda\b/gi, "pound"],       // "pounda" → pound
    [/\bona\b/gi, "one"],            // "ona and a half" → one (common fast-type)
    // Fix Part4-2: bread typos.
    [/\bfoll\b/gi, "roll"],          // "foll" → roll (f/r key-swap typo)
    // Plural-normalisation for multi-word item names ("two bacon egg and cheeses").
    [/\begg(?:\s+and|\s+&)\s+cheeses\b/gi, "egg and cheese"],
    [/\bham\s+and\s+cheeses\b/gi, "ham and cheese"],
  ];
  let out = s;
  for (const [re, fix] of _typos) out = out.replace(re, fix);
  return out;
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------
// Multi-item queue utilities
// ---------------------------

function startsLikeNewItemClause(raw) {
  const n = normalizeText(raw);
  if (!n) return false;
  // Treat only explicit quantities (or a leading digit) as new-item starters.
  // IMPORTANT: do NOT treat "a"/"an" as quantities here. Otherwise phrases like
  // "I want a roma panini" get mis-split into ["i want", "a roma panini"],
  // which then causes the queue-replay system to duplicate items.
  // Exception: "an order of ..." is a safe new-item starter because it always
  // precedes a menu item (e.g., "an order of fries", "an order of rings").
  if (/^(one|two|three|four|five|six|seven|eight|nine|\d)\b/.test(n)) return true;
  if (/^an?\s+order\s+of\b/.test(n)) return true;
  // Weight expressions are unambiguous new-item starters (deli-by-weight ordering).
  // e.g. "a half pound of turkey", "1/2 lb of ham", "a pound of roast beef"
  if (/^(a\s+)?(half|quarter|\d+(\.\d+)?)\s*(pound|lb)s?\b/i.test(n)) return true;
  if (/^\d+\s*\/\s*\d+\s*(pound|lb)s?\b/i.test(n)) return true;
  // "a side of X" / "side of X" / "side order of X" are unambiguous new-item starters.
  if (/^a?\s*side\s+(of|order\s+of|dish\s+of)\b/.test(n)) return true;
  return false;
}

function splitMultiItemUtteranceDeterministic(raw) {
  // Deterministic separators only. We do NOT split on generic "and" unless it is
  // clearly a top-level item starter (", and a ...", " and one ...", etc.).
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return { first: s, rest: [] };

  // Helper: safe top-level ", and" / " and" split only when the next clause looks like a new item.
  const splitBySafeAnd = (input) => {
  const parts = [];
  const cur0 = String(input || "").trim();
  if (!cur0) return parts;

  // Scan for *any* "and" separator that is followed by a clear new-item starter.
  // This avoids false splits inside item names like "ham and cheese".
  // Example: "two ham and cheese and one turkey" -> split at "and one", not "and cheese".
  const reAnd = /(,\s+and\s+|\s+and\s+)/gi;
  let match;
  while ((match = reAnd.exec(cur0)) !== null) {
    const idx = match.index;
    const sepLen = match[1].length;
    const left = cur0.slice(0, idx).trim();
    const right = cur0.slice(idx + sepLen).trim();
    // A split is safe when either:
    // (a) the right side starts like a new item clause (quantity-led: "one ham...", "2 turkey...")
    // (b) the left side ends with a format word (roll/sub/wrap/panini/etc.) — the first item
    //     is complete, so the next clause must be a new item.
    //     e.g. "ham and cheese on a roll AND turkey on a roll"
    //          "chicken cutlet panini AND a turkey sub"
    //          "ham and cheese sub AND fries"
    const _leftEndsWithFormat = /\b(roll|sub|wrap|panini|sandwich|hero|hoagie|wedge|toast|bread)\s*$/i.test(left);
    // Guard: do NOT split compound weight phrases like "one and a half pounds [of turkey]"
    // or "one and three quarters of a pound of turkey".
    // left="one", right="a half pounds of turkey" / "three quarters of a pound" →
    // startsLikeNewItemClause would return true but these are ONE compound weight, not two items.
    const _isCompoundWeightSplit =
      /^(one|two|three|four|five|six|seven|eight|nine|\d+)$/i.test(left) &&
      /^(a\s+)?(half|quarter|three\s+quarters?)\b/i.test(right);
    if (_isCompoundWeightSplit) continue;
    // Check if right side ends with a format word and has no "and" in the item prefix.
    // Handles "ham and cheese and turkey on a roll" → split at second "and":
    //   left="ham and cheese", right="turkey on a roll" → two separate items.
    // Guard: left must have ≥2 words (prevents split where left is a single word like "ham").
    // Guard: prefix before format must NOT contain "and" (so "cheese and turkey on a roll"
    //        with "and" in prefix is skipped at the first "and" where left="ham").
    const _rightLooksLikeItemOnFormat = (() => {
      const _fmtRe2 = /\b(roll|sub|wrap|panini|sandwich|hero|hoagie|wedge|toast|bread)\s*$/i;
      const _m2 = _fmtRe2.exec(right);
      if (!_m2) return false;
      const prefix = right.slice(0, _m2.index).trim();
      if (!prefix || / and /i.test(prefix)) return false;
      // Guard: if left contains "with", the "and" is connecting toppings, not items.
      // e.g. "bacon egg and cheese with sausage on a roll" — "and" is inside the item name.
      if (/\bwith\b/i.test(left)) return false;
      // Guard: if right starts with a condiment/modifier word, the "and" connects toppings.
      // e.g. "lettuce tomato and mayo on a plain roll" — mayo is a topping, not an item.
      if (/^(cheese|with|without|no\s|add|plus|extra|mayo|mustard|lettuce|tomato|onion|pepper)\b/i.test(right.trim())) return false;
      return left.trim().split(/\s+/).length >= 2;
    })();
    if (left && right && (startsLikeNewItemClause(right) || _leftEndsWithFormat || _rightLooksLikeItemOnFormat)) {
      parts.push(left);
      // Recursively scan the remainder so we can split "..., and one X, and one Y"
      // without ever splitting inside a single item phrase.
      const tail = splitBySafeAnd(right);
      if (tail.length) parts.push(...tail);
      else parts.push(right);
      return parts.filter(Boolean);
    }
    // Not safe; keep scanning for a later safe "and".
  }

  // No safe "and" splits found.
  // Secondary deterministic split: quantity-transition without explicit "and".
  // Example: "two ham and cheese one turkey" -> split at "one turkey".
  // Guard: do NOT split per-sandwich variation clauses like "one plain roll".
  // Secondary split: treat explicit quantities as item starters, not articles (a/an).
  const qtyRe = /\s+(one|two|three|four|five|six|seven|eight|nine|\d+)\b/gi;
  let m2;
  while ((m2 = qtyRe.exec(cur0)) !== null) {
    const idx2 = m2.index;
    const left2 = cur0.slice(0, idx2).trim();
    const right2 = cur0.slice(idx2).trim();
    if (!left2 || !right2) continue;
    // Do not split when the left side is purely an order lead-in phrase (e.g. "can i have",
    // "i want", "let me get") with no menu item content — splitting leaves a non-matching
    // fragment as the first item and drops the real order text.
    const _isLeadIn = /^(can i (get|have)|i\s*(?:'d| would)\s*like|i\s*want|get me|give me|let me get|lemme get|gimme|i('ll| will) have|i need|i('ll| will) do)\s*$/i.test(left2);
    if (_isLeadIn) continue;
    // Guard: do NOT split compound weight/fraction phrases at quantity words.
    // e.g. "one and three quarters of a pound of turkey" → left2="one and", right2="three quarters..."
    // "three" triggers startsLikeNewItemClause but is part of the compound fraction, not a new item.
    const _isCompoundFracSplit2 =
      /^(three\s+quarters?|two\s+and\s+|a\s+half|a\s+quarter)\b/i.test(right2) &&
      /\b(pound|lb)s?\b/.test(cur0);
    if (_isCompoundFracSplit2) continue;
    if (!startsLikeNewItemClause(right2)) continue;

    const nextTok = normalizeText(right2).split(/\s+/).slice(1, 2)[0] || "";
    const stop = new Set(["plain","poppy","seed","roll","sub","wrap","panini","with","w","the","other","and"]);
    if (stop.has(nextTok)) continue;

    if (left2.split(/\s+/).length >= 2) {
      parts.push(left2);
      const tail2 = splitBySafeAnd(right2);
      if (tail2.length) parts.push(...tail2);
      else parts.push(right2);
      return parts.filter(Boolean);
    }
  }

  parts.push(cur0);
  return parts.filter(Boolean);
};


  // Strong separators (e.g., ";", ", and also ...") are safe, but we must still
  // apply the safe-and split to each remainder so we don't drop items like:
  // "..., and also X, and Y"  -> [X, Y]
  const strongParts = s
    .split(/\s*;\s*|\s*,\s*and\s+also\s+|\s+and\s+also\s+|\.\s+[Aa]lso\b/i)
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  if (strongParts.length > 1) {
    const rest = [];
    for (const seg of strongParts.slice(1)) {
      rest.push(...splitBySafeAnd(seg));
    }
    return { first: strongParts[0], rest };
  }

  // Bug 2 fix: "N <item(s)>, one <format_A> and one <format_B>" distribution pattern.
  // e.g. "two turkey sandwiches, one plain roll and one seeded sub"
  // → split into two fully-specified same-item entries so each gets qty=1 with its own format/bread.
  {
    const _sdRe = /^(?:two|three|four|five|six|seven|eight|nine|\d+)\s+(.+?)\s*,\s*(one\s+\S.*?\b(?:roll|sub|wrap|panini|bread|toast)\b)\s+and\s+(one\s+\S.*?\b(?:roll|sub|wrap|panini|bread|toast)\b)\s*$/i;
    const _sdM = _sdRe.exec(s);
    if (_sdM) {
      const _sdItem = _sdM[1].trim()
        .replace(/\bsandwiches\b/i, "sandwich")
        .replace(/\bwraps\b/i, "wrap")
        .replace(/\bsubs\b/i, "sub");
      const _sd1 = _sdM[2].trim().replace(/^one\s+/i, "");
      const _sd2 = _sdM[3].trim().replace(/^one\s+/i, "");
      return { first: _sdItem + " " + _sd1, rest: [_sdItem + " " + _sd2] };
    }
  }

  const parts = splitBySafeAnd(s);
  if (parts.length > 1) return { first: parts[0], rest: parts.slice(1) };
  return { first: s, rest: [] };
}


// Menu-aware multi-item split for utterances like "salami and cheese and capicola and cheese"
// where no quantity words are present. Tries each "and" position and scores both halves
// against the menu. If both score well as known items, split there.
function scoreHalfAgainstMenu(half, menuIndex) {
  // Score a phrase against menu items, also trying with "and" replaced by space
  // so "salami and cheese" matches normVariant "salami cheese".
  const halfNoAnd = half.replace(/\band\b/g, ' ').replace(/\s+/g, ' ').trim();
  const toks = new Set(half.split(' ').filter(Boolean));
  const toksNoAnd = new Set(halfNoAnd.split(' ').filter(Boolean));
  let best = 0;
  for (const it of menuIndex) {
    const s1 = scoreItemMatch(half, toks, it);
    const s2 = scoreItemMatch(halfNoAnd, toksNoAnd, it);
    if (s1 > best) best = s1;
    if (s2 > best) best = s2;
  }
  return best;
}

function menuAwareSplitOnAnd(raw, menuIndex) {
  if (!Array.isArray(menuIndex) || !menuIndex.length) return null;
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  const norm = normalizeText(s);
  if (!norm) return null;

  // Attempt when there is at least 1 word-boundary "and" token.
  // (Previously required 2+; lowered to 1 to handle single-"and" deli+side splits
  //  like "half pound turkey and a side of potato salad".)
  const andCount = (norm.match(/\band\b/g) || []).length;
  if (andCount < 1) return null;

  // Collect all valid "and" split positions with scores
  const reAnd = /\band\b/gi;
  let m;
  const candidates = [];
  while ((m = reAnd.exec(norm)) !== null) {
    const left = norm.slice(0, m.index).trim();
    const right = norm.slice(m.index + m[0].length).trim();
    if (left.split(' ').length >= 2 && right.split(' ').length >= 2) {
      const leftScore = scoreHalfAgainstMenu(left, menuIndex);
      const rightScore = scoreHalfAgainstMenu(right, menuIndex);
      if (leftScore >= 2 && rightScore >= 2) {
        // Guard: check if this "and" is part of a compound menu item name (e.g., "ham and cheese").
        // If the phrase spanning the "and" (last 3 words of left + "and" + first 3 words of right)
        // scores highly against the menu, the "and" is likely a name connector, not a multi-item separator.
        const leftWords = left.split(' ');
        const rightWords = right.split(' ');
        const boundaryLeft = leftWords.slice(-3).join(' ');
        const boundaryRight = rightWords.slice(0, 3).join(' ');
        const boundaryPhrase = boundaryLeft + ' and ' + boundaryRight;
        const boundaryScore = scoreHalfAgainstMenu(boundaryPhrase, menuIndex);
        // Block this split only if the boundary phrase scores STRICTLY MORE than either half,
        // meaning the "and" connects two parts of one compound name (e.g. "ham and cheese" as a single item).
        // Using > (not >=) avoids false blocks when the boundary scores the same as the halves,
        // which happens for legitimate two-item splits like "caesar wrap on wheat and hummus wrap on spinach".
        if (boundaryScore > Math.max(leftScore, rightScore)) continue; // "and" is part of an item name — skip
        candidates.push({ left, right, combined: leftScore + rightScore, andIdx: m.index });
      }
    }
  }

  if (!candidates.length) return null;

  // Pick the split with the highest combined score (best separates two distinct items)
  candidates.sort((a, b) => b.combined - a.combined);
  const best = candidates[0];

  // Reconstruct original-case split at this "and"
  const reParts = s.split(/\band\b/i);
  const leftNormWords = best.left.split(' ').length;
  let accumulated = 0;
  for (let i = 0; i < reParts.length - 1; i++) {
    const partWords = reParts[i].trim().split(/\s+/).filter(Boolean).length;
    accumulated += partWords;
    if (Math.abs(accumulated - leftNormWords) <= 1) {
      const origLeft = reParts.slice(0, i + 1).join('and').trim();
      const origRight = reParts.slice(i + 1).join('and').trim();
      if (origLeft && origRight) {
        return { first: origLeft, rest: [origRight] };
      }
    }
  }
  return null;
}

function detectMultiQtyVariation(raw, breadIndex) {
  const n = normalizeText(raw);
  if (!n) return false;

  const hasMultiQty = /\b(two|three|four|five|six|seven|eight|nine|\d+)\b/.test(n);
  const hasPerItemMarkers = /\b(one\b.*\bone\b|the other\b|other one\b)\b/.test(n);
  if (!hasMultiQty || !hasPerItemMarkers) return false;

  const hasFormatWord = /\b(roll|sub|wrap|panini)\b/.test(n);
  const hasBreadType = Boolean(inferBreadTypeFromText(raw, breadIndex));
  return hasFormatWord || hasBreadType;
}

function parseExplicitPerItemCondimentBinding(raw, config) {
  const text = String(raw || "");
  const n = normalizeText(text);
  if (!n) return null;

  // Only handle explicit, deterministic patterns. No inference.
  // Supported:
  //  - "one with X and the other plain"
  //  - "one plain and the other with X"
  //  - "one with X, one with Y" / "one with X and one with Y"
  if (!/\bone\b/.test(n)) return null;

  const otherMarker = /\b(the\s+other|other\s+one)\b/.test(n);

  const getConds = (clause) => {
    const ents = extractEntities(
      clause,
      config.keywordPhrases,
      config.breadIndex,
      config.condimentIndex,
      config.cheeseIndex,
      config.meatIndex,
      config.addonIndex
    );
    const arr = Array.isArray(ents?.condiments) ? ents.condiments : [];
    return Array.from(new Set(arr));
  };

  const isPlain = (clauseNorm) => /\b(plain|nothing|no\s+(?:toppings|condiments|extras)|nothing\s+on\s+it)\b/.test(clauseNorm);

  // one with X ... the other plain OR the other with Y
  const m1 = n.match(/\bone\s+with\s+(.+?)\s+(?:and\s+)?(?:the\s+other|other\s+one)\s+(.+)$/);
  if (m1 && otherMarker) {
    const c1 = m1[1].trim();
    const c2 = m1[2].trim();
    if (isPlain(c2)) return { lists: [getConds(c1), []], source: "one_with_other_plain" };
    const m1b = c2.match(/^with\s+(.+)$/);
    if (m1b) return { lists: [getConds(c1), getConds(m1b[1].trim())], source: "one_with_other_with" };
  }

  // one plain ... the other with X
  const m2 = n.match(/\bone\s+(plain|nothing|no\s+(?:toppings|condiments|extras))\b.*?(?:and\s+)?(?:the\s+other|other\s+one)\s+with\s+(.+)$/);
  if (m2 && otherMarker) {
    return { lists: [[], getConds(m2[2].trim())], source: "one_plain_other_with" };
  }

  // one with X, one with Y
  const m3 = n.match(/\bone\s+with\s+(.+?)\s*(?:,|and)\s+one\s+with\s+(.+)$/);
  if (m3) return { lists: [getConds(m3[1].trim()), getConds(m3[2].trim())], source: "one_with_one_with" };

  return null;
}

function parseExplicitTwoBreadSelections(raw, breadIndex) {
  const text = String(raw || "");
  const n = normalizeText(text);
  if (!n) return null;

  // Deterministic patterns only:
  // "one on a <bread> and one on a <bread>"
  // "one <bread> and one <bread>"
  // Only used when quantity>=2.
  const m = n.match(/\bone\b(?:\s+on\b)?(?:\s+a\b)?\s+(.+?)\s+(?:,\s*)?(?:and\s+)?\bone\b(?:\s+on\b)?(?:\s+a\b)?\s+(.+)$/);
  if (!m) return null;

  const c1 = m[1].trim();
  const c2 = m[2].trim();
  const b1 = inferBreadTypeFromText(c1, breadIndex);
  const b2 = inferBreadTypeFromText(c2, breadIndex);
  if (!b1 || !b2) return null;
  return [b1, b2];
}

function extractFormatBreadSelections(raw, breadIndex) {
  const text = String(raw || "");
  const n = " " + normalizeText(text) + " ";
  if (n.trim() === "") return [];

  const selections = [];
  const usedSpans = [];

  const addSpan = (span) => {
    usedSpans.push(span);
  };
  const overlaps = (a) => {
    for (const b of usedSpans) {
      if (a.start < b.end && b.start < a.end) return true;
    }
    return false;
  };

  // 1) Bread type matches (explicit aliases only)
  const bEntries = Array.isArray(breadIndex) ? breadIndex : [];
  const breadMatches = [];
  for (const e of bEntries) {
    if (!e || !e.id || !e.norm) continue;
    const needle = " " + e.norm + " ";
    let from = 0;
    while (true) {
      const idx = n.indexOf(needle, from);
      if (idx === -1) break;
      const actualStart = idx + 1;
      const actualEnd = actualStart + e.norm.length;
      const span = { start: actualStart, end: actualEnd };
      if (!overlaps(span)) {
        breadMatches.push({
          start: actualStart,
          end: actualEnd,
          bread_type: e.id,
          format: e.group || null,
        });
        addSpan(span);
      }
      from = idx + 1;
    }
  }
  breadMatches.sort((a, b) => a.start - b.start);
  for (const bm of breadMatches) {
    if (!bm.format) continue;
    selections.push({ format: bm.format, bread_type: bm.bread_type, start: bm.start, end: bm.end, source: "bread" });
  }

  // 2) Format-only matches (roll/sub/wrap/panini/bread/toast)
  const fmtRe = /\b(mini\s*subs?|mini_subs?|rolls?|subs?|wraps?|paninis?|breads?|toasts?)\b/gi;
  const fmtMatches = [];
  let m;
  while ((m = fmtRe.exec(n)) !== null) {
    const rawTok = String(m[1] || "").toLowerCase().replace(/\s+/g, " ").trim();
    const tok = rawTok;
    const fmt = (tok === "mini sub" || tok === "mini subs" || tok === "mini_sub" || tok === "mini_subs") ? "mini_sub"
      : (tok === "rolls") ? "roll"
      : (tok === "subs") ? "sub"
      : (tok === "wraps") ? "wrap"
      : (tok === "paninis") ? "panini"
      : (tok === "breads") ? "bread"
      : (tok === "toasts") ? "toast"
      : tok;
    const start = m.index;
    const end = start + m[0].length;
    const span = { start, end };
    if (overlaps(span)) continue;
    fmtMatches.push({ format: fmt, start });
  }
  fmtMatches.sort((a, b) => a.start - b.start);
  for (const fm of fmtMatches) {
    // Avoid double-counting format-only tokens that immediately follow an explicit bread selection
    // e.g., "poppy roll" => bread match implies roll; skip the trailing "roll" token.
    const fmt = fm.format;
    const start = fm.start;
    const lastBread = [...selections].reverse().find((s) => s && s.source === "bread" && s.format === fmt && typeof s.end === "number" && s.start < start);
    if (lastBread && (start - lastBread.end) <= 6) continue;
    selections.push({ format: fmt, bread_type: null, start, end: null, source: "format" });
  }

  // Deduplicate consecutive identical selections (e.g., repeated tokens)
  const out = [];
  for (const s of selections) {
    const last = out[out.length - 1];
    if (last && last.format === s.format && last.bread_type === s.bread_type) continue;
    out.push({ format: s.format || null, bread_type: s.bread_type || null, start: s.start });
  }
  return out;
}

// Deterministic "name-like" heuristic used only when we are explicitly awaiting a name.
function isLikelyName(raw) {
  const text = String(raw || "").trim();
  if (!text) return false;
  const looksQuestion = text.includes("?") || /^does\b|^do\b|^what\b|^how\b|^is\b|^are\b/i.test(text);
  const offSlotKeywords = /\b(pressed|price|cost|total|how much|come pressed|hot|cold)\b/i.test(text);
  const hasDigits = /\d/.test(text);
  const hasOrderWords = /\b(get|have|want|order|sandwich|sub|wrap|roll|panini|and|with)\b/i.test(text);
  const words = text.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 3 && !hasDigits && !hasOrderWords && !looksQuestion && !offSlotKeywords;
}

// Extract "for <name>" from a single utterance (e.g. "... on a roll for Joe").
// Returns { cleanText, inlineName }.
function extractInlineName(raw) {
  const s = String(raw || "");
  // Deterministically capture an inline customer name using "for <name>".
  // IMPORTANT: Do NOT consume ordering glue words like "with", "on", etc. (e.g., "for Joe with hot peppers").
  // This must be conservative and explainable: we capture 1-3 alpha tokens, stopping early if we hit a stopword.
  const reFor = /\bfor\s+([A-Za-z][A-Za-z'\-]{0,30}(?:\s+[A-Za-z][A-Za-z'\-]{0,30}){0,6})/i;
  const m = s.match(reFor);
  if (!m) return { cleanText: s, inlineName: null };

  const tail = String(m[1] || "").trim();
  const tokens = tail.split(/\s+/).filter(Boolean);

  const stopwords = new Set([
    "with",
    "on",
    "in",
    "at",
    "and",
    "plus",
    "add",
    "no",
    "without",
    "w",
    // Fix Part3: ordering/format/bread words must not be captured as name tokens.
    // "for mateo plain roll nothing on it" → name should stop at "plain".
    "plain", "roll", "sub", "wrap", "bread", "panini", "toast", "toasted",
    "hot", "cold", "warm", "heated",
    "nothing", "everything", "none", "just", "only", "extra",
    "please", "thanks",
  ]);

  const nameTokens = [];
  for (const tok of tokens) {
    const normTok = tok.toLowerCase();
    if (stopwords.has(normTok)) break;
    // Keep only alpha-ish tokens (ignore digits).
    if (!/^[A-Za-z][A-Za-z'\-]{0,30}$/.test(tok)) break;
    nameTokens.push(tok);
    if (nameTokens.length >= 3) break;
  }

  if (!nameTokens.length) return { cleanText: s, inlineName: null };

  const inlineName = nameTokens.join(" ").trim();

  // Remove only the exact "for <captured name>" span, leaving the rest intact (including "with ...").
  const escName = inlineName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reExact = new RegExp(`\\bfor\\s+${escName}\\b`, "i");
  const cleanText = s.replace(reExact, " ").replace(/\s+/g, " ").trim();
  return { cleanText, inlineName };
}


function getPath(obj, dotted) {
  if (!dotted) return undefined;
  const parts = dotted.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function setPath(obj, dotted, value) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isHHMM(x) {
  return typeof x === "string" && /^\d{2}:\d{2}$/.test(x);
}

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map((v) => Number(v));
  return h * 60 + m;
}

function compareSmart(actual, expected, op) {
  // Handle time comparisons like "10:30"
  if (isHHMM(actual) && isHHMM(expected)) {
    const a = hhmmToMinutes(actual);
    const e = hhmmToMinutes(expected);
    if (op === "gt") return a > e;
    if (op === "gte") return a >= e;
    if (op === "lt") return a < e;
    if (op === "lte") return a <= e;
  }

  // Default numeric compare
  const aNum = Number(actual);
  const eNum = Number(expected);
  if (Number.isFinite(aNum) && Number.isFinite(eNum)) {
    if (op === "gt") return aNum > eNum;
    if (op === "gte") return aNum >= eNum;
    if (op === "lt") return aNum < eNum;
    if (op === "lte") return aNum <= eNum;
  }

  // Fallback: lexicographic compare (rare)
  const aStr = String(actual);
  const eStr = String(expected);
  if (op === "gt") return aStr > eStr;
  if (op === "gte") return aStr >= eStr;
  if (op === "lt") return aStr < eStr;
  if (op === "lte") return aStr <= eStr;
  return false;
}

function resolveValueTemplates(value, ctx) {
  // If string is exactly "{path}", return the underlying value type.
  if (typeof value === "string") {
    const exact = value.match(/^\{([^}]+)\}$/);
    if (exact) {
      return getPath(ctx, exact[1].trim());
    }

    // If string contains {path} segments, interpolate as text.
    if (value.includes("{")) {
      return value.replace(/\{([^}]+)\}/g, (_, p1) => {
        const v = getPath(ctx, String(p1).trim());
        if (v === undefined || v === null) return "";
        if (typeof v === "object") return JSON.stringify(v);
        return String(v);
      });
    }
  }

  // Deep-resolve arrays/objects
  if (Array.isArray(value)) return value.map((x) => resolveValueTemplates(x, ctx));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValueTemplates(v, ctx);
    return out;
  }

  return value;
}

const OPS = new Set([
  "eq",
  "not_eq",
  "ne", // alias
  "in",
  "not_in",
  "contains",
  "not_contains",
  "contains_any",
  "exists",
  "not_null",
  "gt",
  "gte",
  "lt",
  "lte",
  "count", // exact count
]);

function evalLeafCondition(state, key, expectedRaw, ctx) {
  const expected = resolveValueTemplates(expectedRaw, ctx);

  const parts = key.split(".");
  const last = parts[parts.length - 1];

  // Support "...count.gte" etc.
  const secondLast = parts.length >= 2 ? parts[parts.length - 2] : null;
  const isCountCompare = secondLast === "count" && ["gt", "gte", "lt", "lte", "eq", "not_eq", "ne"].includes(last);

  if (isCountCompare) {
    const basePath = parts.slice(0, -2).join(".");
    const actualArr = getPath(state, basePath);
    const actualCount = Array.isArray(actualArr) ? actualArr.length : 0;

    const op = last === "ne" ? "not_eq" : last;
    if (op === "eq") return actualCount === Number(expected);
    if (op === "not_eq") return actualCount !== Number(expected);
    return compareSmart(actualCount, expected, op);
  }

  const maybeOp = OPS.has(last) ? last : null;

  // IMPORTANT: many configs use a literal boolean field named `exists` (e.g., order.pending_item.exists).
  // The rules engine also supports an `.exists` operator for presence checks.
  // To avoid treating literal fields as operators, prefer the literal path when it exists on state.
  if (maybeOp === "exists") {
    const direct = getPath(state, key);
    if (direct !== undefined) {
      // Treat as a literal field comparison.
      return deepEqual(direct, expected);
    }
  }

  if (!maybeOp) {
    const actual = getPath(state, key);
    return deepEqual(actual, expected);
  }

  const basePath = parts.slice(0, -1).join(".");
  const actual = getPath(state, basePath);

  switch (maybeOp) {
    case "eq":
      return deepEqual(actual, expected);
    case "not_eq":
    case "ne":
      return !deepEqual(actual, expected);
    case "in":
      return Array.isArray(expected) ? expected.includes(actual) : false;
    case "not_in":
      return Array.isArray(expected) ? !expected.includes(actual) : false;
    case "contains":
      if (Array.isArray(actual)) return actual.includes(expected);
      if (typeof actual === "string") return actual.includes(String(expected));
      return false;
    case "not_contains":
      if (Array.isArray(actual)) return !actual.includes(expected);
      if (typeof actual === "string") return !actual.includes(String(expected));
      return true;
    case "contains_any":
      if (!Array.isArray(expected)) return false;
      if (Array.isArray(actual)) return expected.some((x) => actual.includes(x));
      if (typeof actual === "string") return expected.some((x) => actual.includes(String(x)));
      return false;
    case "exists":
      return expected === true ? actual !== undefined && actual !== null : actual === undefined || actual === null;
    case "not_null":
      return expected === true ? actual !== undefined && actual !== null : actual === undefined || actual === null;
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return compareSmart(actual, expected, maybeOp);
    case "count":
      return Array.isArray(actual) ? actual.length === Number(expected) : false;
    default:
      return false;
  }
}

function evalWhen(state, whenObj, ctx) {
  if (!whenObj || typeof whenObj !== "object") return true;

  if (Array.isArray(whenObj.all)) return whenObj.all.every((cond) => evalWhen(state, cond, ctx));
  if (Array.isArray(whenObj.any)) return whenObj.any.some((cond) => evalWhen(state, cond, ctx));

  return Object.entries(whenObj).every(([k, v]) => evalLeafCondition(state, k, v, ctx));
}

// ---- Prompt resolver ----
function buildPromptMap(promptIdJson) {
  return promptIdJson && promptIdJson.prompts ? promptIdJson.prompts : {};
}

function selectPromptVariant(promptValue, state, pid) {
  // If PromptID value is a raw array, pick a random element (display-only).
  if (Array.isArray(promptValue) && promptValue.length > 0) {
    const idx = Math.floor(Math.random() * promptValue.length);
    return String(promptValue[idx]);
  }

  if (promptValue == null) return `(missing prompt: ${pid})`;

  if (typeof promptValue === "string") return promptValue;

  if (typeof promptValue === "object") {
    if (Array.isArray(promptValue.variants) && promptValue.variants.length > 0) {
      const sel = String(promptValue.selection || "first").toLowerCase();
      if (sel === "random") {
        const idx = Math.floor(Math.random() * promptValue.variants.length);
        return String(promptValue.variants[idx]);
      }

      if (sel === "rotate") {
        const idx = Math.floor(Math.random() * promptValue.variants.length);
        return String(promptValue.variants[idx]);
      }

      return String(promptValue.variants[0]);
    }

    if (typeof promptValue.text === "string") return promptValue.text;
    if (typeof promptValue.prompt === "string") return promptValue.prompt;
    if (typeof promptValue.message === "string") return promptValue.message;

    return JSON.stringify(promptValue);
  }

  return String(promptValue);
}

function formatPlaceholder(pathStr, value) {
  // Explicit formatting rules
  if (pathStr === "order.total_before_tax" && typeof value === "number" && Number.isFinite(value)) {
    return `$${value.toFixed(2)}`;
  }

  // Default
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renderTemplate(template, ctx) {
  return String(template).replace(/\{([^}]+)\}/g, (_, rawPath) => {
    const p = String(rawPath).trim();
    const v = getPath(ctx, p);
    return formatPlaceholder(p, v);
  });
}

function resolvePromptText(promptMap, pid, state, ctx) {
  // Issue 1: category-specific bread option answers.
  // When _bread_opt_category is set, return targeted text for BREAD_OPTIONS_LIST.
  if (pid === "BREAD_OPTIONS_LIST" && state?._bread_opt_category) {
    const _cat = state._bread_opt_category;
    state._bread_opt_category = null; // consume so re-ask iteration gets full list if needed
    if (_cat === "wrap") return "Wraps come in white, wheat, tomato basil, or spinach.";
    if (_cat === "roll") return "Rolls come in plain, poppy seed, Portuguese, or knot roll.";
    if (_cat === "sub") return "Subs come on plain or seeded.";
  }
  // Defensive guard: ensure total_before_tax is computed before the total line is rendered.
  // Covers edge cases where the compute_total_before_tax emit did not fire or returned null.
  if (pid === "CLOSE_STATE_TOTAL_BEFORE_TAX" && state?.order && (state.order.total_before_tax == null || !Number.isFinite(state.order.total_before_tax))) {
    state.order.total_before_tax = computeTotalBeforeTax(state);
  }
  const raw = promptMap[pid];
  const selected = selectPromptVariant(raw, state, pid);
  return renderTemplate(selected, ctx);
}

// ---- Config indexing ----
function collectKeywordPhrasesFromRules(rulesJson) {
  const phrases = new Set();

  function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object") return;

    for (const [k, v] of Object.entries(node)) {
      if (k === "entities.keywords.contains_any" && Array.isArray(v)) {
        v.forEach((p) => typeof p === "string" && p.trim() && phrases.add(p.toLowerCase()));
      }
      walk(v);
    }
  }

  for (const r of rulesJson.rules || []) walk(r.when);
  return Array.from(phrases);
}

function buildMenuIndex(menus) {
  const items = [];
  for (const m of menus) {
    if (!m || !Array.isArray(m.items)) continue;
    for (const it of m.items) {
      if (!it || !it.id || !it.name) continue;

      // Normalize item names so user phrases like "ham and cheese" match "Ham & Cheese".
      const normName = normalizeText(it.name);

      // Also store a few lightweight variants to improve matching without redesigning config.
      // Example: "ham and cheese" <-> "ham cheese"
      const normNoAnd = normName.replace(/\band\b/g, " ").replace(/\s+/g, " ").trim();
      const normNoWith = normName.replace(/\bwith\b/g, " ").replace(/\s+/g, " ").trim();
      // Merge config-defined normVariants (from menu JSON) with computed ones.
      const configVariants = Array.isArray(it.normVariants) ? it.normVariants.map(v => normalizeText(String(v))) : [];
      const normVariants = Array.from(new Set([normName, normNoAnd, normNoWith, ...configVariants].filter(Boolean)));

      const tokens = new Set(normName.split(" ").filter(Boolean));
      for (const v of normVariants) for (const t of v.split(" ").filter(Boolean)) tokens.add(t);

      items.push({
        raw: it,
        menu_id: m.menu_id || null,
        id: it.id,
        name: it.name,
        normName,
        normVariants,
        tokens,
      });
    }
  }
  return items;
}


function allowBreakfastMenuItems(userText) {
  const norm = normalizeText(userText);
  const normLower = norm;
  return /\begg\b/.test(normLower) || /\bomelet\b/.test(normLower) || /\bfrench\s+toast\b/.test(normLower) || /\bbreakfast\b/.test(normLower);
}

function filterMenuIndexForUtterance(userText, menuIndex) {
  const allowBreakfast = allowBreakfastMenuItems(userText);
  const norm = normalizeText(userText);
  const normLower = norm;
  const allowEggyItems = /\begg\b/.test(normLower) || /\bomelet\b/.test(normLower) || /\bfrench\s+toast\b/.test(normLower);

  // Gate qualified named items (e.g., 'cold roast beef', 'baked ham') unless the user explicitly used the qualifier token.
  const allowColdItems = /\bcold\b/.test(normLower);
  const allowHotItems = /\bhot\b/.test(normLower);
  const allowBakedItems = /\bbaked\b/.test(normLower);

  return (Array.isArray(menuIndex) ? menuIndex : []).filter((it) => {
    if (!it || !it.raw) return false;

    const isBreakfastMenu = it.menu_id === "menu_breakfast" || it.raw.category === "breakfast_sandwich" || it.raw.category === "breakfast_platter";
    const isEggy = it.raw.contains_egg === true;

    if (isBreakfastMenu && !allowBreakfast) return false;
    if (isEggy && !allowEggyItems) return false;

      // Prevent qualified items from hijacking generic orders (e.g., 'Cold Roast Beef', 'Baked Ham & Cheese').
    // IMPORTANT: Some items have qualifier words in the *name* but are still allowed both hot/cold (menu naming artifact).
    // We only require explicit 'cold'/'hot' tokens when the item is actually temp-restricted.
    const itemNorm = it.normName || "";
    const itemHasCold = /\bcold\b/.test(itemNorm);
    const itemHasHot = /\bhot\b/.test(itemNorm);
    const itemHasBaked = /\bbaked\b/.test(itemNorm);

    const temps = Array.isArray(it.raw.allowed_temps) ? it.raw.allowed_temps : null;
    const isColdOnly = temps ? (temps.includes("cold") && !temps.includes("hot")) : false;
    const isHotOnly = temps ? (temps.includes("hot") && !temps.includes("cold")) : false;

    // Only gate cold/hot name-qualified items if the item is temp-restricted.
    if (itemHasCold && isColdOnly && !allowColdItems) return false;
    if (itemHasHot && isHotOnly && !allowHotItems) return false;

    // Baked is always a distinct item; require explicit 'baked' token to select it.
    if (itemHasBaked && !allowBakedItems) return false;

    return true;
  });
}

function scoreItemMatch(userNorm, userTokens, item) {
  const variants = Array.isArray(item.normVariants) && item.normVariants.length ? item.normVariants : [item.normName];
  // Prefer the LONGEST matching variant - so "turkey sandwich" (15 chars) beats "turkey" (6 chars)
  // when both are substrings of the user's phrase. This prevents deli.turkey from hijacking
  // "turkey on a roll" when lunch.turkey_sandwich is the correct match.
  let bestSubstringScore = -1;
  for (const v of variants) {
    if (v && userNorm.includes(v)) {
      const score = 1000 + (v.length * 10) + item.tokens.size;
      if (score > bestSubstringScore) bestSubstringScore = score;
    }
  }
  if (bestSubstringScore >= 0) return bestSubstringScore;
  let overlap = 0;
  for (const t of item.tokens) if (userTokens.has(t)) overlap++;
  return overlap;
}

function findBestMenuItem(userText, menuIndex) {
  const norm = normalizeText(userText);
  const normLower = norm;
  if (!norm) return null;
  const userTokens = new Set(norm.split(" ").filter(Boolean));

  let best = null;
  let bestScore = -999;

  for (const it of menuIndex) {
    const s = scoreItemMatch(norm, userTokens, it);
    if (s > bestScore) {
      bestScore = s;
      best = it;
    }
  }

  if (best && norm.includes(best.normName)) return best;
  if (bestScore >= 2) return best;
  // When the candidate list has been pre-filtered (e.g. by format or meat) and only
  // one option remains with at least one shared token, return it. This handles cases
  // like "turkey on a roll" where after deli.turkey is format-filtered out, only
  // lunch.turkey_sandwich remains but scores 1 (only "turkey" overlaps, "sandwich" doesn't).
  if (best && bestScore >= 1 && Array.isArray(menuIndex) && menuIndex.length === 1) return best;
  return null;
}

// ---- Minimal deterministic NLU ----
function detectIntent(text, state) {
  const norm = normalizeText(text);

  // When we are awaiting a salad selection, treat the next input as order continuation
  // so the menu match path can deterministically build the pending item.
  if (state?.phase === "AWAITING_SALAD_ITEM") {
    // Allow higher-priority cancel/finish handlers below to override if they match.
    // (We just avoid returning "unknown" for inputs like "tossed salad".)
    // NOTE: we do not early-return for empty input.
    if (String(text || "").trim().length > 0) {
      // Only fall through for explicit cancel/nevermind.
      if (!/\b(cancel|nevermind|never mind)\b/i.test(String(text || ""))) {
        return "place_order";
      }
    }
  }

  // Deli ambiguity clarification: when we asked "sandwich or sliced deli meat?",
  // interpret the next reply deterministically.
  if (state?.phase === "AWAITING_DELI_MODE" || state?.last_prompt_id === "ASK_DELI_MODE") {
    const sandwichSignals = /\b(sandwich|roll|sub|wrap|panini|hero|hoagie|wedge)\b/.test(norm);
    if (sandwichSignals) return "confirm_deli_mode_sandwich";

    // Weight signals (strict, pounds only, same lane as extractEntities)
    const _piDetectId = state?.order?.pending_item?.item_id || "";
    const _isSaladDetect = /^deli\.salad_/.test(_piDetectId);
    const weightSignals =
      /\b(lb|lbs|pound|pounds)\b/.test(norm) ||
      /\b(half\s+pound|quarter\s+pound)\b/.test(norm) ||
      /\b(\d+)\s*\/\s*(\d+)\b/.test(norm) ||
      /\b(one|two)\s+(lb|lbs|pound|pounds)\b/.test(norm) ||
      /\b(\d+(?:\.\d+)?)\s*(lb|lbs|pound|pounds)\b/.test(norm) ||
      /\bby\s+weight\b/.test(norm) ||
      (!_isSaladDetect && /\b(sliced?|deli\s+style|by\s+the\s+slice)\b/.test(norm));
    if (weightSignals) return "confirm_deli_mode_by_weight";
  }

  // If we're in an active item/order flow and we don't yet have a name, treat simple name-like replies as provide_name.
// Some configs ask for name before flipping order.active=true, so also allow pending_item.exists.
if (state.order && ((state.order.awaiting_name === true) || state.order.active === true || state.order?.pending_item?.exists === true) && state.order.customer_name == null) {
  const raw = String(text || "").trim();
  // Guard: avoid treating simple yes/no acknowledgements as names.
  // Deterministic: explicit token checks only.
  if (/^(yes|yep|yeah|no|nope|nah|ok|okay|sure)$/i.test(raw)) {
    // fall through
  } else {
  // Avoid misclassifying full sentences / orders as a name.
  const hasDigits = /\d/.test(raw);
  const hasOrderWords = /\b(get|have|want|order|sandwich|sub|wrap|roll|panini|and|with)\b/i.test(raw);
  const words = raw.split(/\s+/).filter(Boolean);
  const nameLike = words.length >= 1 && words.length <= 3 && !hasDigits && !hasOrderWords;
  if (nameLike) return "provide_name";
  }
}

  // Readback confirmation (prefer last_prompt_id so we don't depend on a state flag being perfectly in sync)
  if (state.last_prompt_id === "ASK_READBACK_CONFIRMATION" || (state.order && state.order.awaiting_readback_confirmation === true)) {
    const rawTrim = String(text || "").trim().toLowerCase();
    // Hard-guard: if the last prompt was the readback confirmation, a leading yes/no must be treated as confirmation.
    // Exception: "yes but/except X" or "looks good but X" are corrections, not pure affirmations.
    if (rawTrim.startsWith("yes") || rawTrim === "y" || rawTrim === "ye" || rawTrim === "ues" || rawTrim === "yse" ||
        /^(yea|yeh|ya)\b/.test(rawTrim)) {
      if (/^yes[,\s]+(but|except|however|although|wait)\b/i.test(rawTrim)) return "confirm_readback_no";
      return "confirm_readback_yes";
    }
    if (/^no\b/.test(rawTrim) || rawTrim === "n") return "confirm_readback_no";
    // "looks good except X" / "sounds good but remove Y" → correction, not affirmation
    if (/\b(looks good|sounds good|ok|okay|fine|perfect|great|all good)\b.*\b(but|except|however|although|wait)\b/i.test(rawTrim)) return "confirm_readback_no";
    if (/\b(yes|yep|yeah|yup|yea|yeh|ya|correct|sure|that[\s']?s right|that is right|sounds good|sounds right|looks good|looks right|that[\s']?s? (right|correct|it|all|good)|that is (right|correct|it|all|good)|ok|okay|all good|that[\s']?s it|that is it|that[\s']?s all|that is all|that[\s']?s correct|that is correct|perfect|good|that works|we[\s']?re good)\b/.test(norm)) return "confirm_readback_yes";
    // "nothing else" / "nothing to change" = affirmative (nothing wrong)
    if (/\bnothing\b/.test(norm) && !/\b(wrong|change|fix|edit|update|remove|different)\b/.test(norm)) return "confirm_readback_yes";
    if (/\b(no|nope|nah|not|wrong|change)\b/.test(norm)) return "confirm_readback_no";
    // Issue 1: correction commands without a leading "no" at readback
    // e.g. "can you remove the mayo", "take off the hot peppers", "actually make that a sub" → implicit confirm_readback_no
    if (/\b(remove|take off|take out|skip|drop|add|change|actually|make it|switch)\b/.test(norm)) return "confirm_readback_no";
    // "start over" / "restart" at readback = full reset — treat as correction so AWAITING_ORDER_CORRECTION handles it.
    if (/\bstart\s+over\b|\brestart\b|\bbegin\s+again\b/.test(norm)) return "confirm_readback_no";
  }

  // Order correction mode (after "what should I change?")
  if (state.last_prompt_id === "OKAY_WHAT_SHOULD_I_FIX" && state.order && state.order.active === true) {
    // Deterministic: format/bread corrections like "the second one is a sub" or "first one on a wrap"
    if (/\b(first|second|third|1st|2nd|3rd|fourth|4th)\b/.test(norm) && /\b(roll|sub|wrap|panini|toast|bread|mini)\b/.test(norm)) {
      return "modify_confirmed_item";
    }
  }

  // When the last prompt was the configured-defaults question, treat bare yes/no as accept/plain.
  if (state.last_prompt_id === "ASK_NAMED_ITEM_AS_IT_COMES") {
    if (/^(yes|yeah|yep|sure|ok|okay|sounds good|looks good|perfect|great|fine|that works?|works for me|that'?s? good|that'?s? fine|go ahead|please|yep that'?s? (it|fine|good)|absolutely|definitely|of course)$/i.test(norm) ||
        /\b(that\s+way|the\s+way\s+it\s+comes?|how\s+it\s+comes?|leave\s+it\s+like\s+that)\b/i.test(norm)) {
      return "accept_item_defaults";
    }
    // Bare "no" at defaults question = "no, just plain" — return no_condiments so the
    // no_condiments rule fires and finalizes the item with empty condiments.
    if (/^(no|no\.|nope|nah)$/.test(norm)) {
      return "no_condiments";
    }
    // Removal-language utterances at defaults question = "accept defaults except remove X".
    // CAPTURE_ACCEPT_ITEM_DEFAULTS_WITH_REMOVALS rule handles this when
    // intent=accept_item_defaults + entities.remove_condiments is populated.
    // NOTE: do not anchor with trailing \b after "no\s+\w+" — that would fail mid-word.
    if (/\bno\s+\w+/.test(norm) ||
        /\b(?:without|hold(?:\s+the)?|remove|take\s+off|take\s+out|leave\s+off|leave\s+out|skip\s+the|don'?t\s+(?:want|put|add|include))\b/i.test(norm)) {
      return "accept_item_defaults";
    }
  }

  // Prompt-driven yes/no intents
  if (state.order?.pending_item?.pressed_prompted === true && state.order?.pending_item?.pressed === null) {
    // Check pressed_no BEFORE pressed_yes to avoid "not pressed" matching "pressed" in pressed_yes.
    if (/\b(no|nope|nah)\b/.test(norm)
        || /\b(not\s+press(ed)?|no\s+press(ing)?|don'?t\s+press|without\s+press(ing)?|skip\s+press(ing)?)\b/.test(norm)) return "pressed_no";
    if (/\b(yes|yep|yeah|sure|ok|okay|press(ed)?|do\s+press)\b/.test(norm)) return "pressed_yes";
  }

  if (state.order?.pending_item?.meat_mode_prompted === true) {
    // Deterministic capture for the multi-meat mode prompt.
    // Accept explicit choices like "half and half" or "full portions of both".
    if (/\b(half\s*(and|n)\s*half|50\s*\/\s*50|fifty\s*fifty)\b/.test(norm)) return "confirm_meat_mode";
    if (/\b(full\s*portions?|both\s*meats?|all\s*of\s*both|full\s*of\s*both)\b/.test(norm)) return "confirm_meat_mode";
    // Back-compat: some prompts may be answered with a simple "yes".
    if (/\b(yes|yep|yeah|sure|ok|okay)\b/.test(norm)) return "confirm_meat_mode";
  }

  if (state.order?.pending_item?.double_meat_requested === true && state.order?.pending_item?.double_meat_confirmed === false) {
    if (/\b(yes|yep|yeah|sure|ok|okay)\b/.test(norm)) return "confirm_double_meat_yes";
    if (/\b(no|nope|nah)\b/.test(norm)) return "confirm_double_meat_no";
  }

  // basic store info
  if (/\bhour/.test(norm) || /\bopen\b/.test(norm) || /\bclose\b/.test(norm) || /\bclosing\b/.test(norm)) return "hours";

  // Accept item's configured defaults ("as it comes", "the usual", etc.)
  if (/\bas\s+it\s+comes?\b/i.test(norm) ||
      /\bhowever\s+it\s+comes?\b/i.test(norm) ||
      /\bjust\s+how\s+it\s+comes?\b/i.test(norm) ||
      /\bthe\s+usual\b/i.test(norm) ||
      /\bwhatever\s+(comes?\s+on\s+it|is\s+on\s+it|it\s+comes?\s+with)\b/i.test(norm) ||
      /\bkeep\s+the\s+defaults?\b/i.test(norm) ||
      /\bas[\s-]+is\b/i.test(norm) ||
      /\bleave\s+it\s+as[\s-]+is\b/i.test(norm) ||
      /\bthat'?s\s+fine\s+as[\s-]+is\b/i.test(norm) ||
      /\bstandard\s+is\s+fine\b/i.test(norm) ||
      /\bjust\s+make\s+it\s+(the\s+)?normal\s+way\b/i.test(norm) ||
      /\b(the\s+)?normal\s+way\s+is\s+fine\b/i.test(norm) ||
      /\bdo\s+it\s+(the\s+)?normal\s+way\b/i.test(norm) ||
      /\bmake\s+it\s+(the\s+)?normal\s+way\b/i.test(norm) ||
      /\bdefault\s+is\s+fine\b/i.test(norm) ||
      /\bjust\s+as\s+it\s+is\b/i.test(norm) ||
      /\bas\s+it\s+is\b/i.test(norm) ||
      /\bthe\s+way\s+it\s+comes?\b/i.test(norm) ||
      /\bhow\s+it\s+comes?\b/i.test(norm) ||
      /\bthat\s+way\s+is\s+(good|fine|perfect|great|works?)\b/i.test(norm) ||
      /\bleave\s+it\s+like\s+that\b/i.test(norm))
    return "accept_item_defaults";

  // Ask what ingredients/toppings come on the pending item or a named item
  if (/\bwhat\s+(comes?\s+on|does\s+it\s+come\s+with|is\s+normally\s+on|goes?\s+on|comes?\s+with\s+it)\b/i.test(norm) ||
      /\bwhat\s*'?s\s+(normally\s+on|on\s+it|included)\b/i.test(norm) ||
      /\bwhat\s+does\s+that\s+come\s+with\b/i.test(norm))
    return "menu_question";

  // Bread/roll options inquiry
  if (/\bwhat\s+(breads?|rolls?|wraps?|subs?)\s*(types?|options?|kinds?|choices?|do\s+you\s+have)?\b/i.test(norm) &&
      /\b(breads?|rolls?|wraps?|subs?)\b/i.test(norm) &&
      (/\btype|option|kind|choice|do\s+you\s+have\b/i.test(norm) || /\bwhat\b/i.test(norm)))
    return "ask_bread_options";

  // menu question
  if (/\bwhat (is|s)\b.*\bon\b/.test(norm) || /\bwhat comes on\b/.test(norm) || /\bingredients\b/.test(norm) || /\bwhat is in\b/.test(norm))
    return "menu_question";

  // modify/remove/restart
  if (/\bremove\b/.test(norm) || /\bdelete\b/.test(norm) || /\btake (it|that) off\b/.test(norm)) return "remove_item";
  if (/\brestart\b/.test(norm) || /\bstart over\b/.test(norm)) return "restart_item";
  if (/\bchange\b/.test(norm) || /\bactually\b/.test(norm) || /\binstead\b/.test(norm)) return "modify_confirmed_item";

  // Price questions (handled deterministically in runner)
  if (/\b(how much|price|cost|total|what do i owe)\b/.test(norm)) return "price_question";

  // Finish / checkout
  // Map finish phrases directly to finish_order so rules can complete the ticket deterministically.
  // Note: normalizeText strips apostrophes to spaces, so "that's" → "that s", "i'm" → "i m".
  // Patterns use [\s']? to match thats/that s/that's interchangeably.
  if (/\b(that[\s']?s it|that is it|thats it|thats?\s*al+|that it|that[\s']?s all|that is all|thats all|that all|thats everything|that[\s']?s everything|all set|all good|all done|done|finish|checkout|im done|i[\s']?m done|nope|nah|nothing else|no thanks|no thank you|no thx|that[\s']?ll do it|that will do it|that[\s']?ll do|i[\s']?m all set)\b/.test(norm)) return "finish_order";

  // A plain "no" is usually an "I'm done" signal in this ordering flow.
  // More specific yes/no intents (pressed_no, confirm_double_meat_no, etc.) are handled above.
  if (/^(no|no\.)$/.test(norm)) return "finish_order";

  // Explicit cancel / nevermind
  if (/\b(cancel|nevermind|never mind)\b/.test(norm)) return "nevermind_item";

  // order language (explicit)
  if (
    /\bcan i (get|have)\b/.test(norm) ||
    /\bi('d| would) like\b/.test(norm) ||
    /\bi want\b/.test(norm) ||
    /\bget me\b/.test(norm) ||
    /\bill take\b/.test(norm) ||
    /\border\b/.test(norm) ||
    /\blet me get\b/.test(norm) ||
    /\blemme get\b/.test(norm) ||
    /\bgimme\b/.test(norm) ||
    /\bgive me\b/.test(norm) ||
    /\bi('ll| will) have\b/.test(norm) ||
    /\bi('ll| will) do\b/.test(norm) ||
    /\bi('m| am) (gonna|going to)\b/.test(norm)
  )
    return "place_order";

  // Bare order detection (deterministic, based on reference lexicon + format/weight patterns)
  const lex = state?.lexicon;
  const tokens = norm.split(/\s+/).filter(Boolean);
  let foodSignals = 0;
  let hasFormat = false;
  let hasFood = false;
  let hasOrderHint = false;

  if (lex) {
    for (const t of tokens) {
      if (lex.formats?.has(t)) hasFormat = true;
      if (lex.order_hints?.has(t)) hasOrderHint = true;
      if (lex.meats?.has(t) || lex.cheeses?.has(t) || lex.breads?.has(t) || lex.toppings?.has(t) || lex.condiments?.has(t)) {
        foodSignals += 1;
        hasFood = true;
      }
    }
  } else {
    // Minimal fallback if lexicon isn't loaded
    if (/\b(roll|sub|wrap|panini)\b/.test(norm)) hasFormat = true;
    if (/\b(sandwich|sandwhich|sandwiche|sandwhitch|sandwitch|sanwich|sammich)\b/.test(norm)) hasOrderHint = true;
  }

  const hasWeight =
    /\b(lb|lbs|pound|pounds|oz|ounce|ounces|g|gram|grams|kg|kilo|kilos)\b/.test(norm) ||
    /\b(half|quarter)\s+pound\b/.test(norm) ||
    /\b\d+\s*\/\s*\d+\s*(lb|lbs|pound|pounds)\b/.test(norm) ||
    /\b\d+(?:\.\d+)?\s*(lb|lbs|pound|pounds|oz|ounce|ounces|g|gram|grams|kg)\b/.test(norm);

  // If we're mid-item, DO NOT automatically treat every reply as order continuation.
  // This was causing finish phrases like "no that's it" to be misread as starting another item.
  // Instead, only continue the order if we see actual order signals in the user's text.
  if (state?.order?.pending_item?.exists) {
    const hasExplicitOrderVerb =
      /\b(can i (get|have)|i\s*(?:'d| would)\s*like|i\s*want|get me|ill take|i('ll| will) have|give me|gimme|order)\b/.test(norm);
    const hasWith = /\bwith\b/.test(norm);
    const hasFormatSignal = /\b(roll|sub|wrap|panini)\b/.test(norm);
    const tokenList = norm.split(/\s+/).filter(Boolean);
    const hasLexFoodSignal =
      !!state?.lexicon &&
      tokenList.some(
        (t) =>
          state.lexicon.meats?.has(t) ||
          state.lexicon.cheeses?.has(t) ||
          state.lexicon.breads?.has(t) ||
          state.lexicon.toppings?.has(t) ||
          state.lexicon.condiments?.has(t)
      );

    // If there are any concrete order signals, treat as an order continuation.
    if (hasExplicitOrderVerb || hasWith || hasFormatSignal || hasLexFoodSignal || hasWeight) return "place_order";

    // Otherwise, let it fall through (finish/no/cancel/etc. are handled above).
  }

  // Weight-based order: "1/2 pound of turkey"
  if (hasWeight && hasFood) return "place_order";

  // Sandwich-style bare order: "ham and cheese", "salami sandwich"
  if (foodSignals >= 2) return "place_order";
  // Non-committal hint + at least one food signal: "ham sandwhich", "turkey sandwich"
  if (foodSignals >= 1 && hasOrderHint) return "place_order";
  if (foodSignals >= 1 && hasFormat) return "place_order";
  if (foodSignals >= 1 && hasOrderHint) return "place_order";

  // Quantity + generic food category: "two sandwiches", "three subs", "2 wraps" → treat as order intent so
  // downstream mockNLU can clarify what kind rather than returning off-topic.
  if (/\b(one|two|three|four|five|six|seven|eight|nine|\d+)\s+(sandwiches?|subs?|wraps?|rolls?|heroes?|hoagies?|paninis?|wedges?|items?)\b/i.test(norm)) {
    return "place_order";
  }

  // Simple acknowledgement intent: used after constraint notifications ("That only comes small.", "I’ll make it hot.", etc.)
  // Deterministic token checks only.
  const rawTrimAck = String(text || "").trim().toLowerCase();
  if (/^(ok|okay|k|alright|all right|sure|sounds good|got it|fine|no problem|thats fine|that's fine)$/.test(rawTrimAck)) {
    return "ack";
  }

  return "unknown";
}

function extractEntities(text, keywordPhrases, breadIndex, condimentIndex, cheeseIndex, meatIndex, addonIndex) {
  const raw = correctMenuTypos(String(text || ""));
  const normLower = raw.toLowerCase();
  const keywords = [];

  for (const phrase of keywordPhrases) {
    const ph = String(phrase || "").toLowerCase().trim();
    if (!ph) continue;
    // Single-token phrases must match whole words to avoid substring collisions (e.g., "pop" in "poppy").
    if (!/\s/.test(ph)) {
      const re = new RegExp("\\b" + escapeRegExp(ph) + "\\b", "i");
      if (re.test(normLower)) keywords.push(ph);
    } else {
      if (normLower.includes(ph)) keywords.push(ph);
    }
  }
  for (const t of normalizeText(raw).split(" ").filter(Boolean)) {
    if (!keywords.includes(t)) keywords.push(t);
  }

  const entities = {
    customer_name: null,
    target_index: null,
    condiments: [],
    remove_condiments: [],
    meats: [],
    requested_temp: null,
    bread_type: null,
    meat_mode: null,
    weight_lbs: null,
    addons: null,
    keywords,
    dish_size: null,
    cheese: null,
    toasted: false,
    heated: false,
  };

  // Multi-meat mode selection (deterministic).
  // Used when the system asks: "half and half, or full portions of both?"
  if (/\b(half\s*(and|n)\s*half|50\s*\/\s*50|fifty\s*fifty)\b/.test(normLower)) {
    entities.meat_mode = "half_half";
  } else if (/\b(full\s*portions?|both\s*meats?|all\s*of\s*both|full\s*of\s*both)\b/.test(normLower)) {
    entities.meat_mode = "full";
  }

  // Temperature intent (deterministic).
  // "hot" / "cold" are also legitimate topping aliases (e.g., "hot" -> hot peppers),
  // so we only lock temperature when the user clearly requests temp.
  // Temperature intent (deterministic).
  // "hot" / "cold" are also legitimate condiment/topping aliases (e.g., "hot" -> hot peppers).
  // We only lock temperature when the user clearly requests temp OR when hot/cold directly qualifies
  // a known meat phrase (e.g., "hot ham", "cold roast beef").
  // Category-level: applies to all meats listed in reference.json (no one-off IDs).
  const baseTempLocked =
    /^\s*(hot|cold)\s*$/i.test(raw) ||
    /\bmake\s+(it|that)\s+(hot|cold)\b/i.test(raw) ||
    /\b(serve|heat)\s+(it|that)\s+(hot|cold)\b/i.test(raw);

  let meatQualifiedTempLocked = false;
  const mEntries = Array.isArray(meatIndex) ? meatIndex : [];
  // Meat mention extraction (deterministic, whole-token).
  // Used for correction-phase modifications and explicit add-on meats.
  if (mEntries.length) {
    const n = " " + normalizeText(raw) + " ";
    for (const e of mEntries) {
      if (!e || !e.norm || !e.id) continue;
      if (n.includes(" " + e.norm + " ")) entities.meats.push(e.id);
    }
  }

  if (mEntries.length && /\b(hot|cold)\b/i.test(raw)) {
    const n = " " + normalizeText(raw) + " ";
    for (const e of mEntries) {
      if (!e || !e.norm) continue;
      // Whole-token boundary: " hot <meat> " or " cold <meat> "
      if (n.includes(" hot " + e.norm + " ") || n.includes(" cold " + e.norm + " ")) {
        meatQualifiedTempLocked = true;
        break;
      }
    }
  }

  const tempLocked = baseTempLocked || meatQualifiedTempLocked;

  const normTextForPhrases = " " + normalizeText(raw) + " ";
  // Pepper-family explicit phrase detection (deterministic, whole-token).
  // Hot/Roasted Red Peppers must be ordered by explicit name; generic "peppers" is reserved for Sweet Peppers.
  const hasHotPeppersPhrase =
    normTextForPhrases.includes(" hot peppers ") || normTextForPhrases.includes(" hot pepper ");
  const hasRoastedRedPeppersPhrase =
    normTextForPhrases.includes(" roasted red peppers ") || normTextForPhrases.includes(" roasted red pepper ");
  const hasSweetPeppersExplicit =
    normTextForPhrases.includes(" sweet peppers ") || normTextForPhrases.includes(" sweet pepper ") ||
    normTextForPhrases.includes(" bell peppers ") || normTextForPhrases.includes(" bell pepper ") ||
    normTextForPhrases.includes(" green peppers ") || normTextForPhrases.includes(" green pepper ") ||
    normTextForPhrases.includes(" red peppers ") || normTextForPhrases.includes(" red pepper ");


  if (tempLocked) {
    if (/\bhot\b/.test(normLower) && !/\bcold\b/.test(normLower)) entities.requested_temp = "hot";
    if (/\bcold\b/.test(normLower) && !/\bhot\b/.test(normLower)) entities.requested_temp = "cold";
  } else {
    // Do not treat "hot"/"cold" as a temperature request when it is part of an explicit topping phrase (e.g., "hot peppers").
    if (!hasHotPeppersPhrase && /\bhot\b/.test(normLower)) entities.requested_temp = "hot";
    if (/\bcold\b/.test(normLower)) entities.requested_temp = "cold";
  }

  const breadHit = inferBreadTypeFromText(raw, breadIndex);
  if (breadHit) entities.bread_type = breadHit;

  // Prep-style modifiers: "toasted" / "heated" are stored separately from bread_type.
  // "toasted" means the assembled sandwich is run through a toaster/press.
  // Must NOT be confused with the format "toast" (bread.white_toast etc).
  // These flags are applied to pending_item.toasted / pending_item.meat_warmed at build time.
  if (/\btoasted\b/.test(normLower)) entities.toasted = true;
  if (/\bheated\b/.test(normLower)) entities.heated = true;

  // Weight parsing (deterministic).
  // Supports: half pound, quarter pound, 1/2 lb, 1 lb, 1.5 lb, one pound, two pounds.
  // Notes:
  // - We only parse pounds (lb/lbs/pound/pounds) here; other units are not supported in this kiosk flow.
  // - This parser is intentionally strict (no fuzzy matching).
  let weight = null;

  // Fractions: 1/2 lb
  const wf = normLower.match(/\b(\d+)\s*\/\s*(\d+)\s*(?:a|an)?\s*(lb|lbs|pound|pounds)\b/);
  if (wf) {
    const num = Number(wf[1]);
    const den = Number(wf[2]);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) weight = num / den;
  }

  // "N and a half/quarter" compound weight expressions.
  // MUST come BEFORE bare "half/quarter pound" check so "one and a half pounds" → 1.5 not 0.5.
  // Covers: "a pound and a half", "one and a half pounds", "one and a quarter pounds", etc.
  if (weight == null) {
    if (/\b(?:a|one|1)\s+(?:lb|lbs|pound|pounds)\s+and\s+a\s+half\b/.test(normLower)) weight = 1.5;
    else if (/\bone\s+and\s+a\s+half\s+(?:lb|lbs|pound|pounds)\b/.test(normLower)) weight = 1.5;
    else if (/\bpound\s+and\s+a\s+half\b/.test(normLower)) weight = 1.5;
    else if (/\bone\s+and\s+a\s+half\b/.test(normLower)) weight = 1.5;
    else if (/\bone\s+and\s+a\s+quarter\s+(?:lb|lbs|pound|pounds)\b/.test(normLower)) weight = 1.25;
    else if (/\bone\s+and\s+a\s+quarter\b/.test(normLower)) weight = 1.25;
    else if (/\bone\s+and\s+three\s+quarters?\s+(?:of\s+(?:a\s+)?)?(?:lb|lbs|pound|pounds)\b/.test(normLower)) weight = 1.75;
    else if (/\bone\s+and\s+three\s+quarters?\b/.test(normLower)) weight = 1.75;
  }

  // Word forms: half/quarter pound (and lb variants).
  // Group 6: Also handle "a half pound", "a quarter pound", "three quarter pound", "three quarters".
  // NOTE: compound "N and a half/quarter" checked above first, so these only fire for bare forms.
  if (weight == null) {
    // Accept common natural variants customers say.
    // Examples: "half pound", "a half pound", "half of a pound", "a quarter pound", "three quarter pound".
    const _wLbUnit = "(?:lb|lbs|pound|pounds)";
    if (new RegExp(`\\b(?:a\\s+)?half\\s+(?:of\\s+)?(?:a\\s+)?${_wLbUnit}\\b`).test(normLower)) weight = 0.5;
    else if (new RegExp(`\\b(?:a\\s+)?half\\s+${_wLbUnit}\\b`).test(normLower)) weight = 0.5;
    else if (new RegExp(`\\bthree\\s+(?:quarter|quarters?)\\s+(?:of\\s+)?(?:a\\s+)?${_wLbUnit}\\b`).test(normLower)) weight = 0.75;
    else if (new RegExp(`\\b(?:a\\s+)?quarter\\s+(?:of\\s+)?(?:a\\s+)?${_wLbUnit}\\b`).test(normLower)) weight = 0.25;
    else if (new RegExp(`\\b(?:a\\s+)?half\\s+(?:a\\s+)?${_wLbUnit}\\b`).test(normLower)) weight = 0.5;
  }

  // Bare word forms when already being asked for weight (common customer replies).
  // Deterministic: only accept stand-alone "half"/"quarter" (optionally with "a" and/or "please").
  // We do NOT interpret "half and half" as weight.
  if (weight == null) {
    const t = normLower.trim();
    if (!/\b(and|n)\b/.test(t)) {
      if (/^(a\s+)?half(\s+please)?$/.test(t)) weight = 0.5;
      else if (/^(a\s+)?quarter(\s+please)?$/.test(t)) weight = 0.25;
      else if (/^(three\s+quarters?|3\/4)(\s+please)?$/.test(t)) weight = 0.75;
    }
  }

  // "a pound" / "a lb" = 1 lb
  if (weight == null) {
    if (/\ba\s+(lb|lbs|pound|pounds)\b/.test(normLower)) weight = 1;
  }

  // Word numbers: one/two/three pounds
  if (weight == null) {
    const ww = normLower.match(/\b(one|two|three)\s+(lb|lbs|pound|pounds)\b/);
    if (ww) {
      if (ww[1] === "one") weight = 1;
      if (ww[1] === "two") weight = 2;
      if (ww[1] === "three") weight = 3;
    }
  }

  // Numeric pounds: 1 lb, 1.5 pounds
  if (weight == null) {
    const wn = normLower.match(/\b(\d+(?:\.\d+)?)\s*(lb|lbs|pound|pounds)\b/);
    if (wn) weight = Number(wn[1]);
  }

  if (weight != null && Number.isFinite(weight)) entities.weight_lbs = weight;


  // Dish size parsing (deterministic).
  // Captures "small" / "large" tokens for dish-based items (salads/sides).
  if (/\blarge\b/.test(normLower) && !/\bextra\s+large\b/.test(normLower)) entities.dish_size = "large_dish";
  if (/\bsmall\b/.test(normLower)) entities.dish_size = "small_dish";

  // Add-on parsing (deterministic, exact phrase match only).
  // We only capture add-ons when there is an explicit add-on lead-in token
  // (with/add/plus/extra/scoop) to avoid misclassifying base items.
  if (Array.isArray(addonIndex) && addonIndex.length) {
    const addonLeadIn = /\b(with|add|added|plus|extra|scoop)\b/.test(normLower);
    if (addonLeadIn) {
      const n = " " + normalizeText(raw) + " ";
      const found = [];
      for (const e of addonIndex) {
        if (!e || !e.id || !e.norm) continue;
        const needle = " " + e.norm + " ";
        if (n.includes(needle)) found.push(e.id);
      }
      if (found.length) {
        // De-dupe deterministically
        entities.addons = Array.from(new Set(found));
      }
    }
  }

  const cEntries = Array.isArray(condimentIndex) ? condimentIndex : [];
  if (cEntries.length) {
    const n = " " + normalizeText(raw) + " ";
    // Parm-sandwich guardrail:
    // Do NOT treat "parm/parmesan" inside a sandwich name ("chicken parm", "chicken parmesan") as a condiment request.
    // Allow it only when the user uses an explicit lead-in (with/add/extra/plus).
    const explicitParmCondimentRequest =
      /\b(with|add|extra|plus)\s+(parmesan|parm)\b/i.test(raw) ||
      /\b(parmesan|parm)\s+cheese\b/i.test(raw);
    const parmInSandwichName =
      /\b(chicken|eggplant|meatball|sausage)\s+(parm|parmesan|parmigiana)\b/i.test(raw);

    // Longest-match-wins, exclusive resolution.
    // This prevents overlaps like "hot peppers" also matching "peppers" (sweet peppers).
    // Deterministic: we only match explicit aliases/synonyms from reference.json (no fuzzy matching).
    const matches = [];
    for (const e of cEntries) {
      if (!e || !e.id || !e.norm) continue;

      // Category-level guard for "peppers" ambiguity:
      // When a user explicitly says "hot peppers", we must NOT also match the generic
      // single-token alias "peppers" (which maps to Sweet Peppers) from reference.json.
      // This keeps behavior deterministic and avoids "hot peppers" being interpreted as Sweet Peppers.
      // (No fuzzy matching; whole-token checks only.)
      if ((e.norm === "peppers" || e.norm === "pepper") && (n.includes(" hot peppers ") || n.includes(" hot pepper "))) {
        continue;
      }
      // If the user clearly requested temperature (e.g., "make it hot" or just "hot"),
      // do not allow a single-word alias "hot"/"cold" to match a condiment/topping.
      // This is category-level and applies to any condiment/topping that uses these words.
      if (tempLocked && (e.norm === "hot" || e.norm === "cold")) continue;
      // Parm-sandwich masking: skip parmesan/parm condiment matches when it is part of the item name.
      if (!explicitParmCondimentRequest && parmInSandwichName && e.id === "condiment.parmesan") continue;
      // Onion-rings masking: "onion" is a condiment alias but must not match when the phrase
      // "onion rings" appears in the utterance (onion rings is a menu item, not a topping request).
      if ((e.norm === "onion" || e.norm === "onions") && /\bonion\s+rings?\b/i.test(raw)) continue;
      const needle = " " + e.norm + " ";
      let from = 0;
      while (true) {
        const idx = n.indexOf(needle, from);
        if (idx === -1) break;
        // IMPORTANT: we search using a space-padded needle to enforce whole-token boundaries.
        // For overlap resolution, we must measure spans on the *actual phrase* only (exclude padding),
        // otherwise adjacent matches like "lettuce" + "tomato" would appear to overlap
        // because they share the boundary space.
        const actualStart = idx + 1;
        const actualEnd = actualStart + e.norm.length;
        matches.push({
          id: e.id,
          norm: e.norm,
          start: actualStart,
          end: actualEnd,
          len: e.norm.length,
        });
        from = idx + 1;
      }
    }

    // Prefer longer phrases; tie-breaker: earlier occurrence; final tie-breaker: stable id ordering.
    matches.sort((a, b) => {
      if (b.len !== a.len) return b.len - a.len;
      if (a.start !== b.start) return a.start - b.start;
      return String(a.id).localeCompare(String(b.id));
    });

    const selected = [];
    const overlaps = (m, s) => !(m.end <= s.start || m.start >= s.end);
    for (const m of matches) {
      if (selected.some((s) => overlaps(m, s))) continue;
      selected.push(m);
    }

    // Fix 1: Bread-name bleed guard.
    // If the matched bread type's synonyms contain a condiment's norm text (e.g. "tomato" in
    // "tomato basil wrap", "spinach" in "spinach wrap"), that condiment is bleed from the bread
    // name — not a user condiment request. Remove it from selected.
    if (entities.bread_type && Array.isArray(breadIndex)) {
      const _breadPhrases = breadIndex
        .filter(e => e && e.id === entities.bread_type)
        .map(e => " " + e.norm + " ");
      if (_breadPhrases.length) {
        for (let _bi = selected.length - 1; _bi >= 0; _bi--) {
          const _bm = selected[_bi];
          const _needle = " " + _bm.norm + " ";
          if (_breadPhrases.some(bp => bp.includes(_needle))) {
            selected.splice(_bi, 1);
          }
        }
      }
    }

    // Per-position negative modifier classification.
    // For each matched condiment, scan the padded normalised text before its position for a
    // removal verb (no, without, remove, take off, …) or a positive connector (add, with, extra, …).
    // This correctly handles mixed utterances like:
    //   "turkey no cheese"           → cheese = removal
    //   "lettuce and tomato no mayo" → lettuce+tomato = additions, mayo = removal
    //   "remove lettuce and tomato"  → both = removals (neg propagates through "and")
    //   "no mayo add extra mustard"  → mayo = removal, mustard = addition
    // Operates on the space-padded normalised string `n` (same variable used during matching).
    const _negVerbRe = /\b(?:no|without(?:\s+the)?|hold(?:\s+the)?|remove(?:\s+the)?|take\s+off(?:\s+the)?|take\s+out(?:\s+the)?|get\s+rid\s+of|can\s+you\s+take(?:\s+(?:off|out))?|drop\s+the|leave\s+off(?:\s+the)?|leave\s+out(?:\s+the)?|skip\s+the|don'?t\s+(?:want|put|add|include)|minus)\b/gi;
    // "just" and "only" reset the polarity after a negative verb: "no cheese just lettuce" → lettuce is positive.
    const _posVerbRe = /\b(?:with|add(?:ed)?|plus|extra|scoop|just|only)\b/gi;
    const _posMatches = [];
    const _negMatches = [];
    // Fix Part4-1: Process condiments left-to-right so a neg verb is consumed by its first target.
    // "no cheese lettuce tomato" → cheese=removal, lettuce/tomato=addition (space ≠ conjunction).
    // Negation extends only through explicit "and"/"or": "remove lettuce and tomato" → both removed.
    const _selectedSorted = selected.slice().sort((a, b) => a.start - b.start);
    const _consumedNegAbsPos = new Set(); // absolute positions in n of already-consumed neg verbs
    let _negChainActive = false;
    let _negChainVerbAbsPos = -1;
    let _negChainLastCondEnd = -1;
    for (const m of _selectedSorted) {
      const _bStart = Math.max(0, m.start - 80);
      const before = n.slice(_bStart, m.start);
      let lastNegPos = -1, lastNegAbsPos = -1, lastNegMatchLen = 0;
      let _tmp;
      _negVerbRe.lastIndex = 0;
      while ((_tmp = _negVerbRe.exec(before)) !== null) {
        lastNegPos = _tmp.index;
        lastNegAbsPos = _bStart + _tmp.index;
        lastNegMatchLen = _tmp[0].length;
      }
      let lastPosPos = -1;
      _posVerbRe.lastIndex = 0;
      while ((_tmp = _posVerbRe.exec(before)) !== null) lastPosPos = _tmp.index;
      let isNeg = false;
      if (lastNegPos >= 0 && lastNegPos > lastPosPos) {
        if (_consumedNegAbsPos.has(lastNegAbsPos)) {
          // This neg verb already targeted a prior condiment.
          // Only extend negation if still in active chain and gap is a conjunction.
          if (_negChainActive && lastNegAbsPos === _negChainVerbAbsPos) {
            const _gap = n.slice(_negChainLastCondEnd, m.start);
            isNeg = /\b(and|or)\b/i.test(_gap);
          }
          if (!isNeg) _negChainActive = false;
        } else {
          // Fresh neg verb — check if it targets an intermediate non-condiment word first.
          // e.g., "no cheese lettuce" → neg verb "no" directly precedes "cheese" (not in condiment
          // scanner), so it's spent on "cheese". "lettuce" should be positive.
          // Strategy: look at the text between the neg verb's end and this condiment's start.
          // If there's any real word (2+ letters) in that gap, the neg verb was targeting that
          // intermediate word (e.g., "cheese"), not this condiment → condiment is positive.
          const _negVerbEndAbs = lastNegAbsPos + lastNegMatchLen;
          const _gapToCondiment = n.slice(_negVerbEndAbs, m.start).trim();
          // Strip leading conjunctions/fillers to find the real first word after the neg verb.
          const _gapStripped = _gapToCondiment.replace(/^(the|a|an|and|or|,|\s)+/i, "").trim();
          if (_gapStripped.length > 0) {
            // Intermediate non-condiment word exists — neg verb is spent on it, condiment is positive.
            _consumedNegAbsPos.add(lastNegAbsPos);
            isNeg = false;
          } else {
            isNeg = true;
            _consumedNegAbsPos.add(lastNegAbsPos);
          }
        }
      } else {
        _negChainActive = false;
      }
      if (isNeg) {
        _negMatches.push(m);
        _negChainActive = true;
        _negChainVerbAbsPos = lastNegAbsPos;
        _negChainLastCondEnd = m.end;
      } else {
        _posMatches.push(m);
      }
    }
    if (_posMatches.length) {
      entities.condiments = Array.from(new Set(_posMatches.map((m) => m.id)));
    }
    if (_negMatches.length) {
      entities.remove_condiments = Array.from(new Set(_negMatches.map((m) => m.id)));
    }
    // Pepper-family determinism (positive-match context only):
    // - "hot peppers" → ensure topping.hot_peppers is in condiments, not sweet_peppers.
    // - "roasted red peppers" → ensure topping.roasted_red_peppers is in condiments.
    if (_posMatches.length) {
      let c = Array.isArray(entities.condiments) ? entities.condiments.slice() : [];
      const set = new Set(c);
      if (hasHotPeppersPhrase && _posMatches.some(m => m.id === "topping.hot_peppers")) {
        set.add("topping.hot_peppers");
        if (!hasSweetPeppersExplicit) set.delete("topping.sweet_peppers");
      }
      if (hasRoastedRedPeppersPhrase && _posMatches.some(m => m.id === "topping.roasted_red_peppers")) {
        set.add("topping.roasted_red_peppers");
        if (!hasSweetPeppersExplicit) set.delete("topping.sweet_peppers");
      }
      entities.condiments = Array.from(set);
    }

    const matchedNorms = new Set(selected.map((m) => m.norm));

    // Temperature disambiguation:
    // If "hot"/"cold" appears only inside a matched condiment phrase (e.g., "hot peppers"),
    // do NOT treat it as a temp request.
    // If temperature was explicitly requested (tempLocked), do not override it here.
    if (!tempLocked && matchedNorms.size) {
      let tempText = " " + normalizeText(raw) + " ";
      for (const p of matchedNorms) {
        // Escape regex metacharacters safely
        const esc = String(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const reP = new RegExp(`\\b${esc}\\b`, "g");
        tempText = tempText.replace(reP, " ");
      }
      const hasHot = /\bhot\b/.test(tempText);
      const hasCold = /\bcold\b/.test(tempText);
      if ((hasHot && !hasCold) || (hasCold && !hasHot)) {
        entities.requested_temp = hasHot ? "hot" : "cold";
      } else {
        entities.requested_temp = null;
      }
    }

  }

  
const chEntries = Array.isArray(cheeseIndex) ? cheeseIndex : [];
if (chEntries.length) {
  // Cheese capture is deterministic and alias-driven. Guard against "parm" being captured from the sandwich name
  // (e.g., "chicken parm") unless the user explicitly requests parmesan via a lead-in ("with/add/extra/plus parm").
  let nCheese = " " + normalizeText(raw) + " ";
  const explicitParmCheeseRequest =
    /\b(with|add|extra|plus)\s+(parmesan|parm)\b/i.test(raw) ||
    /\b(parmesan|parm)\s+cheese\b/i.test(raw);

  if (!explicitParmCheeseRequest) {
    // Mask parm/parmesan tokens that are part of a "parm" sandwich name (e.g., "chicken parm", "chicken parmesan").
    // This prevents cheese capture from firing unless the user explicitly requests parmesan via a lead-in.
    // Deterministic: whole-token phrase replacement only (no fuzzy matching).
    nCheese = nCheese
      .replace(/ (chicken|eggplant|meatball|sausage)\s+parmigiana /g, " $1 parm_sandwich ")
      .replace(/ (chicken|eggplant|meatball|sausage)\s+parmesan /g, " $1 parm_sandwich ")
      .replace(/ (chicken|eggplant|meatball|sausage)\s+parm /g, " $1 parm_sandwich ");
  }
  const found = new Set();
  for (const e of chEntries) {
    if (!e || !e.id || !e.norm) continue;
    const needle = " " + e.norm + " ";
    if (nCheese.includes(needle)) found.add(e.id);
  }
  if (found.size === 1) entities.cheese = Array.from(found)[0];
}

// Ordinal targeting for correction commands (deterministic)
  // Examples: "the second one is a sub", "1st one on a wrap"
  let targetIndex = null;
  if (/\b(first|1st)\b/.test(normLower)) targetIndex = 0;
  else if (/\b(second|2nd)\b/.test(normLower)) targetIndex = 1;
  else if (/\b(third|3rd)\b/.test(normLower)) targetIndex = 2;
  else if (/\b(fourth|4th)\b/.test(normLower)) targetIndex = 3;
  if (targetIndex != null) entities.target_index = targetIndex;

return entities;
}

// Name-based item targeting for order correction commands.
// Finds the single order item whose name contains key words from the user's input.
// Returns the item index if exactly one item matches, null otherwise (ambiguous or no match).
function inferTargetItemIndex(items, text) {
  if (!Array.isArray(items) || items.length <= 1) return null;
  const norm = (text || "").toLowerCase();
  const matches = [];
  items.forEach((it, idx) => {
    if (!it || !it.name) return;
    const name = it.name.toLowerCase();
    const words = name.split(/[\s,&]+/).filter(
      (w) => w.length > 2 && !/^(and|the|with|on|a|an|of|in|at)$/.test(w)
    );
    if (words.some((w) => norm.includes(w))) matches.push(idx);
  });
  return matches.length === 1 ? matches[0] : null;
}

function getLocalHHMM(timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "America/Chicago",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const hh = parts.find((p) => p.type === "hour")?.value;
    const mm = parts.find((p) => p.type === "minute")?.value;
    if (hh && mm) return `${hh}:${mm}`;
  } catch {
    // ignore
  }
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}


function getLocalWeekdayKey(timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "America/Chicago",
      weekday: "long",
    }).formatToParts(new Date());
    const wd = parts.find((p) => p.type === "weekday")?.value;
    if (wd) return String(wd).toLowerCase();
  } catch {
    // ignore
  }
  const d = new Date();
  const map = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  return map[d.getDay()];
}

function computeIsOpenNow(hoursObj) {
  // hoursObj is expected to be: { timezone, weekly_hours }
  const tz = hoursObj?.timezone || "America/Chicago";
  const weekly = hoursObj?.weekly_hours || {};
  const dayKey = getLocalWeekdayKey(tz);
  const today = weekly?.[dayKey];
  if (!today) return null;
  if (today.closed === true) return false;

  const open = today.open;
  const close = today.close;
  if (!isHHMM(open) || !isHHMM(close)) return null;

  const nowHHMM = getLocalHHMM(tz);
  if (!isHHMM(nowHHMM)) return null;

  const nowM = hhmmToMinutes(nowHHMM);
  const openM = hhmmToMinutes(open);
  const closeM = hhmmToMinutes(close);

  // Treat open as inclusive, close as exclusive.
  return nowM >= openM && nowM < closeM;
}

const BUSINESS_KEYWORDS = {
  // Existing
  OPEN_NOW: ["open now", "open right now", "currently open", "are you open"],
  HOURS: ["hours", "opening", "closing", "open", "close"],
  DELIVERY: ["delivery", "deliver", "do you deliver"],
  LOCATION: ["where are you", "address", "located", "location"],
  PHONE: ["phone", "number", "telephone", "call"],

  // Amenities / policies / services
  WIFI: ["wifi", "wi-fi"],
  PAYMENT: ["payment", "pay", "credit", "debit", "apple pay", "cash"],
  DINE_IN: ["dine in", "dine-in", "eat in", "sit in", "indoor seating", "seating"],
  TAKEOUT: ["takeout", "to go", "to-go", "pickup", "pick up"],
  ONLINE_ORDERING: ["online order", "online ordering", "order online", "website order"],
  CATERING: ["catering", "cater", "tray", "party platter", "office event"],
  PARKING: ["parking", "park"],
  RESTROOMS: ["restroom", "restrooms", "bathroom", "bathrooms"],
  ACCESSIBILITY: ["wheelchair", "accessible", "accessibility", "handicap"],
  VEGETARIAN: ["vegetarian", "veggie"],
  VEGAN: ["vegan"],
  GLUTEN_FREE: ["gluten free", "gluten-free", "gf"],
  KIDS_MENU: ["kids menu", "kids' menu", "children's menu", "children menu"],
  LOYALTY: ["loyalty", "rewards", "points program"],

  // Menu / experience
  MENU_OVERVIEW: ["what do you have", "what do you serve", "what kind of food", "menu", "what's on the menu", "what is on the menu"],
  BEST_SELLERS: ["best seller", "best sellers", "popular", "most popular", "what do you recommend", "recommendation"],
  ORDER_METHODS: ["how do i order", "how to order", "order method", "order methods"],
  WAIT_TIME: ["wait time", "how long is the wait", "how long does it take", "busy"],
  PRICE: ["price", "pricing", "how much", "average price"],

  // Customization + breakfast cutoff questions (question-like required)
  CUSTOMIZE: ["customize", "customise", "build my own", "build your own", "custom sandwich", "make a custom", "can i build my own", "can i customize", "can i make a custom"],
  BREAKFAST_END: ["breakfast end", "breakfast ends", "breakfast cutoff", "breakfast cut off", "breakfast stop", "stop serving breakfast", "breakfast over"],

  // Policies
  ALLERGEN: ["allergen", "allergy", "nut", "dairy", "gluten"],
  REFUND: ["refund", "replacement", "wrong order"],
  SAFETY: ["sanitation", "health code", "safety"],
  RAW_FOOD: ["raw food", "undercooked", "raw meat"],
};

function isQuestionLike(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  if (t.includes("?")) return true;
  return /^(what|when|where|do|does|are|is|can|could|will|how)\b/.test(t);
}

function includesAny(text, phrases) {
  const t = String(text || "").toLowerCase();
  return (phrases || []).some((p) => t.includes(String(p).toLowerCase()));
}


function humanJoin(items) {
  const arr = Array.isArray(items) ? items.filter((x) => x != null && String(x).trim() !== "").map((x) => String(x).trim()) : [];
  if (arr.length === 0) return "";
  if (arr.length === 1) return arr[0];
  if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
  return `${arr.slice(0, -1).join(", ")}, and ${arr[arr.length - 1]}`;
}

function paymentMethodsHuman(methods) {
  const map = {
    cash: "cash",
    credit_card: "credit cards",
    debit_card: "debit cards",
    apple_pay: "Apple Pay",
  };
  const arr = Array.isArray(methods) ? methods.map((m) => map[m] || String(m)) : [];
  return humanJoin(arr);
}

function parkingDetails(parking) {
  if (!parking || parking.available !== true) return "";
  const cost = parking.cost ? String(parking.cost) : "";
  const locs = Array.isArray(parking.locations) ? parking.locations.map((x) => String(x).replace(/_/g, " ")) : [];
  const locText = locs.length ? humanJoin(locs) : "";
  const parts = [];
  if (cost) parts.push(cost);
  if (locText) parts.push(`locations: ${locText}`);
  return parts.join(", ");
}

function cateringDetails(catering) {
  if (!catering || catering.available !== true) return "";
  const notice = Number.isFinite(catering.advance_notice_hours_required) ? `${catering.advance_notice_hours_required} hours notice` : "";
  const methods = Array.isArray(catering.allowed_order_methods) ? catering.allowed_order_methods.map((x) => String(x).replace(/_/g, " ")) : [];
  const mText = methods.length ? `order by ${humanJoin(methods)}` : "";
  const notes = catering.notes ? String(catering.notes).trim() : "";
  return humanJoin([notice, mText, notes].filter(Boolean));
}

function onlineOrderingDetails(oo) {
  if (!oo || oo.available !== true) return "";
  if (oo.pickup_only === true) return "Pickup only.";
  return "";
}

function avgPriceHuman(value) {
  if (value == null) return "";
  if (typeof value === "object" && value !== null) {
    if (typeof value.display === "string" && value.display) return value.display;
    if (value.min != null && value.max != null) return `$${value.min}–$${value.max}`;
  }
  return String(value);
}

function detectBusinessInquiry(userText) {
  const raw = String(userText || "");
  const t = normalizeText(raw);

  // Most specific first.
  if (includesAny(t, BUSINESS_KEYWORDS.OPEN_NOW)) return "OPEN_NOW";

  // Direct, low-false-positive amenities/policies/services checks.
  if (includesAny(t, BUSINESS_KEYWORDS.LOCATION)) return "LOCATION";
  if (includesAny(t, BUSINESS_KEYWORDS.PHONE)) return "PHONE";
  if (includesAny(t, BUSINESS_KEYWORDS.DELIVERY)) return "DELIVERY";

  if (includesAny(t, BUSINESS_KEYWORDS.WIFI)) return "WIFI";
  if (includesAny(t, BUSINESS_KEYWORDS.RESTROOMS)) return "RESTROOMS";
  if (includesAny(t, BUSINESS_KEYWORDS.PARKING)) return "PARKING";
  if (includesAny(t, BUSINESS_KEYWORDS.ACCESSIBILITY)) return "ACCESSIBILITY";

  if (includesAny(t, BUSINESS_KEYWORDS.CATERING)) return "CATERING";
  if (includesAny(t, BUSINESS_KEYWORDS.ONLINE_ORDERING)) return "ONLINE_ORDERING";

  // Payment methods can appear in normal text; require question-like OR explicit "payment"/"pay".
  if (t.includes("payment") || t.includes("pay") || (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.PAYMENT))) {
    if (includesAny(t, BUSINESS_KEYWORDS.PAYMENT)) return "PAYMENT";
  }

  // Dine-in / takeout: require question-like or explicit phrasing.
  if (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.DINE_IN)) return "DINE_IN";
  if (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.TAKEOUT)) return "TAKEOUT";

  // Dietary / menu support: question-like required to avoid intercepting actual orders.
  if (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.VEGETARIAN)) return "VEGETARIAN";
  if (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.VEGAN)) return "VEGAN";
  if (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.GLUTEN_FREE)) return "GLUTEN_FREE";
  if (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.KIDS_MENU)) return "KIDS_MENU";
  if (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.LOYALTY)) return "LOYALTY";

  // Customization / build-your-own
  if (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.CUSTOMIZE)) return "CUSTOMIZE";
  // Breakfast cutoff / breakfast end time
  if (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.BREAKFAST_END)) return "BREAKFAST_END";

  // Menu overview / recommendations / experience: question-like required.
  if (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.MENU_OVERVIEW)) return "MENU_OVERVIEW";
  if (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.BEST_SELLERS)) return "BEST_SELLERS";
  if (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.ORDER_METHODS)) return "ORDER_METHODS";
  if (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.WAIT_TIME)) return "WAIT_TIME";
  if (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.PRICE)) return "PRICE";

  // Policies: question-like required.
  if (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.ALLERGEN)) return "ALLERGEN";
  if (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.REFUND)) return "REFUND";
  if (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.SAFETY)) return "SAFETY";
  if (isQuestionLike(raw) && includesAny(t, BUSINESS_KEYWORDS.RAW_FOOD)) return "RAW_FOOD";

  // HOURS: either explicit "hours" OR question-like + open/close words
  if (t.includes("hours")) return "HOURS";
  if (isQuestionLike(raw) && (t.includes("open") || t.includes("close") || t.includes("opening") || t.includes("closing"))) {
    return "HOURS";
  }

  return null;
}

function detectThanks(userText) {
  const raw = String(userText || "");
  const t = normalizeText(raw);
  // Keep strict and explicit to avoid false positives.
  // IMPORTANT: short forms like "ty" must be whole-token matches (so "tyler" doesn't trip this).
  if (!t) return false;
  if (/\bthank\s+you\b/.test(t)) return true;
  if (/\bthanks\b/.test(t)) return true;
  if (/\bappreciate\s+(?:it|you)\b/.test(t)) return true;
  if (/\bthx\b/.test(t)) return true;
  if (/\bty\b/.test(t)) return true;
  return false;
}


function inferFormatFromText(text) {
  const norm = normalizeText(text);
  const normLower = norm;
  // Deterministic token checks (explicit only). Accept simple plurals.
  if (/\bwraps?\b/.test(normLower)) return "wrap";
  if (/\bpaninis?\b/.test(normLower)) return "panini";
  if (/\bmini\b/.test(normLower) && /\bsubs?\b/.test(normLower)) return "mini_sub";
  if (/\bsubs?\b|\bhero(?:es)?\b|\bhoagie(?:s)?\b|\bwedge(?:s)?\b/.test(normLower)) return "sub";
  if (/\brolls?\b|\bkaiser(?:s)?\b/.test(normLower)) return "roll";
  if (/\btoasts?\b/.test(normLower)) return "toast";
  if (/\bbreads?\b/.test(normLower)) return "bread";
  return null;
}

// Wrap type capture must be deterministic and avoid ambiguity with toast/roll synonyms like "white".
function inferWrapTypeFromText(text) {
  const norm = normalizeText(text);
  const normLower = norm;
  if (!norm) return null;

  // IMPORTANT: do NOT treat condiment words like "tomato" as a wrap selection in long utterances.
  // We only accept wrap-type signals when they are explicit ("white wrap", "spinach wrap") or when
  // the reply is short (e.g. the system just asked for wrap type and the user answers "white").
  const tokens = norm.split(/\s+/).filter(Boolean);
  const isShortReply = tokens.length <= 3;

  // Explicit phrases win.
  if (/\bspinach\s+wrap\b/.test(normLower) || (isShortReply && /^(spinach|spinch|spinich|spincah)$/.test(normLower))) return "bread.spinach_wrap";
  if (/\btomato\s+(?:basil\s+)?wrap\b/.test(normLower) || /\bbasil\s+wrap\b/.test(normLower) || (isShortReply && /^(tomato\s*basil|basil)$/.test(normLower))) {
    return "bread.tomato_wrap";
  }
  if (/\b(?:whole\s*wheat|wheat)\s+wrap\b/.test(normLower) || (isShortReply && /^(whole\s*wheat|wheat)$/.test(normLower))) return "bread.wheat_wrap";
  if (/\b(?:white|plain)\s+wrap\b/.test(normLower) || (isShortReply && /^(white|plain)$/.test(normLower))) return "bread.white_wrap";

  return null;
}


function buildBreadIndex(reference) {
  const breads = Array.isArray(reference?.breads) ? reference.breads : [];
  const entries = [];
  for (const b of breads) {
    const syns = [];
    if (typeof b.display_name === "string") syns.push(b.display_name);
    if (Array.isArray(b.synonyms)) syns.push(...b.synonyms);
    if (typeof b.id === "string") syns.push(b.id);
    for (const s of syns) {
      const norm = normalizeText(s);
      if (!norm) continue;
      entries.push({ id: b.id, group: b.group || null, norm });
    }
  }
  entries.sort((a, b) => b.norm.length - a.norm.length);
  return entries;
}


function buildCondimentIndex(reference) {
  const entries = [];
  const idTailVariants = (id) => {
    if (typeof id !== "string") return [];
    const tail = id.split(".").pop();
    if (!tail) return [];
    const spaced = tail.replace(/_/g, " ");
    // Also include the raw tail (with underscores) in case a user types it that way.
    const raw = tail;
    return [spaced, raw].filter(Boolean);
  };
  const add = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const it of arr) {
      if (!it || typeof it !== "object") continue;
      const id = typeof it.id === "string" ? it.id : null;
      if (!id) continue;
      const syns = [];
      if (typeof it.display_name === "string") syns.push(it.display_name);
      if (Array.isArray(it.synonyms)) syns.push(...it.synonyms);
      if (Array.isArray(it.aliases)) syns.push(...it.aliases);
      syns.push(...idTailVariants(id));
      syns.push(id);
      for (const s of syns) {
        const norm = normalizeText(s);
        if (!norm) continue;
        entries.push({ id, norm });
      }
    }
  };
  add(reference?.toppings);
  add(reference?.condiments);
  entries.sort((a, b) => b.norm.length - a.norm.length);
  return entries;
}



function buildCheeseIndex(reference) {
  const entries = [];
  const cheeses = Array.isArray(reference?.cheeses) ? reference.cheeses : [];
  for (const it of cheeses) {
    if (!it || typeof it !== "object") continue;
    const id = typeof it.id === "string" ? it.id : null;
    if (!id) continue;
    const syns = [];
    if (typeof it.display_name === "string") syns.push(it.display_name);
    if (Array.isArray(it.synonyms)) syns.push(...it.synonyms);
    if (Array.isArray(it.aliases)) syns.push(...it.aliases);
    syns.push(id);
    for (const s of syns) {
      const norm = normalizeText(s);
      if (!norm) continue;
      entries.push({ id, norm });
    }
  }
  entries.sort((a, b) => b.norm.length - a.norm.length);
  return entries;
}

function buildMeatIndex(reference) {
  const entries = [];
  const meats = Array.isArray(reference?.meats) ? reference.meats : [];
  for (const it of meats) {
    if (!it || typeof it !== "object") continue;
    const id = typeof it.id === "string" ? it.id : null;
    if (!id) continue;
    const syns = [];
    if (typeof it.display_name === "string") syns.push(it.display_name);
    if (Array.isArray(it.synonyms)) syns.push(...it.synonyms);
    if (Array.isArray(it.aliases)) syns.push(...it.aliases);
    syns.push(id);
    for (const s of syns) {
      const norm = normalizeText(s);
      if (!norm) continue;
      entries.push({ id, norm });
    }
  }
  entries.sort((a, b) => b.norm.length - a.norm.length);
  return entries;
}

function buildAddonIndex(addons) {
  const entries = [];
  const list = Array.isArray(addons?.addons) ? addons.addons : [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const id = typeof it.id === "string" ? it.id : null;
    if (!id) continue;
    const syns = [];
    if (typeof it.name === "string") syns.push(it.name);
    if (Array.isArray(it.synonyms)) syns.push(...it.synonyms);
    syns.push(id);
    for (const s of syns) {
      const norm = normalizeText(s);
      if (!norm) continue;
      entries.push({ id, norm });
    }
  }
  // Longest match wins; deterministic
  entries.sort((a, b) => b.norm.length - a.norm.length);
  return entries;
}
function buildDisplayMaps(reference) {
  const maps = {
    breads: {},
    condiments: {},
    cheeses: {},
    meats: {},
  };

  const add = (arr, target) => {
    if (!Array.isArray(arr)) return;
    for (const it of arr) {
      if (!it || typeof it !== "object") continue;
      const id = typeof it.id === "string" ? it.id : null;
      if (!id) continue;
      const label = typeof it.display_name === "string" && it.display_name.trim()
        ? it.display_name.trim()
        : id;
      target[id] = label;
    }
  };

  add(reference?.breads, maps.breads);
  add(reference?.toppings, maps.condiments);
  add(reference?.condiments, maps.condiments);
  add(reference?.cheeses, maps.cheeses);
  add(reference?.meats, maps.meats);

  return maps;
}

function extractDoYouHaveClause(raw) {
  const s = String(raw || "");
  // Deterministic support for availability questions.
  // Examples: "do you have american cheese", "do you guys have roast beef?",
  //           "... and do you have sweet peppers?", "do you carry pastrami?"
  const re = /(\b(?:and\s+)?do\s+you\s+(?:guys\s+|all\s+|carry\s+|sell\s+)?(?:have|carry|sell)\b\s*)([^\?\.,]+)([\?\.]?)/i;
  const m = s.match(re);
  if (!m) return { cleanText: s, queryText: null };
  const queryText = String(m[2] || "").trim();
  const cleanText = s.replace(re, " ").replace(/\s+/g, " ").trim();
  return { cleanText, queryText };
}

function inferMeatFromText(raw, meatIndex) {
  const mEntries = Array.isArray(meatIndex) ? meatIndex : [];
  if (!mEntries.length) return null;
  const n = " " + normalizeText(raw) + " ";
  for (const e of mEntries) {
    if (!e || !e.id || !e.norm) continue;
    const needle = " " + e.norm + " ";
    if (n.includes(needle)) return e.id;
  }
  return null;
}

// Like inferMeatFromText but picks the meat that appears FIRST in the utterance by character
// position, not by meatIndex order (which is sorted longest-first). This prevents length-bias
// when the user mentions multiple proteins: "bacon sausage egg and cheese" → bacon wins (first
// mentioned) instead of sausage (longer string). Used for menu-item narrowing only.
function inferFirstMeatFromText(raw, meatIndex) {
  const mEntries = Array.isArray(meatIndex) ? meatIndex : [];
  if (!mEntries.length) return null;
  const n = " " + normalizeText(raw) + " ";
  let firstId = null;
  let firstPos = Infinity;
  for (const e of mEntries) {
    if (!e || !e.id || !e.norm) continue;
    const needle = " " + e.norm + " ";
    const idx = n.indexOf(needle);
    if (idx !== -1 && idx < firstPos) {
      firstPos = idx;
      firstId = e.id;
    }
  }
  return firstId;
}

// Deterministic helper: when a meat is mentioned in an explicit add-on clause
// (e.g., "... with bacon", "add salami"), it should not be treated as the *primary*
// meat for menu-item narrowing. This prevents add-on meats from hijacking base
// sandwich selection (e.g., "ham and cheese with bacon" selecting a bacon item).

function getMenuMatchText(raw) {
  const s = String(raw || "");
  // Split on first standalone "with" so toppings don't hijack base item selection.
  // Deterministic: only the first occurrence of the whole word.
  const m = s.match(/\bwith\b/i);
  if (!m || m.index == null) return s;
  return s.slice(0, m.index).trim();
}

function stripAddonMeatClauses(raw, meatIndex) {
  const entries = Array.isArray(meatIndex) ? meatIndex : [];
  if (!entries.length) return String(raw || "");
  // Work in normalized space so phrase matching is deterministic.
  let n = " " + normalizeText(raw) + " ";
  const leadins = ["with", "add", "plus"];
  for (const e of entries) {
    if (!e || !e.norm) continue;
    for (const li of leadins) {
      const pat = " " + li + " " + e.norm + " ";
      if (n.includes(pat)) {
        // remove only the add-on clause phrase, preserve the rest
        n = n.split(pat).join(" ");
      }
    }
  }
  return n.replace(/\s+/g, " ").trim();
}


function extractAddonMeatIds(raw, meatIndex) {
  const entries = Array.isArray(meatIndex) ? meatIndex : [];
  if (!entries.length) return [];
  const n = " " + normalizeText(raw) + " ";
  const leadins = ["with", "add", "plus", "extra"];
  const out = new Set();

  // Look only inside explicit add-on clauses so base meats don't get misinterpreted as add-ons.
  // Deterministic: prefix/phrase-based, whole-token matching only; no fuzzy inference.
  for (const li of leadins) {
    const marker = " " + li + " ";
    const idx = n.indexOf(marker);
    if (idx < 0) continue;
    let clause = n.slice(idx + marker.length);
    // Stop at an inline name clause ("for Tyler") if present.
    const stopIdx = clause.indexOf(" for ");
    if (stopIdx >= 0) clause = clause.slice(0, stopIdx);
    clause = " " + clause.trim() + " ";

    for (const e of entries) {
      if (!e || !e.norm || !e.id) continue;
      if (clause.includes(" " + e.norm + " ")) out.add(e.id);
    }
  }

  return Array.from(out);
}

function resolveAvailability(queryText, config) {
  const raw = String(queryText || "").trim();
  if (!raw) return { found: false, item_display: "" };

  const ents = extractEntities(raw, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, config.addonIndex);
  const conds = Array.isArray(ents?.condiments) ? ents.condiments : [];
  if (conds.length === 1) {
    const id = conds[0];
    const display = config.displayMaps?.condiments?.[id] || id;
    return { found: true, type: "condiment", id, item_display: display };
  }
  if (ents?.cheese) {
    const id = ents.cheese;
    const display = config.displayMaps?.cheeses?.[id] || id;
    return { found: true, type: "cheese", id, item_display: display };
  }
  const meatId = inferMeatFromText(raw, config.meatIndex);
  if (meatId) {
    const display = config.displayMaps?.meats?.[meatId] || meatId;
    return { found: true, type: "meat", id: meatId, item_display: display };
  }
  if (ents?.bread_type) {
    const id = ents.bread_type;
    const display = config.displayMaps?.breads?.[id] || id;
    return { found: true, type: "bread", id, item_display: display };
  }

  // Menu items: only answer "yes" on exact phrase matches (no token-overlap inference).
  const norm = normalizeText(raw);
  const mi = Array.isArray(config.menuIndex) ? config.menuIndex : [];
  for (const it of mi) {
    const vars = Array.isArray(it?.normVariants) ? it.normVariants : [];
    if (vars.some((v) => v && norm.includes(v))) {
      return { found: true, type: "menu_item", id: it.id, item_display: it.name };
    }
  }

  // Fix Cluster 1: generic format category words (wraps, subs, rolls) are NOT in breadIndex
  // as individual entries, so the bread_type check above misses them. Return found=true with
  // a descriptive display so "do you have wraps/subs" answers correctly instead of "we don't carry X".
  {
    const _normQ = normalizeText(norm);
    const _fmtCat = /^wraps?$/.test(_normQ) ? "wrap" : /^subs?$/.test(_normQ) ? "sub" : /^rolls?$/.test(_normQ) ? "roll" : /^paninis?$/.test(_normQ) ? "panini" : null;
    if (_fmtCat) {
      const _bi = Array.isArray(config?.breadIndex) ? config.breadIndex : [];
      const _seenBreadIds = new Set();
      const _names = _bi.filter(b => {
        if (b?.group !== _fmtCat || !b.id) return false;
        if (_seenBreadIds.has(b.id)) return false;
        _seenBreadIds.add(b.id); return true;
      }).map(b => config?.displayMaps?.breads?.[b.id] || b.id);
      const _display = _names.length ? (_fmtCat + "s — " + _names.join(", ")) : (_fmtCat + "s");
      return { found: true, type: "format_category", id: _fmtCat, item_display: _display };
    }
  }

  return { found: false, item_display: raw };
}

function buildLexicon(reference) {
  const lex = {
    meats: new Set(),
    cheeses: new Set(),
    breads: new Set(),
    formats: new Set(),
    toppings: new Set(),
    condiments: new Set(),
    // Non-committal tokens that indicate "this is an order" but do NOT select a format like roll/sub/wrap.
    order_hints: new Set(),
  };

  const addSyns = (arr, set) => {
    if (!Array.isArray(arr)) return;
    for (const it of arr) {
      const syns = [];
      if (typeof it.display_name === "string") syns.push(it.display_name);
      if (Array.isArray(it.synonyms)) syns.push(...it.synonyms);
      if (typeof it.id === "string") syns.push(it.id);
      for (const s of syns) {
        const n = normalizeText(s);
        if (n) set.add(n);
      }
    }
  };

  addSyns(reference?.meats, lex.meats);
  addSyns(reference?.cheeses, lex.cheeses);
  addSyns(reference?.breads, lex.breads);
  addSyns(reference?.toppings, lex.toppings);
  addSyns(reference?.condiments, lex.condiments);
  addSyns(reference?.formats, lex.formats);

  // Some users say "panini" as a format even if not explicitly listed.
  lex.formats.add("panini");

  // Pull non-committal order hints from reference.aliases (type: "order_hint").
  // These should help classify intent as an order without selecting roll/sub/wrap.
  const aliases = Array.isArray(reference?.aliases) ? reference.aliases : [];
  for (const a of aliases) {
    if (!a || typeof a !== "object") continue;
    if (a.type !== "order_hint") continue;
    if (!Array.isArray(a.aliases)) continue;
    for (const s of a.aliases) {
      const n = normalizeText(s);
      if (n) lex.order_hints.add(n);
    }
  }

  // Generic category words users say in natural orders (not always present as explicit synonyms)
  // Example: "ham and cheese" where "cheese" is not a specific cheese item.
  lex.cheeses.add("cheese");

  return lex;
}


function buildMenuItemAliasMap(reference) {
  const map = new Map();
  const phrases = [];
  if (!reference || !Array.isArray(reference.aliases)) return { map, phrases };

  for (const entry of reference.aliases) {
    if (!entry || entry.type !== "menu_item" || !entry.canonical_id) continue;
    const canonId = entry.canonical_id;
    const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
    for (const a of aliases) {
      const norm = normalizeText(String(a || ""));
      if (!norm) continue;
      map.set(norm, canonId);
      if (norm.includes(" ")) phrases.push(norm);
    }
  }

  // Deduplicate phrases to keep checks cheap.
  const uniq = Array.from(new Set(phrases));
  // Sort longer first so "bronx bomber" matches before "bronx".
  uniq.sort((a, b) => b.length - a.length);
  return { map, phrases: uniq };
}


function inferBreadTypeFromText(text, breadIndex) {
  const norm = normalizeText(text);
  if (!norm) return null;

  // breadIndex may be an Array, an object map, or a Map depending on how it was built.
  const entries = (() => {
    if (!breadIndex) return [];
    if (Array.isArray(breadIndex)) return breadIndex;
    if (breadIndex instanceof Map) return Array.from(breadIndex.values());
    if (typeof breadIndex === "object") return Object.values(breadIndex);
    return [];
  })();

  // Prefer the most specific match (longest phrase). This prevents generic
  // matches like "roll" / "plain roll" from overriding "poppy seed roll".
  let best = null;
  let bestLen = 0;
  for (const e of entries) {
    if (!e) continue;
    const eNorm = e.norm || normalizeText(e.name || e.label || e.id || "");
    const eId = e.id || e.value || e.key;
    if (!eId || !eNorm) continue;
    const hit = (norm === eNorm) || norm.includes(eNorm);
    if (!hit) continue;
    const len = eNorm.length;
    if (len > bestLen) {
      best = eId;
      bestLen = len;
    }
  }
  return best;
}

// Parses an order quantity from the leading portion of an utterance (after stripping common
// lead-in phrases). Returns an integer >= 2 or null if no leading quantity detected.
// Conservative: only matches numbers at the *start* to avoid false-positives on dimension
// words ("6-inch"), ordinals, or embedded numbers unrelated to item count.
function parseQuantityFromText(text) {
  let n = normalizeText(text);
  // Strip common order lead-ins so "can I get 15 ham..." → "15 ham..."
  n = n.replace(/^(can i (get|have)|i\s*(?:d| would)\s*like|i\s*want|gimme|give me|let me get|lemme get|i need)\s+/, "").trim();
  // Digit-first: "15 ham sandwiches" → 15
  const dm = n.match(/^(\d+)\s+/);
  if (dm) {
    const num = Number(dm[1]);
    if (num >= 2 && num <= 999) return num;
  }
  // Word numbers at the start of the (stripped) utterance
  const wordNums = {
    two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
    fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  };
  for (const [word, num] of Object.entries(wordNums)) {
    if (n.startsWith(word + " ")) {
      // Guard: "three quarter(s) pound/lb" is a fractional weight, not qty=3.
      // Similarly "one and a half pounds" should not be qty=1 via this path.
      if (/^three\s+quarters?\s+(?:of\s+)?(?:a\s+)?(?:lb|lbs|pound|pounds)\b/.test(n)) break;
      if (/^one\s+and\s+a\s+half\s+(?:lb|lbs|pound|pounds)\b/.test(n)) break;
      return num;
    }
  }
  return null;
}

function buildPendingItemFromMenuItem(menuItemRaw, userText) {
  let fmt = inferFormatFromText(userText);

  // Guard: if the user is using recommendation language ("whatever bread you recommend",
  // "your pick", "up to you"), do NOT lock format from the literal word "bread" in the text.
  // Let the AWAITING_FORMAT handler pick the default intelligently.
  if (fmt === "bread") {
    const _buildRecommendRe = /\b(whatever\s+(\w+\s+)*(you\s+)?(recommend|suggest|think|pick|choose)|your\s+(pick|choice|recommendation|suggestion|call)|dealer'?s?\s+choice|doesn'?t\s+matter|don'?t\s+care|up\s+to\s+you|surprise\s+me)\b/i;
    if (_buildRecommendRe.test(userText)) fmt = null;
  }

  // Validate inferred format against allowed_formats.
  // If the inferred format is not in the item's allowed_formats, discard it.
  // This prevents "garlic bread" from inferring format="bread" for a small_dish item.
  if (fmt && Array.isArray(menuItemRaw.allowed_formats) && menuItemRaw.allowed_formats.length > 0) {
    if (!menuItemRaw.allowed_formats.includes(fmt)) {
      fmt = null;
    }
  }

  // If no format was inferred from user text, apply the item's default_format --
  // BUT only for non-trivial defaults (not "roll", which is the generic fallback).
  // Items like The Roma (panini), buffalo wrap (wrap), ziti (small_dish) skip the format
  // question. Regular sandwiches that default to "roll" still ask.
  if (!fmt && menuItemRaw.default_format && menuItemRaw.default_format !== 'roll') {
    fmt = menuItemRaw.default_format;
  }

  const pending = {
    exists: true,

    name: menuItemRaw.name ?? null,
    category: menuItemRaw.category ?? null,
    format: fmt || null,
    format_source: fmt ? "user" : null,

    bread_type: null,
    bread_type_prompted: false,

    allowed_temps: Array.isArray(menuItemRaw.allowed_temps) ? menuItemRaw.allowed_temps : null,
    default_temp: menuItemRaw.default_temp ?? null,
    requested_temp: (menuItemRaw.default_temp ?? null),

    addons: [],
    addons_specified: false,
    addons_prompted: false,

    temp_source: (menuItemRaw.default_temp ? "default" : null),

    condiments: [],
    condiments_specified: false,
    condiments_prompted: false,
    needs_condiments: menuItemRaw.needs_condiments ?? null,

    pressed: menuItemRaw.forces_pressed ? true : null,
    pressed_prompted: false,
    toasted: null,
    toasted_user: false,
    meat_warmed: null,
    meat_warmed_user: false,
    prep_applied: false,

    meats: Array.isArray(menuItemRaw.ingredient_ids?.meats) ? [...menuItemRaw.ingredient_ids.meats] : null,

    meat_mode: null,
    meat_mode_prompted: false,

    double_meat_requested: false,
    double_meat_confirmed: false,

    is_panini_override: false,
    is_deli_by_weight: Boolean(menuItemRaw.is_deli_by_weight),

    requested_weight_lbs: null,
    weight_prompted: false,

    category_requires_bread: menuItemRaw.category_requires_bread ?? null,

    parm_item: Boolean(menuItemRaw.parm_item),
    parm_cheese: menuItemRaw.default_parm_cheese ?? null,
    parm_cheese_prompted: false,

    // Auto-set dish_size for items that only allow small_dish (no choice to offer)
    dish_size: (() => {
      const af = Array.isArray(menuItemRaw.allowed_formats) ? menuItemRaw.allowed_formats : [];
      if (af.includes('small_dish') && !af.includes('large_dish')) return 'small';
      return null;
    })(),
    dish_size_prompted: false,
    small_only_prompted: false,

    item_id: menuItemRaw.id ?? null,

    cheese_override: null,
    condiments_modifier: null,
    addons_modifier: null,

    cut_style: null,
    on_the_side: null,
    slice_style: null,

    quantity: null,

    // Extra fields used in some rules (not in state_model but referenced in rules):
    // Keep them initialized to avoid undefined comparisons.
    is_mini_sub_override: false,
    meat_text: null,
    meat_id: null,
    price: null,

    // Deli ambiguity support (sandwich vs sliced). These are only used when
    // a deli-by-weight item can also be ordered as a sandwich.
    ambiguous_mode: false,
    ambiguous_mode_prompted: false,
    deli_mode_sandwich_alt_item_id: null,

    // Named sandwich defaults flag: true if the item has pre-configured toppings/condiments.
    has_configured_defaults: menuItemRaw.has_configured_defaults === true,
  };

  // For non-sandwich items (category_requires_bread=false), deterministically apply the menu default_format.
  // This keeps sides and deli-by-weight from getting stuck without a format.
  if (
    !pending.format &&
    menuItemRaw &&
    menuItemRaw.category_requires_bread === false &&
    menuItemRaw.default_format
  ) {
    pending.format = menuItemRaw.default_format;
    pending.format_source = "default";

    // If this is a dish size format, deterministically set the dish_size to match.
    // IMPORTANT: for salad dishes, we *do not* auto-default the size to small. We want to ask.
    if (menuItemRaw.category !== "salad_dish") {
      if (pending.format === "small_dish") {
        pending.dish_size = "small";
        pending.dish_size_prompted = true;
      }
      if (pending.format === "large_dish") {
        pending.dish_size = "large";
        pending.dish_size_prompted = true;
      }
    }
  }

  // Deterministic default for dishes/sides: if we have a dish item and the current format is not a valid
  // dish-size format, force small_dish. This prevents accidental sandwich-style formats like "bread".
  if (pending.category === "side_dish" || pending.category === "salad_dish") {
    const fmt = pending.format;
    const isDishFmt = fmt === "small_dish" || fmt === "large_dish";
    if (!isDishFmt) {
      pending.format = "small_dish";
      pending.format_source = pending.format_source || "default";
    }
  }

  // NOTE: We intentionally do NOT auto-default bread_type to "bread.plain_roll" when
  // format=roll. There are multiple roll types (plain, poppy seed, Portuguese, knot) and
  // the customer should be asked. ASK_BREAD_TYPE_IF_MISSING handles this at rule time.

  // If a menu item has multiple *default* meats (e.g., named combos), do NOT prompt for half/half.
  // Deterministic default: full portions of both.
  // Only prompt if the customer explicitly requests a mode in their utterance, or if meats are user-selected.
  const norm = normalizeText(userText);
  const normLower = norm;
  const userRequestedHalfHalf = /\b(half\s*(and|n)\s*half|50\s*\/\s*50|fifty\s*fifty)\b/.test(normLower);
  const userRequestedFull = /\b(full\s*portions?|both\s*meats?|all\s*of\s*both|full\s*of\s*both)\b/.test(normLower);

  if (userRequestedHalfHalf) pending.meat_mode = "half_half";
  if (userRequestedFull) pending.meat_mode = "full";

  const defaultMeatsCount = Array.isArray(pending.meats) ? pending.meats.length : 0;
  const meatsAreUserSelectable = Boolean(menuItemRaw.meats_allowed) || (Array.isArray(menuItemRaw.meat_options) && menuItemRaw.meat_options.length > 0);

  if (!meatsAreUserSelectable && defaultMeatsCount >= 2 && pending.meat_mode == null) {
    pending.meat_mode = "full";
  }

  return pending;

}


function applyDishSizeToPending(pending, entities) {
  if (!pending || !pending.exists || !entities) return;
  let ds = entities.dish_size;
  // Accept both runner-extracted formats: "small"/"large" and "small_dish"/"large_dish".
  if (ds === "small_dish") ds = "small";
  if (ds === "large_dish") ds = "large";
  if (ds !== "small" && ds !== "large") return;

  // Only apply to non-bread dish items (salads/sides/dishes).
  const isNonBread = pending.category_requires_bread === false || pending.format === "small_dish" || pending.format === "large_dish";
  if (!isNonBread) return;

  if (ds === "small") {
    pending.format = "small_dish";
    pending.format_source = "user";
    pending.dish_size = "small";
    pending.dish_size_prompted = true;
  }
  if (ds === "large") {
    pending.format = "large_dish";
    pending.format_source = "user";
    pending.dish_size = "large";
    pending.dish_size_prompted = true;
  }
}

// Shared cheese upgrade map: maps plain sandwich variant ID → cheese variant ID.
// Reused in mockNLU (one-shot and multi-turn paths) and applyPhaseInput
// (AWAITING_TOPPINGS_OR_CONDIMENTS and AWAITING_ORDER_CORRECTION handlers).
const CHEESE_UPGRADE_MAP = {
  "lunch.turkey_sandwich": "lunch.turkey_cheese",
  "lunch.ham_sandwich":    "lunch.ham_cheese",
  "lunch.baked_ham":       "lunch.baked_ham_cheese",
  "lunch.honey_ham":       "lunch.honey_ham_cheese",
  "lunch.pastrami":        "lunch.pastrami_cheese",
  "lunch.capicola":        "lunch.capicola_cheese",
  "lunch.steak":           "lunch.steak_and_cheese",
};

function mockNLU(userText, state, config, menuIndex, keywordPhrases, breadIndex, condimentIndex, cheeseIndex, meatIndex, rulesEngine, menuItemAliases) {
  const norm = normalizeText(userText);
  const normLower = norm;
  let intent = detectIntent(userText, state);

  // Fix 1B: If the readback guard returned confirm_readback_no AND the user
  // provided inline correction text (e.g. "no. Can you take off the hot peppers"),
  // extract the remainder and store it for same-turn replay after the readback
  // handler transitions us into AWAITING_ORDER_CORRECTION.
  if (intent === "confirm_readback_no" && state) {
    const _rawTrimmed = String(userText || "").trim();
    // Issue 1: expanded prefix pattern + separator made optional (some users say "no remove X")
    const _corrMatch = /^(?:no\b|nah\b|nope\b|not\s+quite\b|not\s+right\b|wrong\b|actually\b|yes[,\s]+(?:but|except|however|although|wait)\b|(?:looks|sounds)\s+good[,\s]+(?:but|except|however|although|wait)\b|(?:ok|okay|fine|great|perfect|all\s+good)[,\s]+(?:but|except|however|although|wait)\b)[^a-zA-Z0-9]*(.*\S)/i.exec(_rawTrimmed);
    if (_corrMatch && _corrMatch[1] && _corrMatch[1].trim().length > 1) {
      const _corrExtracted = _corrMatch[1].trim();
      // "no cheese" → prefix "no", correction "cheese" — but "cheese" alone loses removal semantics.
      // When the original starts with bare "no " (not "nope ", "nah ", "no,"), re-prefix with "no "
      // so that handlers like _hasRemoveCheese can correctly detect "no cheese" → remove cheese.
      // Don't prefix "no " if the extracted text already starts with a removal verb.
      // "no take off the cheese" → extracted="take off the cheese" → keep as-is (has removal semantics).
      // "no cheese" → extracted="cheese" → prefix with "no " so removal semantics are preserved.
      const _hasRemovalVerbPrefix = /^(take\s+off|take\s+out|remove|drop|skip|get\s+rid\s+of|without|hold)\b/i.test(_corrExtracted);
      state._correction_inline_text = (/^no\s/i.test(_rawTrimmed) && !_hasRemovalVerbPrefix) ? ("no " + _corrExtracted) : _corrExtracted;
    } else if (!/^(no|nah|nope|wrong|n)\s*[.!?]?\s*$/i.test(_rawTrimmed)) {
      // No recognizable negative prefix but the text is non-trivial — treat the whole
      // utterance as the correction (e.g. "can you remove the mayo", "take off the peppers").
      state._correction_inline_text = _rawTrimmed;
    } else {
      state._correction_inline_text = null;
    }
  }

  const entities = extractEntities(userText, keywordPhrases, breadIndex, condimentIndex, cheeseIndex, meatIndex);
  const menuMatchText = correctMenuTypos(getMenuMatchText(userText));
  let forcedMenuCandidates = null;

  // Phase guard: when we are explicitly waiting for a salad choice (after asking
  // "Which salad would you like?"), treat common responses like "tossed salad"
  // as a high-confidence menu selection.
  if (state && state.phase === "AWAITING_SALAD_ITEM") {
    const allowedSaladCats = new Set(["salad_dish", "cold_salad", "salad"]);
    const scopedMenuIndex = filterMenuIndexForUtterance(menuMatchText, menuIndex).filter((it) => {
      const cat = it?.raw?.category || null;
      return cat != null && allowedSaladCats.has(String(cat));
    });
    // Do not return early here — we want the normal menu match path to build the pending_item.
    // We simply restrict candidates to salads so the next match is deterministic.
    if (scopedMenuIndex.length) forcedMenuCandidates = scopedMenuIndex;
  }

  // Do NOT treat the token "plain" as "no condiments" during initial item capture.
  // "plain" only means "nothing extra" when the system is actively asking about toppings/condiments.
  if (intent === "no_condiments") {
    const phase = state?.phase || null;
    const lastPid = state?.last_prompt_id || null;
    const okPhase = (phase === "AWAITING_TOPPINGS_OR_CONDIMENTS");
    const okPrompt = Boolean(lastPid && /ASK_(?:CONDIMENTS|TOPPINGS)|CONDIMENTS_OR_TOPPINGS/.test(lastPid));
    const n = normalizeText(userText);
    const looksLikeOrder = /\b(roll|sub|wrap|panini)\b/.test(n);
    const hasPlain = /\bplain\b/.test(n);
    if (!okPhase && !okPrompt && looksLikeOrder && hasPlain) {
      intent = "place_order";
    }
  }

  // Wrap override: if the utterance explicitly names a wrap type (e.g., "white wrap"),
  // force bread_type to the wrap and format=wrap. This avoids ambiguity with "white" toast/bread.
  const wrapId = inferWrapTypeFromText(userText);
  if (wrapId) {
    entities.bread_type = wrapId;
    entities.format = "wrap";
  }

  // Multi-quantity per-item variation detection (e.g., "two turkey... one plain roll, one poppy").
  const _multiQtyVariation = detectMultiQtyVariation(userText, breadIndex);
  if (_multiQtyVariation && state && state.session) {
    state.session.multi_qty_variation = true;

    // If the utterance explicitly specifies two different bread selections ("one on X and one on Y"),
    // store them so the runner can auto-split deterministically even if format is already known.
    const twoBreads = parseExplicitTwoBreadSelections(userText, breadIndex);
    if (twoBreads && twoBreads.length === 2) {
      state.session.multi_qty_per_item_breads = twoBreads;
      state.session.multi_qty_per_item_breads_source = "explicit_one_on_one_on";
    }

    // If the utterance explicitly binds toppings per item (e.g., "one with X and the other plain"),
    // store that binding so the multi-qty split can apply it deterministically.
    const bind = parseExplicitPerItemCondimentBinding(userText, config);
    if (bind && Array.isArray(bind.lists) && bind.lists.length === 2) {
      state.session.multi_qty_per_item_condiments = bind.lists;
      state.session.multi_qty_per_item_condiments_source = bind.source || "explicit";
    }
  }
// Stage multi-slot captures deterministically so later slot questions don't lose earlier details.
  // (Example: "turkey wrap with lettuce" -> we ask wrap type first; condiments are staged and applied later.)
  if (state && state.session) {
    // Bread/wrap/roll type staging: capture early even before we have created a pending_item.
    // This is critical for one-shot orders like: "turkey and cheese on a white wrap ...".
    if (entities.bread_type) {
      if (state.order?.pending_item?.exists) {
        // If pending item exists, store immediately.
        state.order.pending_item.bread_type = entities.bread_type;
      } else {
        state.session.staged_bread_type = entities.bread_type;
        // Also derive and stage the format from the bread's group so the format question is
        // not re-asked when bread type already implies format (e.g. "plain" → bread.plain_roll → "roll").
        // This fixes multi-item queue replay where "one ham and cheese plain" stages the bread type
        // but format remains null causing a redundant format prompt for the second item.
        if (!state.session.staged_format) {
          const _btEntry2 = Array.isArray(breadIndex) ? breadIndex.find(b => b.id === entities.bread_type) : null;
          const _btGroup2 = _btEntry2?.group || null;
          if (_btGroup2 && ["roll","sub","wrap","panini","toast","bread"].includes(_btGroup2)) {
            state.session.staged_format = _btGroup2;
          }
        }
      }
    }

    // Prep-style modifier staging: toasted / heated
    if (entities.toasted) {
      if (state.order?.pending_item?.exists) {
        state.order.pending_item.toasted = true;
        state.order.pending_item.toasted_user = true;
      } else {
        state.session.staged_toasted = true;
      }
    }
    if (entities.heated) {
      if (state.order?.pending_item?.exists) {
        state.order.pending_item.meat_warmed = true;
        state.order.pending_item.meat_warmed_user = true;
      } else {
        state.session.staged_heated = true;
      }
    }

    // Format staging: capture early even before we have created a pending_item.
    if (entities.format) {
      if (state.order?.pending_item?.exists) {
        if (!state.order.pending_item.format) {
          state.order.pending_item.format = entities.format;
          state.order.pending_item.format_source = "user";
        }
      } else {
        state.session.staged_format = entities.format;
      }
    }

    if (Array.isArray(entities.condiments) && entities.condiments.length) {
      if (state.order?.pending_item?.exists) {
        const pi = state.order.pending_item;
        const awaitingName = (state.order && state.order.customer_name == null);
        const multiVar = Boolean(state.session?.multi_qty_variation);
        // If this is a multi-quantity order with per-item variation markers, do NOT apply condiments to the whole item yet.
        // Stage them and ask later so we don\'t finalize incorrectly.
        if (awaitingName && multiVar) {
          state.session.staged_condiments_multi = [...entities.condiments];
        } else if (pi.condiments_specified !== true) {
          pi.condiments = [...entities.condiments];
          pi.condiments_specified = true;
        }
      } else {
        state.session.staged_condiments = [...entities.condiments];
      }

      // Deterministic priced-addon mapping via addons.json links.topping_id
      const pi = state.order?.pending_item?.exists ? state.order.pending_item : null;
      const targetItemId = pi?.item_id || null;
      const daypart = inferDaypartForItemId(config, targetItemId);
      const addonIds = mapToppingIdsToAddonIds(config, entities.condiments, daypart);
      if (addonIds.length) {
        if (pi) {
          const set = new Set([...(pi.addons || [])]);
          for (const a of addonIds) set.add(a);
          pi.addons = Array.from(set);
          pi.addons_specified = true;
          // Force deterministic repricing (base + addons) on finalize.
          pi.price = null;
        } else {
          state.session.staged_addons = Array.from(new Set([...(state.session.staged_addons || []), ...addonIds]));
        }
      }
    }

    // Fix Part3-1a: Stage remove_condiments (negated condiment removals in one-shot utterances).
    // E.g. "turkey no tomato mayo on a sub for Luca" → remove_condiments=[tomato] staged for later.
    if (Array.isArray(entities.remove_condiments) && entities.remove_condiments.length) {
      if (state.order?.pending_item?.exists) {
        const pi = state.order.pending_item;
        if (!Array.isArray(pi.remove_condiments)) pi.remove_condiments = [];
        for (const rc of entities.remove_condiments) {
          if (!pi.remove_condiments.includes(rc)) pi.remove_condiments.push(rc);
        }
      } else {
        state.session.staged_remove_condiments = Array.from(
          new Set([...(state.session.staged_remove_condiments || []), ...entities.remove_condiments])
        );
      }
    }

    // Fix Part3-1b: Stage cheese_removed when user says "no cheese" in a one-shot utterance.
    // This is separate from remove_condiments because cheese lives in cheeseIndex, not condimentIndex.
    if (/\b(no|without|hold(?:\s+the)?)\s+cheese\b/i.test(userText)) {
      if (state.order?.pending_item?.exists) {
        const pi = state.order.pending_item;
        pi.cheese_removed = true;
        pi.price = null;
      } else {
        state.session.staged_cheese_removed = true;
      }
    }

    if (entities.requested_temp) {
      if (state.order?.pending_item?.exists) {
        const pi = state.order.pending_item;
        if (pi.requested_temp == null) {
          pi.requested_temp = entities.requested_temp;
          pi.temp_source = "explicit";
        }
      } else {
        state.session.staged_requested_temp = entities.requested_temp;
      }
    }


    // Cheese override staging: capture early (one-shot) and apply later deterministically.
    if (entities.cheese) {
      if (state.order?.pending_item?.exists) {
        const pi = state.order.pending_item;
        if (pi.cheese_override == null) {
          pi.cheese_override = entities.cheese;
          // Multi-turn cheese upgrade: if the pending item has a plain (no-cheese) variant
          // and the user just added cheese, swap to the cheese variant for correct pricing.
          const _upgradeId = CHEESE_UPGRADE_MAP[pi.item_id];
          if (_upgradeId && getMenuItemById(config, _upgradeId)) {
            pi.item_id = _upgradeId;
            pi.price = null; // force reprice against the cheese variant
          }
        }
      } else {
        state.session.staged_cheese_override = entities.cheese;
      }
    }

    // Placeholder for add-ons staging (entities.addons may be populated by future deterministic parsing).
    if (Array.isArray(entities.addons) && entities.addons.length) {
      if (state.order?.pending_item?.exists) {
        const pi = state.order.pending_item;
        if (pi.addons_specified !== true) {
          pi.addons = [...entities.addons];
          pi.addons_specified = true;
        // Force deterministic repricing (base + addons) on finalize.
        pi.price = null;
        }
      } else {
        state.session.staged_addons = [...entities.addons];
      }
    }
  }
  const _engine = (rulesEngine && typeof rulesEngine === "object") ? rulesEngine : {};
  const confidenceThreshold = (_engine.confidence_threshold ?? _engine.engine?.confidence_threshold ?? _engine.rules?.engine?.confidence_threshold ?? 0.95);
  // Slot-fill intents: if the system asked for bread type, treat matching bread replies as provide_bread_type.
  if (state?.order?.pending_item?.bread_type_prompted === true && entities.bread_type) {
    intent = "provide_bread_type";
  }

  // If we're mid-item and the user replies with only a format (roll/sub/wrap/etc),
  // capture it even when we can't (and shouldn't) match a new menu item in this message.
  const inferredFormatReply = inferFormatFromText(userText);
  // One-shot safeguard: if the utterance contains a format word anywhere ("... on a white wrap ..."),
  // surface it as an entity so rules can deterministically set pending_item.format.
  // This is NOT inference from prompts; it's direct token detection from the user's text.
  // Guard: if the user is using recommendation language ("whatever you recommend", "your pick",
  // "up to you", etc.), do NOT extract literal "bread" as format=bread. The AWAITING_FORMAT and
  // AWAITING_BREAD_TYPE handlers will resolve recommendation language separately.
  const _isRecommendLang = /\b(whatever\s+(\w+\s+)*(you\s+)?(recommend|suggest|think|pick|choose)|your\s+(pick|choice|recommendation|suggestion|call)|dealer'?s?\s+choice|doesn'?t\s+matter|don'?t\s+care|up\s+to\s+you|surprise\s+me)\b/i.test(userText);
  if (inferredFormatReply && !entities.format && !(inferredFormatReply === "bread" && _isRecommendLang)) {
    entities.format = inferredFormatReply;
  }

  // If the user specified a specific wrap type (e.g., "white_wrap") but didn't say the word "wrap"
  // (or tokenization missed it), deterministically treat that as format=wrap.
  if (!entities.format && typeof entities.bread_type === "string" && /_wrap$/.test(entities.bread_type)) {
    entities.format = "wrap";
  }
  if (inferredFormatReply && state?.order?.pending_item?.exists) {
    const norm = normalizeText(userText);
    const normLower = norm;
    const fmtOnly = /^(a\s+)?(roll|sub|wrap|panini|bread|toast|mini\s*sub)\b/.test(normLower) && norm.split(/\s+/).length <= 3;
    if (fmtOnly) {
      state.order.pending_item.format = inferredFormatReply;
      state.order.pending_item.format_source = "user";
    }
  }


  // If we're already building a pending item and we have a format entity from this turn,
  // commit it immediately (rules still control downstream prompts).
  // Guard: skip if the format isn't valid for this item (e.g., "bread" for a small_dish item).
  if (entities.format && state?.order?.pending_item?.exists && !state.order.pending_item.format) {
    const _pi2 = state.order.pending_item;
    const _piRawFmts2 = _pi2.item_id && Array.isArray(menuIndex)
      ? (menuIndex.find(x => x && x.id === _pi2.item_id)?.raw?.allowed_formats || null)
      : null;
    if (!_piRawFmts2 || _piRawFmts2.includes(entities.format)) {
      state.order.pending_item.format = entities.format;
      state.order.pending_item.format_source = "user";
    }
  }

  // Order intent must win: if the user message contains clear order signals, force place_order.
  // This prevents TOPIC_OFF_TOPIC rules from stealing genuine order turns.
  const orderVerb = /\b(can i (get|have)|i\s*(?:'d| would)\s*like|i\s*want|gimme|give me|let me get|lemme get|order)\b/.test(normLower);
  const hasFoodWord = state?.lexicon ? norm.split(/\s+/).some((t) => state.lexicon.meats?.has(t) || state.lexicon.cheeses?.has(t) || state.lexicon.toppings?.has(t) || state.lexicon.condiments?.has(t)) : false;
  const hasFormatWord = /\b(roll|sub|wrap|panini)\b/.test(normLower);
  const hasWeight = entities.weight_lbs != null;
  // Guard: do not override readback/flow-confirmation intents with place_order.
  // e.g. "no I want to change it" has "i want" but must stay confirm_readback_no.
  const _isConfirmIntent = /^(confirm_|pressed_)/.test(intent)
    || intent === "finish_order" || intent === "modify_confirmed_item" || intent === "provide_name";
  // Do not promote info/defaults intents to place_order
  const _isInfoOrDefaultsIntent = intent === "accept_item_defaults" || intent === "ask_bread_options" || intent === "menu_question";
  if (intent !== "place_order" && !_isConfirmIntent && !_isInfoOrDefaultsIntent && (orderVerb || hasFoodWord || hasFormatWord || hasWeight || inferredFormatReply)) {
    intent = "place_order";
  }


  
  // If user provided a specific bread selection while an item is pending, capture it now.
  if (entities.bread_type && state?.order?.pending_item?.exists) {
    state.order.pending_item.bread_type = entities.bread_type;
  }
  // Apply toasted/heated prep modifiers if pending item exists.
  if (entities.toasted && state?.order?.pending_item?.exists) {
    state.order.pending_item.toasted = true;
    state.order.pending_item.toasted_user = true;
  }
  if (entities.heated && state?.order?.pending_item?.exists) {
    state.order.pending_item.meat_warmed = true;
    state.order.pending_item.meat_warmed_user = true;
  }
// Confidence model: deterministic heuristic.
  // IMPORTANT: rules include a global guardrail that asks the customer to rephrase
  // when nlu.confidence < confidence_threshold. So we must be generous for clearly
  // classified intents even when we cannot yet match a menu item.
  let confidence = 0.6;

  const highConfidenceIntents = new Set([
    "provide_name",
    "hours",
    "location",
    "menu_question",
    "price_question",
    "catering",
    "ordering",
    "napoli_deli_info",
    "remove_item",
    "restart_item",
    "modify_confirmed_item",
    "finish_order",
    "finish_order_soft",
    "confirm_readback_yes",
    "confirm_readback_no",
    "pressed_yes",
    "pressed_no",
    "confirm_double_meat_yes",
    "confirm_double_meat_no",
    "confirm_meat_mode",
    "nevermind_item",
    "ack",
    "skip_item",
    "cancel_item",
    "accept_item_defaults",
    "ask_bread_options",
  ]);

  if (highConfidenceIntents.has(intent)) confidence = 0.98;
  if (intent === "place_order") confidence = 0.96;

  if (intent === "provide_name") {
    const maybeName = String(userText || "").trim();
    if (maybeName.length > 0 && maybeName.length <= 40) {
      entities.customer_name = maybeName;
      confidence = 0.99;
      if (state.order) state.order.awaiting_name = false;
    }
    return { intent: "provide_name", entities, confidence, success: confidence >= confidenceThreshold };
  }


  // Deterministic menu-item alias match (named sandwiches/paninis). This is display-safe and does not affect formats.
  const _aliasMap = (menuItemAliases && menuItemAliases.map instanceof Map) ? menuItemAliases.map : null;
  const _aliasPhrases = (menuItemAliases && Array.isArray(menuItemAliases.phrases)) ? menuItemAliases.phrases : [];
  let _aliasId = null;
  let _aliasItem = null;

  if (_aliasMap) {
    const _norm = normalizeText(userText);

    // 1) Exact whole-utterance alias match.
    _aliasId = _aliasMap.get(_norm) || null;

    // 2) Multi-word phrase alias match inside the utterance (space-delimited).
    if (!_aliasId && _aliasPhrases.length) {
      for (const ph of _aliasPhrases) {
        const esc = ph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp("(?:^|\s)" + esc + "(?:$|\s)");
        if (re.test(_norm)) {
          _aliasId = _aliasMap.get(ph) || null;
          if (_aliasId) break;
        }
      }
    }

    // 3) Single-token alias match inside a larger utterance (e.g., "can i have a davinci").
    // Deterministic: exact token match only (no fuzzy).
    if (!_aliasId) {
      const toks = String(_norm || "").split(/\s+/).filter(Boolean);
      for (const t of toks) {
        const id = _aliasMap.get(t);
        if (id) { _aliasId = id; break; }
      }
    }

    if (_aliasId && Array.isArray(menuIndex)) {
      _aliasItem = menuIndex.find(x => x && x.id === _aliasId) || null;
    }
  }

  // Fix Bug 3: weight signals must not resolve to a non-by-weight alias item.
  // E.g., "a quarter pound of genoa salami" → alias token "genoa" → "The Genoa" panini is wrong.
  // Clear the alias so normal scoring routes to deli.gensal instead.
  if (_aliasId && _aliasItem && _aliasItem.raw && !_aliasItem.raw.is_deli_by_weight) {
    const _aliasNormChk = normalizeText(userText);
    const _aliasHasWeightSig = /\b(lb|lbs|pound|pounds|quarter|half)\b/.test(_aliasNormChk) || entities.weight_lbs != null;
    if (_aliasHasWeightSig) {
      _aliasId = null;
      _aliasItem = null;
    }
  }

  // Bug 1 fix: alias resolves to a panini item but user explicitly said "sandwich" (not "panini").
  // E.g., "genoa salami sandwich" → alias "genoa" → lunch_special.genoa (The Genoa panini) is wrong.
  // Clear alias so scoring path picks the correct lunch.genoa_salami_cheese sandwich item.
  if (_aliasId && _aliasItem && _aliasItem.raw && _aliasItem.raw.default_format === "panini") {
    const _aliasNormPan = normalizeText(userText);
    const _hasSandwichWord = /\b(sandwich|sub|roll|hero|hoagie|wedge)\b/.test(_aliasNormPan);
    const _hasPaniniWord = /\bpanini\b/.test(_aliasNormPan);
    if (_hasSandwichWord && !_hasPaniniWord) {
      _aliasId = null;
      _aliasItem = null;
    }
  }

  if (_aliasId) {
    entities.menu_item_id = _aliasId;
    entities.menu_item_name = _aliasItem ? _aliasItem.name : _aliasId;
    confidence = 0.99;
    // Do not override menu_question/info intents to place_order — the alias match
    // sets entities.menu_item_id so handleMenuQuestion can answer about the item.
    if (!_isConfirmIntent && !_isInfoOrDefaultsIntent) intent = "place_order";

    // Fix Item-Name Condiment Bleed (alias path): remove condiments whose norm appears as a
    // token in the matched alias item's name before staging is applied to the pending item.
    // E.g., "hummus wrap" → "hummus" is the item name, not a requested topping.
    if (_aliasItem && Array.isArray(entities.condiments) && entities.condiments.length && Array.isArray(condimentIndex)) {
      const _bleedNorm1 = " " + normalizeText(_aliasItem.raw?.name || _aliasItem.name || "") + " ";
      const _bleedIds1 = new Set();
      entities.condiments = entities.condiments.filter(cid => {
        const allNorms1 = condimentIndex.filter(ce => ce && ce.id === cid).map(ce => ce.norm);
        if (allNorms1.some(n => _bleedNorm1.includes(" " + n + " "))) { _bleedIds1.add(cid); return false; }
        return true;
      });
      if (_bleedIds1.size > 0) {
        if (state?.session?.staged_condiments) {
          state.session.staged_condiments = state.session.staged_condiments.filter(cid => !_bleedIds1.has(cid));
          if (!state.session.staged_condiments.length) state.session.staged_condiments = null;
        }
        const _daypartBleed1 = inferDaypartForItemId(config, _aliasItem.raw?.id || _aliasItem.id);
        const _rmAddonIds1 = new Set(mapToppingIdsToAddonIds(config, Array.from(_bleedIds1), _daypartBleed1));
        if (_rmAddonIds1.size > 0 && state?.session?.staged_addons) {
          state.session.staged_addons = state.session.staged_addons.filter(a => !_rmAddonIds1.has(a));
          if (!state.session.staged_addons.length) state.session.staged_addons = null;
        }
      }
    }

    // CRITICAL: if the user ordered a named sandwich BEFORE providing a name,
    // we must still create a pending_item now. Otherwise, after name capture,
    // there is no pending item and the turn falls through to "(no rule matched)".
    // Guard: do NOT create a pending item for info/menu queries ("what comes on the Roma?").
    if (!_isInfoOrDefaultsIntent && state?.order && !(state.order.pending_item && state.order.pending_item.exists) && _aliasItem && _aliasItem.raw) {
      state.order.pending_item = buildPendingItemFromMenuItem(_aliasItem.raw, userText);
      applyDishSizeToPending(state.order.pending_item, entities);

      // Apply staged fields captured earlier in the same utterance deterministically.
      if (state.session?.staged_bread_type && state.order.pending_item && !state.order.pending_item.bread_type) {
        state.order.pending_item.bread_type = state.session.staged_bread_type;
        state.order.pending_item.bread_type_prompted = true;
        state.session.staged_bread_type = null;
      }
      if (state.session?.staged_format && state.order.pending_item && !state.order.pending_item.format) {
        // Guard: only apply staged_format if it's valid for this item's allowed_formats
        const _sfRaw = _aliasItem?.raw;
        const _sfAllowed = !_sfRaw || !Array.isArray(_sfRaw.allowed_formats) || _sfRaw.allowed_formats.length === 0 || _sfRaw.allowed_formats.includes(state.session.staged_format);
        if (_sfAllowed) {
          state.order.pending_item.format = state.session.staged_format;
          state.order.pending_item.format_source = "user";
        }
        state.session.staged_format = null;
      }
      if (Array.isArray(state.session?.staged_condiments) && state.session.staged_condiments.length && state.order.pending_item) {
        const _staged6c = state.session.staged_condiments;
        const _pi6c = state.order.pending_item;
        _pi6c.condiments = [..._staged6c];
        _pi6c.condiments_specified = true;
        _pi6c.condiments_prompted = true;
        _pi6c.prep_applied = true;
        // Fix 6: compute addon IDs so staged condiments are priced.
        const _dp6c = inferDaypartForItemId(config, _pi6c.item_id);
        const _aIds6c = mapToppingIdsToAddonIds(config, _staged6c, _dp6c);
        if (_aIds6c.length) {
          const _set6c = new Set([...(Array.isArray(_pi6c.addons) ? _pi6c.addons : [])]);
          for (const a of _aIds6c) _set6c.add(a);
          _pi6c.addons = Array.from(_set6c);
          _pi6c.price = null;
        }
        state.session.staged_condiments = null;
      }
      if (state.session?.staged_requested_temp && state.order.pending_item && state.order.pending_item.requested_temp == null) {
        state.order.pending_item.requested_temp = state.session.staged_requested_temp;
        state.order.pending_item.temp_source = "explicit";
        state.session.staged_requested_temp = null;
      }
      if (state.session?.staged_cheese_override && state.order.pending_item && state.order.pending_item.cheese_override == null) {
        state.order.pending_item.cheese_override = state.session.staged_cheese_override;
        state.session.staged_cheese_override = null;
      }
      if (Array.isArray(state.session?.staged_addons) && state.session.staged_addons.length && state.order.pending_item && state.order.pending_item.addons_specified !== true) {
        state.order.pending_item.addons = [...state.session.staged_addons];
        state.order.pending_item.addons_specified = true;
        state.order.pending_item.price = null;
        state.session.staged_addons = null;
      }
      // Apply staged toasted/heated prep modifiers (user-explicit)
      if (state.session?.staged_toasted && state.order.pending_item) {
        state.order.pending_item.toasted = true;
        state.order.pending_item.toasted_user = true;
        state.session.staged_toasted = null;
      }
      if (state.session?.staged_heated && state.order.pending_item) {
        state.order.pending_item.meat_warmed = true;
        state.order.pending_item.meat_warmed_user = true;
        state.session.staged_heated = null;
      }
    }
  }

  // Try match a menu item
  const scopedMenuIndex = forcedMenuCandidates || filterMenuIndexForUtterance(userText, menuIndex);

  // Deterministic narrowing (no fuzzy inference):
  // If the user explicitly names a meat and/or "cheese", prefer menu items whose default ingredients match.
  // This prevents ties like "turkey" selecting "pepper turkey" due to token overlap.
  const _normU = normalizeText(userText);
  // Primary-meat narrowing should ignore meats mentioned as explicit add-ons ("with bacon", "add salami", etc.).
  // This keeps add-on meats from hijacking the base sandwich selection.
  const _primaryMeatText = stripAddonMeatClauses(menuMatchText, config.meatIndex);
  // Use position-first meat detection so the first-mentioned protein wins when multiple are present
  // (e.g., "bacon sausage egg and cheese" → bacon, not sausage which is longer).
  const _explicitMeatId = inferFirstMeatFromText(_primaryMeatText, config.meatIndex);
  // Cheese narrowing: filter to items that inherently contain cheese only when the user says "cheese"
  // generically (no specific type extracted). If a specific cheese type was captured (e.g., "swiss"),
  // it's a modifier/override — do NOT exclude items like "Ham Sandwich" that have no default cheese.
  // Do NOT narrow to cheese-only items when the user explicitly negated cheese
  // (e.g. "turkey sandwich no cheese add bacon") — the word "cheese" appears but is being removed.
  const _hasNegatedCheese = /\b(no|without|hold(?:\s+the)?)\s+cheese\b/i.test(userText);
  const _wantsCheese = /\bcheese\b/.test(_normU) && !entities.cheese && !_hasNegatedCheese;

  let candidates = scopedMenuIndex;

  if (_explicitMeatId) {
    // Guard: "sausage" alone in a breakfast-context utterance (has "egg" but no "italian") refers to
    // the breakfast sausage patty (meat.sausage), not Italian sausage (meat.italian_sausage).
    // Skipping the narrowing lets scoring correctly pick "Sausage Egg & Cheese" over "Sausage" (Italian sausage sub).
    const _skipItalianSausageNarrowing =
      _explicitMeatId === "meat.italian_sausage" &&
      /\begg\b/.test(_normU) &&
      !/\bitalian\b/.test(_normU);
    if (!_skipItalianSausageNarrowing) {
      const byMeat = Array.isArray(candidates)
        ? candidates.filter(it => Array.isArray(it?.raw?.ingredient_ids?.meats) && it.raw.ingredient_ids.meats.includes(_explicitMeatId))
        : [];
      if (byMeat.length) candidates = byMeat;
    } else {
      // "sausage" in a breakfast context (has "egg", no "italian") means the breakfast
      // sausage patty (meat.sausage), not Italian sausage. Positively narrow to items
      // containing meat.sausage so scoring picks "Sausage Egg & Cheese" over "Bacon Egg & Cheese"
      // when both proteins appear in the utterance (e.g. "sausage bacon egg and cheese").
      const byBreakfastSausage = Array.isArray(candidates)
        ? candidates.filter(it => Array.isArray(it?.raw?.ingredient_ids?.meats) && it.raw.ingredient_ids.meats.includes("meat.sausage"))
        : [];
      if (byBreakfastSausage.length) candidates = byBreakfastSausage;
    }
  }

  if (_wantsCheese) {
    const byCheeseSignal = Array.isArray(candidates)
      ? candidates.filter(it => Array.isArray(it?.raw?.ingredient_ids?.cheeses) && it.raw.ingredient_ids.cheeses.length > 0)
      : [];
    if (byCheeseSignal.length) candidates = byCheeseSignal;
  }

  let best = findBestMenuItem(menuMatchText, candidates);
  // Fallback: if meat/cheese narrowing reduced candidates too aggressively and no match
  // was found, retry against the full scoped index.  This ensures e.g. "ham sandwich with
  // cheese" (where _wantsCheese filters out lunch.ham_sandwich) still finds the base item
  // so the cheese upgrade map can then upgrade it to lunch.ham_cheese.
  if (!best && candidates !== scopedMenuIndex) {
    best = findBestMenuItem(menuMatchText, scopedMenuIndex);
  }
  // Veggie sandwich fallback: when scoring finds no menu item AND the user specified
  // cheese + a sandwich format signal, >=2 toppings, or an explicit veggie/vegetarian keyword
  // — and no meat was detected — construct a dynamic pending item so the normal
  // format → bread → condiments flow fires without depending on any menu item.
  if (!best) {
    const _hasVeggieKw = /\bveg(etarian|gie)s?\b/i.test(userText);
    const _hasCheeseAndFmt = !!(entities.cheese) && /\b(sandwich|sub|roll|wrap|panini)\b/i.test(userText);
    const _toppingCount = Array.isArray(entities.condiments) ? entities.condiments.filter(id => /^topping\./.test(id)).length : 0;
    const _hasMultiToppings = _toppingCount >= 2;
    const _noMeat = !_explicitMeatId;
    if (_noMeat && (_hasVeggieKw || _hasCheeseAndFmt || _hasMultiToppings)) {
      const _vegPriceByFormat = { roll: 7.95, wrap: 7.95, sub: 9.95, bread: 7.95, toast: 7.95, panini: 7.95, mini_sub: 7.95 };
      const _vegFmt = inferFormatFromText(userText) || null;
      const _vegCondiments = Array.isArray(entities.condiments) && entities.condiments.length ? [...entities.condiments] : [];
      // Derive a customer-friendly name: use the cheese display label if present, else "Veggie Sandwich".
      const _vegCheeseLabel = entities.cheese ? (config.displayMaps?.cheeses?.[entities.cheese] || null) : null;
      const _vegName = _hasVeggieKw ? "Veggie Sandwich"
        : _vegCheeseLabel ? _vegCheeseLabel + " Sandwich"
        : "Veggie Sandwich";
      state.order.pending_item = {
        exists: true,
        name: _vegName,
        item_id: null,
        _price_by_format: _vegPriceByFormat,
        category: "lunch_sandwich",
        category_requires_bread: true,
        allowed_formats: ["roll", "sub", "wrap", "bread", "toast", "panini", "mini_sub"],
        default_format: null,
        format: _vegFmt,
        format_source: _vegFmt ? "user" : null,
        allowed_temps: ["cold"],
        default_temp: "cold",
        requested_temp: "cold",
        temp_source: "default",
        needs_condiments: true,
        meats: [],
        is_deli_by_weight: false,
        bread_type: null, bread_type_prompted: false,
        addons: [],
        addons_specified: false,
        addons_prompted: false,
        condiments: _vegCondiments,
        condiments_specified: _vegCondiments.length > 0,
        condiments_prompted: false,
        prep_applied: false,
        pressed: null, pressed_prompted: false,
        toasted: null, toasted_user: false,
        meat_warmed: null, meat_warmed_user: false,
        double_meat_requested: false, double_meat_confirmed: false,
        is_panini_override: false,
        requested_weight_lbs: null, weight_prompted: false,
        parm_item: false, parm_cheese: null, parm_cheese_prompted: false,
        dish_size: null, dish_size_prompted: false, small_only_prompted: false,
        cheese_override: entities.cheese || null,
        condiments_modifier: null, addons_modifier: null,
        cut_style: null, on_the_side: null, slice_style: null,
        quantity: null,
        is_mini_sub_override: false,
        meat_text: null, meat_id: null, price: null,
        ambiguous_mode: false, ambiguous_mode_prompted: false,
        deli_mode_sandwich_alt_item_id: null,
        has_configured_defaults: false,
        meat_mode: null, meat_mode_prompted: false,
      };
      // Consume staged values to prevent double-application in downstream blocks.
      if (state.session) {
        state.session.staged_condiments = null;
        state.session.staged_cheese_override = null;
        state.session.staged_addons = null;
      }
      entities.menu_item_id = null;
      entities.menu_item_name = _vegName;
      intent = "place_order";
    }
  }
  // If the customer explicitly mentioned a serving format (roll/sub/wrap/panini/etc),
  // do not allow a menu item that cannot be served in that format to win the match.
  // This prevents deli-by-weight items (format: by_weight only) from hijacking sandwich orders.
  const _explicitFmt = inferFormatFromText(userText);
  if (_explicitFmt && best && best.raw && Array.isArray(best.raw.allowed_formats) && !best.raw.allowed_formats.includes(_explicitFmt)) {
    const fmtFiltered = Array.isArray(candidates)
      ? candidates.filter(it => {
          const af = it?.raw?.allowed_formats;
          return !Array.isArray(af) || af.includes(_explicitFmt);
        })
      : [];
    const alt = findBestMenuItem(userText, fmtFiltered);
    if (alt) best = alt;
  }


  // Weight-first: if there are weight signals (pound/lb/oz) and no sandwich signals,
  // and the best match is a sandwich but a deli-by-weight alternative exists, prefer the deli item.
  // This handles "a pound of ham" / "half pound of turkey" where normVariant aliasing causes
  // lunch.ham_sandwich (via its "ham" normVariant) to outscore deli.ham.
  {
    const _norm2 = normalizeText(userText);
    const _wSig = (entities.weight_lbs != null) || /(lb|lbs|pound|pounds|oz|ounce|ounces|gram|grams|kg)/.test(_norm2);
    const _sSig = /(roll|sub|wrap|panini|sandwich|hero|hoagie|wedge)/.test(_norm2) || !!entities.bread_type;
    if (_wSig && !_sSig && best && best.raw && !best.raw.is_deli_by_weight) {
      // Try to find a deli-by-weight alternative that matches
      const deliCandidates = Array.isArray(candidates) ? candidates.filter(it => it && it.raw && it.raw.is_deli_by_weight) : [];
      const deliAlt = findBestMenuItem(menuMatchText, deliCandidates);
      if (deliAlt) best = deliAlt;
    }
    // Ambiguous-first: if no sandwich signals AND no weight signals AND best is a non-deli item,
    // check if a deli-by-weight item with the same name exists. If so, prefer the deli item so
    // that ASK_DELI_MODE_IF_AMBIGUOUS can ask sandwich vs. sliced (e.g. "roast beef").
    if (!_wSig && !_sSig && best && best.raw && !best.raw.is_deli_by_weight) {
      const _deliSameName = Array.isArray(candidates) ? candidates.find(it => it && it.raw && it.raw.is_deli_by_weight && it.raw.name === best.raw.name) : null;
      if (_deliSameName) best = _deliSameName;
    }
  }

  // If the best match is a deli-by-weight item but the customer is clearly ordering a sandwich (roll/sub/wrap/panini),
  // prefer a non-deli item match. This prevents cheese-by-weight items (e.g., "Cheddar Cheese") from stealing
  // "ham and cheddar on a roll" style sandwich orders.
  if (best && best.raw && best.raw.is_deli_by_weight) {
    const norm = normalizeText(userText);
    const normLower = norm;
    const sandwichSignals = /\b(roll|sub|wrap|panini|sandwich|hero|hoagie|wedge)\b/.test(normLower) || !!entities.bread_type;
    const weightSignals = (entities.weight_lbs != null) || /\b(lb|lbs|pound|pounds|oz|ounce|ounces|gram|grams|kg)\b/.test(normLower);
    const lex = state?.lexicon;
    // NOTE: meats/cheeses may be multi-word (e.g., "roast beef"). Token membership alone is insufficient.
    const hasMeat = !!lex && lex.meats && Array.from(lex.meats).some(ph => ph && norm.includes(ph));
    const hasCheese = !!lex && lex.cheeses && Array.from(lex.cheeses).some(ph => ph && norm.includes(ph));

    // If there are sandwich signals (roll/sub/wrap) but no weight signals, prefer a
    // non-deli match. This handles "turkey on a roll" where deli.turkey wins on substring
    // but the user clearly wants a sandwich. We try without hasMeat/hasCheese requirement
    // so that any bread-format signal is enough to trigger the preference.
    if (sandwichSignals && !weightSignals) {
      const filtered = Array.isArray(scopedMenuIndex) ? scopedMenuIndex.filter(it => !(it && it.raw && it.raw.is_deli_by_weight)) : [];
      const alt = findBestMenuItem(menuMatchText, filtered);
      if (alt) {
        best = alt;
      } else if (filtered.length > 0) {
        // findBestMenuItem returned null (score < threshold). But since we've already
        // confirmed sandwich signals + deli match, any item sharing >=1 token with the
        // user's phrase is a better candidate than the deli item.
        const norm2 = normalizeText(menuMatchText);
        const tokens2 = new Set(norm2.split(" ").filter(Boolean));
        let bestAlt = null, bestAltScore = 0;
        for (const it of filtered) {
          const s = scoreItemMatch(norm2, tokens2, it);
          if (s > bestAltScore) { bestAltScore = s; bestAlt = it; }
        }
        // Tiebreaker: prefer the item with fewer unmatched tokens (least "extra" ingredients).
        // e.g. "turkey" -> "turkey sandwich" (1 extra: sandwich) beats "pepper turkey" (1 extra: pepper)
        // when scores are equal, prefer fewer unmatched item tokens = simpler item.
        // Additional tiebreaker: if an explicit meat was inferred, strongly prefer items
        // whose ingredient_ids.meats contains EXACTLY that meat (not a variant like pepper_turkey).
        if (bestAltScore >= 1) {
          const norm2b = normalizeText(menuMatchText);
          const tokens2b = new Set(norm2b.split(" ").filter(Boolean));
          let bestFinal = null, bestFinalScore = -1, bestFinalExtra = 999;
          let bestFinalExactMeat = false;
          for (const it of filtered) {
            const s = scoreItemMatch(norm2b, tokens2b, it);
            if (s < 1) continue;
            const extra = it.tokens ? Array.from(it.tokens).filter(t => !tokens2b.has(t)).length : 999;
            const totalTokens = it.tokens ? it.tokens.size : 999;
            // Prefer items whose meats exactly match the inferred meat (e.g. meat.turkey not meat.pepper_turkey)
            const itemMeats = it.raw?.ingredient_ids?.meats;
            const hasExactMeat = _explicitMeatId && Array.isArray(itemMeats) && itemMeats.length === 1 && itemMeats[0] === _explicitMeatId;
            const prevHasExactMeat = bestFinalExactMeat;
            if (s > bestFinalScore || 
                (s === bestFinalScore && hasExactMeat && !prevHasExactMeat) ||
                (s === bestFinalScore && hasExactMeat === prevHasExactMeat && extra < bestFinalExtra) ||
                (s === bestFinalScore && hasExactMeat === prevHasExactMeat && extra === bestFinalExtra && totalTokens < (bestFinal?.tokens?.size ?? 999))) {
              bestFinalScore = s;
              bestFinalExtra = extra;
              bestFinalExactMeat = hasExactMeat;
              bestFinal = it;
            }
          }
          if (bestFinal) best = bestFinal;
        }
      }
    }
  }
  // Fix Bug 1 & 2: side-signal override.
  // If user said "side of X" / "a side of X" / "side order of X", prefer sides.* items
  // over deli.salad_* or lunch.* sandwich items when a sides.* item is available.
  // Fixes "side of egg salad" ($0.00 deli flow) and "a side of sausage" (sandwich loop).
  {
    const _hasSideSig = /\b(side\s+of|a\s+side\s+of|side\s+order\s+of)\b/.test(_normU);
    if (_hasSideSig && best && !/^sides\./.test(best.id)) {
      const _sideCands = Array.isArray(scopedMenuIndex) ? scopedMenuIndex.filter(it => it && /^sides\./.test(it.id)) : [];
      const _sideAlt = findBestMenuItem(menuMatchText, _sideCands);
      if (_sideAlt) best = _sideAlt;
    }
  }

  // Bug 4 fix: bare salad names (no "side of" prefix, no weight signal) that match deli.salad_*
  // should prefer the sides.* counterpart (macaroni salad, potato salad, egg salad).
  // Weight signals ("half pound", "by the weight") still route to deli path as expected.
  {
    if (best && /^deli\.salad_/.test(best.id || "")) {
      const _normU4 = normalizeText(userText);
      const _hasWeightSig4 = (entities.weight_lbs != null) || /\b(lb|lbs|pound|pounds|half|quarter)\b/.test(_normU4) || /\b\d+\s*\/\s*\d+\b/.test(_normU4) || /\bby\s+weight\b/.test(_normU4);
      if (!_hasWeightSig4) {
        const _sideCands4 = Array.isArray(scopedMenuIndex) ? scopedMenuIndex.filter(it => it && /^sides\./.test(it.id)) : [];
        const _sideAlt4 = findBestMenuItem(menuMatchText, _sideCands4);
        if (_sideAlt4) best = _sideAlt4;
      }
    }
  }

  if (best) {
    entities.menu_item_id = best.id;
    entities.menu_item_name = best.name;
    confidence = 0.97;

    // When a high-confidence menu item match is found but no order verb was used
    // (e.g. "tossed salad", "turkey sub"), upgrade intent to place_order so that
    // buildPendingItemFromMenuItem is called and the item enters the order flow.
    // Do not override conflicting intents like provide_name, hours, cancel_order, etc.
    // Do not override info/menu_question intents — entities.menu_item_id is set so
    // handleMenuQuestion can answer without starting an order.
    const _conflictingIntents = new Set(["hours","location","provide_name","provide_feedback","order_status","cancel_order","greeting"]);
    if (intent !== "place_order" && !_conflictingIntents.has(intent) && !_isConfirmIntent && !_isInfoOrDefaultsIntent) {
      intent = "place_order";
    }

    // Cheese upgrade: if the user orders a plain (no-cheese) sandwich variant but specifies
    // any cheese, switch to the corresponding "& Cheese" variant for correct base pricing.
    // e.g. "ham sandwich with swiss" → lunch.ham_cheese ($7.95 base, not $7.25 + add-on).
    // The specified cheese type (entities.cheese) is preserved for override application later.
    {
      const _hasCheeseSignal = !!(entities.cheese || _wantsCheese);
      if (best.id && CHEESE_UPGRADE_MAP[best.id] && _hasCheeseSignal) {
        const _upgradedId = CHEESE_UPGRADE_MAP[best.id];
        const _upgradedItem = Array.isArray(menuIndex) ? menuIndex.find(x => x && x.id === _upgradedId) : null;
        if (_upgradedItem) {
          best = _upgradedItem;
          entities.menu_item_id = _upgradedId;
          entities.menu_item_name = _upgradedItem.name;
        }
      }
    }

    // Breakfast double-meat upgrade: if the best match is a single-meat breakfast item and
    // the full user text mentions a second breakfast meat after "with/add/plus/and", upgrade
    // to the corresponding double-meat combo item (e.g. "bacon egg and cheese with sausage" →
    // breakfast.bacon_sausage_egg_cheese).
    if (best && /^breakfast\./.test(best.id || '') && best.raw?.allows_double_meat !== false) {
      const _bfDblRe = /\b(?:with|add(?:ed)?|plus|and)\s+(sausage|bacon|ham)\b/i;
      const _bfDblM = _bfDblRe.exec(normalizeText(userText));
      if (_bfDblM) {
        const _secKeyword = _bfDblM[1].toLowerCase();
        const _secMeatMap = { sausage: "meat.sausage", bacon: "meat.bacon", ham: "meat.ham" };
        const _secMeatId = _secMeatMap[_secKeyword];
        const _primMeats = Array.isArray(best.raw?.ingredient_ids?.meats) ? best.raw.ingredient_ids.meats : [];
        if (_secMeatId && !_primMeats.includes(_secMeatId)) {
          const _dblItem = Array.isArray(menuIndex) ? menuIndex.find(it =>
            /^breakfast\./.test(it?.raw?.id || it?.id || '') &&
            it?.raw?.allows_double_meat === false &&
            Array.isArray(it?.raw?.ingredient_ids?.meats) &&
            _primMeats.every(m => it.raw.ingredient_ids.meats.includes(m)) &&
            it.raw.ingredient_ids.meats.includes(_secMeatId)
          ) : null;
          if (_dblItem) {
            best = _dblItem;
            entities.menu_item_id = _dblItem.id || _dblItem.raw?.id;
            entities.menu_item_name = _dblItem.name;
          }
        }
      }
    }

    // Fix Item-Name Condiment Bleed (main scoring path): remove condiments whose norm appears
    // as a token in the matched item's name before staged values are applied to the pending item.
    // E.g., "pepper turkey on a roll" → "pepper" (condiment.black_pepper) is the item name token,
    // not a user-requested condiment. "sausage and peppers sub" → "peppers" is from the item name.
    {
      const _bleedItemName2 = best.raw?.name || best.name || null;
      if (_bleedItemName2 && Array.isArray(entities.condiments) && entities.condiments.length && Array.isArray(condimentIndex)) {
        const _bleedNorm2 = " " + normalizeText(_bleedItemName2) + " ";
        const _bleedIds2 = new Set();
        entities.condiments = entities.condiments.filter(cid => {
          const allNorms2 = condimentIndex.filter(ce => ce && ce.id === cid).map(ce => ce.norm);
          if (allNorms2.some(n => _bleedNorm2.includes(" " + n + " "))) { _bleedIds2.add(cid); return false; }
          return true;
        });
        if (_bleedIds2.size > 0) {
          if (state?.session?.staged_condiments) {
            state.session.staged_condiments = state.session.staged_condiments.filter(cid => !_bleedIds2.has(cid));
            if (!state.session.staged_condiments.length) state.session.staged_condiments = null;
          }
          const _daypartBleed2 = inferDaypartForItemId(config, best.id || best.raw?.id);
          const _rmAddonIds2 = new Set(mapToppingIdsToAddonIds(config, Array.from(_bleedIds2), _daypartBleed2));
          if (_rmAddonIds2.size > 0 && state?.session?.staged_addons) {
            state.session.staged_addons = state.session.staged_addons.filter(a => !_rmAddonIds2.has(a));
            if (!state.session.staged_addons.length) state.session.staged_addons = null;
          }
        }
      }
    }

    if (intent === "place_order") {
      if (!(state.order && state.order.pending_item && state.order.pending_item.exists)) {
        // Bulk quantity guard: if user orders more than 8 of a single item, refuse and direct to call the store.
        const _parsedQty = parseQuantityFromText(userText);
        const _isBulkRefused = _parsedQty !== null && _parsedQty > 8 && best.raw?.is_deli_by_weight !== true;
        if (_isBulkRefused) {
          if (state.session) state.session.bulk_quantity_refused = _parsedQty;
        } else {
        state.order.pending_item = buildPendingItemFromMenuItem(best.raw, userText);
        // Store parsed quantity (e.g. "8 ham and cheese" → quantity=8) so the multi-split
        // format-handling path can clone the item N times when the customer picks their bread.
        if (_parsedQty && _parsedQty >= 2) {
          // Fix Bug 4: guard against item names that start with the SAME digit as parsed qty.
          // "two egg omelet" → qty=2, item="2 Egg Omelet" — "two" refers to the eggs, not qty of items.
          // "3 egg omelet" → qty=3, item="2 Egg Omelet" — different digits; allow qty=3 through
          //   so readback shows "3x 2 Egg Omelet" (explicit, not silent collapse to qty=1).
          const _itemLeadDigitMatch = /^(\d+)\s/.exec(best?.raw?.name || "");
          const _itemLeadDigit = _itemLeadDigitMatch ? parseInt(_itemLeadDigitMatch[1], 10) : null;
          const _itemNameLeadNum = _itemLeadDigit !== null && _parsedQty === _itemLeadDigit;
          // Fix Cluster 4A: "two sandwiches, turkey plain roll and ham seeded sub" — "two" modifies
          // the generic category prefix (quantity of order types), not the specific first item.
          // Detected by: qty_word + generic_category + comma directly before the item spec.
          const _qtyIsGenericCategoryPrefix = /\b(?:two|three|four|five|six|seven|eight|nine|\d+)\s+(?:sandwiches?|subs?|wraps?|orders?|items?)\s*,/i.test(userText);
          if (!_itemNameLeadNum && !_qtyIsGenericCategoryPrefix) {
            state.order.pending_item.quantity = _parsedQty;
            if (state.session) state.session.last_order_utterance = userText;
          } else if (_qtyIsGenericCategoryPrefix) {
            // Strip number keywords so CAPTURE_QUANTITY_* rules don't also set quantity=N
            // on the first item after name capture (the "two" is a distribution cue, not a multiplier).
            const _numKws = new Set(["two","2","three","3","four","4","five","5","six","6","seven","7","eight","8","nine","9"]);
            entities.keywords = entities.keywords.filter(k => !_numKws.has(k));
          }
        }
        applyDishSizeToPending(state.order.pending_item, entities);
        // Deli ambiguity (deterministic): for certain items (turkey/ham/roast beef/american cheese)
        // that exist both as sliced deli meat (by weight) and as a sandwich, and when the user
        // provided neither a weight nor a bread/format signal, ask "sandwich or sliced?".
        {
          const pi = state.order.pending_item;
          const ambiguousMap = {
            "deli.turkey": "lunch.turkey_sandwich",
            "deli.ham": "lunch.ham_sandwich",
            "deli.rb": "lunch.cold_roast_beef",
            "deli.am": "lunch.chrilled_cheese",
            // Fix Issue 3: add all deli meats that also have a sandwich counterpart
            "deli.salami": "lunch.salami_cheese",
            "deli.gensal": "lunch.genoa_salami_cheese",
            "deli.bal": "lunch.bologna",
            "deli.pep": "lunch.pepperoni",
            "deli.capicola": "lunch.capicola",
            "deli.pros": "lunch.prosciutto",
            // Fix: turkey pastrami and cranberry chicken salad also have sandwich counterparts
            "deli.turkey_pastrami": "lunch.turkey_pastrami",
            "deli.salad_cranberry_chicken": "lunch.cranberry_chicken_salad_sand",
            // Fix Cluster 5: pastrami alone was skipping disambiguation (going straight to weight flow)
            "deli.pastrami": "lunch.pastrami",
          };
          const id = pi?.item_id || null;
          if (pi && pi.exists && pi.is_deli_by_weight === true && id && ambiguousMap[id]) {
            const n = normalizeText(userText);
            const sandwichSignals = /\b(roll|sub|wrap|panini|sandwich|hero|hoagie|wedge)\b/.test(n) || !!entities.bread_type || !!inferFormatFromText(userText);
            // Prepared salads (deli.salad_*) cannot be "sliced" — exclude slice-based signals for those items.
            const _isSaladItem = /^deli\.salad_/.test(id);
            const weightSignals = (entities.weight_lbs != null) || /\b(lb|lbs|pound|pounds)\b/.test(n) || /\b(half|quarter)\b/.test(n) || /\b\d+\s*\/\s*\d+\b/.test(n) || /\bby\s+weight\b/.test(n) || (!_isSaladItem && /\b(sliced?|deli\s+style|by\s+the\s+slice)\b/.test(n));
            if (!sandwichSignals && !weightSignals) {
              pi.ambiguous_mode = true;
              pi.deli_mode_sandwich_alt_item_id = ambiguousMap[id];
              // Clear format so ASK_DELI_MODE_IF_AMBIGUOUS can fire (it requires format: null).
              // Deli-by-weight items get format=by_weight from buildPendingItemFromMenuItem,
              // but for ambiguous items we need to ask sandwich vs sliced first.
              pi.format = null;
              pi.format_source = null;
            } else if (sandwichSignals && !weightSignals) {
              // Fix Issue 2: if bread type or format signals a sandwich, auto-convert the deli
              // item to the sandwich variant immediately (no deli-mode question needed).
              const altId = ambiguousMap[id];
              const altMi = altId ? getMenuItemById(config, altId) : null;
              if (altMi) {
                const prev = { ...pi };
                const next = buildPendingItemFromMenuItem(altMi, userText);
                next.quantity = prev.quantity || null;
                // Use prev.bread_type if set; fall back to entities.bread_type which may have been
                // staged (not yet on pending_item) when the fix runs before bread staging is applied.
                const _btSource = prev.bread_type || entities.bread_type || null;
                if (_btSource) { next.bread_type = _btSource; next.bread_type_prompted = true; }
                if (Array.isArray(prev.condiments) && prev.condiments.length) { next.condiments = [...prev.condiments]; next.condiments_specified = prev.condiments_specified === true; }
                if (Array.isArray(prev.addons) && prev.addons.length) { next.addons = [...prev.addons]; next.addons_specified = prev.addons_specified === true; next.price = null; }
                if (prev.cheese_override) next.cheese_override = prev.cheese_override;
                if (prev.requested_temp) { next.requested_temp = prev.requested_temp; next.temp_source = prev.temp_source || "explicit"; }
                next.ambiguous_mode = false;
                next.ambiguous_mode_prompted = true;
                next.deli_mode_sandwich_alt_item_id = null;
                // Fix 4: carry forward explicit format from utterance (e.g. "capicola sub" → format=sub).
                // Check entities.format first, then inferFormatFromText — both populated before this block.
                const _fmtFromUtterance = entities.format || inferFormatFromText(userText) || null;
                if (_fmtFromUtterance && !next.format && Array.isArray(altMi.allowed_formats) && altMi.allowed_formats.includes(_fmtFromUtterance)) {
                  next.format = _fmtFromUtterance;
                  next.format_source = "user";
                }
                // If bread type implies a format (e.g., poppy_seed_roll → format=roll), apply it.
                if (next.bread_type && !next.format && Array.isArray(breadIndex)) {
                  const _bEntry = breadIndex.find((e) => e && e.id === next.bread_type);
                  if (_bEntry && _bEntry.group && Array.isArray(altMi.allowed_formats) && altMi.allowed_formats.includes(_bEntry.group)) {
                    next.format = _bEntry.group;
                    next.format_source = "user";
                  }
                }
                state.order.pending_item = next;
                // Consume staged_bread_type so the bread staging block below doesn't re-apply it.
                if (state.session && next.bread_type) state.session.staged_bread_type = null;
              }
            }
          }
        }
        // Fix Issue 5: meatball sub vs. side dish ambiguity.
        // When user says bare "meatball" (no sandwich or side signals), ask sub or side.
        {
          const pi = state.order.pending_item;
          if (pi && pi.exists && pi.item_id === "lunch.meatball" && !pi.meatball_alt_is_side && !pi.ambiguous_mode_prompted) {
            const _n5 = normalizeText(userText);
            const _sSig5 = /\b(roll|sub|wrap|panini|sandwich|hero|hoagie|wedge)\b/.test(_n5) || !!entities.bread_type || !!inferFormatFromText(userText);
            const _sideSig5 = /\b(side|side\s+dish|side\s+order)\b/.test(_n5);
            if (!_sSig5 && !_sideSig5) {
              pi.ambiguous_mode = true;
              pi.meatball_alt_is_side = true;
              pi.ambiguous_mode_prompted = false;
              pi.format = null;
              pi.format_source = null;
            }
          }
        }
        // Immediately apply any staged bread/format captured from the same utterance (e.g., "white wrap")
        if (state.session?.staged_bread_type && state.order.pending_item && !state.order.pending_item.bread_type) {
          let _stagedBt = state.session.staged_bread_type;
          // Remap "plain roll" → "plain sub" when format is sub (same as AWAITING_BREAD_TYPE handler).
          const _pendingFmt3 = state.order.pending_item.format || state.session.staged_format || null;
          if (_pendingFmt3 === "sub" && _stagedBt === "bread.plain_roll") _stagedBt = "bread.plain_sub";
          state.order.pending_item.bread_type = _stagedBt;
          state.order.pending_item.bread_type_prompted = true;
          state.session.staged_bread_type = null;
          // Fix Issue 2: if format is still null, infer it from the bread type's group
          // (e.g., bread.poppy_seed_roll → group=roll → format=roll).
          if (!state.order.pending_item.format && Array.isArray(breadIndex)) {
            const _bEntry2 = breadIndex.find((e) => e && e.id === _stagedBt);
            if (_bEntry2 && _bEntry2.group) {
              const _allowedFmts = Array.isArray(best?.raw?.allowed_formats) ? best.raw.allowed_formats : [];
              if (_allowedFmts.length === 0 || _allowedFmts.includes(_bEntry2.group)) {
                state.order.pending_item.format = _bEntry2.group;
                state.order.pending_item.format_source = "user";
              }
            }
          }
        }
        if (state.session?.staged_format && state.order.pending_item && !state.order.pending_item.format) {
          // Guard: only apply staged_format if valid for item's allowed_formats
          const _sfRaw2 = best?.raw;
          const _sfAllowed2 = !_sfRaw2 || !Array.isArray(_sfRaw2.allowed_formats) || _sfRaw2.allowed_formats.length === 0 || _sfRaw2.allowed_formats.includes(state.session.staged_format);
          if (_sfAllowed2) {
            state.order.pending_item.format = state.session.staged_format;
            state.order.pending_item.format_source = "user";
          }
          state.session.staged_format = null;
        }

        // Immediately apply any staged toppings/condiments and related fields captured from the same utterance.
        // This is critical when we must ask for the customer's name first: we still need to preserve
        // one-shot details like "with lettuce, tomato" deterministically.
        if (state.order.pending_item && state.order.pending_item.exists) {
          const pi = state.order.pending_item;

          // Merge staged condiments into pending_item without wiping anything already applied
          // (e.g., availability "add it" confirmations).
          if (Array.isArray(state.session?.staged_condiments) && state.session.staged_condiments.length) {
            const _staged6b = state.session.staged_condiments;
            const merged = new Set([...(Array.isArray(pi.condiments) ? pi.condiments : []), ..._staged6b]);
            pi.condiments = Array.from(merged);
            pi.condiments_specified = true;
            // Fix 6: compute addon IDs so staged condiments are priced.
            const _dp6b = inferDaypartForItemId(config, pi.item_id);
            const _aIds6b = mapToppingIdsToAddonIds(config, _staged6b, _dp6b);
            if (_aIds6b.length) {
              const _set6b = new Set([...(Array.isArray(pi.addons) ? pi.addons : [])]);
              for (const a of _aIds6b) _set6b.add(a);
              pi.addons = Array.from(_set6b);
              pi.price = null;
            }
            state.session.staged_condiments = null;
          }

          // Fix Part3-1c: Apply staged condiment removals (one-shot path: "no tomato", "no mayo", etc.).
          if (Array.isArray(state.session?.staged_remove_condiments) && state.session.staged_remove_condiments.length) {
            const _toRemove = new Set(state.session.staged_remove_condiments);
            pi.condiments = Array.isArray(pi.condiments) ? pi.condiments.filter(c => !_toRemove.has(c)) : [];
            pi.condiments_specified = true;
            // Also remove any priced addon IDs that are linked to the removed topping IDs.
            const _rmAddonIds = new Set(mapToppingIdsToAddonIds(config, state.session.staged_remove_condiments, inferDaypartForItemId(config, pi.item_id)));
            if (_rmAddonIds.size > 0 && Array.isArray(pi.addons)) {
              pi.addons = pi.addons.filter(a => !_rmAddonIds.has(a));
            }
            state.session.staged_remove_condiments = null;
          }

          // Fix Part3-1c: Apply staged cheese removal from "no cheese" in one-shot utterance.
          if (state.session?.staged_cheese_removed) {
            pi.cheese_removed = true;
            pi.price = null;
            // Also strip "& Cheese" from pi.name so question prompts and readback both show the
            // cheese-free name (e.g. "Salami" not "Salami & Cheese").
            if (typeof pi.name === "string") {
              pi.name = pi.name.replace(/\s*&\s*[Cc]heese\b/g, "").trim();
            }
            state.session.staged_cheese_removed = null;
          }

          // Fix Part3-1d: No-toppings signal in one-shot utterance ("nothing on it", "no toppings", etc.).
          // Set condiments_specified=true with empty array so the condiment question is skipped.
          if (pi.condiments_specified !== true) {
            const _noToppingsOneShot = /(no\s+toppings?|no\s+condiments?|nothing\s+on\s+(it|there)|leave\s+it\s+plain|keep\s+it\s+plain|just\s+plain|plain\s+only|just\s+the\s+(bread|roll|sub|wrap)|no\s+extras?|no\s+veggies?)/i;
            if (_noToppingsOneShot.test(userText)) {
              pi.condiments = [];
              pi.condiments_specified = true;
            }
          }

          // Merge staged addon IDs (priced toppings) deterministically.
          if (Array.isArray(state.session?.staged_addons) && state.session.staged_addons.length) {
            const merged = new Set([...(Array.isArray(pi.addons) ? pi.addons : []), ...state.session.staged_addons]);
            pi.addons = Array.from(merged);
            pi.addons_specified = true;
            // Force deterministic repricing (base + addons) on finalize.
            pi.price = null;
            state.session.staged_addons = null;
          }

          // Apply staged prep-style modifiers (user-explicit: toasted / heated) from the same utterance.
          if (state.session?.staged_toasted && !pi.toasted) {
            pi.toasted = true;
            pi.toasted_user = true;
            state.session.staged_toasted = null;
          }
          if (state.session?.staged_heated && !pi.meat_warmed) {
            pi.meat_warmed = true;
            pi.meat_warmed_user = true;
            state.session.staged_heated = null;
          }

          // Also apply any explicit add-on meats mentioned in the same utterance (e.g., "with bacon", "add salami").
          // Deterministic: whole-phrase matching only; no fuzzy inference.
          const addonMeatIds = extractAddonMeatIds(userText, config.meatIndex);
          if (Array.isArray(addonMeatIds) && addonMeatIds.length) {
            const targetItemId = pi?.item_id || null;
            const daypart = inferDaypartForItemId(config, targetItemId);
            const meatAddonIds = mapMeatIdsToAddonIds(config, addonMeatIds, daypart);
            if (meatAddonIds.length) {
              const merged = new Set([...(Array.isArray(pi.addons) ? pi.addons : []), ...meatAddonIds]);
              pi.addons = Array.from(merged);
              pi.addons_specified = true;
              pi.price = null;
            }
          }

          // Breakfast secondary-meat detection: when a breakfast item is ordered and the user
          // mentions a SECOND meat type alongside the primary (e.g., "bacon sausage egg and cheese"),
          // detect it and add the corresponding breakfast extra as a priced add-on.
          // This is separate from extractAddonMeatIds() (which requires "with/add/extra" prefixes)
          // because breakfast double-meat is commonly expressed without explicit prefixes.
          {
            const _bfItemId = pi?.item_id || null;
            if (inferDaypartForItemId(config, _bfItemId) === "breakfast" && best.raw) {
              // Keyword → add-on mapping for breakfast secondary meats (deterministic).
              const _bfSecMap = [
                { kw: "turkey bacon",  addon: "addon.extra_turkey_bacon_breakfast" },
                { kw: "sausage patty", addon: "addon.extra_sausage_breakfast" },
                { kw: "breakfast sausage", addon: "addon.extra_sausage_breakfast" },
                { kw: "pastrami",      addon: "addon.extra_pastrami_breakfast" },
                { kw: "sausage",       addon: "addon.extra_sausage_breakfast" },
                { kw: "bacon",         addon: "addon.extra_bacon_breakfast" },
                { kw: "ham",           addon: "addon.extra_ham_breakfast" },
              ];
              // Build exclusion set from the item's own primary meats (so we don't add
              // the item's own meat as an "extra").
              const _bfPrimaryMeatIds = Array.isArray(best.raw.ingredient_ids?.meats)
                ? new Set(best.raw.ingredient_ids.meats)
                : new Set();
              // Map primary meat IDs to their canonical keyword(s) so we know what to exclude.
              const _bfMeatKwExclude = new Set();
              const _bfMeatKwMap = {
                "meat.bacon":         ["bacon"],
                "meat.sausage":       ["sausage", "sausage patty", "breakfast sausage"],
                "meat.ham":           ["ham"],
                "meat.pastrami":      ["pastrami"],
                "meat.turkey_bacon":  ["turkey bacon"],
                "meat.steak":         ["steak"],
                "meat.turkey":        ["turkey"],
                "meat.turkey_pastrami": ["turkey pastrami"],
              };
              for (const mid of _bfPrimaryMeatIds) {
                const kws = _bfMeatKwMap[mid];
                if (kws) for (const kw of kws) _bfMeatKwExclude.add(kw);
              }

              const _bfNorm = " " + normalizeText(userText) + " ";
              const _bfExtras = new Set();
              for (const { kw, addon } of _bfSecMap) {
                if (!_bfNorm.includes(" " + kw + " ")) continue;
                if (_bfMeatKwExclude.has(kw)) continue; // primary meat's own keyword — skip
                _bfExtras.add(addon);
              }
              if (_bfExtras.size > 0) {
                const merged = new Set([...(Array.isArray(pi.addons) ? pi.addons : []), ..._bfExtras]);
                pi.addons = Array.from(merged);
                pi.addons_specified = true;
                pi.price = null; // force repricing at finalize
              }
            }
          }

          // Apply staged cheese override if present and not already set.
          if (state.session?.staged_cheese_override && !pi.cheese_override) {
            pi.cheese_override = state.session.staged_cheese_override;
            state.session.staged_cheese_override = null;
          }

          // Apply staged requested temp if present and not already set.
          if (state.session?.staged_requested_temp && pi.requested_temp == null) {
            pi.requested_temp = state.session.staged_requested_temp;
            pi.temp_source = "explicit";
            state.session.staged_requested_temp = null;
          }
        }
        } // end !_isBulkRefused

      } else {
        // overwrite if user clearly changed item
        const curId = state.order.pending_item.item_id;
        if (curId !== best.id && /instead|change|actually|make that/.test(normalizeText(userText))) {
          state.order.pending_item = buildPendingItemFromMenuItem(best.raw, userText);
        applyDishSizeToPending(state.order.pending_item, entities);
        // Immediately apply any staged bread/format captured from the same utterance (e.g., "white wrap")
        if (state.session?.staged_bread_type && state.order.pending_item && !state.order.pending_item.bread_type) {
          state.order.pending_item.bread_type = state.session.staged_bread_type;
          state.order.pending_item.bread_type_prompted = true;
          state.session.staged_bread_type = null;
        }
        if (state.session?.staged_format && state.order.pending_item && !state.order.pending_item.format) {
          state.order.pending_item.format = state.session.staged_format;
          state.order.pending_item.format_source = "user";
          state.session.staged_format = null;
        }

        }
      }

      const fmt = inferFormatFromText(userText);
      // Guard: don't commit format="bread" when user is using recommendation language
      // (e.g. "whatever bread you recommend" → should NOT set format=bread).
      const _fmtIsRecommend = fmt === "bread" && _isRecommendLang;
      if (fmt && !_fmtIsRecommend && state.order.pending_item) {
        // Guard: only apply inferred format if valid for this item's allowed_formats.
        // Prevents "garlic bread" from setting format="bread" on a small_dish item.
        const _piForFmt = state.order.pending_item;
        const _fmtAllowedFinal = !_piForFmt.item_id
          || !Array.isArray(menuIndex)
          || (() => {
            const _miEntry = menuIndex.find(x => x && x.id === _piForFmt.item_id);
            const _af = _miEntry?.raw?.allowed_formats;
            return !Array.isArray(_af) || _af.length === 0 || _af.includes(fmt);
          })();
        if (_fmtAllowedFinal) {
          state.order.pending_item.format = fmt;
          state.order.pending_item.format_source = "user";
        }
      }
    }
  }

  // Order intent must win: if the utterance contains order signals but intent fell through to unknown,
  // force place_order with high confidence so off-topic redirects don't fire.
  if (intent === "unknown") {
    const norm = normalizeText(userText);
    const normLower = norm;
    const hasFormat = /\b(roll|sub|wrap|panini|hero|hoagie|wedge)\b/.test(normLower);
    const hasOrderVerbs = /\b(can i|could i|i\s*want|i\s*would like|i\s*ll have|get me|give me|order)\b/.test(normLower);
    const hasWeight = /\b(lb|lbs|pound|pounds|oz|ounce|ounces|g|gram|grams|kg)\b/.test(normLower) || /\b(half|quarter)\s+pound\b/.test(normLower);

    // Lexicon token check (meats/cheeses/toppings/condiments). Treat "cheese" as a signal too.
    let foodSignals = 0;
    const lex = state?.lexicon;
    if (lex) {
      for (const t of norm.split(/\s+/).filter(Boolean)) {
        if (lex.meats?.has(t) || lex.cheeses?.has(t) || lex.toppings?.has(t) || lex.condiments?.has(t) || lex.order_hints?.has(t)) {
          foodSignals += 1;
        }
      }
    }

    const hasEntitySignals = !!(entities.bread_type || entities.requested_temp || entities.weight_lbs || entities.menu_item_id);
    if (best || hasEntitySignals || hasWeight || hasFormat || hasOrderVerbs || foodSignals >= 1) {
      intent = "place_order";
      confidence = Math.max(confidence, 0.96);
    }
  }

  // Bug Cluster C Fix 2: qty + generic sandwich category ("two sandwiches", "three subs") → inject
  // canonical keywords so GENERIC_LUNCH_SANDWICH_ASK_TYPE fires and asks which kind, rather than
  // falling through to "no rule matched".
  if (!entities.menu_item_id) {
    const _genSandM = /\b(?:one|two|three|four|five|six|seven|eight|nine|\d+)\s+sandwiches\b/i.test(normLower);
    if (_genSandM) {
      if (!entities.keywords.includes("sandwich")) entities.keywords.push("sandwich");
      if (!entities.keywords.includes("lunch")) entities.keywords.push("lunch");
    }
  }

  return { intent, entities, confidence, success: confidence >= confidenceThreshold };
}

function handleMenuQuestion(nlu, menuIndex, state) {
  if (nlu.intent !== "menu_question") return null;
  let id = nlu.entities.menu_item_id;

  // If no specific item was named but there is a pending item, answer about that item.
  if (!id && state?.order?.pending_item?.exists && state?.order?.pending_item?.item_id) {
    id = state.order.pending_item.item_id;
  }

  if (!id) return "Which menu item are you asking about?";

  const hit = menuIndex.find((x) => x.id === id);
  if (!hit) return "I’m not finding that item in the menu files.";

  const ing = String(hit.raw.ingredients_text || "").trim();
  if (!ing) return `${hit.name}: ingredients text is not filled in yet for that item.`;

  // Check if it’s a build-your-own item (needs_condiments=true, no configured defaults)
  const hasCfgDefaults = hit.raw.has_configured_defaults === true ||
    (hit.raw.needs_condiments === false &&
      ((Array.isArray(hit.raw.ingredient_ids?.toppings) && hit.raw.ingredient_ids.toppings.length > 0) ||
       (Array.isArray(hit.raw.ingredient_ids?.condiments) && hit.raw.ingredient_ids.condiments.length > 0)));
  if (!hasCfgDefaults && hit.raw.needs_condiments === true) {
    return `${hit.name} is build-your-own — just tell me what you’d like on it.`;
  }

  return `${hit.name} comes with: ${ing}.`;
}

// ---- Runner State ----
function initState(config) {
  const tz = config?.hours?.timezone || "America/Chicago";

  return {
    lexicon: config?.lexicon || null,
    displayMaps: config?.displayMaps || null,
    phase: null,
    last_prompt_id: null,
    _deferred_order_text: null,
    _inline_replay_done: false,
    _inline_replay_pending: false,
    _name_captured_in_phase: false,
    _queue_replay_pending: false,
    _queue_replay_entry: null,
    _suppress_ask_anything_else_once: false,
    moderation: {
      profanity_detected: false,
      self_harm_detected: false,
      violence_threat_detected: false,
      unsafe_instructions_detected: false,
      prank_detected: false,
    },
    nlu: {
      confidence: 0,
      success: false,
    },
    session: {
      start: true,
      failed_attempts: 0,
      inline_name: null,
      staged_bread_type: null,
      staged_condiments: null,
      staged_addons: null,
      staged_format: null,
      staged_requested_temp: null,
      staged_cheese_override: null,
    },
    time: {
      local_hhmm: getLocalHHMM(tz),
    },
    intent: "unknown",
    entities: {
      customer_name: null,
      condiments: null,
      requested_temp: null,
      bread_type: null,
      meat_mode: null,
      weight_lbs: null,
      addons: null,
      keywords: [],
      dish_size: null,
      cheese: null,
      format: null,
    },
    order_readback: null,
    order: {
      active: false,
      confirmed: false,
      awaiting_readback_confirmation: false,
      awaiting_name: false,
      customer_name: null,
      // Runner-managed queue for deterministic multi-item support.
      // Entries are either:
      //  - { kind: "text", text: "<raw item phrase>" }
      //  - { kind: "snapshot", item: <pending_item object> }
      item_queue: [],
      distinct_item_count: 0,
      total_before_tax: null,
      wait_time_minutes: null,
      unserious_detected: false,
      pending_item: {
        exists: false,
        name: null,
        category: null,
        format: null,
        format_source: null,
        bread_type: null,
        bread_type_prompted: false,
        allowed_temps: null,
        default_temp: null,
        requested_temp: null,
        addons: [],
        addons_specified: false,
        addons_prompted: false,
        // Set when a menu item is selected; initState should not depend on any menu item.
        temp_source: null,
        condiments: [],
        condiments_specified: false,
        condiments_prompted: false,
        needs_condiments: null,
        pressed: null,
        pressed_prompted: false,
        toasted: null,
        meat_warmed: null,
        prep_applied: false,
        meats: null,
        meat_mode: null,
        meat_mode_prompted: false,
        double_meat_requested: false,
        double_meat_confirmed: false,
        is_panini_override: false,
        is_deli_by_weight: false,
        requested_weight_lbs: null,
        weight_prompted: false,
        category_requires_bread: null,
        parm_item: false,
        parm_cheese: null,
        parm_cheese_prompted: false,
        dish_size: null,
        dish_size_prompted: false,
        item_id: null,
        cheese_override: null,
        condiments_modifier: null,
        addons_modifier: null,
        cut_style: null,
        on_the_side: null,
        slice_style: null,
        quantity: null,
        // extra
        is_mini_sub_override: false,
        meat_text: null,
        meat_id: null,
        price: null,
      },
      items: [],
    },

    // internal
    _promptRotation: {},
  };
}

// ---- Pricing & readback helpers ----
function getMenuItemById(config, itemId) {
  if (!itemId) return null;
  return config.menuIndex.find((x) => x.id === itemId)?.raw || null;
}

function getBasePriceForFormat(menuItemRaw, format) {
  if (!menuItemRaw) return null;

  const fmt = format || null;
  if (menuItemRaw.price_by_format && fmt && menuItemRaw.price_by_format[fmt] != null) {
    return Number(menuItemRaw.price_by_format[fmt]);
  }

  // hidden_format_defaults fallbacks (common: panini/bread/toast price defaults to roll)
  const hfd = menuItemRaw.hidden_format_defaults || {};
  if (menuItemRaw.price_by_format && fmt) {
    if (fmt === "panini" && hfd.panini_price_defaults_to && menuItemRaw.price_by_format[hfd.panini_price_defaults_to] != null) {
      return Number(menuItemRaw.price_by_format[hfd.panini_price_defaults_to]);
    }
    if (fmt === "bread" && hfd.bread_price_defaults_to && menuItemRaw.price_by_format[hfd.bread_price_defaults_to] != null) {
      return Number(menuItemRaw.price_by_format[hfd.bread_price_defaults_to]);
    }
    if (fmt === "toast" && hfd.toast_price_defaults_to && menuItemRaw.price_by_format[hfd.toast_price_defaults_to] != null) {
      return Number(menuItemRaw.price_by_format[hfd.toast_price_defaults_to]);
    }
  }

  if (menuItemRaw.price != null) return Number(menuItemRaw.price);
  return null;
}


function inferDaypartForItemId(config, itemId) {
  try {
    if (!itemId) return "lunch";
    const set = config?._breakfastItemIds;
    if (set && set.has(itemId)) return "breakfast";
  } catch {
    // ignore
  }
  return "lunch";
}

function mapToppingIdsToAddonIds(config, toppingIds, daypart) {
  if (!Array.isArray(toppingIds) || toppingIds.length === 0) return [];
  const want = new Set(toppingIds);
  const out = new Set();
  const addons = config?.addons?.addons;
  if (!Array.isArray(addons) || addons.length === 0) return [];
  for (const a of addons) {
    if (!a || !a.id) continue;
    const linkTid = a?.links?.topping_id;
    if (!linkTid || !want.has(linkTid)) continue;
    const dps = a?.applies_to?.daypart;
    if (Array.isArray(dps) && daypart && !dps.includes(daypart)) continue;
    out.add(a.id);
  }
  return Array.from(out);
}


function mapMeatIdsToAddonIds(config, meatIds, daypart) {
  if (!Array.isArray(meatIds) || meatIds.length === 0) return [];
  const want = new Set(meatIds);
  const out = new Set();
  const addons = config?.addons?.addons;
  if (!Array.isArray(addons) || addons.length === 0) return [];
  for (const a of addons) {
    if (!a || !a.id) continue;
    const linkMid = a?.links?.meat_id;
    if (!linkMid || !want.has(linkMid)) continue;
    const dps = a?.applies_to?.daypart;
    if (Array.isArray(dps) && daypart && !dps.includes(daypart)) continue;
    out.add(a.id);
  }
  return Array.from(out);
}

// Deterministically find canonical IDs referenced in text using an index of {id,norm} entries.
// Whole-token match only; no fuzzy matching.
function findIdsInTextUsingIndex(raw, index) {
  const entries = Array.isArray(index) ? index : [];
  if (!entries.length) return [];
  const n = " " + normalizeText(raw) + " ";
  const out = new Set();
  for (const e of entries) {
    if (!e || !e.id || !e.norm) continue;
    const needle = " " + e.norm + " ";
    if (n.includes(needle)) out.add(e.id);
  }
  return Array.from(out);
}

function getAddonById(config, addonId) {
  return (config.addons?.addons || []).find((a) => a.id === addonId) || null;
}

function priceAddons(config, addonIds, format) {
  if (!Array.isArray(addonIds) || addonIds.length === 0) return 0;
  let total = 0;
  for (const id of addonIds) {
    const a = getAddonById(config, id);
    if (!a) continue;
    const pb = a.price_by_format || {};
    if (format && pb[format] != null) total += Number(pb[format]);
    else if (pb.roll != null) total += Number(pb.roll);
  }
  return total;
}

function buildItemReadback(item) {
  const parts = [];
  const qty = item.quantity && Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : 1;
  if (qty > 1) parts.push(`${qty}x`);

  // Temperature qualifier formatting for readback.
  // - If the item name has a contradictory leading qualifier (e.g., "Cold Roast Beef" but requested "hot"),
  //   strip it.
  // - If the customer explicitly requested a temp (hot/cold), render it as a leading adjective
  //   ("Hot Roast Beef"), not as a trailing token ("Roast Beef ... hot").
  // IMPORTANT: Do not surface default/constraint temperatures in readback.
  // Only render Hot/Cold when the temp came from the user (explicitly stated OR answered after being asked).
  // This preserves determinism while keeping readback aligned with what was actually asked.
  const ts = String(item.temp_source || "").toLowerCase();
  const showTemp = ts === "user" || ts.startsWith("user_");

  let displayName = item.name || "Item";
  const rt = item.requested_temp ? String(item.requested_temp).toLowerCase() : null;

  if (!showTemp) {
    // Strip any leading temp qualifiers from menu item names to avoid implying a temp
    // when we never asked and the user never specified.
    if (/^(hot|cold)\s+/i.test(displayName)) displayName = displayName.replace(/^(hot|cold)\s+/i, "");
  } else {
    // Deterministic: driven only by explicit requested_temp (user-sourced) and the literal item name.
    if (rt === "hot" && /^cold\s+/i.test(displayName)) displayName = displayName.replace(/^cold\s+/i, "");
    if (rt === "cold" && /^hot\s+/i.test(displayName)) displayName = displayName.replace(/^hot\s+/i, "");

    // Apply leading qualifier when temp explicitly provided and name doesn't already start with it.
    if (rt === "hot" && !/^hot\s+/i.test(displayName)) displayName = `Hot ${displayName}`;
    if (rt === "cold" && !/^cold\s+/i.test(displayName)) displayName = `Cold ${displayName}`;
  }


  // Dish and by-weight formatting for readback (deterministic).
  // - Dish sizes: show Small/Large as a leading adjective; do NOT surface internal format tokens.
  // - Deli by weight: show the weight explicitly (e.g., "1/2 lb of Ham"); do NOT render "on a By_weight".
  const fmtLower = item.format ? String(item.format).toLowerCase() : null;

  const weightLabelFromLbs = (lbs) => {
    const w = Number(lbs);
    if (!Number.isFinite(w)) return null;
    const eps = 1e-6;
    const eq = (a, b) => Math.abs(a - b) < eps;
    if (eq(w, 0.25)) return "1/4 lb";
    if (eq(w, 0.5)) return "1/2 lb";
    if (eq(w, 0.75)) return "3/4 lb";
    if (eq(w, 1)) return "1 lb";
    if (eq(w, 1.25)) return "1 1/4 lb";
    if (eq(w, 1.5)) return "1 1/2 lb";
    if (eq(w, 1.75)) return "1 3/4 lb";
    if (eq(w, 2)) return "2 lb";
    // Fallback: render up to 2 decimals deterministically.
    const s = String(Math.round(w * 100) / 100);
    return `${s} lb`;
  };

  // Only prefix "Small"/"Large" when the user explicitly chose a size (dish_size_prompted=true).
  // Single-format items (e.g. Meatball side: only small_dish) have dish_size auto-set but
  // dish_size_prompted=false — no size prefix needed for those.
  if (fmtLower === "small_dish" && item.dish_size_prompted) displayName = `Small ${displayName}`;
  if (fmtLower === "large_dish") displayName = `Large ${displayName}`;

  if (fmtLower === "by_weight") {
    const wl = weightLabelFromLbs(item.requested_weight_lbs);
    if (wl) displayName = `${wl} of ${displayName}`;
  }

  // Cheese override name substitution: if the item name contains "& Cheese" (generic placeholder)
  // and a specific cheese was requested, replace the generic with the specific type in the name.
  // Example: "Ham & Cheese" + Swiss override → displayName becomes "Ham & Swiss".
  // This must run BEFORE parts.push(displayName) so the correct name is in parts.
  const extras = [];
  let cheeseAddedToName = false;
  if (item.cheese_removed) {
    // User explicitly removed cheese via correction — strip "& Cheese" from display name.
    displayName = displayName.replace(/\s*&\s*[Cc]heese\b/g, "").trim();
  } else if (item.cheese_label) {
    if (/&\s+[Cc]heese(?:\s|$)/.test(displayName)) {
      displayName = displayName.replace(/(&\s+)[Cc]heese\b/, `$1${item.cheese_label}`);
      cheeseAddedToName = true;
    }
  }

  // Breakfast double-meat fold: when a breakfast sandwich item (contains "Egg & Cheese" in its name)
  // has secondary-meat addons (addon.extra_*_breakfast), fold the extra meat name directly into
  // the display name instead of appending "with Extra Sausage".
  // e.g. "Bacon Egg & Cheese" + addon.extra_sausage_breakfast → "Bacon Sausage Egg & Cheese"
  const _foldedLabels = new Set();
  if (Array.isArray(item.addons) && /\bEgg\s*&\s*Cheese\b/i.test(displayName)) {
    const secondaryMeats = [];
    for (const addonId of item.addons) {
      const addonIdStr = String(addonId || "");
      const bfMatch = /^addon\.extra_(.+?)_breakfast$/.exec(addonIdStr);
      if (!bfMatch) continue;
      const meatSlug = bfMatch[1]; // e.g. "sausage", "turkey_bacon"
      const meatName = meatSlug.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      secondaryMeats.push(meatName);
      _foldedLabels.add(`extra ${meatName.toLowerCase()}`);
    }
    if (secondaryMeats.length > 0) {
      displayName = displayName.replace(/(\bEgg\s*&\s*Cheese\b)/i, `${secondaryMeats.join(" ")} $1`);
    }
  }

  parts.push(displayName);

  // Bread/wrap type is more specific than format.
  if (item.bread_type_label) {
    parts.push(`on ${item.bread_type_label}`);
  } else if (item.format) {
    const fmt = String(item.format);
    const fmtLower2 = String(fmt).toLowerCase();
    if (fmtLower2 === "small_dish" || fmtLower2 === "large_dish" || fmtLower2 === "by_weight") {
      // Do not render internal dish/by-weight formats as "on a ...".
    } else {
      const fmtMap = {
        roll: "a Roll",
        wrap: "a Wrap",
        panini: "a Panini",
        sub: "a Sub",
        mini_sub: "a Mini Sub",
        toast: "Toast",
        // Group 10: "bread" format without a bread_type_label → fall back to "Plain Roll" or "Plain Sub"
        // based on item.bread_type. Never show bare "on Bread".
        bread: null,
      };
      let label = fmtMap[fmt];
      if (label === null) {
        // Format is "bread" but no bread_type_label — derive from bread_type or default to Plain Roll.
        const bt = String(item.bread_type || "").toLowerCase();
        if (bt.includes("sub")) label = "a Plain Sub";
        else label = "a Plain Roll";
      } else if (label === undefined) {
        label = `a ${fmt.charAt(0).toUpperCase()}${fmt.slice(1)}`;
      }
      parts.push(`on ${label}`);
    }
  }

  // NOTE: Temperature is rendered as a leading adjective above (Hot/Cold ...).

  // Prep-style modifiers: render after bread type, before condiments.
  if (item.toasted) parts.push("toasted");
  if (item.meat_warmed) parts.push("heated");

  if (item.cheese_label && !cheeseAddedToName) {
    // Cheese was not substituted into the name — add as an extra if not already in the name.
    const nameLower = String(displayName || "").toLowerCase();
    const cheeseLower = String(item.cheese_label || "").toLowerCase();
    // If the cheese is already expressed in the item name (e.g., "Garlic Bread with Mozzarella"),
    // don't repeat it as an extra.
    if (cheeseLower && !nameLower.includes(cheeseLower)) {
      // Also catch cases where the cheese label includes a leading "with" but the name already has the cheese word.
      const cheeseWord = cheeseLower.replace(/^with\s+/i, "").trim();
      if (!cheeseWord || !nameLower.includes(cheeseWord)) {
        extras.push(item.cheese_label);
      }
    }
  }
  if (Array.isArray(item.condiments_labels) && item.condiments_labels.length) {
    const nameLower = String(displayName || "").toLowerCase();
    for (const cl of item.condiments_labels) {
      const lab = String(cl || "").trim();
      if (!lab) continue;
      // Deterministic suppression: if the condiment label is already part of the item name, don't repeat it.
      if (nameLower.includes(lab.toLowerCase())) continue;
      extras.push(lab);
    }
  }
  // Include priced add-ons in the readback by name instead of a count.
  // Avoid repeating anything already listed in condiments/toppings.
  // Also skip addon labels that were already folded into the display name (breakfast double-meat).
  if (Array.isArray(item.addon_labels) && item.addon_labels.length) {
    const existing = new Set(extras.map((x) => String(x).trim().toLowerCase()).filter(Boolean));
    for (const al of item.addon_labels) {
      const key = String(al).trim().toLowerCase();
      if (!key) continue;
      if (existing.has(key)) continue;
      if (_foldedLabels.has(key)) continue;
      existing.add(key);
      extras.push(al);
    }
  }
  if (extras.length) parts.push(`with ${extras.join(", ")}`);

  return parts.join(" ");
}

function computeOrderReadback(state) {
  if (!Array.isArray(state.order.items) || state.order.items.length === 0) return null;
  const dm = state.displayMaps || {};
  const breadMap = dm.breads || {};
  const condMap = dm.condiments || {};
  const cheeseMap = dm.cheeses || {};
  const addonMap = dm.addons || {};

  const enriched = state.order.items.map((it) => {
    const breadLabel = it.bread_type ? (breadMap[it.bread_type] || it.bread_type) : null;
    const condLabels = (() => {
      if (!Array.isArray(it.condiments)) return [];
      const _seen = new Set();
      return Array.from(new Set(it.condiments)).map((c) => condMap[c] || c).filter((label) => {
        if (!label) return false;
        const _key = String(label).toLowerCase().trim();
        if (_seen.has(_key)) return false;
        _seen.add(_key);
        return true;
      });
    })();
    const cheeseLabel = it.cheese_override ? (cheeseMap[it.cheese_override] || it.cheese_override) : null;
    const addonLabels = Array.isArray(it.addons) ? it.addons.map((a) => addonMap[a] || a).filter(Boolean) : [];
    return {
      ...it,
      bread_type_label: breadLabel,
      condiments_labels: condLabels,
      cheese_label: cheeseLabel,
      addon_labels: addonLabels,
    };
  });

  return enriched.map((it, idx) => `(${idx + 1}) ${buildItemReadback(it)}`).join("  ");
}

function computeTotalBeforeTax(state) {
  let total = 0;
  for (const it of state.order.items || []) {
    if (typeof it.total_price === "number" && Number.isFinite(it.total_price)) {
      total += it.total_price;
    } else if (typeof it.price === "number" && Number.isFinite(it.price)) {
      total += it.price;
    }
  }
  return Number.isFinite(total) ? total : null;
}

// ---- Emits ----
function dispatchEmit(state, emit, config) {
  if (!emit || typeof emit !== "object") return;
  const type = emit.type;

  switch (type) {
    case "inventory_check_silent":
      // Stock not enforced yet (Phase 2 / application logic). No-op.
      return;

    case "reset_pending_item_keep_name": {
      const keepName = state.order.pending_item?.name || null;
      const keepId = state.order.pending_item?.item_id || null;
      const keepCat = state.order.pending_item?.category || null;
      const keepAllowedTemps = state.order.pending_item?.allowed_temps || null;
      const keepDefaultTemp = state.order.pending_item?.default_temp || null;
      const keepNeedsCond = state.order.pending_item?.needs_condiments ?? null;
      const keepCatReqBread = state.order.pending_item?.category_requires_bread ?? null;
      const keepParmItem = Boolean(state.order.pending_item?.parm_item);
      state.order.pending_item = {
        ...initState(config).order.pending_item,
        exists: true,
        name: keepName,
        item_id: keepId,
        category: keepCat,
        allowed_temps: keepAllowedTemps,
        default_temp: keepDefaultTemp,
        needs_condiments: keepNeedsCond,
        category_requires_bread: keepCatReqBread,
        parm_item: keepParmItem,
      };
      return;
    }

    case "discard_pending_item": {
      state.order.pending_item = initState(config).order.pending_item;
      // After finalizing any item, default back to "anything else" flow.
      state.phase = "AWAITING_ANYTHING_ELSE";
      return;
    }

    case "reprice_pending_item": {
      const pi = state.order.pending_item;
      const mi = getMenuItemById(config, pi.item_id);
      // Synthetic pricing for dynamically constructed items (e.g. veggie sandwich with no item_id).
      const _miForPrice = mi || (pi._price_by_format ? { price_by_format: pi._price_by_format } : null);
      const base = getBasePriceForFormat(_miForPrice, pi.format);
      const addonTotal = priceAddons(config, pi.addons, pi.format);

      // Deterministic pricing:
      // - by_weight base prices are treated as PER-POUND and multiplied by requested_weight_lbs.
      // - other formats use the base price as-is.
      if (base != null) {
        let computedBase = Number(base);
        if (String(pi.format || "").toLowerCase() === "by_weight") {
          const w = Number(pi.requested_weight_lbs);
          if (Number.isFinite(w)) computedBase = computedBase * w;
        }
        pi.price = computedBase + addonTotal;
      } else {
        pi.price = (addonTotal || addonTotal === 0) ? addonTotal : null;
      }
      return;
    }

    case "convert_pending_item_to_sandwich_alt": {
      const pi = state.order.pending_item;
      if (!pi || !pi.exists) return;
      const altId = pi.deli_mode_sandwich_alt_item_id || null;
      if (!altId) return;

      const mi = getMenuItemById(config, altId);
      if (!mi) return;

      const prev = { ...pi };
      const next = buildPendingItemFromMenuItem(mi, "");

      // Preserve deterministic fields that may have already been captured.
      next.quantity = prev.quantity || null;
      if (prev.bread_type) {
        next.bread_type = prev.bread_type;
        next.bread_type_prompted = prev.bread_type_prompted === true;
      }
      if (Array.isArray(prev.condiments) && prev.condiments.length) {
        next.condiments = [...prev.condiments];
        next.condiments_specified = prev.condiments_specified === true;
      }
      if (Array.isArray(prev.addons) && prev.addons.length) {
        next.addons = [...prev.addons];
        next.addons_specified = prev.addons_specified === true;
        next.price = null;
      }
      if (prev.cheese_override) next.cheese_override = prev.cheese_override;
      // Only inherit temp when the user explicitly set it (not a system/menu default).
      // deli.rb has default_temp="cold" but the converted sandwich must ask hot/cold fresh.
      if (prev.requested_temp && prev.temp_source !== "default") {
        next.requested_temp = prev.requested_temp;
        next.temp_source = prev.temp_source || "explicit";
      }
      // Inherit meats from the deli item so roast-beef-specific rules (ITEM_TEMP_ROAST_BEEF_ALWAYS_ASK)
      // can fire on the converted sandwich even when the sandwich menu item uses a flat ingredient_ids array.
      if ((!Array.isArray(next.meats) || next.meats.length === 0) && Array.isArray(prev.meats) && prev.meats.length > 0) {
        next.meats = [...prev.meats];
      }

      // Clear deli ambiguity flags after conversion.
      next.ambiguous_mode = false;
      next.ambiguous_mode_prompted = true;
      next.deli_mode_sandwich_alt_item_id = null;

      // Fix 4: if the user stated a format when choosing "sandwich" (e.g. "sub"), carry it forward.
      const _cvtFmt = state.entities?.format || null;
      if (_cvtFmt && !next.format && Array.isArray(mi.allowed_formats) && mi.allowed_formats.includes(_cvtFmt)) {
        next.format = _cvtFmt;
        next.format_source = "user";
      }

      state.order.pending_item = next;
      return;
    }

    case "finalize_pending_item_add_to_order": {
      const pi = state.order.pending_item;
      if (!pi || !pi.exists) return;

      // Ensure deterministic pricing before persisting item (always recompute from menu base + addons).
      {
        const mi = getMenuItemById(config, pi.item_id);
        // Synthetic pricing for dynamically constructed items (e.g. veggie sandwich with no item_id).
        const _miForPrice = mi || (pi._price_by_format ? { price_by_format: pi._price_by_format } : null);
        const base = getBasePriceForFormat(_miForPrice, pi.format);
        const addonTotal = priceAddons(config, pi.addons, pi.format);
        if (base != null) {
          let computedBase = Number(base);
          if (String(pi.format || "").toLowerCase() === "by_weight") {
            const w = Number(pi.requested_weight_lbs);
            if (Number.isFinite(w)) computedBase = computedBase * w;
          }
          pi.price = computedBase + addonTotal;
        } else {
          // If base price is unavailable, fall back to addon total deterministically.
          pi.price = (addonTotal || addonTotal === 0) ? addonTotal : null;
        }
      }

      const item = {
        id: pi.item_id,
        item_id: pi.item_id,
        name: pi.name,
        category: pi.category,
        format: pi.format,
        requested_temp: pi.requested_temp,
        temp_source: pi.temp_source,
        bread_type: pi.bread_type,
        cheese_override: pi.cheese_override,
        cheese_removed: pi.cheese_removed || false,  // Fix Part3: propagate cheese removal to readback
        addons: Array.isArray(pi.addons) ? [...pi.addons] : [],
        condiments: Array.isArray(pi.condiments) ? [...pi.condiments] : [],
        quantity: pi.quantity || 1,
        price: typeof pi.price === "number" ? pi.price : null,
        total_price: typeof pi.price === "number" ? pi.price * (Number(pi.quantity || 1) || 1) : null,
        requested_weight_lbs: pi.requested_weight_lbs,
        toasted: pi.toasted_user || false,
        meat_warmed: pi.meat_warmed_user || false,
        _batch_index: pi._batch_index || null,
        _total_batch_qty: pi._total_batch_qty || null,
        dish_size: pi.dish_size || null,
        dish_size_prompted: pi.dish_size_prompted || false,
      };
      state.order.items.push(item);
      state.order.distinct_item_count = state.order.items.length;
      state.order.active = true;

      // Batch sibling propagation: if the queue contains batch-sibling snapshots (items
      // cloned from the same multi-qty order with a single shared format), copy this item's
      // condiments, bread_type, requested_temp, and addons to all of them now so the system
      // asks each slot ONCE (for the first item) and skips the prompts for the rest.
      if (Array.isArray(state.order.item_queue) && state.order.item_queue.length > 0) {
        const _finalConds = Array.isArray(pi.condiments) ? [...pi.condiments] : [];
        const _finalAddons = Array.isArray(pi.addons) ? [...pi.addons] : [];
        for (const _qe of state.order.item_queue) {
          if (_qe && _qe.kind === "snapshot" && _qe.item && _qe.item._batch_condiment_sibling === true) {
            // Propagate condiments/addons if not already explicitly set per-item.
            if (_qe.item.condiments_specified !== true) {
              _qe.item.condiments = [..._finalConds];
              _qe.item.condiments_specified = true;
              _qe.item.condiments_prompted = true;
              if (_finalAddons.length) {
                _qe.item.addons = [..._finalAddons];
                _qe.item.addons_specified = true;
              }
              _qe.item.price = null; // force repricing on finalize
            }
            // Propagate bread_type so bread type isn't re-asked for each sibling.
            if (_qe.item.bread_type == null && pi.bread_type != null) {
              _qe.item.bread_type = pi.bread_type;
              _qe.item.bread_type_prompted = true;
            }
            // Propagate requested_temp so temp rules don't re-evaluate for siblings.
            if (_qe.item.requested_temp == null && pi.requested_temp != null) {
              _qe.item.requested_temp = pi.requested_temp;
              _qe.item.temp_source = pi.temp_source || "explicit";
            }
            _qe.item._batch_condiment_sibling = false; // clear batch flag
          }
        }
      }

      // reset pending item
      state.order.pending_item = initState(config).order.pending_item;

      // Explicitly clear any leftover staged session values so they cannot bleed
      // into the next item's build via normalizeStateAfterRules.
      // Per-item values for queued items are already baked into snapshots at queue-creation time.
      if (state.session) {
        state.session.staged_bread_type = null;
        state.session.staged_format = null;
        state.session.staged_condiments = null;
        state.session.staged_addons = null;
        state.session.staged_requested_temp = null;
        state.session.staged_cheese_override = null;
        state.session.staged_toasted = null;
        state.session.staged_heated = null;
      }

      // Deterministic multi-item: if we have queued items, schedule an immediate
      // replay of the next queued entry (same user turn) and suppress ASK_ANYTHING_ELSE.
      if (state?.order?.item_queue && Array.isArray(state.order.item_queue) && state.order.item_queue.length > 0) {
        state._queue_replay_pending = true;
        state._queue_replay_entry = state.order.item_queue.shift();
        state._suppress_ask_anything_else_once = true;
      }
      return;
    }

    case "apply_item_modification_no_duplicate": {
      // Deterministic: apply entities to a specific indexed item when provided, otherwise default to the last item.
      const items = Array.isArray(state.order.items) ? state.order.items : [];
      const ti = (state.entities && Number.isInteger(state.entities.target_index)) ? state.entities.target_index : null;
      const target = (ti != null && items[ti]) ? items[ti] : items[items.length - 1];
      if (!target) return;

      // Format/bread corrections (e.g., "second one is a sub", "first one on poppy roll")
      if (state.entities && state.entities.format) {
        const prevFormat = target.format;
        target.format = state.entities.format;
        target.format_source = "user";
        // If the format changed to a different type, the previous bread choice no longer applies.
        // Clear bread_type so it does not show in readback as if it still applies.
        if (prevFormat && prevFormat !== state.entities.format && !state.entities.bread_type) {
          target.bread_type = null;
          target.bread_type_prompted = false;
        }
      }
      if (state.entities && state.entities.bread_type) {
        target.bread_type = state.entities.bread_type;
        target.bread_type_prompted = true;
      }


      if (state.entities.requested_temp) {
        target.requested_temp = state.entities.requested_temp;
        // If the user is modifying a confirmed item and provides an explicit temp,
        // record that it came from the user so readback can include it.
        target.temp_source = "user";
      }

      if (state.entities.cheese) {
        target.cheese_override = state.entities.cheese;
        target.cheese_removed = false; // adding cheese cancels any prior removal flag
      }
      // "no cheese" correction: remove_cheese flag clears any cheese override.
      // Repricing is handled by reprice_modified_item_only (runs after this dispatcher).
      if (state.entities.remove_cheese) {
        target.cheese_override = null;
        target.cheese_removed = true; // signal buildItemReadback to strip "& Cheese" from display name
      }

      if (Array.isArray(state.entities.condiments) && state.entities.condiments.length) {
        const set = new Set([...(target.condiments || [])]);
        for (const c of state.entities.condiments) set.add(c);
        target.condiments = Array.from(set);
      }
      // Fix 1C: remove condiments that the user explicitly requested to take off.
      // Also remove the corresponding priced addon IDs (e.g., topping.hot_peppers → addon.lunch.hot_peppers)
      // so readback doesn't still show the topping via the addon_labels path.
      if (Array.isArray(state.entities.remove_condiments) && state.entities.remove_condiments.length) {
        const toRemove = new Set(state.entities.remove_condiments);
        target.condiments = Array.isArray(target.condiments)
          ? target.condiments.filter((c) => !toRemove.has(c))
          : [];
        target.condiments_specified = true;
        // Also remove any priced addon IDs that are linked to the removed topping IDs.
        const _removeAddonIds = new Set(
          mapToppingIdsToAddonIds(config, state.entities.remove_condiments, inferDaypartForItemId(config, target.id))
        );
        if (_removeAddonIds.size > 0 && Array.isArray(target.addons)) {
          target.addons = target.addons.filter((a) => !_removeAddonIds.has(a));
          target.price = null; // force repricing — removed priced addon changes the total
        }
      }

      if (Array.isArray(state.entities.addons) && state.entities.addons.length) {
        const set = new Set([...(target.addons || [])]);
        for (const a of state.entities.addons) set.add(a);
        target.addons = Array.from(set);
      }

      return;
    }

    case "reprice_modified_item_only": {
      const items = Array.isArray(state.order.items) ? state.order.items : [];
      const ti = (state.entities && Number.isInteger(state.entities.target_index)) ? state.entities.target_index : null;
      const last = (ti != null && items[ti]) ? items[ti] : items[items.length - 1];
      if (!last) return;
      // When cheese was removed, look up the cheese-free variant of the menu item for base pricing.
      // Pattern: lunch.xxx_cheese → lunch.xxx_sandwich, lunch.xxx_and_cheese → lunch.xxx_sandwich.
      let _repriceId = last.id;
      if (last.cheese_removed === true) {
        const _cand = (last.id || "")
          .replace(/_and_cheese$/, '_sandwich')
          .replace(/_cheese$/, '_sandwich');
        if (_cand !== last.id && getMenuItemById(config, _cand)) _repriceId = _cand;
      }
      // Reprice the modified item deterministically (base + addons)
      {
        const mi = getMenuItemById(config, _repriceId);
        const base = getBasePriceForFormat(mi, last.format);
        const addonTotal = priceAddons(config, last.addons, last.format);
        if (base != null) {
          last.price = base + addonTotal;
          last.total_price = last.price * (Number(last.quantity || 1) || 1);
        } else if (addonTotal != null) {
          last.price = addonTotal;
          last.total_price = last.price * (Number(last.quantity || 1) || 1);
        }
      }
      return;
    }

    case "compute_total_before_tax": {
      state.order.total_before_tax = computeTotalBeforeTax(state);
      return;
    }

    case "compute_order_readback": {
      state.order_readback = computeOrderReadback(state);
      return;
    }

    case "compute_wait_time_minutes_with_bulk_rules": {
      const n = state.order.items?.length || 0;
      // Conservative deterministic estimate. (Can be refined later.)
      state.order.wait_time_minutes = n >= 5 ? 25 : 15;
      return;
    }

    case "remove_item_from_order": {
      if (!Array.isArray(state.order.items) || state.order.items.length === 0) return;
      state.order.items.pop();
      state.order.distinct_item_count = state.order.items.length;
      return;
    }

    case "submit_order": {
      // This runner does not integrate with POS.
      // Mark confirmed so the close flow can end deterministically.
      state.order.confirmed = true;
      state.order.awaiting_readback_confirmation = false;
      return;
    }

    case "apply_item_default_ingredients": {
      // Apply the item's configured default toppings/condiments to the pending item.
      // Used when the user says "as it comes" or "the usual".
      const pi = state.order?.pending_item;
      if (!pi || !pi.exists) return;
      const mi = getMenuItemById(config, pi.item_id);
      if (!mi) return;
      const ids = mi.ingredient_ids || {};
      const defaultIds = [
        ...(Array.isArray(ids.toppings) ? ids.toppings : []),
        ...(Array.isArray(ids.condiments) ? ids.condiments : []),
      ];
      pi.condiments = defaultIds;
      pi.condiments_specified = true;
      pi.condiments_prompted = true;
      // If bread type still needs to be chosen, reset bread_type_prompted so
      // ASK_BREAD_TYPE_IF_MISSING can re-fire after this pass-through.
      if (!pi.bread_type && pi.bread_type_prompted) {
        pi.bread_type_prompted = false;
      }
      // Configured defaults are included in the item's base price — do NOT add
      // them as priced addon charges.
      return;
    }

    case "apply_item_default_ingredients_with_removals": {
      // Apply item defaults then remove explicitly excluded condiments.
      // Used when user says "as it comes but no X".
      const pi = state.order?.pending_item;
      if (!pi || !pi.exists) return;
      const mi = getMenuItemById(config, pi.item_id);
      if (!mi) return;
      const ids = mi.ingredient_ids || {};
      const allDefaults = [
        ...(Array.isArray(ids.toppings) ? ids.toppings : []),
        ...(Array.isArray(ids.condiments) ? ids.condiments : []),
      ];
      const toRemove = new Set(Array.isArray(state.entities?.remove_condiments) ? state.entities.remove_condiments : []);
      const filtered = allDefaults.filter((id) => !toRemove.has(id));
      pi.condiments = filtered;
      pi.condiments_specified = true;
      pi.condiments_prompted = true;
      // If bread type still needs to be chosen, reset bread_type_prompted so
      // ASK_BREAD_TYPE_IF_MISSING can re-fire after this pass-through.
      if (!pi.bread_type && pi.bread_type_prompted) {
        pi.bread_type_prompted = false;
      }
      // Build human-readable label for removed items (used by {removed_items} placeholder).
      const condMap = config?.displayMaps?.condiments || {};
      state._last_removed_defaults_labels = Array.from(toRemove)
        .map((id) => condMap[id] || id.replace(/^(condiment|topping)\./, "").replace(/_/g, " "))
        .join(", ");
      // Configured defaults (including the reduced set after removals) are included in the
      // item's base price — do NOT add them as priced addon charges.
      return;
    }

    case "reapply_item_defaults_to_finalized_item": {
      // Reapply configured defaults to an already-finalized order item (correction mode).
      // Finds the most recent item matching the user's target (by entity target_index or last).
      const items = Array.isArray(state.order?.items) ? state.order.items : [];
      const ti = (state.entities && Number.isInteger(state.entities.target_index)) ? state.entities.target_index : null;
      const target = (ti != null && items[ti]) ? items[ti] : items[items.length - 1];
      if (!target) return;
      const mi = getMenuItemById(config, target.id);
      if (!mi) return;
      const ids = mi.ingredient_ids || {};
      const defaultIds = [
        ...(Array.isArray(ids.toppings) ? ids.toppings : []),
        ...(Array.isArray(ids.condiments) ? ids.condiments : []),
      ];
      target.condiments = defaultIds;
      target.condiments_specified = true;
      // Reprice
      const daypart = inferDaypartForItemId(config, target.id);
      const addonIds = mapToppingIdsToAddonIds(config, defaultIds, daypart);
      target.addons = addonIds;
      target.price = null;
      const base = getBasePriceForFormat(mi, target.format);
      const addonTotal = priceAddons(config, target.addons, target.format);
      if (base != null) {
        target.price = base + addonTotal;
        target.total_price = target.price * (Number(target.quantity || 1) || 1);
      }
      return;
    }

    default:
      return;
  }
}

// ---- Actions ----
function applySetObject(state, setObj, ctx) {
  for (const [k, vRaw] of Object.entries(setObj || {})) {
    // increment operation: { "session.failed_attempts.increment": 1 }
    if (k.endsWith(".increment")) {
      const basePath = k.slice(0, -".increment".length);
      const current = getPath(state, basePath);
      const delta = Number(resolveValueTemplates(vRaw, ctx) || 0);
      const next = (Number(current) || 0) + delta;
      setPath(state, basePath, next);
      continue;
    }

    const v = resolveValueTemplates(vRaw, ctx);
    setPath(state, k, v);
  }
}

function applyActions(state, actions, promptMap, config, outputs) {
  let ended = false;

  for (const a of actions) {
    const ctx = buildCtx(state, config);

    if (a.set) {
      applySetObject(state, a.set, ctx);
    }

    if (a.emit) {
      // Inline emit processing: emits must affect subsequent responds in the same rule.
      const _emitResolved = resolveValueTemplates(a.emit, ctx);
      dispatchEmit(state, _emitResolved, config);
      outputs.emits.push(a.emit);
      // Duplicate-finalization guard: once an item is finalized in this turn,
      // mark the flag so the rule engine can stop after this rule completes.
      if (_emitResolved && _emitResolved.type === 'finalize_pending_item_add_to_order') {
        outputs._finalized_this_turn = true;
      }
    }

    if (a.respond) {
      const pid = a.respond.prompt_id;
       if (process.env.NAPOLI_DEBUG_PROMPTS === "1") {
         console.log(`[NAPOLI_DEBUG] responding prompt_id=${pid}`);
       }

      // Multi-item queue: if we just finalized an item and we have queued work,
      // suppress the generic "Anything else?" prompt once so we can immediately
      // proceed to the next queued item.
      if (pid === "ASK_ANYTHING_ELSE" && state?._suppress_ask_anything_else_once === true) {
        state._suppress_ask_anything_else_once = false;
        continue;
      }

      // Update phase/slot context deterministically whenever we emit a PromptID.
      setPhaseFromPromptId(state, pid);

      // If we have an inline "for <name>" and the rules are about to ask for a name,
      // suppress the prompt and inject a virtual name-provide turn.
      if (false && pid === "ASK_NAME_FOR_ORDER" && state?.session?.inline_name) {
        const inlineName = String(state.session.inline_name || "").trim();
        if (inlineName) {
          state._auto_name_from_inline = true;
          state.intent = "provide_name";
          state.entities = { ...state.entities, customer_name: inlineName };
          state.nlu.confidence = 0.99;
          state.nlu.success = true;
          if (state.order) {
            state.order.awaiting_name = false;
            state.order.active = true;
          }
          state.session.inline_name = null;
          // Do not push a user-visible ASK_NAME prompt.
          continue;
        }
      }

      // If we have a deferred order text (user ordered before giving name),
      // suppress the generic "What can I get started for you?" and continue the flow.
      // If user ordered before giving name, suppress NAME_CONFIRMED_CONTINUE so we can replay deferred order immediately.
      if (pid === "NAME_CONFIRMED_CONTINUE" && state?._deferred_order_text) {
        // Do not push a user-visible response here; main() will replay deferred text and produce the next prompt.
        // BUT we must still signal stop_on_first_match so the engine doesn't cascade into order flow rules.
        outputs._silent_stop = true;
      } else {
        const txt = resolvePromptText(promptMap, pid, state, buildCtx(state, config));
        outputs.responses.push(txt);
      }
    }

    if (a.end) ended = true;
  }

  return ended;
}

function buildCtx(state, config) {
  // Merge context for prompt/rule templates.
  // Prompts reference {business.*} and {hours.*}.
  // Some PromptID templates also use top-level variables like {format}.
  const fmt =
    state?.order?.pending_item?.format ??
    state?.entities?.format ??
    null;

  const formatLabel =
    fmt === "mini_sub" ? "mini sub" :
    fmt === "small_dish" ? "small dish" :
    fmt === "large_dish" ? "large dish" :
    fmt ? String(fmt).replace(/_/g, " ") : "";


  const bt = state?.order?.pending_item?.bread_type ?? state?.entities?.bread_type ?? null;
  const breadLabel = bt ? (config?.displayMaps?.breads?.[bt] || bt) : "";
  const bread_phrase = breadLabel ? ` on ${breadLabel}` : "";

  // Resolve ingredients_text for the pending item (used by ASK_NAMED_ITEM_AS_IT_COMES prompt).
  const _piForCtx = state?.order?.pending_item;
  const _miForCtx = (_piForCtx?.item_id && config) ? getMenuItemById(config, _piForCtx.item_id) : null;
  const _ingredientsText = _miForCtx?.ingredients_text || "";

  return {
    ...state,
    business: config.business?.business || config.business || {},
    hours: config.hours || {},
    format: formatLabel,
    bread_label: breadLabel,
    bread_phrase: bread_phrase, // supports templates like "What kind of {format} would you like?"
    item: { ingredients_text: _ingredientsText },
    removed_items: state._last_removed_defaults_labels || "",
  };
}

function runRulesOnce(state, config) {
  const rulesJson = config.rulesJson;
  const promptMap = config.promptMap;
  const engine = rulesJson.engine || {};

  const rules = [...(rulesJson.rules || [])].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const outputs = { responses: [], emits: [], matched: false, _finalized_this_turn: false };

  for (const rule of rules) {
    const ctx = buildCtx(state, config);

    const inOrderFlow =
      state?.order?.active === true ||
      state?.order?.pending_item?.exists === true ||
      state?.order?.awaiting_name === true ||
      !!state?.phase;

    if (inOrderFlow && typeof rule.id === "string" && rule.id.startsWith("TOPIC_OFF_TOPIC_REDIRECT")) {
      continue;
    }
    if (!evalWhen(state, rule.when, ctx)) continue;
    if (process.env.NAPOLI_DEBUG_PROMPTS === "1") {
      console.log(`[NAPOLI_DEBUG] matched_rule=${rule.id} intent=${state.intent} phase=${state.phase} pending_exists=${state.order?.pending_item?.exists} pending_format=${state.order?.pending_item?.format} cond_specified=${state.order?.pending_item?.condiments_specified} prep_applied=${state.order?.pending_item?.prep_applied}`);
    }

    outputs.matched = true;
    const ended = applyActions(state, rule.then || [], promptMap, config, outputs);

    // Normalize checkbox-style slot completion between rule matches
    normalizeStateAfterRules(state, config);

    if (ended) break;
    if (engine.stop_on_first_match === true && (outputs.responses.length || outputs._silent_stop || outputs._finalized_this_turn)) break;
  }

  return outputs;
}



function normalizeStateAfterRules(state, config) {
  if (!state || !state.order) return;

  // Name checkbox: if committed, stop awaiting.
  if (state.order.customer_name != null && state.order.customer_name !== "") {
    state.order.awaiting_name = false;
    if (state.phase === "AWAITING_NAME") state.phase = null;
    if (state.session) state.session.inline_name = null;
  }

  const pi = state.order?.pending_item;
  if (!pi) return;

  // Bread checkbox: if bread_type exists, treat as satisfied and avoid re-asking.
  if (pi.bread_type != null && pi.bread_type !== "") {
    pi.bread_type_prompted = true;
  } else if (pi.exists === true && !pi.bread_type && state.session?.staged_bread_type) {
    // Auto-apply staged bread type once a real pending item exists (pi.exists guard prevents
    // consuming staged values against the placeholder pending_item before it has been populated).
    pi.bread_type = state.session.staged_bread_type;
    pi.bread_type_prompted = true;
    state.session.staged_bread_type = null;
  }

  // Format checkbox: if format exists, treat as satisfied; otherwise auto-apply staged format.
  if (pi.format != null && pi.format !== "") {
    // no-op
  } else if (pi.exists === true && !pi.format && state.session?.staged_format) {
    pi.format = state.session.staged_format;
    pi.format_source = "user";
    state.session.staged_format = null;
  }

  // If we have a specific wrap type on the pending item, format must be "wrap".
  // This is deterministic (bread_type IDs ending in _wrap are unambiguous).
  if (pi.exists === true && !pi.format && typeof pi.bread_type === "string" && /_wrap$/.test(pi.bread_type)) {
    pi.format = "wrap";
    pi.format_source = pi.format_source || "explicit";
  }

  // Condiments checkbox: once specified (including empty = none), treat as satisfied.
  // Also treat this as prep handled for finish-order logic.
  if (pi.condiments_specified === true) {
    pi.condiments_prompted = true;
    pi.prep_applied = true;
    if (state.phase === "AWAITING_TOPPINGS_OR_CONDIMENTS") state.phase = null;
  } else if (pi.exists === true && pi.condiments_specified !== true && Array.isArray(state.session?.staged_condiments) && state.session.staged_condiments.length) {
    // Auto-apply staged condiments once a REAL pending item exists (pi.exists guard).
    pi.condiments = [...state.session.staged_condiments];
    pi.condiments_specified = true;
    pi.condiments_prompted = true;
    pi.prep_applied = true;
    // Fix 6: also compute and add addon IDs so condiments are priced correctly.
    if (config) {
      const _dp6a = inferDaypartForItemId(config, pi.item_id);
      const _aIds6a = mapToppingIdsToAddonIds(config, state.session.staged_condiments, _dp6a);
      if (_aIds6a.length) {
        const _set6a = new Set([...(Array.isArray(pi.addons) ? pi.addons : [])]);
        for (const a of _aIds6a) _set6a.add(a);
        pi.addons = Array.from(_set6a);
        pi.price = null;
      }
    }
    state.session.staged_condiments = null;
    if (state.phase === "AWAITING_TOPPINGS_OR_CONDIMENTS") state.phase = null;
  }

  // If the item explicitly does NOT need condiments, consider prep handled.
  if (pi.needs_condiments === false) {
    pi.prep_applied = true;
  }

  // Auto-apply staged temperature once a real pending item exists.
  if (pi.exists === true && pi.requested_temp == null && state.session?.staged_requested_temp) {
    pi.requested_temp = state.session.staged_requested_temp;
    pi.temp_source = "explicit";
    state.session.staged_requested_temp = null;
    if (state.phase === "AWAITING_TEMP") state.phase = null;
  }

  // Auto-apply staged cheese override once a real pending item exists.
  if (pi.exists === true && pi.cheese_override == null && state.session?.staged_cheese_override) {
    pi.cheese_override = state.session.staged_cheese_override;
    state.session.staged_cheese_override = null;
  }

  // Auto-apply staged add-ons once a real pending item exists.
  if (pi.exists === true && pi.addons_specified !== true && Array.isArray(state.session?.staged_addons) && state.session.staged_addons.length) {
    pi.addons = [...state.session.staged_addons];
    pi.addons_specified = true;
        // Force deterministic repricing (base + addons) on finalize.
        pi.price = null;
    state.session.staged_addons = null;
  }

  // Auto-apply staged toasted/heated prep modifiers once a real pending item exists (user-explicit).
  if (pi.exists === true && !pi.toasted && state.session?.staged_toasted) {
    pi.toasted = true;
    pi.toasted_user = true;
    state.session.staged_toasted = null;
  }
  if (pi.exists === true && !pi.meat_warmed && state.session?.staged_heated) {
    pi.meat_warmed = true;
    pi.meat_warmed_user = true;
    state.session.staged_heated = null;
  }

  // Safety: once any item has been committed to the order, deferred order replay is no longer valid.
  // This prevents accidental duplication where a stored pre-name order is replayed later in the flow.
  if (Array.isArray(state.order.items) && state.order.items.length > 0 && state._deferred_order_text) {
    state._deferred_order_text = null;
  }

}

function applyAutoMultiSplitFromExplicitBreads(state, config) {
  try {
    if (!state || !config) return;
    if (!state.order?.pending_item?.exists) return;
    const qty = Number(state.order.pending_item.quantity || 0) || 0;
    if (qty < 2) return;
    if (!state.session) return;
    if (state.session.multi_qty_split_applied === true) return;

    const breads = Array.isArray(state.session.multi_qty_per_item_breads)
      ? state.session.multi_qty_per_item_breads
      : null;
    if (!breads || breads.length !== 2) return;

    // Only auto-split when we have an item queue to hold the clones.
    if (!Array.isArray(state.order.item_queue)) return;

    const base = JSON.parse(JSON.stringify(state.order.pending_item));

    // Ensure we have a stable order utterance available for deterministic binding.
    const orderText = state.session.last_order_utterance || state._deferred_order_text || "";
    let perItemConds = Array.isArray(state.session.multi_qty_per_item_condiments)
      ? state.session.multi_qty_per_item_condiments
      : null;
    if (!perItemConds && orderText) {
      const bind = parseExplicitPerItemCondimentBinding(orderText, config);
      if (bind && Array.isArray(bind.lists) && bind.lists.length === 2) {
        perItemConds = bind.lists;
        state.session.multi_qty_per_item_condiments = bind.lists;
        state.session.multi_qty_per_item_condiments_source = bind.source || "explicit";
      }
    }

    const inferFmtFromBreadId = (id) => {
      const arr = Array.isArray(config.breadIndex) ? config.breadIndex : [];
      const hit = arr.find((x) => x && (x.id === id));
      return hit?.group || null;
    };

    const makeItem = (breadId, idx) => {
      const it = JSON.parse(JSON.stringify(base));
      it.exists = true;
      it.quantity = 1;
      // Preserve explicit format if already known; otherwise infer from bread group, else roll.
      it.format = it.format || inferFmtFromBreadId(breadId) || "roll";
      it.format_source = it.format_source || "user";
      it.bread_type = breadId || null;
      it.bread_type_prompted = true;
      it._batch_index = idx + 1;
      it._total_batch_qty = breads.length;

      if (perItemConds && Array.isArray(perItemConds[idx])) {
        it.condiments = [...perItemConds[idx]];
        it.condiments_specified = true;
        it.condiments_prompted = true;
        it.prep_applied = true;
      }
      return it;
    };

    const first = makeItem(breads[0], 0);
    const second = makeItem(breads[1], 1);

    state.order.pending_item = first;
    // Queue second immediately so it completes before any later "and also" items.
    state.order.item_queue = [{ kind: "snapshot", item: second }, ...state.order.item_queue];

    // Mark applied so we don't split repeatedly.
    state.session.multi_qty_split_applied = true;

    // Clear one-shot bread selection after applying.
    state.session.multi_qty_per_item_breads = null;
    state.session.multi_qty_per_item_breads_source = null;

    // Clear per-item condiments binding after applying to this split.
    state.session.multi_qty_per_item_condiments = null;
    state.session.multi_qty_per_item_condiments_source = null;
  } catch {
    // never throw from runner; determinism > crashing
  }
}

function clearTransientInput(state) {
  state.intent = null;
  state.entities = {};
  state._name_input_consumed = false;
}

function runRulesStepped(state, config, maxSteps = 20) {
  let last = { responses: [], emits: [], matched: false };
  const combined = { responses: [], emits: [], matched: false };

  // Deterministic pre-hook: if the user explicitly specified per-item breads
  // for a multi-quantity sandwich ("one on X and one on Y"), split the pending
  // item before rules run so toppings/prep are handled item-by-item.
  applyAutoMultiSplitFromExplicitBreads(state, config);

  // Fix Part5-2: While "both the same" DUO sentinel is active, suppress all rules.
  // The multi-qty AWAITING_FORMAT handler clears the sentinel on the next user turn
  // (when "plain rolls", "plain subs", etc. is provided).
  if (state?.order?.pending_item?.format === "_same_tbd") {
    return combined;
  }

  // Fix Part6-1: While a correction-mode bread follow-up is pending, suppress all rules.
  // Prevents FLOW_ORDER_ACTIVE_NO_MATCH_FALLBACK_CLARIFY from firing in the inline
  // correction replay path after Fix 4A sets phase=AWAITING_BREAD_TYPE.
  if (state._correction_awaiting_bread != null) {
    return combined;
  }

  const hasOrderSignalEntities = (ents) => {
    if (!ents) return false;
    return Boolean(
      ents.menu_item ||
      ents.meat ||
      ents.cheese ||
      ents.format ||
      ents.bread_type ||
      ents.requested_temp ||
      ents.weight_lbs ||
      (Array.isArray(ents.condiments) && ents.condiments.length)
    );
  };

  for (let i = 0; i < maxSteps; i++) {
    const out = runRulesOnce(state, config);
    last = out;
    normalizeStateAfterRules(state, config);

    combined.matched = combined.matched || Boolean(out.matched);
    if (out.responses && out.responses.length) {
      combined.responses.push(...out.responses);
    }
    if (out.emits && out.emits.length) {
      combined.emits.push(...out.emits);
    }

    // If a step produced user-visible output (or a silent stop was signaled), stop stepping so we don't
    // accidentally run follow-on rules that finalize/duplicate items in the
    // same turn. We'll wait for the next user input.
    //
    // EXCEPTION: short confirmation prompts (bread type ack, pressed ack) are pure
    // acknowledgements — the user expects the very next question to follow in the
    // same response turn. For these PIDs we clear transient input and keep stepping.
    if (out.responses && out.responses.length) {
      const _passThroughPids = new Set([
        "BREAD_TYPE_CONFIRMED_SHORT",
        "PRESSED_CONFIRMED_SHORT",
        "NOT_PRESSED_CONFIRMED_SHORT",
        "NAMED_ITEM_DEFAULTS_APPLIED",
        "NAMED_ITEM_DEFAULTS_APPLIED_WITH_REMOVALS",
      ]);
      if (_passThroughPids.has(state.last_prompt_id)) {
        clearTransientInput(state);
        continue;
      }
      return combined;
    }
    if (out._silent_stop) return combined;
    if (!out.matched) return combined;

    // A rule matched but produced no response (set/emit only).
    // We usually clear transient input so the next rule can fire.
    // BUT: if we're carrying critical capture payload (like a name) that
    // has not yet been committed into order state, we must not clear it.
    const pendingNameCommit =
      state.intent === "provide_name" &&
      state.entities &&
      state.entities.customer_name &&
      state.order &&
      state.order.customer_name == null;

    const pendingOrderStart =
      state.intent === "place_order" &&
      hasOrderSignalEntities(state.entities) &&
      state.order &&
      state.order.active !== true &&
      state.order?.pending_item?.exists !== true;

    if (state._auto_name_from_inline === true) {
      state._auto_name_from_inline = false;
      continue;
    }

    if (pendingNameCommit || pendingOrderStart) {
      continue;
    }

    clearTransientInput(state);
  }
  return combined;
}


function loadConfig() {
  const rulesJson = loadJson("rules.json");
  const promptIdJson = loadJson("PromptID.json");

  const menus = [
    safeLoadJson("menu_breakfast.json"),
    safeLoadJson("menu_lunch_sandwiches.json"),
    safeLoadJson("menu_panini.json"),
    safeLoadJson("menu_deli_by_weight.json"),
    safeLoadJson("menu_side_dishes.json"),
  ].filter(Boolean);

  const business = safeLoadJson("business.json") || {};
  const hours = safeLoadJson("hours.json") || {};
  const reference = safeLoadJson("reference.json") || {};
  const addons = safeLoadJson("addons.json") || {};

  // ---- Addons normalization (deterministic) ----
  // Pricing logic expects a flat `addons.addons` array. The config stores
  // addons by category (e.g., `sandwich_addons`, `salad_addons`).
  // Normalize into `addons.addons` without changing semantics.
  const flatAddons = [];
  if (Array.isArray(addons.addons)) flatAddons.push(...addons.addons);
  if (Array.isArray(addons.sandwich_addons)) flatAddons.push(...addons.sandwich_addons);
  if (Array.isArray(addons.salad_addons)) flatAddons.push(...addons.salad_addons);

  // De-duplicate deterministically by addon id.
  const seenAddonIds = new Set();
  addons.addons = [];
  for (const a of flatAddons) {
    const id = a?.id;
    if (typeof id !== "string") continue;
    if (seenAddonIds.has(id)) continue;
    seenAddonIds.add(id);
    addons.addons.push(a);
  }

  const promptMap = buildPromptMap(promptIdJson);
  const keywordPhrases = collectKeywordPhrasesFromRules(rulesJson);
  const menuIndex = buildMenuIndex(menus);
  const breadIndex = buildBreadIndex(reference);
  const condimentIndex = buildCondimentIndex(reference);
  const cheeseIndex = buildCheeseIndex(reference);
  const meatIndex = buildMeatIndex(reference);
  const addonIndex = buildAddonIndex(addons);
  const displayMaps = buildDisplayMaps(reference);
  // Addon display map (deterministic): used only for readback rendering.
  // Pricing uses the normalized `addons.addons` records.
  displayMaps.addons = {};
  if (Array.isArray(addons.addons)) {
    for (const a of addons.addons) {
      const id = a?.id;
      if (typeof id !== "string") continue;
      const name = a?.name;
      displayMaps.addons[id] = (typeof name === "string" && name.trim()) ? name.trim() : id;
    }
  }
  const lexicon = buildLexicon(reference);
  const menuItemAliases = buildMenuItemAliasMap(reference);

  // Precompute breakfast item IDs for deterministic daypart checks.
  const _breakfastItemIds = new Set();
  for (const m of menus) {
    const items = m?.items;
    if (!Array.isArray(items) || items.length === 0) continue;
    const isBreakfastMenu = items.some((it) => typeof it?.id === "string" && it.id.startsWith("breakfast."));
    if (!isBreakfastMenu) continue;
    for (const it of items) {
      if (typeof it?.id === "string") _breakfastItemIds.add(it.id);
    }
  }

  return {
    rulesJson,
    promptMap,
    keywordPhrases,
    menuIndex,
    menus,
    business,
    hours,
    reference,
    addons,
    menuItemAliases,
    breadIndex,
    condimentIndex,
    cheeseIndex,
    meatIndex,
    addonIndex,
    displayMaps,
    lexicon,
    _breakfastItemIds,
  };
}



// ---- Phase/slot context (deterministic) ----
function setPhaseFromPromptId(state, promptId) {
  if (!state) return;
  const pid = String(promptId || "");
  state.last_prompt_id = pid || null;

  if (pid === "ASK_NAME_FOR_ORDER") {
    state.phase = "AWAITING_NAME";
    if (state.order) state.order.awaiting_name = true;
    return;
  }

  // After readback "No" the rules ask what to change.
  // Next user input should be treated as an order modification, not a new item.
  if (pid === "OKAY_WHAT_SHOULD_I_FIX") {
    state.phase = "AWAITING_ORDER_CORRECTION";
    return;
  }

  // After asking "Anything else?" next user input is either finish_order or a new item.
  if (pid === "ASK_ANYTHING_ELSE") {
    state.phase = "AWAITING_ANYTHING_ELSE";
    return;
  }

  if (pid === "ASK_SANDWICH_FORMAT" || pid === "ASK_SANDWICH_FORMAT_MULTI" || pid === "ASK_SANDWICH_FORMAT_DUO" || pid === "FORMAT_PANINI_NOT_SUGGESTED") {
    state.phase = "AWAITING_FORMAT";
    return;
  }

  if (pid === "ASK_BREAD_TYPE" || pid === "ASK_SUB_BREAD_TYPE") {
    state.phase = "AWAITING_BREAD_TYPE";
    if (state.order?.pending_item) state.order.pending_item.bread_type_prompted = true;
    return;
  }

  // Confirming bread type clears the AWAITING_BREAD_TYPE phase so condiment-asking
  // and finalization rules can fire freely on subsequent steps.
  if (pid === "BREAD_TYPE_CONFIRMED_SHORT") {
    if (state.phase === "AWAITING_BREAD_TYPE") state.phase = null;
    return;
  }

  if (pid === "ASK_WRAP_TYPE") {
    state.phase = "AWAITING_WRAP_TYPE";
    return;
  }

  if (pid === "ASK_CONDIMENTS_OR_TOPPINGS" || pid === "ASK_NAMED_ITEM_AS_IT_COMES") {
    state.phase = "AWAITING_TOPPINGS_OR_CONDIMENTS";
    return;
  }

  // Temperature (hot/cold) slot
  // Some prompts are phrased as confirmations (e.g., CONFIRM_TEMP_OVERRIDE) but still expect a temp/yes-no reply.
  if (pid === "ASK_HOT_OR_COLD_ROAST_BEEF" || pid === "ASK_HOT_OR_COLD" || pid === "CONFIRM_TEMP_OVERRIDE" || pid === "DELI_TEMP_NOT_CHANGEABLE") {
    state.phase = "AWAITING_TEMP";
    return;
  }

  if (pid === "CLARIFY_APPLY_TO_ALL_OR_LAST") {
    state.phase = "AWAITING_APPLY_SCOPE";
    return;
  }

  // Salad selection (after asking which salad)
  if (pid === "ASK_SALAD_ITEM") {
    state.phase = "AWAITING_SALAD_ITEM";
    return;
  }
  // Dish size (small/large) for salads/sides/dishes
  if (pid === "ASK_DISH_SIZE_SMALL_OR_LARGE") {
    state.phase = "AWAITING_DISH_SIZE";
    return;
  }

  if (pid === "SIDE_DISH_ONLY_COMES_SMALL_CONFIRM") {
    state.phase = "AWAITING_SIDE_DISH_SMALL_CONFIRM";
    return;
  }


  // Deli ambiguity clarification (sandwich vs sliced)
  if (pid === "ASK_DELI_MODE" || pid === "ASK_MEATBALL_MODE") {
    state.phase = "AWAITING_DELI_MODE";
    return;
  }
  // Deli weight slot
  if (pid === "ASK_DELI_WEIGHT") {
    state.phase = "AWAITING_DELI_WEIGHT";
    return;
  }

}

function applyPhaseInput(state, userText, config) {
  const phase = state?.phase;
  if (!phase) return false;

  const text = String(userText || "").trim();

  if (phase === "AWAITING_AVAILABILITY_ADD") {
    const norm = normalizeText(text);
    const normLower = norm;
    // Accept natural yes/no replies for "Would you like to add it?".
    // Deterministic: explicit keyword checks only (no fuzzy logic).
    const yesRe = /\b(yes|yeah|yep|sure|ok|okay|please|do it|add it|sounds good|go ahead)\b/;
    const noRe = /\b(no|nope|nah|dont|don't|do not|not now|no thanks|no thank you|not today)\b/;

    const pending = state?.availability && typeof state.availability === "object" ? state.availability : null;
    const id = pending?.pending_id;
    const type = pending?.pending_type;

    if (yesRe.test(normLower) && id && type === "condiment") {
      // Deterministically apply the requested add-on WITHOUT wiping existing condiments.
      // Target priority:
      //   1) current pending_item (if exists)
      //   2) last committed item in the order (if no pending_item)
      // This matters because in mixed-utterance orders, the rules may have already committed the item
      // by the time we present the availability offer.
      const order = state?.order || null;
      const pi = order?.pending_item?.exists ? order.pending_item : null;
      const last = !pi && Array.isArray(order?.items) && order.items.length ? order.items[order.items.length - 1] : null;
      const target = pi || last;

      if (target) {
        const set = new Set([...(Array.isArray(target.condiments) ? target.condiments : [])]);
        set.add(id);
        target.condiments = Array.from(set);
        target.condiments_specified = true;

        // Map priced toppings to addon IDs so pricing stays deterministic.
        const itemId = target.item_id || pi?.item_id || null;
        const daypart = inferDaypartForItemId(config, itemId);
        const addonIds = mapToppingIdsToAddonIds(config, [id], daypart);
        if (addonIds.length) {
          const aset = new Set([...(Array.isArray(target.addons) ? target.addons : [])]);
          for (const a of addonIds) aset.add(a);
          target.addons = Array.from(aset);
          target.addons_specified = true;
        }

        // Force deterministic repricing (base + addons) on next total/recompute.
        target.price = null;
        if (order) order.total = null;
      }

      // Emit a short confirmation and resume the prior phase (or continue normal flow).
      state.intent = "noop";
      state.entities = {};
      state.nlu = { success: true, confidence: 0.99, reason: "phase:availability_add:yes" };
      const resume = pending?.resume_phase || null;
      state.phase = resume;
      state.availability = null;
      state._availability_added = { id, item_display: pending?.item_display || "" };
      return true;
    }

    if (noRe.test(normLower)) {
      state.intent = "noop";
      state.entities = {};
      state.nlu = { success: true, confidence: 0.99, reason: "phase:availability_add:no" };
      // Resume the prior phase if we captured one.
      const resume = pending?.resume_phase || null;
      state.phase = resume;
      state.availability = null;
      return true;
    }

    // If unclear, deterministically re-ask the yes/no.
    state.intent = "noop";
    state.entities = {};
    state.nlu = { success: false, confidence: 0.0, reason: "phase:availability_add:unclear" };
    // Keep phase so we re-prompt in runner.
    return true;
  }


  if (phase === "AWAITING_ANYTHING_ELSE") {
    const norm = normalizeText(text);
    const normLower = norm;

    // If user indicates they are done, deterministically finish the order.
    const finishRe = /\b(that[\s']?s it|that is it|thats it|thats?\s*al+|that it|that[\s']?s all|that is all|thats all|that all|thats everything|that[\s']?s everything|all set|all good|all done|done|finish|checkout|im done|i[\s']?m done|nope|nah|nothing else|nothing|no thanks|no thank you|no thx|that[\s']?ll do it|that will do it|that[\s']?ll do|i[\s']?m all set|thats\s+ll|that\s+ll)\b/;
    if (finishRe.test(normLower) || /^no\b/.test(normLower)) {
      // Clear any stale entities from prior turns before finishing.
      state.entities = {};
      state.intent = "finish_order";
      state.nlu = { success: true, confidence: 0.99, reason: "phase:anything_else" };
      state.phase = null;
      return true;
    }


    // If user says "add ..." with only attachable entities (toppings/condiments/cheese/temp),
    // treat it deterministically as a modification to the last confirmed item.
    // This prevents accidental new-item parsing during the "anything else?" phase.
    if (state?.order?.active === true && Array.isArray(state.order.items) && state.order.items.length > 0) {
      const norm2 = normalizeText(text);
      if (state?.lexicon) {
        const toks = norm2.split(/\s+/).filter(Boolean);
        const lex = state.lexicon;
        const hasAttachable =
          toks.some((t) => lex.toppings?.has(t) || lex.condiments?.has(t) || lex.cheeses?.has(t)) ||
          /\bhot\b|\bcold\b/.test(norm2);
        const hasCore =
          toks.some((t) => lex.meats?.has(t) || lex.breads?.has(t) || lex.order_hints?.has(t));
        if (hasAttachable && !hasCore) {
          const ents = extractEntities(text, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, config.addonIndex);
          const last = state.order.items[state.order.items.length - 1];
          const daypart = inferDaypartForItemId(config, last?.id);
          const addonIds = mapToppingIdsToAddonIds(config, ents?.condiments || [], daypart);

          state.intent = "modify_confirmed_item";
          state.entities = {
            ...state.entities,
            condiments: Array.isArray(ents?.condiments) ? ents.condiments : [],
            cheese: ents?.cheese || null,
            requested_temp: ents?.requested_temp || null,
            addons: addonIds,
          };
          state.nlu = { success: true, confidence: 0.99, reason: "phase:anything_else:modify_last_item" };
          state.phase = null;
          return true;
        }
      }
    }

    // Bare affirmative at "Anything else?" means the user wants to add more.
    // Emit a dedicated intent so a rule can ask "What would you like to add?"
    // instead of falling through to unknown → CLARIFY.
    // EXCEPTION: if the affirmative is followed by actual item content
    // (e.g. "yes can I also have a ham and cheese"), strip the affirmative +
    // filler words and let mockNLU parse the item — no re-prompt needed.
    const _bareAffRe = /^(yes|yeah|yep|yup|yea|yeh|ya|sure|ok|okay|please|ues|yse|absolutely|definitely|of course)\b/i;
    if (_bareAffRe.test(normLower.trim())) {
      const _afterAff = normLower.trim().replace(_bareAffRe, "").trim();
      const _fillerStripped = _afterAff
        .replace(/^[,\s]*(can\s+i\s+(?:also\s+)?(?:have|get|add)|i\s+(?:also\s+)?(?:want|would\s+like)|i(?:'d| would)\s+(?:also\s+)?like|also\s+(?:have|get|add|want|like)|and\s+also|and|also|add\s+(?:a\s+|an\s+)?|get\s+me)\s*/i, "")
        .trim();
      if (_fillerStripped.length > 0) {
        // Has item content after the affirmative — fall through to normal NLU.
        // The full original text is passed to mockNLU which will score the item.
        state.entities = {};
        state.phase = null;
        return false;
      }
      state.entities = {};
      state.intent = "add_more_item";
      state.nlu = { success: true, confidence: 0.99, reason: "phase:anything_else:add_more" };
      state.phase = null;
      return true;
    }

    // Otherwise, allow a new item to be parsed normally.
    // Clear stale entities so the next NLU pass starts clean.
    state.entities = {};
    state.phase = null;
    return false;
  }

  if (phase === "AWAITING_NAME") {
    if (text) {
      // If the name was already captured inline (e.g. "Turkey sandwich for John"),
      // don't overwrite customer_name with the order text — just release the phase
      // and let mockNLU build the item from the cleaned effectiveText.
      if (state.order?.customer_name && state._auto_activate_from_inline_name) {
        state._auto_activate_from_inline_name = false;
        state.order.awaiting_name = false;
        state.phase = null;
        return false;
      }

      // Pass through info/menu queries so handleMenuQuestion can answer them
      // without consuming the name slot.
      const _nameInfoPassRe = /\bwhat\s+(comes?\s+on|does\s+it\s+come|breads?|rolls?|wraps?|subs?|is\s+(on|included))\b/i;
      const _nameInfoPassRe2 = /\bdo\s+you\s+(have|carry|sell|make)\b/i;
      if (_nameInfoPassRe.test(text) || _nameInfoPassRe2.test(text)) {
        return false; // let NLU + handleMenuQuestion handle; name phase preserved
      }

      // Deterministically treat this turn as the customer's name.
      // Do NOT let the rest of the pipeline interpret the name as an order message.
      state._name_input_consumed = true;

      state.order.customer_name = text;
      state.order.awaiting_name = false;

      // Don't force order.active here; FLOW_ORDER_CAPTURE_NAME will do that deterministically.
      // But keep compatibility for configs that gate name-capture on order.active.
      state.order.active = true;

      // If the user already tried to order before giving their name, deterministically replay that text once.
      if (state._deferred_order_text) {
        state._replay_after_name_pending = true;
      }

      // After name capture we can proceed with rules.
      // Immediately set intent to provide_name so the rule engine runs name-capture rules
      // and stops cleanly. This prevents NLU from re-classifying "Tyler" as place_order
      // and cascading into order flow rules in the same turn.
      state.intent = "provide_name";
      state.entities = { ...state.entities, customer_name: text };
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state._name_captured_in_phase = true;
      state.phase = null;
      return true;
    }
  }

  if (phase === "AWAITING_FORMAT") {
    // Fix Part4-3: Clear the "both the same" sentinel so format processing runs normally.
    if (state?.order?.pending_item?.format === "_same_tbd") {
      state.order.pending_item.format = null;
      state.order.pending_item.format_source = null;
    }
    // Pass through bread/roll option queries so INFO_ASK_BREAD_OPTIONS can answer them
    // without consuming the format slot.
    const _fmtInfoPassRe = /\bwhat\s+(breads?|rolls?|wraps?|subs?)\s*(types?|options?|kinds?|do\s+you\s+have|you\s+have|are\s+available)\b/i;
    const _fmtMenuPassRe = /\bwhat\s+(comes?\s+on|does\s+it\s+come\s+with|is\s+(on|included))\b/i;
    if (_fmtInfoPassRe.test(text) || _fmtMenuPassRe.test(text)) {
      return false; // let NLU + rules handle; format phase preserved
    }

    // Recommendation / "dealer's choice" language: default to "roll" and move on.
    // Prevents "whatever bread you recommend" from extracting format="bread" (literal word match).
    const _fmtRecommendRe = /\b(whatever\s+(you\s+)?(recommend|suggest|think|pick|choose)|which\s+(do\s+you\s+)?(recommend|suggest|think\s+is\s+better)|what\s+(do\s+you|would\s+you)\s+(recommend|suggest|go\s+with)|your\s+(pick|choice|recommendation|suggestion|call)|dealer'?s?\s+choice|doesn'?t\s+matter|don'?t\s+care|up\s+to\s+you|surprise\s+me|you\s+pick|your\s+call|you\s+choose|you\s+decide|i\s+don'?t\s+(mind|care|know)|either\s+(is\s+)?fine|anything\s+(is\s+)?fine|anything\s+works?|doesn'?t\s+matter\s+to\s+me|just\s+pick\s+(one|something)|you\s+tell\s+me)\b/i;
    if (_fmtRecommendRe.test(text)) {
      const fmt = "roll";
      const _defaultBreadFmt = "bread.plain_roll";
      state.intent = "provide_format";
      state.entities = { ...state.entities, format: fmt, bread_type: _defaultBreadFmt };
      if (state?.order?.pending_item) {
        state.order.pending_item.format = fmt;
        state.order.pending_item.format_source = "user";
        state.order.pending_item.bread_type = _defaultBreadFmt;
      }
      if (!state.session) state.session = {};
      state.session.staged_bread_type = _defaultBreadFmt;
      state.session._bread_recommended_label = "a plain roll";
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state.phase = null;
      return true;
    }

    let fmt = inferFormatFromText(text);
    // Also allow combined replies like "plain roll" / "seeded sub" / "wheat wrap".
    const ents = extractEntities(text, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, config.addonIndex);
    const bt = ents?.bread_type || null;

    // B1 fix: if no explicit format word but a bread type was given, derive format from the
    // bread type's group (e.g. "plain" → bread.plain_roll → group "roll" → format "roll").
    // This lets replies like "plain with mayo" or "plain" at the format-ask step resolve correctly.
    if (!fmt && bt) {
      const breadEntry = (config.breadIndex || []).find(e => e.id === bt);
      const grp = breadEntry?.group || null;
      if (grp && ["roll","sub","wrap","panini","toast","bread"].includes(grp)) {
        fmt = grp;
      }
    }

    // No-toppings signal: user says "no toppings", "nothing on it", etc. alongside format answer.
    // Capture it here so we skip the condiment question entirely when format is answered in one shot.
    const _noToppingsReFmt = /(no\s+toppings?|no\s+condiments?|nothing\s+on\s+(it|there)|just\s+the\s+(bread|roll|sub|wrap)|plain\s+only|as\s+is|no\s+extras?)/i;
    const _noToppingsSignaledAtFormat = _noToppingsReFmt.test(text);

    if (fmt) {
      // Always surface to rules.
      state.intent = "provide_format";
      state.entities = { ...state.entities, format: fmt };

      // If pending_item exists, commit format immediately (rules still control follow-ups).
      if (state?.order?.pending_item) {
        state.order.pending_item.format = fmt;
        state.order.pending_item.format_source = "user";
      }

      // If a bread/wrap type is embedded in the same answer, stash it for auto-apply.
      if (bt) {
        // Format-aware remap: if format=sub but bt=bread.plain_roll, the user meant a plain sub.
        let resolvedBt = bt;
        if (fmt === "sub" && bt === "bread.plain_roll") resolvedBt = "bread.plain_sub";
        if (state?.order?.pending_item) {
          // If pending item exists, we can safely store it and mark prompted so we don't re-ask.
          state.order.pending_item.bread_type = resolvedBt;
          state.order.pending_item.bread_type_prompted = true;
        } else if (state.session) {
          state.session.staged_bread_type = resolvedBt;
        }
        state.entities = { ...state.entities, bread_type: resolvedBt };
      }

      // B2 fix: if user said "no toppings" / "nothing on it" together with the format reply,
      // mark condiments as specified (empty) so the condiment question is skipped entirely.
      if (_noToppingsSignaledAtFormat) {
        const pi = state?.order?.pending_item;
        if (pi && pi.condiments_specified !== true) {
          pi.condiments = [];
          pi.condiments_specified = true;
        }
      }

      // Toppings buffer: if the user mentions condiments alongside the format answer
      // (e.g., "plain with mayo"), capture them now so they aren't lost.
      if (Array.isArray(ents.condiments) && ents.condiments.length > 0 && !_noToppingsSignaledAtFormat) {
        const pi = state?.order?.pending_item;
        if (pi && pi.condiments_specified !== true) {
          pi.condiments = [...ents.condiments];
          pi.condiments_specified = true;
          // Fix 3/Fix 6: compute addon IDs so format-step condiments are priced correctly.
          const _dp6f = inferDaypartForItemId(config, pi.item_id);
          const _aIds6f = mapToppingIdsToAddonIds(config, ents.condiments, _dp6f);
          if (_aIds6f.length) {
            const _set6f = new Set([...(Array.isArray(pi.addons) ? pi.addons : [])]);
            for (const a of _aIds6f) _set6f.add(a);
            pi.addons = Array.from(_set6f);
            pi.price = null;
          }
        }
        state.entities = { ...state.entities, condiments: ents.condiments };
      }

      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state.phase = null;
      return true;
    }
  }

  // Group 4: AWAITING_DELI_MODE — re-ask when input is neither sandwich nor weight signal.
  if (phase === "AWAITING_DELI_MODE") {
    const norm = normalizeText(text);
    const sandwichSignals = /\b(sandwich|roll|sub|wrap|panini|hero|hoagie|wedge)\b/.test(norm);
    const _piDmSaladId = state?.order?.pending_item?.item_id || "";
    const _isSaladDm = /^deli\.salad_/.test(_piDmSaladId);
    const weightSignals =
      /\b(lb|lbs|pound|pounds)\b/.test(norm) ||
      /\b(half\s+pound|quarter\s+pound|three\s+quarter\s+pound)\b/.test(norm) ||
      /\b(\d+)\s*\/\s*(\d+)\b/.test(norm) ||
      /\b(one|two|three)\s+(lb|lbs|pound|pounds)\b/.test(norm) ||
      /\b(\d+(?:\.\d+)?)\s*(lb|lbs|pound|pounds)\b/.test(norm) ||
      /\b(a\s+)?(half|quarter)\s+(pound|lb)\b/.test(norm) ||
      /\bby\s+weight\b/.test(norm) ||
      (!_isSaladDm && /\b(sliced?|deli\s+style|by\s+the\s+slice)\b/.test(norm));
    // Fix Issue 5: meatball sub vs. side dish — handle in applyPhaseInput.
    const _piDm5 = state?.order?.pending_item;
    if (_piDm5?.meatball_alt_is_side === true) {
      const sideSignals5 = /\b(side|side\s+dish|side\s+order|just\s+(the\s+)?meatball|bowl)\b/.test(norm);
      const yesSignals5 = /^(yes|yeah|sure|yep|yup|ok|okay)$/.test(norm.trim());
      if (sandwichSignals) {
        // Stay as lunch.meatball sandwich — detect specific format if stated.
        const _mfmt5 = /\bsub\b/.test(norm) ? "sub" : /\bwrap\b/.test(norm) ? "wrap" : /\broll\b/.test(norm) ? "roll" : null;
        _piDm5.ambiguous_mode = false;
        _piDm5.meatball_alt_is_side = false;
        _piDm5.ambiguous_mode_prompted = true;
        if (_mfmt5) {
          _piDm5.format = _mfmt5;
          _piDm5.format_source = "user";
          state.entities = { ...state.entities, format: _mfmt5 };
        }
        state.intent = "provide_format";
        state.phase = null;
        state.nlu.confidence = 0.99;
        state.nlu.success = true;
        return true;
      } else if (sideSignals5) {
        // Convert to sides.mtb.
        const _sideMi5 = getMenuItemById(config, "sides.mtb");
        if (_sideMi5) {
          const _newPi5 = buildPendingItemFromMenuItem(_sideMi5, text);
          _newPi5.quantity = _piDm5.quantity || null;
          state.order.pending_item = _newPi5;
        }
        state.intent = "provide_format";
        state.phase = null;
        state.nlu.confidence = 0.99;
        state.nlu.success = true;
        return true;
      } else {
        // Unclear — re-ask.
        state.intent = "deli_mode_reask";
        state.nlu.confidence = 0.3;
        state.nlu.success = false;
        return true;
      }
    }
    // Bug Cluster B Fix 1: for deli.rb (roast beef), "hot"/"cold" implies sandwich — auto-convert and apply temp.
    {
      const _piDmRb = state?.order?.pending_item;
      if (_piDmRb && _piDmRb.item_id === "deli.rb") {
        const _hotColdRb = /\bhot\b/.test(norm) ? "hot" : /\bcold\b/.test(norm) ? "cold" : null;
        if (_hotColdRb) {
          const _altIdRb = _piDmRb.deli_mode_sandwich_alt_item_id || "lunch.cold_roast_beef";
          const _altMiRb = getMenuItemById(config, _altIdRb);
          if (_altMiRb) {
            const _nextRb = buildPendingItemFromMenuItem(_altMiRb, text);
            _nextRb.quantity = _piDmRb.quantity || null;
            _nextRb.requested_temp = _hotColdRb;
            _nextRb.temp_source = "explicit";
            _nextRb.ambiguous_mode = false;
            _nextRb.ambiguous_mode_prompted = true;
            state.order.pending_item = _nextRb;
          }
          state.intent = "confirm_deli_mode_sandwich";
          state.phase = null;
          state.nlu.confidence = 0.99;
          state.nlu.success = true;
          return true;
        }
      }
    }
    if (sandwichSignals || weightSignals) {
      // Let detectIntent handle the clear signals.
      return false;
    }
    // Unclear response — signal re-ask.
    state.intent = "deli_mode_reask";
    state.nlu.confidence = 0.3;
    state.nlu.success = false;
    return true;
  }

  if (phase === "AWAITING_BREAD_TYPE") {
    // Fix Part5-4B: Bread type response for a correction-mode format change.
    // When a confirmed item's format was just changed (Fix 4A), we asked what bread they want.
    // Now capture the answer and apply it to the finalized item, then re-show the readback.
    if (state._correction_awaiting_bread != null) {
      const _corrIdx4b = state._correction_awaiting_bread.index;
      const _corrItems4b = Array.isArray(state.order?.items) ? state.order.items : [];
      const _corrItem4b = _corrItems4b[_corrIdx4b];
      const _corrFmt4b = _corrItem4b?.format || null;
      // Format-constrained keyword matching runs FIRST (before extractEntities) when the
      // target format is known. This prevents cross-format matches — e.g. "white" mapping
      // to bread.white_toast instead of bread.white_wrap when format is "wrap".
      const _corrRaw = (typeof correctMenuTypos === "function" ? correctMenuTypos(text) : text).toLowerCase().trim();
      let _fmtConstrainedBt = null;
      if (_corrFmt4b === "sub") {
        if (/\bseeded?\b/.test(_corrRaw))        _fmtConstrainedBt = "bread.seeded_sub";
        else if (/\bplain\b/.test(_corrRaw))     _fmtConstrainedBt = "bread.plain_sub";
      } else if (_corrFmt4b === "wrap") {
        if (/\bspinach\b/.test(_corrRaw))        _fmtConstrainedBt = "bread.spinach_wrap";
        else if (/\btomato\b/.test(_corrRaw))    _fmtConstrainedBt = "bread.tomato_wrap";
        else if (/\bwheat\b/.test(_corrRaw))     _fmtConstrainedBt = "bread.wheat_wrap";
        else if (/\bwhite\b|\bplain\b/.test(_corrRaw)) _fmtConstrainedBt = "bread.white_wrap";
      } else if (_corrFmt4b === "roll") {
        if (/\bpoppy\b/.test(_corrRaw))          _fmtConstrainedBt = "bread.poppy_seed_roll";
        else if (/\bportuguese\b/.test(_corrRaw)) _fmtConstrainedBt = "bread.portuguese_roll";
        else if (/\bknot\b/.test(_corrRaw))      _fmtConstrainedBt = "bread.knot_roll";
        else if (/\bplain\b/.test(_corrRaw))     _fmtConstrainedBt = "bread.plain_roll";
      }
      // Fall back to extractEntities only when format-constrained keyword matching found nothing.
      let _corrEnts4b = _fmtConstrainedBt
        ? { bread_type: _fmtConstrainedBt }
        : extractEntities(text, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, config.addonIndex);
      if (_corrEnts4b?.bread_type) {
        // Format-aware remap: if item format is sub, "plain" means plain_sub not plain_roll.
        let _corrBt4b = _corrEnts4b.bread_type;
        if (_corrFmt4b === "sub" && _corrBt4b === "bread.plain_roll") _corrBt4b = "bread.plain_sub";
        if (_corrFmt4b === "wrap" && _corrBt4b === "bread.plain_roll") _corrBt4b = "bread.white_wrap";
        if (_corrItem4b) {
          _corrItem4b.bread_type = _corrBt4b;
        }
        state._correction_awaiting_bread = null;
        // Trigger standard correction re-readback via modify_confirmed_item intent.
        state.entities = {
          ...state.entities,
          target_index: _corrIdx4b,
          bread_type: _corrBt4b,
          condiments: [],
          remove_condiments: [],
          addons: [],
        };
        state.intent = "modify_confirmed_item";
        state.phase = null;
        state.nlu.confidence = 0.99;
        state.nlu.success = true;
        return true;
      }
      // No bread type found — keep waiting (re-ask next turn).
      return true;
    }
    // Fix Part4-7: Mid-flow format change — "actually make that a sub" / "wait, make it a roll".
    // Detect format-switch language and update pending_item.format, then re-ask bread type.
    const _fmtSwitchRe = /\b(?:actually|wait|never\s*mind|on\s+second\s+thought|change\s+(?:it\s+)?to|make\s+(?:that\s+a?|it\s+a?)|switch\s+(?:it\s+)?to|i\s+(?:want|changed\s+my\s+mind)[\s,]+(?:a\s+)?|can\s+(?:i\s+)?(?:get|have)\s+(?:a\s+)?)\s*(roll|sub|wrap)\b/i;
    const _fmtSwitchM = _fmtSwitchRe.exec(text);
    if (_fmtSwitchM && state?.order?.pending_item?.exists) {
      const _newFmt = _fmtSwitchM[_fmtSwitchM.length - 1].toLowerCase();
      const pi = state.order.pending_item;
      pi.format = _newFmt;
      pi.format_source = "user";
      pi.bread_type = null;
      pi.bread_type_prompted = false;
      // Return false so rules re-ask the bread type question for the new format.
      return false;
    }
    // Recommendation language: pick a sensible default bread type and continue.
    const _breadRecommendRe = /\b(whatever\s+(you\s+)?(recommend|suggest|think|pick|choose)|your\s+(pick|choice|recommendation|suggestion|call)|dealer'?s?\s+choice|doesn'?t\s+matter|don'?t\s+care|up\s+to\s+you|surprise\s+me|which\s+(do\s+you|would\s+you)\s+recommend|what\s+(do\s+you|would\s+you)\s+(recommend|suggest|go\s+with)|you\s+(tell|pick|choose|decide)\s+(me\s+)?|i\s+don'?t\s+(know|mind)|doesn'?t\s+matter\s+to\s+me)\b/i;
    if (_breadRecommendRe.test(text) && state?.order?.pending_item) {
      const pi = state.order.pending_item;
      const fmt = pi.format || "roll";
      const defaultBread = fmt === "sub" ? "bread.plain_sub" : fmt === "wrap" ? "bread.white_wrap" : "bread.plain_roll";
      const _breadLabel = fmt === "sub" ? "a plain sub" : fmt === "wrap" ? "a white wrap" : "a plain roll";
      pi.bread_type = defaultBread;
      state.intent = "provide_bread_type";
      state.entities = { ...state.entities, bread_type: defaultBread };
      if (!state.session) state.session = {};
      state.session._bread_recommended_label = _breadLabel;
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state.phase = null;
      return true;
    }
    const ents = extractEntities(text, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, config.addonIndex);
    if (ents?.bread_type && state?.order?.pending_item) {
      let bt = ents.bread_type;
      // Format-aware remap: bread.plain_roll has "plain" as a short synonym, but if the
      // pending item's format is "sub", the user's "plain" means a plain sub, not a plain roll.
      // Without this guard, applyPhaseInput would set bread_type="bread.plain_roll" on a sub item,
      // and the condiment prompt would then show "on Plain Roll" instead of "on Plain Sub".
      const pendingFmt = state.order.pending_item.format ?? null;
      if (pendingFmt === "sub" && bt === "bread.plain_roll") bt = "bread.plain_sub";
      state.order.pending_item.bread_type = bt;
      state.intent = "provide_bread_type";
      const newEntities = { ...state.entities, bread_type: bt };
      // Toppings buffer: if the user also mentions condiments alongside the bread type answer
      // (e.g., "plain with mayo"), apply them now so they aren't lost when mockNLU is skipped.
      if (Array.isArray(ents.condiments) && ents.condiments.length > 0) {
        newEntities.condiments = ents.condiments;
        const pi = state.order.pending_item;
        if (pi && pi.condiments_specified !== true) {
          pi.condiments = [...ents.condiments];
          pi.condiments_specified = true;
          // Fix 6: compute and add addon IDs so bread-step condiments are priced.
          const _dp6e = inferDaypartForItemId(config, pi.item_id);
          const _aIds6e = mapToppingIdsToAddonIds(config, ents.condiments, _dp6e);
          if (_aIds6e.length) {
            const _set6e = new Set([...(Array.isArray(pi.addons) ? pi.addons : [])]);
            for (const a of _aIds6e) _set6e.add(a);
            pi.addons = Array.from(_set6e);
            pi.price = null;
          }
        }
      }
      // No-toppings signal: user says "plain no toppings", "nothing on it", etc. alongside bread answer.
      // Capture condiments_specified=true with empty array so we skip the condiment question entirely.
      const _noToppingsRe = /\b(no\s+toppings?|no\s+condiments?|nothing\s+(on\s+(it|there)|extra)|just\s+the\s+(bread|roll|sub|wrap)|plain\s+only|as\s+is|no\s+extras?)\b/i;
      if (_noToppingsRe.test(text)) {
        const pi = state.order.pending_item;
        if (pi && pi.condiments_specified !== true) {
          pi.condiments = [];
          pi.condiments_specified = true;
        }
      }
      state.entities = newEntities;
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state.phase = null;
      return true;
    }
    // Group 1: "no" / "nope" / "nah" / "plain" at bread-type step with no extractable bread_type
    // → default to the plain variant matching the item's format.
    const _negBreadRe = /^(no|nope|nah|plain|doesn'?t\s+matter|don'?t\s+care|i\s+don'?t\s+(know|mind)|whatever)$/i;
    if (_negBreadRe.test(text.trim()) && state?.order?.pending_item?.exists) {
      const _piBt = state.order.pending_item;
      const _fmtBt = _piBt.format || "roll";
      const _defaultBreadBt = _fmtBt === "sub" ? "bread.plain_sub" : _fmtBt === "wrap" ? "bread.white_wrap" : "bread.plain_roll";
      _piBt.bread_type = _defaultBreadBt;
      state.intent = "provide_bread_type";
      state.entities = { ...state.entities, bread_type: _defaultBreadBt };
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state.phase = null;
      return true;
    }
    // Fix Issue 4: no-toppings signal alone at bread step (no bread_type extracted).
    // "nothing on it", "nothing extra", "no toppings" → default bread + skip condiment Q.
    const _noToppingsAloneRe = /\b(no\s+toppings?|no\s+condiments?|nothing\s+(on\s+(it|there)|extra)|just\s+the\s+(bread|roll|sub|wrap)|plain\s+only|no\s+extras?)\b/i;
    if (_noToppingsAloneRe.test(text) && state?.order?.pending_item?.exists) {
      const _piNt = state.order.pending_item;
      const _fmtNt = _piNt.format || "roll";
      const _defaultBtNt = _fmtNt === "sub" ? "bread.plain_sub" : _fmtNt === "wrap" ? "bread.white_wrap" : "bread.plain_roll";
      _piNt.bread_type = _defaultBtNt;
      _piNt.condiments = [];
      _piNt.condiments_specified = true;
      state.intent = "provide_bread_type";
      state.entities = { ...state.entities, bread_type: _defaultBtNt };
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state.phase = null;
      return true;
    }
  }

  if (phase === "AWAITING_WRAP_TYPE") {
    // Deterministic wrap inference (avoid ambiguity with "white" toast/roll).
    const wrapId = inferWrapTypeFromText(text);
    const ents = extractEntities(text, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, config.addonIndex);
    const breadType = wrapId || (typeof ents?.bread_type === "string" && /_wrap$/.test(ents.bread_type) ? ents.bread_type : null);

    if (breadType && state?.order?.pending_item?.exists) {
      state.order.pending_item.bread_type = breadType;
      state.intent = "provide_bread_type";
      state.entities = { ...state.entities, bread_type: breadType };
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state.phase = null;
      return true;
    }

    // Keep waiting if unclear.
    state.intent = "awaiting_wrap_type";
    state.nlu.confidence = 0.5;
    state.nlu.success = false;
    return true;
  }

  if (phase === "AWAITING_TOPPINGS_OR_CONDIMENTS") {
    // Fix Part5-3: Mid-flow format change at toppings step (mirrors Part4-7 for AWAITING_BREAD_TYPE).
    // "actually make that a sub" / "wait, make it a wrap" at toppings phase → update format, re-ask bread.
    const _fmtSwitchRe3 = /\b(?:actually|wait|never\s*mind|on\s+second\s+thought|change\s+(?:it\s+)?to|make\s+(?:that\s+a?|it\s+a?)|switch\s+(?:it\s+)?to)\s*(roll|sub|wrap)\b/i;
    const _fmtSwitchM3 = _fmtSwitchRe3.exec(text);
    if (_fmtSwitchM3 && state?.order?.pending_item?.exists) {
      const _newFmt3 = _fmtSwitchM3[_fmtSwitchM3.length - 1].toLowerCase();
      const pi3 = state.order.pending_item;
      pi3.format = _newFmt3;
      pi3.format_source = "user";
      pi3.bread_type = null;
      pi3.bread_type_prompted = false;
      pi3.condiments_specified = false;
      pi3.condiments_prompted = false; // reset so condiment Q re-fires for new format
      // Return true (phaseHandled) so mockNLU does NOT re-classify this as a correction.
      // Rules will fire ASK_SUB_BREAD_TYPE_IF_MISSING / ASK_BREAD_TYPE_IF_MISSING based on new format.
      state.phase = "AWAITING_BREAD_TYPE";
      state.intent = "provide_format";
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      return true;
    }
    // When the last prompt was the configured-defaults yes/no question (ASK_NAMED_ITEM_AS_IT_COMES),
    // ALL input for configured-defaults items must go through mockNLU — including bare "yes" or "no" —
    // because "no" here means "I want to change something", not "no toppings".
    // The detectIntent override for ASK_NAMED_ITEM_AS_IT_COMES handles "yes" → accept_item_defaults.
    // Anything else passes to mockNLU to handle as a modification/correction request.
    const _piEarlyCheck = state?.order?.pending_item;
    if (state?.last_prompt_id === "ASK_NAMED_ITEM_AS_IT_COMES" && _piEarlyCheck?.exists && _piEarlyCheck?.has_configured_defaults === true) {
      return false; // let mockNLU handle; phase preserved
    }

    // Info queries and defaults intents mid-condiment-phase: let mockNLU handle them.
    // Phase is preserved on state, so the condiment question will be re-asked next turn.
    const _infoPassRe = /\bwhat\s+(comes?\s+on|does\s+it\s+come\s+with|is\s+normally\s+on|goes?\s+on|comes?\s+with\s+it)\b/i;
    const _infoPassRe2 = /\bwhat\s*'?s\s+(normally\s+on|on\s+it|included)\b/i;
    const _infoPassRe3 = /\bwhat\s+does\s+that\s+come\s+with\b/i;
    const _breadOptRe = /\bwhat\s+(bread|roll|wrap)\b/i;
    if (_infoPassRe.test(text) || _infoPassRe2.test(text) || _infoPassRe3.test(text) || _breadOptRe.test(text)) {
      return false; // let mockNLU handle; phase preserved
    }
    // "as it comes" / accept defaults — let mockNLU route to CAPTURE_ACCEPT_ITEM_DEFAULTS rule
    // BUT: for BYO items (no configured_defaults), treat "as it is" as "plain" instead.
    if (/\bas\s+it\s+comes?\b/i.test(text) || /\bthe\s+usual\b/i.test(text) ||
        /\bhowever\s+it\s+comes?\b/i.test(text) || /\bjust\s+how\s+it\s+comes?\b/i.test(text) ||
        /\bkeep\s+the\s+defaults?\b/i.test(text) || /\bwhatever\s+(comes?\s+on\s+it|it\s+comes?\s+with)\b/i.test(text) ||
        /\bas[\s-]+is\b/i.test(text) || /\bleave\s+it\s+as[\s-]+is\b/i.test(text) ||
        /\bthat'?s\s+fine\s+as[\s-]+is\b/i.test(text) || /\bstandard\s+is\s+fine\b/i.test(text) ||
        /\bjust\s+make\s+it\s+(the\s+)?normal\s+way\b/i.test(text) || /\b(the\s+)?normal\s+way\s+is\s+fine\b/i.test(text) ||
        /\bdo\s+it\s+(the\s+)?normal\s+way\b/i.test(text) || /\bmake\s+it\s+(the\s+)?normal\s+way\b/i.test(text) ||
        /\bjust\s+as\s+it\s+is\b/i.test(text) || /\bas\s+it\s+is\b/i.test(text) ||
        /\bthe\s+way\s+it\s+comes?\b/i.test(text) || /\bhow\s+it\s+comes?\b/i.test(text) ||
        /\bthat\s+way\s+is\s+(good|fine|perfect|great|works?)\b/i.test(text)) {
      // For items with configured defaults (e.g. Roma panini), let rules handle (CAPTURE_ACCEPT_ITEM_DEFAULTS).
      // For BYO items, "as it is" means "plain" — treat same as none.
      const _piForDefault = state?.order?.pending_item;
      const _hasCfgDefaults = _piForDefault?.exists && _piForDefault?.has_configured_defaults === true;
      if (_hasCfgDefaults) {
        return false; // let mockNLU handle; phase preserved
      }
      // BYO item: treat "as it is" as "no toppings"
      state.intent = "no_condiments";
      state.entities = { condiments: [], keywords: null };
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state.phase = null;
      return true;
    }

    const n = normalizeText(text).replace(/\s+/g, " ").trim();
    // Note: normalizeText strips apostrophes to spaces ("that's" → "that s", "i'm" → "i m").
    // Both the apostrophe-stripped normalized form and common shorthands are listed.
    const none = /^(no|nope|nah|nothing|none|plain|keep it plain|no thanks|no thanks\.|no thank you|nothing at all|nothing at all please|nothing else|no toppings|no topping|no condiments|no extras|nothing on it|thats it|that s it|thats all|that s all|all good|all set|done|i m good|im good|i'm good|i am good|nothing extra|leave it plain|just plain|as is|just as is|that ll do|that'll do|thats fine|that s fine|that will do|leave it|leave it like that|leave it as is|leave it as it is|keep it as is|keep it as it is|keep it plain|just leave it|leave as is)$/i.test(n);
    if (none) {
      state.intent = "no_condiments";
      // Reset keywords to null to prevent stale keywords from prior turns (e.g. "extra" from the
      // initial order utterance) from triggering keyword-sensitive rules like CAPTURE_EXTRA_CONDIMENTS.
      state.entities = { condiments: [], keywords: null };
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state.phase = null;
      return true;
    }

    // Group 8: "make it spicy" / "make that spicy" → add hot peppers as a condiment.
    const _makeSpicyRe = /\b(make\s+(it|that|this)\s+spicy|add\s+(some\s+)?spice|make\s+(it\s+)?hot\s+(?:and\s+)?spicy|spicy\s+please|extra\s+spicy)\b/i;
    if (_makeSpicyRe.test(n) && state?.order?.pending_item?.exists) {
      const _hotPepperCond = "topping.hot_peppers";
      const _piSp = state.order.pending_item;
      if (!Array.isArray(_piSp.condiments)) _piSp.condiments = [];
      if (!_piSp.condiments.includes(_hotPepperCond)) _piSp.condiments.push(_hotPepperCond);
      _piSp.condiments_specified = true;
      state.intent = "provide_condiments";
      state.entities = { ...state.entities, condiments: [..._piSp.condiments] };
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state.phase = null;
      return true;
    }

    // If customer says "yes, the ones I said" (or similar), deterministically re-apply staged condiments.
    const confirmPrev = /^(yes|yep|yeah|correct|right|same|exactly)(\b.*\b)?(the ones i said|what i said|same as i said|as i said|like i said|the same|those|them)?$/i.test(n);
    if (confirmPrev && Array.isArray(state.session?.staged_condiments) && state.session.staged_condiments.length) {
      state.intent = "provide_condiments";
      const _staged6d = state.session.staged_condiments;
      state.entities = { ...state.entities, condiments: [..._staged6d] };
      if (state?.order?.pending_item) {
        const _pi6d = state.order.pending_item;
        _pi6d.condiments = [..._staged6d];
        _pi6d.condiments_specified = true;
        // Fix 6: compute addon IDs so staged condiments are priced.
        const _dp6d = inferDaypartForItemId(config, _pi6d.item_id);
        const _aIds6d = mapToppingIdsToAddonIds(config, _staged6d, _dp6d);
        if (_aIds6d.length) {
          const _set6d = new Set([...(Array.isArray(_pi6d.addons) ? _pi6d.addons : [])]);
          for (const a of _aIds6d) _set6d.add(a);
          _pi6d.addons = Array.from(_set6d);
          _pi6d.price = null;
        }
      }
      state.session.staged_condiments = null;
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state.phase = null;
      return true;
    }

    // Issue 3: "exactly the same as the first one" — clone condiments from first batch item.
    // Only fires when current pending_item has a _batch_index >= 2 (it's a duplicate item in a multi-qty order).
    const _sameAsFirstRe = /\b(same\s+as\s+(?:the\s+)?(?:first(?:\s+one)?|before|last\s+one|previous\s+one)|exactly\s+(?:the\s+)?same(?:\s+as\s+(?:the\s+)?(?:first|last|other|that|previous)(?:\s+one)?)?|make\s+(?:it|this\s+one?|the\s+second\s+one?)\s+(?:the\s+)?same|same\s+toppings?\s+as\s+(?:the\s+)?(?:first|last|other)|copy\s+(?:it|that|the\s+first)|identical(?:\s+to\s+(?:the\s+)?first)?)\b/i;
    const _pi3 = state?.order?.pending_item;
    if (_sameAsFirstRe.test(n) && _pi3?.exists && _pi3?._batch_index >= 2) {
      // Find the first batch item already finalized in state.order.items.
      const _finalized = Array.isArray(state.order?.items) ? state.order.items : [];
      const _firstBatch = _finalized.find(it => it._batch_index === 1 && it.item_id === _pi3.item_id);
      if (_firstBatch) {
        // Clone condiments, addons, cheese_override from the first batch item.
        _pi3.condiments = Array.isArray(_firstBatch.condiments) ? [..._firstBatch.condiments] : [];
        _pi3.condiments_specified = true;
        _pi3.condiments_prompted = true;
        if (_firstBatch.addons) _pi3.addons = Array.isArray(_firstBatch.addons) ? [..._firstBatch.addons] : _pi3.addons;
        if (_firstBatch.addons_specified) _pi3.addons_specified = true;
        if (_firstBatch.cheese_override) _pi3.cheese_override = _firstBatch.cheese_override;
        state.intent = "provide_condiments";
        state.entities = { condiments: [..._pi3.condiments], keywords: null };
        state.nlu.confidence = 0.99;
        state.nlu.success = true;
        state.phase = null;
        return true;
      }
    }

    // In this phase, treat the reply as modifications to the current pending item.
    // Deterministically extract any attachable slots: condiments/toppings, cheese, temp, bread type, format.
    const ents = extractEntities(text, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, config.addonIndex);

    const inferredFormat = inferFormatFromText(text);
    if (inferredFormat && !ents.format) ents.format = inferredFormat;

    const hasCondiments = Array.isArray(ents?.condiments) && ents.condiments.length;
    const hasRemovals = Array.isArray(ents?.remove_condiments) && ents.remove_condiments.length > 0;
    const hasCheese = !!ents?.cheese;
    const hasTemp = !!ents?.requested_temp;
    const hasBreadType = !!ents?.bread_type;
    const hasFormat = !!ents?.format;

    const hasAnyAttachable = hasCondiments || hasRemovals || hasCheese || hasTemp || hasBreadType || hasFormat;

    if (hasAnyAttachable) {
      // In this phase, a reply that contains toppings/condiments should be treated as providing condiments.
      // This aligns with rules.json (intent=provide_condiments) and ensures condiments persist deterministically.
      // Also map any priced toppings to addon IDs so pricing stays deterministic.
      const daypart = inferDaypartForItemId(config, state?.order?.pending_item?.item_id);
      const addonIds = mapToppingIdsToAddonIds(config, hasCondiments ? ents.condiments : [], daypart);

      // If we have a pending item, apply mapped addons immediately (rules capture condiments; runner guarantees addon persistence).
      if (state?.order?.pending_item?.exists && addonIds.length) {
        const pi = state.order.pending_item;
        const set = new Set([...(pi.addons || [])]);
        for (const a of addonIds) set.add(a);
        pi.addons = Array.from(set);
        pi.addons_specified = true;
        // Force deterministic repricing (base + addons) on finalize.
        pi.price = null;
      }

      // Cheese upgrade: if the pending item's plain variant is in the upgrade map, swap to
      // the cheese variant so pricing reflects the cheese add correctly.
      if (hasCheese && state?.order?.pending_item?.exists) {
        const _cheesePi = state.order.pending_item;
        if (_cheesePi.cheese_override == null) {
          _cheesePi.cheese_override = ents.cheese;
          const _condUpgradeId = CHEESE_UPGRADE_MAP[_cheesePi.item_id];
          if (_condUpgradeId && getMenuItemById(config, _condUpgradeId)) {
            _cheesePi.item_id = _condUpgradeId;
            _cheesePi.price = null; // force reprice against the cheese variant
          }
        }
      }

      state.intent = hasCondiments ? "provide_condiments" : "modify_pending_item";
      state.entities = {
        ...state.entities,
        condiments: hasCondiments ? ents.condiments : [],
        remove_condiments: hasRemovals ? ents.remove_condiments : [],
        cheese: hasCheese ? ents.cheese : null,
        requested_temp: hasTemp ? ents.requested_temp : null,
        bread_type: hasBreadType ? ents.bread_type : null,
        format: hasFormat ? ents.format : null,
        addons: addonIds,
      };
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state.phase = null;
      return true;
    }

    // If the reply doesn't include any attachable toppings/condiments/etc., it may still be a priced meat add-on
    // (e.g., "bacon", "add bacon"). In this phase, treat meat words as add-ons to the pending item,
    // not as a brand-new item. Deterministic whole-token match only.
    //
    // Exception: if the text also contains a sandwich-format word (e.g. "add turkey sandwich",
    // "turkey sub"), the customer wants a NEW item, not a meat add-on to the current one.
    // Return false so mockNLU handles it as a new order item.
    const _hasFormatWord = /\b(sandwich|sub|roll|wrap|panini|hero|hoagie|wedge)\b/i.test(text);
    // Group 5: require explicit add/extra/double/more signal before treating meat tokens as condiment-step addons.
    const _hasMeatAddSignalAtToppings = /\b(add|extra|double|more)\b/i.test(text);
    if (state?.order?.pending_item?.exists && !_hasFormatWord && _hasMeatAddSignalAtToppings) {
      const daypart = inferDaypartForItemId(config, state?.order?.pending_item?.item_id);
      const meatIds = findIdsInTextUsingIndex(text, config.meatIndex);
      const addonIds = mapMeatIdsToAddonIds(config, meatIds, daypart);

      if (addonIds.length) {
        const pi = state.order.pending_item;
        const set = new Set([...(pi.addons || [])]);
        for (const a of addonIds) set.add(a);
        pi.addons = Array.from(set);
        pi.addons_specified = true;
        pi.price = null;

        state.intent = "modify_pending_item";
        state.entities = { ...ents, addons: addonIds };
        state.nlu.confidence = 0.99;
        state.nlu.success = true;
        state.phase = null;
        return true;
      }

      // Fallback: if meatIds didn't map to addon IDs (e.g., "sausage" at a breakfast toppings step),
      // try the breakfast secondary-meat keyword table.  This is the same table used at order-creation
      // time (see the _bfSecMap block in mockNLU) but run here when we're in AWAITING_TOPPINGS phase.
      if (daypart === "breakfast") {
        const _bfSecMap2 = [
          { kw: "turkey bacon",       addon: "addon.extra_turkey_bacon_breakfast" },
          { kw: "sausage patty",      addon: "addon.extra_sausage_breakfast" },
          { kw: "breakfast sausage",  addon: "addon.extra_sausage_breakfast" },
          { kw: "pastrami",           addon: "addon.extra_pastrami_breakfast" },
          { kw: "sausage",            addon: "addon.extra_sausage_breakfast" },
          { kw: "bacon",              addon: "addon.extra_bacon_breakfast" },
          { kw: "ham",                addon: "addon.extra_ham_breakfast" },
        ];
        const pi2 = state.order.pending_item;
        const _bfNorm2 = " " + normalizeText(text) + " ";
        // Build exclusion set from item's own primary meats (don't add item's own meat as "extra").
        // pending_item stores meats in pi2.meats, not pi2.ingredient_ids.meats
        const _bfPrimMeats2 = new Set(Array.isArray(pi2?.meats) ? pi2.meats : []);
        const _bfKwMap2 = {
          "meat.bacon": ["bacon"], "meat.sausage": ["sausage", "sausage patty", "breakfast sausage"],
          "meat.ham": ["ham"], "meat.pastrami": ["pastrami"], "meat.turkey_bacon": ["turkey bacon"],
        };
        const _bfKwExclude2 = new Set();
        for (const mid of _bfPrimMeats2) {
          const kws = _bfKwMap2[mid];
          if (kws) for (const kw of kws) _bfKwExclude2.add(kw);
        }
        const _bfExtras2 = new Set();
        for (const { kw, addon } of _bfSecMap2) {
          if (!_bfNorm2.includes(" " + kw + " ")) continue;
          if (_bfKwExclude2.has(kw)) continue;
          _bfExtras2.add(addon);
        }
        if (_bfExtras2.size > 0) {
          const set2 = new Set([...(pi2.addons || []), ..._bfExtras2]);
          pi2.addons = Array.from(set2);
          pi2.addons_specified = true;
          pi2.price = null;
          const addonIds2 = Array.from(_bfExtras2);
          // Store human-readable label(s) for systemSay to include in acknowledgment
          const _bfAddonLabels2 = addonIds2.map((id) => {
            const m = /^addon\.extra_(.+?)_breakfast$/.exec(id);
            if (!m) return null;
            return m[1].split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
          }).filter(Boolean);
          if (_bfAddonLabels2.length > 0) {
            if (!state.session) state.session = {};
            state.session._bf_addon_label = _bfAddonLabels2.join(" & ");
          }
          state.intent = "modify_pending_item";
          state.entities = { ...ents, addons: addonIds2 };
          state.nlu.confidence = 0.99;
          state.nlu.success = true;
          state.phase = null;
          return true;
        }
      }
    }

    // If the text contains a sandwich-format word (e.g. "add turkey sandwich", "turkey sub"),
    // the customer is ordering a NEW item, not modifying the current one.
    // Treat the current pending item as having no condiments, push the new item text onto the
    // front of the queue so it is processed immediately after finalization.
    if (_hasFormatWord) {
      const pi = state.order?.pending_item;
      if (pi && pi.exists) {
        pi.condiments = [];
        pi.condiments_specified = true;
      }
      // Strip leading add/also/get-me prefixes before queueing so that e.g.
      // "add turkey sandwich" queues as "turkey sandwich" — prevents extractAddonMeatIds
      // from treating "add turkey" as a meat add-on when the text is later replayed.
      const _queueText = text
        .replace(/^\s*(also\s+)?(add|get\s+me|gimme|let\s+me\s+get|i\s+(?:also\s+)?want)\s+/i, "")
        .trim() || text;
      if (state.order && Array.isArray(state.order.item_queue)) {
        state.order.item_queue.unshift({ kind: "text", text: _queueText });
      }
      state.intent = "no_condiments";
      state.entities = { ...state.entities, condiments: [] };
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state.phase = null;
      return true;
    }

    // For items with configured defaults (e.g. Roma panini), unrecognized input like "yes" should
    // be passed to mockNLU to handle via accept_item_defaults → CAPTURE_ACCEPT_ITEM_DEFAULTS rule.
    // Return false preserves the phase so the condiment question is not consumed.
    const _piForCfg = state?.order?.pending_item;
    if (_piForCfg?.exists && _piForCfg?.has_configured_defaults === true) {
      return false; // let mockNLU handle; phase preserved
    }

    // Otherwise: ask for condiment examples, but always replace entities with the current turn's extraction
    // to avoid stale keywords from earlier turns triggering unrelated guardrails.
    state.intent = "ask_condiment_examples";
    state.entities = { ...ents };
    state.nlu.confidence = 0.6;
    state.nlu.success = true;
    return true;
  }

  if (phase === "AWAITING_TEMP") {
    const n = normalizeText(text);
    const hasHot = /\bhot\b/.test(n);
    const hasCold = /\bcold\b/.test(n);

    // Some prompt variants are phrased as confirmations (e.g., "You want it hot. That right?")
    // even though the slot is temperature. Support explicit yes/no deterministically.
    const yesRe = /\b(yes|yeah|yep|sure|ok|okay)\b/;
    const noRe = /\b(no|nope|nah)\b/;

    if (yesRe.test(n) && !hasHot && !hasCold) {
      // Accept the previously inferred temperature if it exists.
      const candidate =
        (state.entities && (state.entities.requested_temp === "hot" || state.entities.requested_temp === "cold")
          ? state.entities.requested_temp
          : null) ||
        (state.session && (state.session.staged_requested_temp === "hot" || state.session.staged_requested_temp === "cold")
          ? state.session.staged_requested_temp
          : null) ||
        (state.order && state.order.pending_item && (state.order.pending_item.requested_temp === "hot" || state.order.pending_item.requested_temp === "cold")
          ? state.order.pending_item.requested_temp
          : null);

      if (candidate) {
        // If this was a confirmation-style prompt, finalize the pending item's temp source
        // so we don't re-prompt (rules check temp_source === "user").
        const pi = state.order && state.order.pending_item && state.order.pending_item.exists ? state.order.pending_item : null;
        const lastPid = String(state.last_prompt_id || "");
        if (pi) {
          // Keep requested_temp as-is if already set; otherwise apply candidate.
          if (pi.requested_temp == null) pi.requested_temp = candidate;
          if (lastPid === "CONFIRM_TEMP_OVERRIDE") {
            pi.temp_source = "user_confirmed";
          } else if (lastPid === "DELI_TEMP_NOT_CHANGEABLE") {
            // Customer confirmed the default/non-changeable temp.
            pi.temp_source = "default_confirmed";
          } else {
            // Generic temp confirmation (e.g., runner inferred hot/cold earlier).
            pi.temp_source = "user_confirmed";
          }
        }

        // IMPORTANT: CONFIRM_TEMP_OVERRIDE is a confirmation prompt, not a request for a new temp.
        // If we set entities.requested_temp here, rules.json will re-apply temp_source="user" and
        // the confirmation prompt will loop. Keep the value on the item, but clear the entity.
        const isConfirmPrompt = lastPid === "CONFIRM_TEMP_OVERRIDE" || lastPid === "DELI_TEMP_NOT_CHANGEABLE";
        state.intent = isConfirmPrompt ? "confirm_temp" : "provide_temp";
        state.entities = { ...state.entities, requested_temp: isConfirmPrompt ? null : candidate };
        state.nlu.confidence = 0.99;
        state.nlu.success = true;
        state.phase = null;
        return true;
      }
    }

    if (noRe.test(n) && !hasHot && !hasCold) {
      const pi = state.order && state.order.pending_item && state.order.pending_item.exists ? state.order.pending_item : null;
      const lastPid = String(state.last_prompt_id || "");

      // If we were confirming an override, "no" means revert to default.
      if (pi && lastPid === "CONFIRM_TEMP_OVERRIDE" && pi.default_temp) {
        pi.requested_temp = pi.default_temp;
        pi.temp_source = "default_confirmed";
        state.intent = "confirm_temp";
        // Keep the change on the item; do not re-emit an entity temp that would re-trigger capture rules.
        state.entities = { ...state.entities, requested_temp: null };
        state.nlu.confidence = 0.99;
        state.nlu.success = true;
        state.phase = null;
        return true;
      }

      // Otherwise: customer rejected the inferred temp; clear any staged temp and keep waiting.
      if (state.entities) state.entities.requested_temp = null;
      if (state.session) state.session.staged_requested_temp = null;
      if (pi) {
        pi.requested_temp = null;
        // Reset to default/null; leave temp_source as-is.
      }
      state.intent = "awaiting_temp";
      state.nlu.confidence = 0.5;
      state.nlu.success = false;
      return true;
    }

    // Only accept a single clear temperature.
    if ((hasHot && !hasCold) || (hasCold && !hasHot)) {
      const temp = hasHot ? "hot" : "cold";
      // Apply directly to pending item when we are in an explicit temp prompt.
      const pi = state.order && state.order.pending_item && state.order.pending_item.exists ? state.order.pending_item : null;
      if (pi) {
        pi.requested_temp = temp;
        pi.temp_source = "user";
      }
      state.intent = "provide_temp";
      state.entities = { ...state.entities, requested_temp: temp };
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state.phase = null;
      return true;
    }

    // Keep waiting if unclear.
    state.intent = "awaiting_temp";
    state.nlu.confidence = 0.5;
    state.nlu.success = false;
    return true;
  }

  if (phase === "AWAITING_APPLY_SCOPE") {
    const n = normalizeText(text);
    const kws = new Set([...(state.entities?.keywords || [])]);

    const wantsAll = /\ball\b|\bevery\b|\beverything\b|\bboth\b/.test(n);
    const wantsLast = /\blast\b|\bjust\b|\bone\b|\bthis\b|\bthat\b/.test(n);

    if (wantsAll || wantsLast) {
      // Add multiple canonical-ish tokens to maximize rule match probability.
      if (wantsAll) {
        ["all", "apply_to_all", "scope_all", "apply.all"].forEach(x => kws.add(x));
        state.intent = "apply_scope_all";
      } else {
        ["last", "apply_to_last", "scope_last", "apply.last"].forEach(x => kws.add(x));
        state.intent = "apply_scope_last";
      }
      state.entities = { ...state.entities, keywords: Array.from(kws) };
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state.phase = null;
      return true;
    }

    // Keep waiting if unclear.
    state.intent = "awaiting_apply_scope";
    state.nlu.confidence = 0.5;
    state.nlu.success = false;
    return true;
  }

  if (phase === "AWAITING_ORDER_CORRECTION") {
    // Bug 2 fix: for correction text like "change the plain roll to a seeded sub", extractEntities
    // over the full text may pick up the OLD bread (plain roll) instead of the NEW bread (seeded sub)
    // because inferBreadTypeFromText picks the longest match. Extract entities from just the "to X"
    // tail if present, so the correction bread/format refers to the target, not the old value.
    const _corrToMatch = text.match(/\bto\s+(?:a\s+|an\s+)?(.+)$/i);
    const _corrTailText = _corrToMatch ? _corrToMatch[1].trim() : text;
    const ents = extractEntities(_corrTailText, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, config.addonIndex);
    const fmt = inferFormatFromText(_corrTailText);

    // Bug 2 fix (part 2): if correction text contains a bread modifier word ("seeded", "plain", "poppy", etc.)
    // but no explicit bread_type was resolved, try to resolve it by combining with the current item's format.
    // E.g., "make that seeded" on a sub item → format=sub → bread.seeded_sub.
    if (!ents.bread_type && !fmt) {
      const _normCorr = normalizeText(_corrTailText);
      // Map of standalone modifier words → format-specific bread IDs
      const _corrBreadModMap = {
        "seeded":  { sub: "bread.seeded_sub" },
        "plain":   { sub: "bread.plain_sub", roll: "bread.plain_roll" },
        "poppy":   { roll: "bread.poppy_seed_roll" },
        "portuguese": { roll: "bread.portuguese_roll" },
        "knot":    { roll: "bread.knot_roll" },
        "wheat":   { wrap: "bread.wheat_wrap" },
        "white":   { wrap: "bread.white_wrap" },
        "spinach": { wrap: "bread.spinach_wrap" },
      };
      const _corrItems2 = Array.isArray(state.order?.items) ? state.order.items : [];
      const _corrTarget2 = _corrItems2.length > 0 ? _corrItems2[_corrItems2.length - 1] : null;
      const _currFmt = _corrTarget2?.format || null;
      for (const [mod, fmtMap] of Object.entries(_corrBreadModMap)) {
        if (new RegExp("\\b" + mod + "\\b").test(_normCorr) && _currFmt && fmtMap[_currFmt]) {
          ents.bread_type = fmtMap[_currFmt];
          break;
        }
      }
    }

    // Bug 3 fix: "start over" / "restart" / "cancel" in correction phase = full order reset.
    // Must detect BEFORE item-swap and hasAny blocks so it doesn't get misrouted.
    {
      const _normSO = normalizeText(text);
      const _isStartOver = /\bstart\s+over\b|\brestart\b|\bbegin\s+again\b|\bcancel\s+(the\s+)?order\b/.test(_normSO);
      if (_isStartOver) {
        // Reset order completely — clear items, pending item, name, all phases.
        const _freshOrder = initState(config).order;
        state.order = _freshOrder;
        state.phase = null;
        // Use "ordering" intent: it's in the off-topic rule's allowed list so no redirect fires,
        // and FLOW_DO_NOT_ASK_NAME_FOR_INQUIRIES (the only rule matching "ordering") is a no-op.
        state.intent = "ordering";
        state.nlu.confidence = 0.99;
        state.nlu.success = true;
        // Clear any correction/clarification state
        state._correction_awaiting_bread = null;
        state._correction_ambiguity = null;
        state._pending_which_item_clarification = null;
        const _freshSession = initState(config).session;
        _freshSession.start = false; // Don't retrigger FLOW_GREET_ON_SESSION_START greeting
        state.session = _freshSession;
        // Use _pending_which_item_clarification to send fresh-start message via systemSay in main loop.
        // Also set _start_over_complete so the main loop skips the rules engine this turn.
        state._pending_which_item_clarification = "No problem! Let's start fresh. What can I get for you?";
        state._start_over_complete = true;
        return true;
      }
    }

    // Bug Cluster B Fix 2: item-type swap ("change turkey to ham", "switch that to ham").
    // Must detect BEFORE hasAny so we don't fall into condiment/bread/temp modification paths.
    {
      const _swapSig = /\b(change|switch|swap)\b/i.test(text);
      if (_swapSig) {
        const _toMatchSwap = text.match(/\bto\s+(?:a\s+|an\s+)?(\w[\w\s]+?)(?:\s+(?:instead|please))?\s*$/i);
        const _toTextSwap = _toMatchSwap ? _toMatchSwap[1].trim() : null;
        // Bug 2 fix: if "to X" resolves purely to a bread type or format, skip item-swap
        // so the hasAny block can handle it as a bread/format correction instead.
        // E.g. "change the plain roll to a seeded sub" → _toTextSwap = "seeded sub" is a bread, not a menu item.
        const _toIsBreadOrFormat = _toTextSwap ? (!!inferBreadTypeFromText(_toTextSwap, config.breadIndex) || !!inferFormatFromText(_toTextSwap)) : false;
        if (_toTextSwap && _toTextSwap.length >= 2 && !_toIsBreadOrFormat) {
          const _allSwapMenu = Array.isArray(config.menuIndex) ? config.menuIndex : [];
          const _swapItems = Array.isArray(state.order?.items) ? state.order.items : [];
          let _swapIdx = null;
          if (_swapItems.length > 1) _swapIdx = inferTargetItemIndex(_swapItems, text);
          if (_swapIdx == null) _swapIdx = _swapItems.length - 1;
          const _oldSwapIt = _swapItems[_swapIdx];
          // Build a context-aware search text: append the original item's category words
          // (e.g., original "Turkey Sandwich" → search "ham sandwich" not just "ham").
          // This prevents "ham" from matching deli.ham (exact name) over lunch.ham_sandwich.
          const _origNameNorm = normalizeText(_oldSwapIt?.name || "");
          const _origMeat = _origNameNorm.split(/\s+/)[0] || "";
          const _origCategory = _origMeat ? _origNameNorm.slice(_origMeat.length).trim() : "";
          const _swapSearchText = normalizeText(_toTextSwap) + (_origCategory ? " " + _origCategory : "");
          // Prefer same-category items (sandwich→sandwich, deli→deli).
          const _origIsDeli = Boolean(_oldSwapIt && _oldSwapIt.id && _oldSwapIt.id.startsWith("deli."));
          const _sameCatMenu = _allSwapMenu.filter(x => x && x.raw && Boolean(x.id && x.id.startsWith("deli.")) === _origIsDeli);
          let _swapTarget = findBestMenuItem(_swapSearchText, _sameCatMenu.length > 0 ? _sameCatMenu : _allSwapMenu);
          // Fallback: if context search failed, try meat-based lookup within same-category first,
          // then plain text — but NEVER fall back to full menu (which includes deli items
          // that would silently produce wrong-category swaps like "salami" → deli.salami at $0.25).
          if (!_swapTarget) {
            const _swapMeatId = inferMeatFromText(_toTextSwap, config.meatIndex);
            if (_swapMeatId) {
              const _byMeat = (_sameCatMenu.length > 0 ? _sameCatMenu : _allSwapMenu).filter(
                x => Array.isArray(x?.raw?.ingredient_ids?.meats) && x.raw.ingredient_ids.meats.includes(_swapMeatId)
              );
              if (_byMeat.length === 1) {
                _swapTarget = _byMeat[0];
              } else if (_byMeat.length > 1) {
                // Prefer items where this is the ONLY meat (e.g. "salami" → Salami & Cheese,
                // not Italian Cold Cut Combo which also contains salami alongside ham).
                const _singleMeat = _byMeat.filter(x => x.raw.ingredient_ids.meats.length === 1);
                if (_singleMeat.length === 1) {
                  _swapTarget = _singleMeat[0];
                } else {
                  _swapTarget = findBestMenuItem(normalizeText(_toTextSwap) + (_origCategory ? " " + _origCategory : ""), _byMeat.length > 1 && _singleMeat.length > 1 ? _singleMeat : _byMeat);
                }
              }
            }
          }
          if (!_swapTarget) _swapTarget = findBestMenuItem(normalizeText(_toTextSwap), _sameCatMenu.length > 0 ? _sameCatMenu : _allSwapMenu);
          if (_swapTarget && _swapTarget.raw && _swapTarget.raw.id) {
            if (_oldSwapIt && _swapTarget.raw.id !== _oldSwapIt.id) {
              const _swapMi = getMenuItemById(config, _swapTarget.raw.id);
              const _swapBase = getBasePriceForFormat(_swapMi, _oldSwapIt.format);
              const _swapAddonTotal = priceAddons(config, Array.isArray(_oldSwapIt.addons) ? _oldSwapIt.addons : [], _oldSwapIt.format);
              _swapItems[_swapIdx] = {
                ..._oldSwapIt,
                id: _swapTarget.raw.id,
                name: _swapTarget.raw.name || _oldSwapIt.name,
                price: _swapBase != null ? _swapBase + _swapAddonTotal : _oldSwapIt.price,
                total_price: _swapBase != null ? (_swapBase + _swapAddonTotal) * (Number(_oldSwapIt.quantity || 1) || 1) : _oldSwapIt.total_price,
              };
              state.entities = { ...state.entities, target_index: _swapIdx, condiments: [], remove_condiments: [], addons: [], bread_type: null, requested_temp: null };
              state.intent = "modify_confirmed_item";
              state.nlu.confidence = 0.99;
              state.nlu.success = true;
              state.phase = null;
              return true;
            }
          }
        }
      }
    }

    // Deterministically treat any recognized slot content here as a modification.
    // Rules own how (and to which item) the modification is applied.
    const hasRemoveCondiments = Array.isArray(ents?.remove_condiments) && ents.remove_condiments.length > 0;
    const hasAny = Boolean(
      (Array.isArray(ents?.condiments) && ents.condiments.length) ||
      hasRemoveCondiments ||
      ents?.bread_type ||
      ents?.requested_temp ||
      ents?.cheese ||
      fmt ||
      (Array.isArray(ents?.meats) && ents.meats.length)
    );

    if (hasAny) {
      state.intent = "modify_confirmed_item";

      // Resolve which item the user is referring to: ordinal → name match → condiment-owner → last item fallback.
      const items = Array.isArray(state.order?.items) ? state.order.items : [];
      let resolvedIndex = null;

      // 1. Ordinal from extractEntities ("first", "second", etc.)
      if (Number.isInteger(ents.target_index) && items[ents.target_index]) {
        resolvedIndex = ents.target_index;
      }
      // 2. Name-based inference (e.g., "change the turkey", "make the ham and cheese a sub")
      if (resolvedIndex == null && items.length > 1) {
        resolvedIndex = inferTargetItemIndex(items, text);
      }
      // 3. Condiment-owner inference — if removing a condiment and exactly one item has it, target that item.
      //    Issue 2: if MULTIPLE items have it, ask which one.
      if (resolvedIndex == null && hasRemoveCondiments && items.length > 1) {
        const _remIds = new Set(ents.remove_condiments);
        const _ownerIndices = items.reduce((acc, item, idx) => {
          const conds = Array.isArray(item.condiments) ? item.condiments : [];
          if (conds.some((c) => _remIds.has(c))) acc.push(idx);
          return acc;
        }, []);
        if (_ownerIndices.length === 1) {
          resolvedIndex = _ownerIndices[0];
        } else if (_ownerIndices.length > 1) {
          // Issue 2: ambiguous — multiple items carry this condiment. Ask which item.
          const _condName = (() => {
            const _cId = Array.from(_remIds)[0] || "";
            const _cEntry = Array.isArray(config.condimentIndex) ? config.condimentIndex.find(c => c && c.id === _cId) : null;
            return _cEntry?.name || _cId.replace(/^topping\./, "").replace(/_/g, " ");
          })();
          const _itemNames = _ownerIndices.map(i => items[i]?.name || `item ${i + 1}`);
          const _last = _itemNames[_itemNames.length - 1];
          const _rest = _itemNames.slice(0, -1).map(n => `the ${n}`).join(", ");
          const _clarText = `Do you want me to remove the ${_condName} from ${_rest || ("the " + _last)}, the ${_last}, or both?`;
          state._correction_ambiguity = { condimentIds: Array.from(_remIds), itemIndices: _ownerIndices, clarificationText: _clarText };
          state._pending_which_item_clarification = _clarText;
          state.phase = "AWAITING_CORRECTION_WHICH_ITEM";
          state.intent = "awaiting_correction_details";
          state.nlu.confidence = 0.5;
          state.nlu.success = false;
          return true; // early exit — don't fall through to the normal modify flow
        }
      }
      // 4. Fallback to last item (single-item order or no clear name match)
      if (resolvedIndex == null) resolvedIndex = items.length - 1;

      // Map any priced toppings to addon IDs deterministically so correction repricing works.
      const targetItem = items[resolvedIndex];
      const daypart = inferDaypartForItemId(config, targetItem?.id);
      const toppingAddonIds = mapToppingIdsToAddonIds(config, Array.isArray(ents.condiments) ? ents.condiments : [], daypart);
      // When removing condiments, meat names are used for item targeting (e.g., "take off the hot peppers
      // on the turkey"), not for adding meat. Only include meat addon IDs when no remove signal is present.
      // Group 5: Also require an explicit add/extra/double/more signal before treating meat tokens as addons.
      // Without such a signal, meat words are used for item targeting only (e.g., "change the turkey sandwich").
      const _hasExplicitMeatAddSignal = /\b(add|extra|double|more)\b/i.test(text);
      const meatAddonIds = (hasRemoveCondiments || !_hasExplicitMeatAddSignal)
        ? []
        : mapMeatIdsToAddonIds(config, Array.isArray(ents.meats) ? ents.meats : [], daypart);
      const addonIds = Array.from(new Set([...(toppingAddonIds || []), ...(meatAddonIds || [])]));

      // Fix Part5-4A: Format change on confirmed item without an explicit bread type.
      // Apply the new format immediately, then ask what bread they want for it.
      if (fmt && !ents.bread_type) {
        const _corrItemFmt = items[resolvedIndex];
        if (_corrItemFmt) {
          _corrItemFmt.format = fmt;
          _corrItemFmt.bread_type = null;
          const _bq = fmt === "sub"
            ? "What kind of sub — plain or seeded?"
            : fmt === "wrap"
            ? "What kind of wrap — white, wheat, tomato basil, or spinach?"
            : "What kind of roll — plain, poppy seed, Portuguese, or knot?";
          state._correction_awaiting_bread = { index: resolvedIndex };
          state._pending_which_item_clarification = _bq;
          state.phase = "AWAITING_BREAD_TYPE";
          state.intent = "awaiting_correction_details";
          state.nlu.confidence = 0.99;
          state.nlu.success = true;
          return true;
        }
      }

      // Bug 2 fix: when bread_type implies a format change (e.g. "seeded sub" → format=sub),
      // derive the format from the breadIndex group so the confirmed item format updates correctly.
      let _corrDerivedFmt = fmt || null;
      if (!_corrDerivedFmt && ents.bread_type && Array.isArray(config.breadIndex)) {
        const _corrBEntry = config.breadIndex.find(e => e && e.id === ents.bread_type);
        if (_corrBEntry && _corrBEntry.group) _corrDerivedFmt = _corrBEntry.group;
      }

      // Cheese upgrade on confirmed item: swap to cheese variant and reprice in-place.
      if (ents.cheese && items[resolvedIndex] && !items[resolvedIndex].cheese_override) {
        const _corrCi = items[resolvedIndex];
        _corrCi.cheese_override = ents.cheese;
        const _corrCiNewId = CHEESE_UPGRADE_MAP[_corrCi.id];
        if (_corrCiNewId) {
          const _corrCiMi = getMenuItemById(config, _corrCiNewId);
          if (_corrCiMi) {
            _corrCi.id = _corrCiNewId;
            _corrCi.name = _corrCiMi.name || _corrCi.name;
            const _corrCiBase = getBasePriceForFormat(_corrCiMi, _corrCi.format);
            const _corrCiAddon = priceAddons(config, Array.isArray(_corrCi.addons) ? _corrCi.addons : [], _corrCi.format);
            if (_corrCiBase != null) {
              _corrCi.price = _corrCiBase + _corrCiAddon;
              _corrCi.total_price = _corrCi.price * (Number(_corrCi.quantity || 1) || 1);
            }
          }
        }
      }

      state.entities = {
        ...state.entities,
        target_index: resolvedIndex,
        condiments: Array.isArray(ents.condiments) ? ents.condiments : [],
        remove_condiments: hasRemoveCondiments ? ents.remove_condiments : [],
        addons: addonIds,
        bread_type: ents.bread_type || null,
        requested_temp: ents.requested_temp || null,
        ...(_corrDerivedFmt ? { format: _corrDerivedFmt } : {}),
      };
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state.phase = null;
      return true;
    }

    // Detect "no cheese" / "without cheese" / "take off the cheese" as cheese removal.
    // cheese is in cheeseIndex (not condimentIndex), so remove_condiments won't catch it.
    const _hasRemoveCheese = /\b(no|without|hold(?:\s+the)?|remove|take\s+off(?:\s+the)?|take\s+out(?:\s+the)?|drop|skip)\s+(?:the\s+)?cheese\b/i.test(text);
    if (_hasRemoveCheese) {
      const items2 = Array.isArray(state.order?.items) ? state.order.items : [];
      const resolvedIndex2 = items2.length > 0 ? items2.length - 1 : 0;
      state.entities = {
        ...state.entities,
        target_index: resolvedIndex2,
        remove_cheese: true,
        condiments: [],
        remove_condiments: [],
      };
      state.intent = "modify_confirmed_item";
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state.phase = null;
      return true;
    }

    // Nothing actionable detected; keep waiting.
    state.intent = "awaiting_correction_details";
    state.nlu.confidence = 0.5;
    state.nlu.success = false;
    return true;
  }

  // Issue 2: phase to resolve which item the user means after a multi-owner condiment ambiguity.
  if (phase === "AWAITING_CORRECTION_WHICH_ITEM") {
    const amb = state._correction_ambiguity;
    if (!amb) { state.phase = null; return false; }
    const items = Array.isArray(state.order?.items) ? state.order.items : [];
    const n = normalizeText(text);

    // "both" / "all" → apply removal to every owner item then let the rule reprice the first.
    if (/\bboth\b|\ball\b|\beach\b/.test(n)) {
      const [firstIdx, ...restIdx] = amb.itemIndices;
      // Apply removal to secondary items directly (primary handled by apply_item_modification_no_duplicate)
      for (const idx of restIdx) {
        const _it = items[idx];
        if (!_it) continue;
        const _remSet = new Set(amb.condimentIds);
        _it.condiments = Array.isArray(_it.condiments) ? _it.condiments.filter(c => !_remSet.has(c)) : [];
        _it.condiments_specified = true;
        const _remAddonIds = new Set(mapToppingIdsToAddonIds(config, amb.condimentIds, inferDaypartForItemId(config, _it.id)));
        if (_remAddonIds.size && Array.isArray(_it.addons)) _it.addons = _it.addons.filter(a => !_remAddonIds.has(a));
        // Reprice this secondary item in-place using the same helpers as reprice_modified_item_only
        const _mi = getMenuItemById(config, _it.id);
        const _base = getBasePriceForFormat(_mi, _it.format);
        const _addonTotal = priceAddons(config, _it.addons, _it.format);
        if (_base != null) { _it.price = _base + _addonTotal; _it.total_price = _it.price * (Number(_it.quantity || 1) || 1); }
      }
      state.entities = { ...state.entities, target_index: firstIdx, remove_condiments: amb.condimentIds, condiments: [], addons: [], bread_type: null, requested_temp: null };
      state.intent = "modify_confirmed_item";
      state.nlu.confidence = 0.99;
      state.nlu.success = true;
      state.phase = null;
      state._correction_ambiguity = null;
      return true;
    }

    // Match by item name word
    let resolvedIdx = null;
    for (const idx of amb.itemIndices) {
      const iWords = (items[idx]?.name || "").toLowerCase().split(/\s+/).filter(w => w.length > 2 && !/^(and|the|with|on)$/.test(w));
      if (iWords.some(w => n.includes(w))) { resolvedIdx = idx; break; }
    }
    // Ordinal fallback ("first", "second", etc.)
    if (resolvedIdx == null) {
      const ordinals = ["first","second","third","fourth","1st","2nd","3rd","4th"];
      for (let oi = 0; oi < ordinals.length; oi++) {
        if (n.includes(ordinals[oi]) && amb.itemIndices[oi] != null) { resolvedIdx = amb.itemIndices[oi]; break; }
      }
    }
    if (resolvedIdx == null) {
      // Can't resolve — re-emit the clarification and keep waiting
      state._pending_which_item_clarification = amb.clarificationText;
      state.intent = "awaiting_correction_details";
      state.nlu.confidence = 0.5;
      state.nlu.success = false;
      return true;
    }
    state.entities = { ...state.entities, target_index: resolvedIdx, remove_condiments: amb.condimentIds, condiments: [], addons: [], bread_type: null, requested_temp: null };
    state.intent = "modify_confirmed_item";
    state.nlu.confidence = 0.99;
    state.nlu.success = true;
    state.phase = null;
    state._correction_ambiguity = null;
    return true;
  }

  return false;
}

// ---- Web-mode response capture ----
// makeSystemSay returns a systemSay function bound to `state` and an optional captureBuffer.
// When captureBuffer is null (CLI mode), responses are printed to stdout.
// When captureBuffer is an array (web mode), responses are pushed instead of printed.
function makeSystemSay(state, captureBuffer) {
  return function systemSay(lines) {
    // Kiosk polish: collapse consecutive identical lines deterministically (prevents duplicate confirmations
    // when auto-processing queued items in the same turn).
    const deduped = [];
    let last = null;
    for (const line of Array.isArray(lines) ? lines : []) {
      const s = String(line);
      if (s && s === last) continue;
      deduped.push(s);
      last = s;
    }

    // Output tightening: suppress redundant micro-confirmations and merge chatty pairs.
    //
    // Rule 1 — Drop generic one-word confirm before condiment question:
    //   "Got it." + "For the X, any toppings?" → just ask the condiment question.
    //   The condiment question already establishes context; the bare "Got it." adds nothing.
    //
    // Rule 2 — Merge generic item/condiment confirm before "Anything else?":
    //   "Got it." + "Anything else for you today?" → "Got it — anything else?"
    //   Specific confirmations ("Got it — keeping it plain.") carry real info and are kept as-is.
    const _isMicroConfirm = (s) => /^(Got it\.|Perfect\.|You got it\.)$/.test(s);
    const _isCondimentQ   = (s) => /\b(toppings|condiments|anything on it|keep it plain|anything you want on it)\b/i.test(s);
    const _isAnythingElse = (s) => /^(Anything else|What else can I get|Want to add anything else)/i.test(s);
    const _isGenericConfirm = (s) => {
      // Normalize Unicode em-dash (U+2014) and curly apostrophe (U+2019) so PromptID.json
      // variants that use typographic punctuation still match the ASCII-based patterns here.
      const norm = String(s).replace(/[\u2013\u2014]/g, "\u2014").replace(/[\u2018\u2019]/g, "'");
      return /^(Got it\.|Perfect\.|You got it\.|Perfect \u2014 got it\.|Perfect \u2014 I've got that\.|Got it \u2014 added\.)$/.test(norm);
    };

    const out = [];
    for (let i = 0; i < deduped.length; i++) {
      const cur  = deduped[i];
      const next = deduped[i + 1];

      // Rule 1: Drop generic micro-confirm if the next line is a condiment/toppings question.
      // Exception: if a bread recommendation label is stored, replace with "Going with X." before
      // the condiment question so the user knows what bread was selected.
      if (_isMicroConfirm(cur) && next && _isCondimentQ(next)) {
        const _breadRec = state?.session?._bread_recommended_label;
        if (_breadRec) {
          state.session._bread_recommended_label = null; // consume once
          out.push(`Going with ${_breadRec}.`);
        }
        continue; // skip the bare micro-confirm; the condiment question carries the context
      }

      // Rule 2: Merge generic confirm with a following "Anything else?" into one line.
      if (_isGenericConfirm(cur) && next && _isAnythingElse(next)) {
        // If a breakfast add-on label was stored (e.g. "Sausage"), include it in the merge.
        const _bfLabel = state?.session?._bf_addon_label;
        if (_bfLabel) {
          state.session._bf_addon_label = null; // consume once
          out.push(`Got it — ${_bfLabel} added. Anything else on it?`);
        } else {
          out.push("Got it — anything else?");
        }
        // Consume bread recommendation label if present (item finalized before condiment step)
        if (state?.session?._bread_recommended_label) state.session._bread_recommended_label = null;
        i++; // consume the "Anything else?" too
        continue;
      }

      // Rule 3: Drop generic confirm when next line is also a generic confirm (batch sibling chains),
      // or when next line is already a merged "Got it — …" form.
      if (_isGenericConfirm(cur) && next && (_isGenericConfirm(next) || /^Got it —/.test(next))) {
        continue;
      }

      // Rule 4: Merge specific informational confirmation with a following "Anything else?" line.
      // e.g. "Got it — keeping it plain." + "Anything else?" → "Got it — keeping it plain. Anything else?"
      //      "Perfect — no toppings." + "What else can I get you?" → same merge
      // Complement to Rule 2 (which handles bare generic confirms).
      if (/^(Got it|Perfect|You got it|Sure)\s*[\u2014\-]\s*.+\.$/.test(cur) && next && _isAnythingElse(next)) {
        out.push(cur.replace(/\.$/, '') + '. Anything else?');
        i++;
        continue;
      }

      out.push(cur);
    }

    // Post-loop: if a bread recommendation label was set but never consumed by Rule 1 (because
    // no micro-confirm preceded the condiment question), inject "Going with X." before the first
    // condiment question in out. This handles the format-recommendation path where intent is
    // "provide_format" and no BREAD_TYPE_CONFIRMED_SHORT fires.
    if (state?.session?._bread_recommended_label) {
      const _breadRec2 = state.session._bread_recommended_label;
      const _condIdx = out.findIndex(s => _isCondimentQ(String(s)));
      if (_condIdx >= 0) {
        out.splice(_condIdx, 0, `Going with ${_breadRec2}.`);
        state.session._bread_recommended_label = null; // consume
      }
    }

    // Post-processing: compute display name for pending item (with breakfast secondary meat fold).
    const _pi = state?.order?.pending_item;
    let _displayName = _pi?.name ? String(_pi.name) : null;
    // Issue 4: Fold secondary breakfast meat into display name for toppings prompts.
    // e.g. "Bacon Egg & Cheese" with addon.extra_sausage_breakfast → "Bacon Sausage Egg & Cheese"
    if (_displayName && /\bEgg\s*&\s*Cheese\b/i.test(_displayName) && Array.isArray(_pi?.addons)) {
      const _bfSecondary = [];
      for (const _aid of _pi.addons) {
        const _bfM = /^addon\.extra_(.+?)_breakfast$/.exec(String(_aid || ""));
        if (!_bfM) continue;
        const _meatWord = _bfM[1].split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
        _bfSecondary.push(_meatWord);
      }
      if (_bfSecondary.length > 0) {
        _displayName = _displayName.replace(/(\bEgg\s*&\s*Cheese\b)/i, `${_bfSecondary.join(" ")} $1`);
      }
    }

    // Ordinal injection: when processing a duplicate item (batch_index >= 2, total > 1),
    // prefix the item name in format/bread/condiment questions with "first"/"second"/etc.
    // e.g. "For Ham and Cheese, do you want..." → "For the second Ham and Cheese, do you want..."
    const _batchIdx = _pi?._batch_index;
    const _batchTotal = _pi?._total_batch_qty;
    if (_displayName && _batchIdx >= 1 && _batchTotal > 1) {
      const _ordinals = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];
      const _ordWord = _ordinals[_batchIdx - 1] || `#${_batchIdx}`;
      // Use base item name (_pi.name) for search so we find the un-folded string in the prompt.
      const _baseItemName = String(_pi.name);
      // Match "For [the] X" and "On [the] X" — ASK_CONDIMENTS_OR_TOPPINGS uses "On the" variant.
      const _nameRe = new RegExp("((?:For|On)\\s+(?:the\\s+)?)(" + _baseItemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")(?=[,\\s])", "i");
      for (let _oi = 0; _oi < out.length; _oi++) {
        const _ol = String(out[_oi]);
        if (_ol.includes("?") && _nameRe.test(_ol)) {
          out[_oi] = _ol.replace(_nameRe, (m, prefix, name) => `${prefix}the ${_ordWord} ${_displayName}`);
          // Normalize doubled "the" ("For the the second X" → "For the second X").
          out[_oi] = out[_oi].replace(/\b(For|On) the the\b/gi, "$1 the");
        }
      }
      // Second pass: handle "[ItemName] — [question]" prompts (e.g. "Roast beef — hot or cold?").
      // These don't use the "For the X" prefix so the first pass misses them.
      // Transform to "For the [ordinal] [item lowercase] — [question]" for multi-item clarity.
      const _dashRe = new RegExp(
        "^(" + _baseItemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")(\\s*[—–-]\\s*)",
        "i"
      );
      for (let _oi = 0; _oi < out.length; _oi++) {
        const _ol = String(out[_oi]);
        if (_ol.includes("?") && _dashRe.test(_ol)) {
          out[_oi] = _ol.replace(_dashRe, (_m, itemPart, dashPart) =>
            `For the ${_ordWord} ${itemPart.toLowerCase()}${dashPart}`
          );
        }
      }
    } else if (_displayName && _displayName !== _pi?.name) {
      // No ordinal needed but display name differs (breakfast fold only) — replace in question prompts.
      const _baseItemName = String(_pi.name);
      const _nameRe2 = new RegExp("((?:For|On)\\s+(?:the\\s+)?)(" + _baseItemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")(?=[,\\s])", "i");
      for (let _oi = 0; _oi < out.length; _oi++) {
        const _ol = String(out[_oi]);
        if (_ol.includes("?") && _nameRe2.test(_ol)) {
          out[_oi] = _ol.replace(_nameRe2, (m, prefix, name) => `${prefix}${_displayName}`);
        }
      }
    }

    for (const line of out) {
      if (captureBuffer !== null) {
        captureBuffer.push(String(line));
      } else {
        console.log(`SYSTEM: ${String(line)}`);
      }
    }
    if (captureBuffer === null && process.env.NAPOLI_DEBUG_PROMPTS === "1") {
      console.log(`[NAPOLI_DEBUG] last_prompt_id=${state.last_prompt_id} phase=${state.phase} pending_exists=${state.order?.pending_item?.exists} pending_format=${state.order?.pending_item?.format}`);
    }
  };
}

// processTurn: executes one conversation turn synchronously.
// Extracted from the main() while-loop body so the web layer can call it directly.
// Returns { responses: string[], done: boolean }.
function processTurn(state, config, _rawInputText) {
  const captureBuffer = [];
  const systemSay = makeSystemSay(state, captureBuffer);
  const trimmed = _rawInputText;

    // refresh time
    state.time.local_hhmm = getLocalHHMM(config.hours?.timezone || "America/Chicago");

    // Extract inline "for <name>" from full-utterance orders.
    const { cleanText, inlineName } = extractInlineName(trimmed);

    // If the user provides "for <name>" alongside an order, handle it deterministically in two steps:
    //  1) commit the name (intent=provide_name) in this same turn
    //  2) immediately replay the remaining order text once the name is set
    // This avoids requiring the user to repeat their order and prevents "What would you like to order?" dead-ends.
    let effectiveText = cleanText;

    // Pronoun follow-up: substitute "that"/"it" with the last queried item when in ordering context.
    // e.g. "do you have roast beef?" then "okay I want that on a sandwich" → "okay I want roast beef on a sandwich"
    if (state._last_queried_item) {
      const _orderingPronounRe = /\b(?:want|have|get|give(?:\s+me)?|order|take|like|do)\s+(?:that|it)\b|\b(?:that|it)\s+on\b/i;
      if (/\b(that|it)\b/i.test(effectiveText) && _orderingPronounRe.test(effectiveText)) {
        effectiveText = effectiveText.replace(/\b(that|it)\b/i, state._last_queried_item.display);
      }
      state._last_queried_item = null; // Always clear after one turn
    }

    // Deterministic availability question support: "do you have X?"
    // We remove the clause from the order text for parsing, but remember it so we can answer.
    const haveClause = extractDoYouHaveClause(effectiveText);
    effectiveText = haveClause.cleanText;
    const doYouHaveQuery = haveClause.queryText;
    // When the availability query was the entire utterance, suppress rule fallbacks that
    // fire on the resulting empty/near-empty effectiveText.
    const doYouHaveIsEntireUtterance = Boolean(doYouHaveQuery) && !haveClause.cleanText.trim();

    // ---------------------------
    // Multi-item: enqueue additional items from a single utterance
    // Only when it is safe and deterministic (strong separators or "and" followed by a new item starter).
    // This runs before we potentially defer/replay the order for name capture.
    // ---------------------------
    if (state?.order && Array.isArray(state.order.item_queue)) {
      const prelimIntent = detectIntent(effectiveText, state);
      const inItemBuild = Boolean(state?.order?.pending_item?.exists) || Boolean(state?.phase);
      if (prelimIntent === "place_order" && !inItemBuild) {
        // Fix Part3-3: apply typo corrections BEFORE splitting so compound weight phrases
        // like "ona and a half pound" → "one and a half pound" are protected by the
        // _isCompoundWeightSplit guard in splitBySafeAnd.
        const _splitInputText = correctMenuTypos(effectiveText);
        let split = splitMultiItemUtteranceDeterministic(_splitInputText);
        // Fallback: menu-aware split for "X and Y" without quantity words
        if ((!split || !split.rest || !split.rest.length) && config.menuIndex) {
          const maSplit = menuAwareSplitOnAnd(_splitInputText, config.menuIndex);
          if (maSplit) split = maSplit;
        }
        if (split && Array.isArray(split.rest) && split.rest.length) {
          for (const seg of split.rest) {
            state.order.item_queue.push({ kind: "text", text: seg });
          }
          effectiveText = split.first;
        }
      }
    }

    if (inlineName && state.order) {
      const nm = String(inlineName || "").trim();
      const hasOrderText = effectiveText && effectiveText.length > 0;

      if (nm && hasOrderText) {
        // Inline name + order in the same utterance.
        // Commit the name immediately.
        // We will auto-activate the order flow *after* NLU runs (only if we deterministically
        // matched an order payload) so we can continue the order in the same turn without
        // triggering FLOW_ORDER_START_WITH_EXISTING_NAME.
        state.order.customer_name = nm;
        state.order.awaiting_name = false;
        if (state.session) state.session.inline_name = null;

        // Deferred replay is NOT needed here; we keep the original order text in this same turn.
        // Instead, set a deterministic flag so we can safely flip order.active after NLU proves
        // we have an order payload to proceed with.
        state._deferred_order_text = null;
        state._inline_replay_pending = false;
        state._inline_replay_done = false;
        state._auto_activate_from_inline_name = true;
      } else if (nm && !hasOrderText) {
        // Name-only input.
        state.order.customer_name = nm;
        state.order.awaiting_name = false;
        if (state.session) state.session.inline_name = null;

        // IMPORTANT: Do NOT clear any previously deferred order text here.
        // The customer may have ordered on the prior turn (without giving a name),
        // and we need to replay that order now that we have the name.
        // state._deferred_order_text is consumed by the replay block in the main loop.
        state._inline_replay_pending = false;
        state._auto_activate_from_inline_name = false;
      }
    }
    const userText = effectiveText;

    const engine = config.rulesJson.engine || {};

    // ---- Business inquiry intercept (read-only; must not mutate ordering state) ----
    const businessType = detectBusinessInquiry(trimmed);
    // Issue 5: when mid-order in format or bread-type phase, "what do you recommend" is a
    // format/bread recommendation request — skip the BEST_SELLERS business intercept so
    // applyPhaseInput can handle it with _fmtRecommendRe / _breadRecommendRe.
    const _skipBestSellersForPhase =
      businessType === "BEST_SELLERS" &&
      (state?.phase === "AWAITING_FORMAT" || state?.phase === "AWAITING_BREAD_TYPE");
    if (businessType && !_skipBestSellersForPhase) {
      // Build prompt context with unwrapped business/hours objects for templates.
      const ctxBiz = buildCtx(state, config);
      ctxBiz.business = config.business?.business || config.business || {};
      ctxBiz.hours = config.hours?.hours || config.hours || {};

      // Precompute human-friendly fields for business prompts (read-only; context only).
      try {
        ctxBiz.business.payment_methods_human = paymentMethodsHuman(ctxBiz.business.payment_methods);
        ctxBiz.business.parking_details = parkingDetails(ctxBiz.business?.amenities?.parking);
        ctxBiz.business.catering_details = cateringDetails(ctxBiz.business?.services?.catering);
        ctxBiz.business.online_ordering_details = onlineOrderingDetails(ctxBiz.business?.services?.online_ordering);

        const ms = ctxBiz.business?.menu_summary || {};
        const cuisines = Array.isArray(ms.cuisines) ? ms.cuisines : [];
        const offers = Array.isArray(ms.main_offerings) ? ms.main_offerings : [];
        const menuBits = [];
        if (cuisines.length) menuBits.push(humanJoin(cuisines));
        if (offers.length) menuBits.push(humanJoin(offers));
        ctxBiz.business.menu_overview = menuBits.filter(Boolean).join(" — ");

        const ce = ctxBiz.business?.customer_experience || {};
        ctxBiz.business.best_sellers_human = humanJoin(Array.isArray(ce.best_sellers) ? ce.best_sellers : []);
        ctxBiz.business.order_methods_human = humanJoin(Array.isArray(ce.order_methods) ? ce.order_methods.map((x) => String(x).replace(/_/g, " ")) : []);
        ctxBiz.business.avg_wait_time_minutes = (() => {
          const _wt = ce.avg_wait_time_minutes;
          if (_wt == null) return "";
          if (typeof _wt === "object" && _wt !== null) {
            if (_wt.min != null && _wt.max != null) return `${_wt.min}–${_wt.max}`;
            if (_wt.display) return String(_wt.display);
          }
          return String(_wt);
        })();
        ctxBiz.business.avg_price_per_person_human = avgPriceHuman(ce.avg_price_per_person);

        const pol = ctxBiz.business?.policies || {};
        ctxBiz.business.allergen_notice = pol.allergen_notice || "";
        ctxBiz.business.refund_policy = pol.refund_policy || "";
        ctxBiz.business.safety_and_sanitation = pol.safety_and_sanitation || "";
        ctxBiz.business.raw_food_notice = pol.raw_food_notice || "";
      } catch (e) {
        // If enrichment fails, fall back to raw fields only.
      }

      let promptId = null;

      if (businessType === "HOURS") {
        promptId = "HOURS_STANDARD";
      } else if (businessType === "LOCATION") {
        promptId = "BUSINESS_LOCATION";
      } else if (businessType === "PHONE") {
        promptId = "BUSINESS_PHONE";
      } else if (businessType === "DELIVERY") {
        const delivery = Boolean(ctxBiz.business?.services?.delivery);
        promptId = delivery ? "BUSINESS_DELIVERY_AVAILABLE" : "BUSINESS_DELIVERY_NOT_AVAILABLE";
      } else if (businessType === "OPEN_NOW") {
        const isOpen = computeIsOpenNow(ctxBiz.hours);
        if (isOpen === true) promptId = "BUSINESS_OPEN_NOW_YES";
        else if (isOpen === false) promptId = "BUSINESS_OPEN_NOW_NO";
        else promptId = "HOURS_STANDARD";
      } else if (businessType === "WIFI") {
        const wifi = Boolean(ctxBiz.business?.amenities?.wifi);
        promptId = wifi ? "BUSINESS_WIFI_YES" : "BUSINESS_WIFI_NO";
      } else if (businessType === "PAYMENT") {
        promptId = "BUSINESS_PAYMENT_METHODS";
      } else if (businessType === "DINE_IN") {
        const dineIn = Boolean(ctxBiz.business?.services?.dine_in);
        promptId = dineIn ? "BUSINESS_DINE_IN_YES" : "BUSINESS_DINE_IN_NO";
      } else if (businessType === "TAKEOUT") {
        const takeout = Boolean(ctxBiz.business?.services?.takeout);
        promptId = takeout ? "BUSINESS_TAKEOUT_YES" : "BUSINESS_TAKEOUT_NO";
      } else if (businessType === "ONLINE_ORDERING") {
        const oo = Boolean(ctxBiz.business?.services?.online_ordering?.available);
        promptId = oo ? "BUSINESS_ONLINE_ORDERING_AVAILABLE" : "BUSINESS_ONLINE_ORDERING_NOT_AVAILABLE";
      } else if (businessType === "CATERING") {
        const cat = Boolean(ctxBiz.business?.services?.catering?.available);
        promptId = cat ? "BUSINESS_CATERING_AVAILABLE" : "BUSINESS_CATERING_NOT_AVAILABLE";
      } else if (businessType === "PARKING") {
        const park = Boolean(ctxBiz.business?.amenities?.parking?.available);
        promptId = park ? "BUSINESS_PARKING_AVAILABLE" : "BUSINESS_PARKING_NOT_AVAILABLE";
      } else if (businessType === "RESTROOMS") {
        const rr = Boolean(ctxBiz.business?.amenities?.public_restrooms);
        promptId = rr ? "BUSINESS_RESTROOMS_YES" : "BUSINESS_RESTROOMS_NO";
      } else if (businessType === "ACCESSIBILITY") {
        const acc = Boolean(ctxBiz.business?.amenities?.wheelchair_accessible_entrance);
        promptId = acc ? "BUSINESS_ACCESSIBLE_YES" : "BUSINESS_ACCESSIBLE_NO";
      } else if (businessType === "VEGETARIAN") {
        const v = Boolean(ctxBiz.business?.menu_summary?.vegetarian_options);
        promptId = v ? "BUSINESS_VEGETARIAN_YES" : "BUSINESS_VEGETARIAN_NO";
      } else if (businessType === "VEGAN") {
        const v = Boolean(ctxBiz.business?.menu_summary?.dedicated_vegan_menu);
        promptId = v ? "BUSINESS_VEGAN_MENU_YES" : "BUSINESS_VEGAN_MENU_NO";
      } else if (businessType === "GLUTEN_FREE") {
        const gf = Boolean(ctxBiz.business?.menu_summary?.dedicated_gluten_free_menu);
        promptId = gf ? "BUSINESS_GLUTEN_FREE_MENU_YES" : "BUSINESS_GLUTEN_FREE_MENU_NO";
      } else if (businessType === "KIDS_MENU") {
        const km = Boolean(ctxBiz.business?.menu_summary?.kids_menu);
        promptId = km ? "BUSINESS_KIDS_MENU_YES" : "BUSINESS_KIDS_MENU_NO";
      } else if (businessType === "LOYALTY") {
        const lp = Boolean(ctxBiz.business?.loyalty_program?.available);
        promptId = lp ? "BUSINESS_LOYALTY_YES" : "BUSINESS_LOYALTY_NO";
      } else if (businessType === "MENU_OVERVIEW") {
        promptId = "BUSINESS_MENU_OVERVIEW";
      } else if (businessType === "CUSTOMIZE") {
        const ok = Boolean(ctxBiz.business?.menu_summary?.customization_allowed);
        promptId = ok ? "BUSINESS_CUSTOMIZE_YES" : "BUSINESS_CUSTOMIZE_NO";
      } else if (businessType === "BREAKFAST_END") {
        const cutoff = ctxBiz.business?.menu_summary?.breakfast?.cutoff_time || ctxBiz.hours?.breakfast_cutoff;
        promptId = cutoff ? "BUSINESS_BREAKFAST_END" : "HOURS_STANDARD";
      } else if (businessType === "BEST_SELLERS") {
        promptId = "BUSINESS_BEST_SELLERS";
      } else if (businessType === "ORDER_METHODS") {
        promptId = "BUSINESS_ORDER_METHODS";
      } else if (businessType === "WAIT_TIME") {
        promptId = "BUSINESS_AVG_WAIT_TIME";
      } else if (businessType === "PRICE") {
        promptId = "BUSINESS_AVG_PRICE";
      } else if (businessType === "ALLERGEN") {
        promptId = "BUSINESS_ALLERGEN_NOTICE";
      } else if (businessType === "REFUND") {
        promptId = "BUSINESS_REFUND_POLICY";
      } else if (businessType === "SAFETY") {
        promptId = "BUSINESS_SAFETY_SANITATION";
      } else if (businessType === "RAW_FOOD") {
        promptId = "BUSINESS_RAW_FOOD_NOTICE";
      }

      if (promptId) {
        const text = resolvePromptText(config.promptMap, promptId, state, ctxBiz);
        systemSay([text]);
        // Re-ask pending slot after off-topic interruption.
        // If the user asked a business question mid-order (e.g. hours during AWAITING_BREAD_TYPE),
        // answer their question and then re-prompt the pending slot so they know where to pick up.
        const _reaskPids = new Set([
          "ASK_SANDWICH_FORMAT", "ASK_SANDWICH_FORMAT_MULTI",
          "ASK_SUB_BREAD_TYPE", "ASK_ROLL_BREAD_TYPE", "ASK_BREAD_TYPE_FOR_WRAP",
          "ASK_CONDIMENTS_OR_TOPPINGS", "ASK_CONDIMENTS_MULTI",
          "ASK_DELI_WEIGHT", "ASK_DELI_MODE_AMBIGUOUS",
          "ASK_DISH_SIZE", "ASK_TEMP_HOT_OR_COLD",
        ]);
        const _lastPid = state?.last_prompt_id;
        if (_lastPid && _reaskPids.has(_lastPid) && state?.order?.pending_item?.exists) {
          const _reaskCtx = buildCtx(state, config);
          const _reaskText = resolvePromptText(config.promptMap, _lastPid, state, _reaskCtx);
          if (_reaskText) systemSay([_reaskText]);
        }
        return { responses: captureBuffer, done: state.order.confirmed === true };
      }
    }


    // ---- Thanks / acknowledgement intercept (read-only; do not start an order) ----
    if (detectThanks(trimmed)) {
      const pendingExists = Boolean(state.order?.pending_item?.exists);
      const awaitingName = Boolean(state.order?.awaiting_name) || state.phase === "AWAITING_NAME";
      // Only auto-respond when we're not mid-order and not waiting on a required slot.
      if (!pendingExists && !awaitingName && state.phase == null) {
        const ctxThanks = buildCtx(state, config);
        const text = resolvePromptText(config.promptMap, "THANKS_YOURE_WELCOME", state, ctxThanks);
        systemSay([text]);
        return { responses: captureBuffer, done: state.order.confirmed === true };
      }
      // Otherwise, fall through to normal flow (the system will reprompt if needed).
    }


    // Slot/phase-first: interpret short replies (e.g., "yes", "plain", "white") based on what we just asked.
    // This MUST run before name-capture gating so that availability add confirmations ("Would you like to add it?")
    // cannot be accidentally consumed as a customer name.
    // ---------------------------
    // Multi-item: per-item format split for quantity>1 while awaiting format
    // Example: "two ham..." -> ask format -> user replies "one plain sub one poppy roll"
    // This must split into distinct items deterministically (no inference).
    // ---------------------------
    let phaseHandled = false;
    if (
      state?.phase === "AWAITING_FORMAT" &&
      state?.order?.pending_item?.exists === true &&
      Number(state.order.pending_item.quantity || 0) >= 2 &&
      Array.isArray(state?.order?.item_queue)
    ) {
      const qty = Number(state.order.pending_item.quantity || 0) || 0;
      const sels = extractFormatBreadSelections(userText, config.breadIndex);

      const n = normalizeText(userText);
      const wantsBoth = /\bboth\b/.test(n) || /\ball\b/.test(n);

      // Issue 4: "different" at DUO format step → split into N individual items,
      // each with format=null so the format question re-fires for each one separately.
      const _wantsDifferent = /\b(different(ly)?|each\s+(one\s+)?different|different\s+for\s+(each|all)|not\s+the\s+same)\b/i.test(n);
      if (_wantsDifferent && qty >= 2 && sels.length === 0) {
        const _baseClone = JSON.parse(JSON.stringify(state.order.pending_item));
        _baseClone.quantity = 1;
        _baseClone.format = null;
        _baseClone.format_source = null;
        _baseClone.bread_type = null;
        _baseClone.bread_type_prompted = false;
        // Queue items 2..N as snapshots (each will get its own format/bread/condiment questions).
        const _diffRest = [];
        for (let _di = 1; _di < qty; _di++) {
          const _diffClone = JSON.parse(JSON.stringify(_baseClone));
          _diffClone._batch_index = _di + 1;
          _diffClone._total_batch_qty = qty;
          _diffRest.push({ kind: "snapshot", item: _diffClone });
        }
        if (_diffRest.length) state.order.item_queue = [..._diffRest, ...state.order.item_queue];
        // Reset current item to qty=1 with no format so rules re-ask the format question.
        state.order.pending_item = { ...state.order.pending_item, quantity: 1, format: null, format_source: null, bread_type: null, bread_type_prompted: false, _batch_index: 1, _total_batch_qty: qty };
        // Fall through: phaseHandled stays false → applyPhaseInput returns false → rules re-ask format.
      } else {

      // Fix Part3-2: "both the same" / "same for both" at the DUO format step with no format specified.
      // User is confirming identical builds but hasn't specified WHAT format (roll/sub/wrap) yet.
      // Boost confidence + set a valid intent so the guardrail (nlu.confidence < 0.95) doesn't fire.
      // The DUO rule (priority 77015) then re-asks "same or different? You can say both plain rolls..."
      // which is exactly the right guidance for the user to specify their format.
      const _sameBuildOnlyRe = /\b(both\s+the\s+same|same\s+(for\s+)?both|make\s+(them|both)\s+(the\s+)?same|same\s+(on\s+)?both|they(['']?ll?|['']?re)\s+(the\s+)?same|all\s+the\s+same)\b/i;
      if (_sameBuildOnlyRe.test(n) && sels.length === 0 && qty >= 2) {
        // Fix Part4-3: "both the same" — user wants identical builds but hasn't named the format yet.
        // Use a sentinel format to block the DUO rule from re-firing, and show a targeted prompt.
        state.order.pending_item.format = "_same_tbd";
        state.order.pending_item.format_source = "same_sentinel";
        const _qty2Label = qty === 2 ? "both" : `all ${qty}`;
        systemSay([`Got it — what should ${_qty2Label} be on? You can say 'plain rolls', 'plain subs', 'wraps', or choose differently for each.`]);
        state.phase = "AWAITING_FORMAT";
        phaseHandled = true;
        return { responses: captureBuffer, done: state.order.confirmed === true }; // sentinel shown — skip the rules/combinedResponses loop for this turn
      } else {

      let normalized = sels.map((x) => ({ format: x.format, bread_type: x.bread_type }));
      if (normalized.length === 1 && qty > 1 && wantsBoth) {
        normalized = Array.from({ length: qty }, () => ({ ...normalized[0] }));
      }
      if (normalized.length === 1 && qty > 1 && !wantsBoth) {
        // Still accept a single selection as "apply to all" when quantity is already known.
        normalized = Array.from({ length: qty }, () => ({ ...normalized[0] }));
      }

      if (qty > 0 && normalized.length === qty) {
        // Clone the pending item N times, apply per-item format/bread, and queue the rest.
        const base = JSON.parse(JSON.stringify(state.order.pending_item));

        let perItemConds = Array.isArray(state.session?.multi_qty_per_item_condiments) ? state.session.multi_qty_per_item_condiments : null;
        if (!perItemConds && state?.session?.last_order_utterance) {
          const bind = parseExplicitPerItemCondimentBinding(state.session.last_order_utterance, config);
          if (bind && Array.isArray(bind.lists) && bind.lists.length === 2) {
            perItemConds = bind.lists;
            state.session.multi_qty_per_item_condiments = bind.lists;
            state.session.multi_qty_per_item_condiments_source = bind.source || "explicit";
          }
        }

        const makeItem = (sel, idx) => {
          const it = JSON.parse(JSON.stringify(base));
          it.exists = true;
          it.quantity = 1;
          it.format = sel.format || null;
          it.format_source = sel.format ? "user" : null;
          // If the selection includes a specific bread type, set it. Otherwise clear it.
          it.bread_type = sel.bread_type || null;
          it.bread_type_prompted = Boolean(sel.bread_type);
          it._batch_index = idx + 1;
          it._total_batch_qty = normalized.length;

          // Deterministic per-item topping binding (explicit patterns only).
          if (perItemConds && Array.isArray(perItemConds[idx])) {
            it.condiments = [...perItemConds[idx]];
            it.condiments_specified = true;
            it.condiments_prompted = true;
            it.prep_applied = true;
          }
          return it;
        };

        const firstItem = makeItem(normalized[0], 0);
        state.order.pending_item = firstItem;

        // Issue 3: "all same" batch only when user explicitly says same-build language.
        // Same bread type alone does NOT mean same condiments — each item needs its own toppings Q.
        const _explicitSameRe = /\b(same(\s+(as|for)\s+(the\s+)?(first|all|both|each|every|last|one|them|other))?|identical|exact(ly)?\s+the\s+same|make\s+(them|it|all)\s+(the\s+)?same|both\s+the\s+same|all\s+the\s+same)\b/i;
        const _isBatchAllSame = _explicitSameRe.test(n) && sels.length === 1 && qty > 1;

        // Queue remaining clones to be processed immediately after the first one is finalized.
        const rest = [];
        for (let i = 1; i < normalized.length; i++) {
          const _snapItem = makeItem(normalized[i], i);
          // Mark as batch sibling only when condiments aren't already explicitly bound per-item.
          if (_isBatchAllSame && !(_snapItem.condiments_specified === true)) {
            _snapItem._batch_condiment_sibling = true;
          }
          rest.push({ kind: "snapshot", item: _snapItem });
        }
        if (rest.length) {
          // Put these at the front of the queue so they are handled before any later "and also" items.
          state.order.item_queue = [...rest, ...state.order.item_queue];
        }

        // Clear explicit per-item binding after applying it to this split.
        if (state.session) {
          state.session.multi_qty_per_item_condiments = null;
          state.session.multi_qty_per_item_condiments_source = null;
        }

        // Surface to rules as a format-provide turn.
        state.intent = "provide_format";
        state.entities = {
          ...state.entities,
          ...(firstItem.format ? { format: firstItem.format } : {}),
          ...(firstItem.bread_type ? { bread_type: firstItem.bread_type } : {}),
        };
        state.nlu.confidence = 0.99;
        state.nlu.success = true;
        state.phase = null;
        phaseHandled = true;
      }
      } // end else (not sameBuildOnly)
      } // end else (!_wantsDifferent)
    }

    if (!phaseHandled) {
      phaseHandled = applyPhaseInput(state, userText, config);
    }

    // Group 4: AWAITING_DELI_MODE re-ask — when input was unclear (neither sandwich nor weight signal).
    if (phaseHandled && state.phase === "AWAITING_DELI_MODE" && state.intent === "deli_mode_reask") {
      const _piDm = state?.order?.pending_item;
      const _dmName = _piDm?.name || "that";
      if (_piDm?.meatball_alt_is_side === true) {
        systemSay([`I'm not quite getting that — did you want a meatball sub, or a side order of meatballs?`]);
      } else {
        const _dmIsSalad = /^deli\.salad_/.test(_piDm?.item_id || "");
        const _dmWeightPhrase = _dmIsSalad ? "by the pound" : "sliced by the pound";
        systemSay([`I'm not quite getting that — for the ${_dmName}, do you want it as a sandwich or ${_dmWeightPhrase}?`]);
      }
      return { responses: captureBuffer, done: state.order.confirmed === true };
    }

    // If we are awaiting an availability add confirmation and the user's reply was unclear,
    // deterministically re-ask the yes/no without going through rules.
    if (phaseHandled && state.phase === "AWAITING_AVAILABILITY_ADD" && state.nlu?.success === false) {
      const pending = state?.availability;
      if (pending && pending.item_display) {
        const ctxA = buildCtx(state, config);
        ctxA.availability = { item_display: pending.item_display };
        const askAgain = resolvePromptText(config.promptMap, "AVAIL_HAVE_YES_ADD", state, ctxA);
        systemSay([askAgain]);
        return { responses: captureBuffer, done: state.order.confirmed === true };
      }
    }

    // If we were previously asking for the customer's name, do not allow availability add confirmations
    // to advance the normal slot flow (e.g., bread-type prompts) before the name is captured.
    // Deterministic: re-emit ASK_NAME_FOR_ORDER (and the availability add confirmation if present).
    if (
      phaseHandled &&
      state?.order?.awaiting_name === true &&
      state?.order?.customer_name == null &&
      state?.last_prompt_id === "ASK_NAME_FOR_ORDER"
    ) {
      const lines = [];
      if (state._availability_added) {
        const ctx = buildCtx(state, config);
        ctx.availability = { item_display: state._availability_added.item_display || "" };
        lines.push(resolvePromptText(config.promptMap, "AVAIL_ADD_APPLIED", state, ctx));
        state._availability_added = null;
      }

      // Keep phase/awaiting_name consistent with the name prompt.
      setPhaseFromPromptId(state, "ASK_NAME_FOR_ORDER");
      lines.push(resolvePromptText(config.promptMap, "ASK_NAME_FOR_ORDER", state, buildCtx(state, config)));
      systemSay(lines);
      return { responses: captureBuffer, done: state.order.confirmed === true };
    }


    // Absolute guard: if we're awaiting a name, treat the user's reply strictly as a name answer.
    // This must happen BEFORE any normal NLU/intent detection so we don't override provide_name.
    if (!phaseHandled && (state.phase === "AWAITING_NAME" || state.order?.awaiting_name === true) && isLikelyName(userText)) {
      state.intent = "provide_name";
      state.entities = { ...state.entities, customer_name: String(userText).trim() };
      state.nlu.confidence = 0.99;
      state.nlu.success = true;      // Do not commit name or flip order.active here; rules own those fields.
      state.phase = null;

      const outName = runRulesStepped(state, config);

      // If the user ordered before giving a name, replay the deferred order immediately after the name is committed.
      // Only replay when a pending item was NOT already created from the earlier utterance.
      if (state._deferred_order_text && state.order?.customer_name && !(state?.order?.pending_item?.exists)) {
        const replay = state._deferred_order_text;
        state._deferred_order_text = null;
        const nlu2 = mockNLU(replay, state, config, config.menuIndex, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, engine, config.menuItemAliases);
        state.intent = nlu2.intent;
        state.entities = { ...state.entities, ...nlu2.entities };
        state.nlu.confidence = nlu2.confidence;
        state.nlu.success = nlu2.success;
        const out2 = runRulesStepped(state, config);
        if (out2.responses.length) {
          systemSay(out2.responses);
        } else {
          systemSay(outName.responses);
        }
      } else {
        systemSay(outName.responses);
      }
      return { responses: captureBuffer, done: state.order.confirmed === true };
    }

    if (!phaseHandled && (state.phase === "AWAITING_NAME" || state.order?.awaiting_name === true)) {
      // Exception: info/menu queries should pass through to NLU + handleMenuQuestion
      // so they can be answered without consuming the name slot.
      const _nameInfoPassRe = /\bwhat\s+(comes?\s+on|does\s+it\s+come|breads?|rolls?|wraps?|subs?|is\s+(on|included))\b/i;
      const _nameInfoPassRe2 = /\bdo\s+you\s+(have|carry|sell|make)\b/i;
      if (!_nameInfoPassRe.test(userText) && !_nameInfoPassRe2.test(userText)) {
        // We are explicitly waiting on a name, but the input doesn't look like a name.
        // Do not fall into general NLU; deterministically re-ask for the name.
        const again = resolvePromptText(config.promptMap, "ASK_NAME_FOR_ORDER", state, buildCtx(state, config));
        systemSay([again]);
        return { responses: captureBuffer, done: state.order.confirmed === true };
      }
    }

    // If the user placed an order before giving their name, capture that raw text
    // so we can parse it after name capture without forcing them to repeat it.
    // Only set once per flow, and ONLY when we truly expect a name capture to occur.
    //
    // Guard against accidental duplication when the customer name is already present
    // (e.g., "Turkey... for Tyler") — in that case we should NOT defer/replay.
    if (
      state?._deferred_order_text == null &&
      state?.order?.customer_name == null &&
      state?.session?.inline_name == null &&
      detectIntent(userText, state) === "place_order"
    ) {
      state._deferred_order_text = userText;
      if (state.session) state.session.last_order_utterance = userText;
    }

    let nlu;
    if (!phaseHandled) {
      nlu = mockNLU(userText, state, config, config.menuIndex, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, engine, config.menuItemAliases);

      state.intent = nlu.intent;
      state.entities = { ...state.entities, ...nlu.entities };
      state.nlu.confidence = nlu.confidence;
      state.nlu.success = nlu.success;

      // Post-NLU confidence override: if a panini item has pressing captured (pressed !== null)
      // but prep has not yet been applied, the system is in a post-press transition state.
      // Override low confidence so NLU_REPHRASE_IF_CONFIDENCE_LOW doesn't intercept the turn
      // before PREP_APPLY_HOT/COLD_FOR_PANINI_WHEN_PRESSED_SET can fire.
      if (
        state.order?.pending_item?.exists === true &&
        state.order?.pending_item?.format === "panini" &&
        state.order?.pending_item?.pressed != null &&
        state.order?.pending_item?.prep_applied !== true &&
        state.nlu.confidence < 0.95
      ) {
        state.nlu.confidence = 0.99;
        state.nlu.success = true;
      }
    } else {
      // applyPhaseInput already wrote intent/entities/nlu fields
      nlu = { intent: state.intent, entities: state.entities, confidence: state.nlu.confidence, success: state.nlu.success };
    }

    // Inline "for <name>" + order in the same utterance:
    // Only after NLU deterministically proves we have an order payload, flip order.active
    // so downstream ordering rules can proceed in the same turn (without firing start prompts).
    if (state._auto_activate_from_inline_name === true) {
      const hasPending = state?.order?.pending_item?.exists === true;
      const hasMenuId = Boolean(state?.entities?.menu_item_id);
      if (state?.order?.customer_name && state.intent === "place_order" && (hasPending || hasMenuId)) {
        state.order.active = true;
      }
      state._auto_activate_from_inline_name = false;
    }

    // Deferred order replay: if the user provides an order before the name is committed,
    // store the raw order text so it can be replayed immediately after name capture.
    // Use the actual NLU result (not detectIntent), because bare orders like "ham and cheese"
    // may not match the simple keyword intent detector.
    if (
      state?._deferred_order_text == null &&
      state?.order?.customer_name == null &&
      state?.session?.inline_name == null &&
      state.intent === "place_order" &&
      typeof userText === "string" &&
      userText.trim().length
    ) {
      state._deferred_order_text = userText;
      if (state.session) state.session.last_order_utterance = userText;
    }

    // session failed attempts reset on success
    if (config.rulesJson.session_defaults?.failed_attempts_reset_on_success && state.nlu.success) {
      state.session.failed_attempts = 0;
    }

    // Name capture is handled by rules (FLOW_ORDER_CAPTURE_NAME) via set using {entities.customer_name}.

    // Issue 1: detect category-specific bread/roll/wrap query; stored for resolvePromptText intercept.
    if (state.intent === "ask_bread_options") {
      const _rawBo = normalizeText(userText);
      if (/\bwraps?\b/.test(_rawBo) && !/\b(roll|sub|bread)\b/.test(_rawBo)) {
        state._bread_opt_category = "wrap";
      } else if (/\brolls?\b/.test(_rawBo) && !/\b(wrap|sub|bread)\b/.test(_rawBo)) {
        state._bread_opt_category = "roll";
      } else if (/\bsubs?\b/.test(_rawBo) && !/\b(wrap|roll|bread)\b/.test(_rawBo)) {
        state._bread_opt_category = "sub";
      } else {
        state._bread_opt_category = null;
      }
    }

    const menuAnswer = handleMenuQuestion(nlu, config.menuIndex, state);
    if (menuAnswer) {
      systemSay([menuAnswer]);
      return { responses: captureBuffer, done: state.order.confirmed === true };
    }

    // Bug 3: if start-over was triggered, skip the rules loop entirely and just output the message.
    if (state._start_over_complete) {
      state._start_over_complete = false;
      if (state._pending_which_item_clarification) {
        systemSay([state._pending_which_item_clarification]);
        state._pending_which_item_clarification = null;
      }
      return { responses: captureBuffer, done: state.order.confirmed === true };
    }

    // Run rules until we produce a user-visible response (or no rule matches).
    const combinedResponses = [];
    let steps = 0;

    while (steps < 15) {
      const out = runRulesStepped(state, config);

      // If we auto-captured a name from an inline "for <name>" AND we have stashed order text,
      // immediately replay that order text now that the name is committed. This prevents the
      // system from asking "What would you like to order?" after already receiving a full order.
      if (state._inline_replay_pending && state._deferred_order_text && state.order?.customer_name && !state._inline_replay_done) {
        state._inline_replay_done = true;
        state._inline_replay_pending = false;
        const replay = state._deferred_order_text;
        state._deferred_order_text = null;
        state._auto_name_from_inline = false;
        if (state.session) state.session.inline_name = null;

        const nlu2 = mockNLU(replay, state, config, config.menuIndex, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, engine, config.menuItemAliases);
        state.intent = nlu2.intent;
        state.entities = { ...state.entities, ...nlu2.entities };
        state.nlu.confidence = nlu2.confidence;
        state.nlu.success = nlu2.success;

        const out2 = runRulesStepped(state, config);
        if (out2.responses.length) {
          combinedResponses.push(...out2.responses);
          break;
        }
      }


      // If we captured a name via the name prompt (provide_name) and we stashed order text from earlier,
      // replay it now that the name is committed.
      // Only replay deferred order text if the item was NOT already created (pending_item.exists = false).
      // If pending_item already exists, the item was matched upfront; replaying would re-process it.
      if (state._replay_after_name_pending && state._deferred_order_text && state.order?.customer_name && !state._replay_after_name_done && !(state.order?.pending_item?.exists)) {
        state._replay_after_name_done = true;
        state._replay_after_name_pending = false;

        const replay = state._deferred_order_text;
        state._deferred_order_text = null;

        const nlu2 = mockNLU(replay, state, config, config.menuIndex, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, engine, config.menuItemAliases);
        state.intent = nlu2.intent;
        state.entities = { ...state.entities, ...nlu2.entities };
        state.nlu.confidence = nlu2.confidence;
        state.nlu.success = nlu2.success;

        const out2 = runRulesStepped(state, config);
        if (out2.responses.length) {
          combinedResponses.push(...out2.responses);
          break;
        }
      }

      if (out.responses.length) {
        combinedResponses.push(...out.responses);

        // Multi-item queue replay: if the last rule finalized an item and scheduled
        // a queued follow-up, process the next queued entry immediately (same user turn).
        // Use a while-loop so that batch-sibling items (pre-filled condiments) chain through
        // without requiring a new user turn for each one. The loop only continues when
        // finalize_pending_item_add_to_order schedules the next replay (_queue_replay_pending),
        // so items that still need user input (format, condiments, etc.) break naturally.
        // Fix 1B: After readback "no [correction text]" fires CLOSE_HANDLE_READBACK_NEEDS_CHANGES
        // and transitions to AWAITING_ORDER_CORRECTION, immediately replay the inline correction
        // text so the user's change is applied in the same turn (no extra prompt round-trip).
        if (state._correction_inline_text && state.phase === "AWAITING_ORDER_CORRECTION") {
          // The rules just emitted "No problem — what should I change?" (OKAY_WHAT_SHOULD_I_FIX).
          // Since we already have the inline correction text, suppress that prompt so we don't
          // ask a question that the user already answered.
          if (state.last_prompt_id === "OKAY_WHAT_SHOULD_I_FIX" && combinedResponses.length > 0) {
            combinedResponses.pop();
          }
          const _corrText = state._correction_inline_text;
          state._correction_inline_text = null;
          clearTransientInput(state);
          // Try applyPhaseInput first (AWAITING_ORDER_CORRECTION) since it correctly
          // handles removal phrases like "take off the lettuce" via extractEntities.
          // Only fall back to mockNLU if applyPhaseInput does not handle the text.
          const _corrPhaseHandled = applyPhaseInput(state, _corrText, config);
          if (!_corrPhaseHandled) {
            const _corrNLU = mockNLU(_corrText, state, config, config.menuIndex, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, engine, config.menuItemAliases);
            state.intent = _corrNLU.intent;
            state.entities = { ...state.entities, ..._corrNLU.entities };
            state.nlu.confidence = _corrNLU.confidence;
            state.nlu.success = _corrNLU.success;
          }
          // If applyPhaseInput triggered a start-over reset, skip rules and surface the
          // fresh-start message directly (don't let _start_over_complete bleed into the
          // next readline turn, which would cause the next user input to be silently skipped).
          if (state._start_over_complete) {
            state._start_over_complete = false;
            if (state._pending_which_item_clarification) {
              combinedResponses.push(state._pending_which_item_clarification);
              state._pending_which_item_clarification = null;
            }
          } else {
            const _corrOut = runRulesStepped(state, config);
            if (_corrOut.responses && _corrOut.responses.length) {
              combinedResponses.push(..._corrOut.responses);
            }
          }
        }

        while (state._queue_replay_pending && state._queue_replay_entry) {
          const entry = state._queue_replay_entry;
          state._queue_replay_pending = false;
          state._queue_replay_entry = null;

          // Clear transient input before replaying.
          clearTransientInput(state);

          if (entry.kind === "snapshot" && entry.item && typeof entry.item === "object") {
            state.order.pending_item = entry.item;
            state.order.pending_item.exists = true;
            state.intent = "place_order";
            state.nlu.confidence = 0.99;
            state.nlu.success = true;
          } else if (entry.kind === "text" && typeof entry.text === "string") {
            const nlu2 = mockNLU(entry.text, state, config, config.menuIndex, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, engine, config.menuItemAliases);
            state.intent = nlu2.intent;
            state.entities = { ...state.entities, ...nlu2.entities };
            state.nlu.confidence = nlu2.confidence;
            state.nlu.success = nlu2.success;
          }

          const out2 = runRulesStepped(state, config);
          if (out2.responses && out2.responses.length) {
            combinedResponses.push(...out2.responses);
          }
        }

        break;
      }

      if (!out.matched) break;

      // Matched a rule but it only performed sets/emits (no respond).
      clearTransientInput(state);

      steps += 1;
    }

    // Availability question answer ("do you have X?") can occur at any point.
    // It must not mutate order state. If the item is an addable condiment/topping and an order is active,
    // we can offer to add it with explicit confirmation.
    if (doYouHaveQuery) {
      const res = resolveAvailability(doYouHaveQuery, config);
      const ctxAvail = buildCtx(state, config);
      ctxAvail.availability = { item_display: res.item_display };

      // Only offer to add when we deterministically resolved a single condiment/topping.
      const canOfferAdd = res.found && res.type === "condiment" && /^((topping|condiment)\.)/.test(String(res.id || ""));
      const hasActiveOrder = state?.order?.active === true || state?.order?.pending_item?.exists === true;

      if (canOfferAdd && hasActiveOrder) {
        // Remember the offer so a later "yes/no" can be handled deterministically.
        state.availability = {
          pending_id: res.id,
          pending_type: res.type,
          item_display: res.item_display,
          resume_phase: state.phase || null,
        };
        state.phase = "AWAITING_AVAILABILITY_ADD";
        const offer = resolvePromptText(config.promptMap, "AVAIL_HAVE_YES_ADD", state, ctxAvail);
        systemSay([offer]);
        return { responses: captureBuffer, done: state.order.confirmed === true };
      }

      // Otherwise, answer yes/no and then continue with normal responses (if any).
      // When the availability query was the entire utterance, suppress rule fallbacks that
      // fired on the empty effective text (e.g. CLARIFY_REQUEST from unknown intent).
      const pid = res.found ? "AVAIL_HAVE_YES" : "AVAIL_HAVE_NO";
      const ans = resolvePromptText(config.promptMap, pid, state, ctxAvail);
      const outLines = doYouHaveIsEntireUtterance ? [ans] : [ans, ...combinedResponses];
      // Store resolved non-condiment item for pronoun follow-up next turn
      // ("I want that", "okay give me that on a roll"). Condiments have their own
      // offer-to-add flow above, so we only store menu items, meats, cheeses, breads.
      if (res.found && res.id && res.type !== "condiment") {
        state._last_queried_item = { id: res.id, type: res.type, display: res.item_display };
      } else {
        state._last_queried_item = null;
      }
      systemSay(outLines);
      return { responses: captureBuffer, done: state.order.confirmed === true };
    }

    // Issue 2: inject "which item?" clarification when condiment removal is ambiguous
    // (no rules fire for this case, so we inject directly into combinedResponses here).
    if (state._pending_which_item_clarification) {
      combinedResponses.push(state._pending_which_item_clarification);
      state._pending_which_item_clarification = null;
    }

    if (combinedResponses.length) {
      // If an availability add was just applied ("Yes, add it"), surface a deterministic confirmation
      // before continuing the normal flow.
      if (state._availability_added) {
        const ctx = buildCtx(state, config);
        ctx.availability = {
          item_display: state._availability_added.item_display || "",
        };
        const msg = resolvePromptText(config.promptMap, "AVAIL_ADD_APPLIED", state, ctx);
        combinedResponses.unshift(msg);
        state._availability_added = null;
      }
      systemSay(combinedResponses);
    } else {
      // Issue 2: AWAITING_NAME handler sets customer_name before rules run, so
      // FLOW_ORDER_CAPTURE_NAME (which requires customer_name=null) cannot fire.
      // If _name_captured_in_phase is true and pending_item already exists (user said
      // item + name in sequence), run a place_order pass to fire the format/bread question.
      if (state._name_captured_in_phase) {
        state._name_captured_in_phase = false;
        state.intent = "place_order";
        state.nlu.confidence = 0.99;
        state.nlu.success = true;
        const outName = runRulesStepped(state, config);
        if (outName.responses.length) {
          systemSay(outName.responses);
        }
      } else {
      // Fallback: if we failed to match any rule but the utterance looks like an order,
      // force intent=place_order and try once more (prevents "no rule matched" on clear orders).
      const normFallback = normalizeText(userText);
      const hasOrderSignal =
        /\b(roll|sub|wrap|panini)\b/.test(normFallback) ||
        /\b(can i (get|have)|i\s*(?:'d| would)\s*like|i\s*want|gimme|give me|let me get|lemme get|order)\b/.test(normFallback) ||
        (state?.lexicon ? normFallback.split(/\s+/).some((t) => state.lexicon.meats?.has(t) || state.lexicon.cheeses?.has(t) || state.lexicon.toppings?.has(t) || state.lexicon.condiments?.has(t)) : false);

      if (hasOrderSignal && state.intent !== "place_order") {
        state.intent = "place_order";
        state.nlu.confidence = 0.99;
        state.nlu.success = true;
        const outRetry = runRulesStepped(state, config);
        if (outRetry.responses.length) {
          systemSay(outRetry.responses);
        } else {
          captureBuffer.push("Sorry, I didn't catch that — could you say it another way?");
        }
      } else {
        captureBuffer.push("Sorry, I didn't catch that — could you say it another way?");
      }
      } // end else (_name_captured_in_phase fallback)
    }

  // If any response in this turn is a question, drop bare "Got it." lines —
  // they add nothing when a follow-up question already appears in the same bubble.
  // Longer "Got it — X" phrases (which carry informative content) are preserved.
  const _hasQ = captureBuffer.some(r => String(r).includes("?"));
  const _responses = _hasQ
    ? captureBuffer.filter(r => !/^got it[.!]?\s*$/i.test(String(r).trim()))
    : captureBuffer;

  return { responses: _responses, done: state.order.confirmed === true };
}

async function main() {
  const config = loadConfig();
  const isTTY = Boolean(process.stdin.isTTY);
  // Line-buffered queue so piped input (test harness, CI) works correctly.
  // rl.question() with output:stdout blocks on non-TTY; this pattern avoids that.
  const _lineQueue = [];
  let _lineWaiter = null;
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    if (_lineWaiter) { const r = _lineWaiter; _lineWaiter = null; r(line); }
    else _lineQueue.push(line);
  });

  const state = initState(config);
  // Attach config-derived lexicons/indexes to state for deterministic intent/entity detection.
  state.lexicon = config.lexicon;
  state.menuItemAliases = config.menuItemAliases;
  state.breadIndex = config.breadIndex;
  state.menuIndex = config.menuIndex;


  const systemSay = makeSystemSay(state, null);

  function ask(q) {
    if (isTTY) process.stdout.write(q);
    return new Promise((res) => {
      if (_lineQueue.length > 0) res(_lineQueue.shift());
      else _lineWaiter = res;
    });
  }

  // Greeting (run once)
  // Start deterministically with PromptID GREETING (not OFF_TOPIC redirects).
  // This is a product requirement: greet first, then handle input.
  const greetText = resolvePromptText(config.promptMap, "GREETING", state, buildCtx(state, config));
  systemSay([greetText]);

  // Critical: FLOW_GREET_ON_SESSION_START is keyed off session.start=true. Flip it off after greeting.
  state.session.start = false;

  while (true) {
    const input = await ask("YOU: ");
    const trimmed = String(input || "").trim();
    if (!trimmed) continue;
    const low = trimmed.toLowerCase();
    if (low === "exit" || low === "quit") break;

    const { responses, done } = processTurn(state, config, trimmed);
    for (const r of responses) {
      console.log(`SYSTEM: ${String(r)}`);
    }
    if (done) break;
    continue; // processTurn handled this turn; legacy body below is intentionally unreachable

    // refresh time (dead code — covered by processTurn above; kept for reference only)
    state.time.local_hhmm = getLocalHHMM(config.hours?.timezone || "America/Chicago");

    // Extract inline "for <name>" from full-utterance orders.
    const { cleanText, inlineName } = extractInlineName(trimmed);

    // If the user provides "for <name>" alongside an order, handle it deterministically in two steps:
    //  1) commit the name (intent=provide_name) in this same turn
    //  2) immediately replay the remaining order text once the name is set
    // This avoids requiring the user to repeat their order and prevents "What would you like to order?" dead-ends.
    let effectiveText = cleanText;

    // Pronoun follow-up: substitute "that"/"it" with the last queried item when in ordering context.
    // e.g. "do you have roast beef?" then "okay I want that on a sandwich" → "okay I want roast beef on a sandwich"
    if (state._last_queried_item) {
      const _orderingPronounRe = /\b(?:want|have|get|give(?:\s+me)?|order|take|like|do)\s+(?:that|it)\b|\b(?:that|it)\s+on\b/i;
      if (/\b(that|it)\b/i.test(effectiveText) && _orderingPronounRe.test(effectiveText)) {
        effectiveText = effectiveText.replace(/\b(that|it)\b/i, state._last_queried_item.display);
      }
      state._last_queried_item = null; // Always clear after one turn
    }

    // Deterministic availability question support: "do you have X?"
    // We remove the clause from the order text for parsing, but remember it so we can answer.
    const haveClause = extractDoYouHaveClause(effectiveText);
    effectiveText = haveClause.cleanText;
    const doYouHaveQuery = haveClause.queryText;
    // When the availability query was the entire utterance, suppress rule fallbacks that
    // fire on the resulting empty/near-empty effectiveText.
    const doYouHaveIsEntireUtterance = Boolean(doYouHaveQuery) && !haveClause.cleanText.trim();

    // ---------------------------
    // Multi-item: enqueue additional items from a single utterance
    // Only when it is safe and deterministic (strong separators or "and" followed by a new item starter).
    // This runs before we potentially defer/replay the order for name capture.
    // ---------------------------
    if (state?.order && Array.isArray(state.order.item_queue)) {
      const prelimIntent = detectIntent(effectiveText, state);
      const inItemBuild = Boolean(state?.order?.pending_item?.exists) || Boolean(state?.phase);
      if (prelimIntent === "place_order" && !inItemBuild) {
        // Fix Part3-3: apply typo corrections BEFORE splitting so compound weight phrases
        // like "ona and a half pound" → "one and a half pound" are protected by the
        // _isCompoundWeightSplit guard in splitBySafeAnd.
        const _splitInputText = correctMenuTypos(effectiveText);
        let split = splitMultiItemUtteranceDeterministic(_splitInputText);
        // Fallback: menu-aware split for "X and Y" without quantity words
        if ((!split || !split.rest || !split.rest.length) && config.menuIndex) {
          const maSplit = menuAwareSplitOnAnd(_splitInputText, config.menuIndex);
          if (maSplit) split = maSplit;
        }
        if (split && Array.isArray(split.rest) && split.rest.length) {
          for (const seg of split.rest) {
            state.order.item_queue.push({ kind: "text", text: seg });
          }
          effectiveText = split.first;
        }
      }
    }

    if (inlineName && state.order) {
      const nm = String(inlineName || "").trim();
      const hasOrderText = effectiveText && effectiveText.length > 0;

      if (nm && hasOrderText) {
        // Inline name + order in the same utterance.
        // Commit the name immediately.
        // We will auto-activate the order flow *after* NLU runs (only if we deterministically
        // matched an order payload) so we can continue the order in the same turn without
        // triggering FLOW_ORDER_START_WITH_EXISTING_NAME.
        state.order.customer_name = nm;
        state.order.awaiting_name = false;
        if (state.session) state.session.inline_name = null;

        // Deferred replay is NOT needed here; we keep the original order text in this same turn.
        // Instead, set a deterministic flag so we can safely flip order.active after NLU proves
        // we have an order payload to proceed with.
        state._deferred_order_text = null;
        state._inline_replay_pending = false;
        state._inline_replay_done = false;
        state._auto_activate_from_inline_name = true;
      } else if (nm && !hasOrderText) {
        // Name-only input.
        state.order.customer_name = nm;
        state.order.awaiting_name = false;
        if (state.session) state.session.inline_name = null;

        // IMPORTANT: Do NOT clear any previously deferred order text here.
        // The customer may have ordered on the prior turn (without giving a name),
        // and we need to replay that order now that we have the name.
        // state._deferred_order_text is consumed by the replay block in the main loop.
        state._inline_replay_pending = false;
        state._auto_activate_from_inline_name = false;
      }
    }
    const userText = effectiveText;

    const engine = config.rulesJson.engine || {};

    // ---- Business inquiry intercept (read-only; must not mutate ordering state) ----
    const businessType = detectBusinessInquiry(trimmed);
    // Issue 5: when mid-order in format or bread-type phase, "what do you recommend" is a
    // format/bread recommendation request — skip the BEST_SELLERS business intercept so
    // applyPhaseInput can handle it with _fmtRecommendRe / _breadRecommendRe.
    const _skipBestSellersForPhase =
      businessType === "BEST_SELLERS" &&
      (state?.phase === "AWAITING_FORMAT" || state?.phase === "AWAITING_BREAD_TYPE");
    if (businessType && !_skipBestSellersForPhase) {
      // Build prompt context with unwrapped business/hours objects for templates.
      const ctxBiz = buildCtx(state, config);
      ctxBiz.business = config.business?.business || config.business || {};
      ctxBiz.hours = config.hours?.hours || config.hours || {};

      // Precompute human-friendly fields for business prompts (read-only; context only).
      try {
        ctxBiz.business.payment_methods_human = paymentMethodsHuman(ctxBiz.business.payment_methods);
        ctxBiz.business.parking_details = parkingDetails(ctxBiz.business?.amenities?.parking);
        ctxBiz.business.catering_details = cateringDetails(ctxBiz.business?.services?.catering);
        ctxBiz.business.online_ordering_details = onlineOrderingDetails(ctxBiz.business?.services?.online_ordering);

        const ms = ctxBiz.business?.menu_summary || {};
        const cuisines = Array.isArray(ms.cuisines) ? ms.cuisines : [];
        const offers = Array.isArray(ms.main_offerings) ? ms.main_offerings : [];
        const menuBits = [];
        if (cuisines.length) menuBits.push(humanJoin(cuisines));
        if (offers.length) menuBits.push(humanJoin(offers));
        ctxBiz.business.menu_overview = menuBits.filter(Boolean).join(" — ");

        const ce = ctxBiz.business?.customer_experience || {};
        ctxBiz.business.best_sellers_human = humanJoin(Array.isArray(ce.best_sellers) ? ce.best_sellers : []);
        ctxBiz.business.order_methods_human = humanJoin(Array.isArray(ce.order_methods) ? ce.order_methods.map((x) => String(x).replace(/_/g, " ")) : []);
        ctxBiz.business.avg_wait_time_minutes = (() => {
          const _wt = ce.avg_wait_time_minutes;
          if (_wt == null) return "";
          if (typeof _wt === "object" && _wt !== null) {
            if (_wt.min != null && _wt.max != null) return `${_wt.min}–${_wt.max}`;
            if (_wt.display) return String(_wt.display);
          }
          return String(_wt);
        })();
        ctxBiz.business.avg_price_per_person_human = avgPriceHuman(ce.avg_price_per_person);

        const pol = ctxBiz.business?.policies || {};
        ctxBiz.business.allergen_notice = pol.allergen_notice || "";
        ctxBiz.business.refund_policy = pol.refund_policy || "";
        ctxBiz.business.safety_and_sanitation = pol.safety_and_sanitation || "";
        ctxBiz.business.raw_food_notice = pol.raw_food_notice || "";
      } catch (e) {
        // If enrichment fails, fall back to raw fields only.
      }

      let promptId = null;

      if (businessType === "HOURS") {
        promptId = "HOURS_STANDARD";
      } else if (businessType === "LOCATION") {
        promptId = "BUSINESS_LOCATION";
      } else if (businessType === "PHONE") {
        promptId = "BUSINESS_PHONE";
      } else if (businessType === "DELIVERY") {
        const delivery = Boolean(ctxBiz.business?.services?.delivery);
        promptId = delivery ? "BUSINESS_DELIVERY_AVAILABLE" : "BUSINESS_DELIVERY_NOT_AVAILABLE";
      } else if (businessType === "OPEN_NOW") {
        const isOpen = computeIsOpenNow(ctxBiz.hours);
        if (isOpen === true) promptId = "BUSINESS_OPEN_NOW_YES";
        else if (isOpen === false) promptId = "BUSINESS_OPEN_NOW_NO";
        else promptId = "HOURS_STANDARD";
      } else if (businessType === "WIFI") {
        const wifi = Boolean(ctxBiz.business?.amenities?.wifi);
        promptId = wifi ? "BUSINESS_WIFI_YES" : "BUSINESS_WIFI_NO";
      } else if (businessType === "PAYMENT") {
        promptId = "BUSINESS_PAYMENT_METHODS";
      } else if (businessType === "DINE_IN") {
        const dineIn = Boolean(ctxBiz.business?.services?.dine_in);
        promptId = dineIn ? "BUSINESS_DINE_IN_YES" : "BUSINESS_DINE_IN_NO";
      } else if (businessType === "TAKEOUT") {
        const takeout = Boolean(ctxBiz.business?.services?.takeout);
        promptId = takeout ? "BUSINESS_TAKEOUT_YES" : "BUSINESS_TAKEOUT_NO";
      } else if (businessType === "ONLINE_ORDERING") {
        const oo = Boolean(ctxBiz.business?.services?.online_ordering?.available);
        promptId = oo ? "BUSINESS_ONLINE_ORDERING_AVAILABLE" : "BUSINESS_ONLINE_ORDERING_NOT_AVAILABLE";
      } else if (businessType === "CATERING") {
        const cat = Boolean(ctxBiz.business?.services?.catering?.available);
        promptId = cat ? "BUSINESS_CATERING_AVAILABLE" : "BUSINESS_CATERING_NOT_AVAILABLE";
      } else if (businessType === "PARKING") {
        const park = Boolean(ctxBiz.business?.amenities?.parking?.available);
        promptId = park ? "BUSINESS_PARKING_AVAILABLE" : "BUSINESS_PARKING_NOT_AVAILABLE";
      } else if (businessType === "RESTROOMS") {
        const rr = Boolean(ctxBiz.business?.amenities?.public_restrooms);
        promptId = rr ? "BUSINESS_RESTROOMS_YES" : "BUSINESS_RESTROOMS_NO";
      } else if (businessType === "ACCESSIBILITY") {
        const acc = Boolean(ctxBiz.business?.amenities?.wheelchair_accessible_entrance);
        promptId = acc ? "BUSINESS_ACCESSIBLE_YES" : "BUSINESS_ACCESSIBLE_NO";
      } else if (businessType === "VEGETARIAN") {
        const v = Boolean(ctxBiz.business?.menu_summary?.vegetarian_options);
        promptId = v ? "BUSINESS_VEGETARIAN_YES" : "BUSINESS_VEGETARIAN_NO";
      } else if (businessType === "VEGAN") {
        const v = Boolean(ctxBiz.business?.menu_summary?.dedicated_vegan_menu);
        promptId = v ? "BUSINESS_VEGAN_MENU_YES" : "BUSINESS_VEGAN_MENU_NO";
      } else if (businessType === "GLUTEN_FREE") {
        const gf = Boolean(ctxBiz.business?.menu_summary?.dedicated_gluten_free_menu);
        promptId = gf ? "BUSINESS_GLUTEN_FREE_MENU_YES" : "BUSINESS_GLUTEN_FREE_MENU_NO";
      } else if (businessType === "KIDS_MENU") {
        const km = Boolean(ctxBiz.business?.menu_summary?.kids_menu);
        promptId = km ? "BUSINESS_KIDS_MENU_YES" : "BUSINESS_KIDS_MENU_NO";
      } else if (businessType === "LOYALTY") {
        const lp = Boolean(ctxBiz.business?.loyalty_program?.available);
        promptId = lp ? "BUSINESS_LOYALTY_YES" : "BUSINESS_LOYALTY_NO";
      } else if (businessType === "MENU_OVERVIEW") {
        promptId = "BUSINESS_MENU_OVERVIEW";
      } else if (businessType === "CUSTOMIZE") {
        const ok = Boolean(ctxBiz.business?.menu_summary?.customization_allowed);
        promptId = ok ? "BUSINESS_CUSTOMIZE_YES" : "BUSINESS_CUSTOMIZE_NO";
      } else if (businessType === "BREAKFAST_END") {
        const cutoff = ctxBiz.business?.menu_summary?.breakfast?.cutoff_time || ctxBiz.hours?.breakfast_cutoff;
        promptId = cutoff ? "BUSINESS_BREAKFAST_END" : "HOURS_STANDARD";
      } else if (businessType === "BEST_SELLERS") {
        promptId = "BUSINESS_BEST_SELLERS";
      } else if (businessType === "ORDER_METHODS") {
        promptId = "BUSINESS_ORDER_METHODS";
      } else if (businessType === "WAIT_TIME") {
        promptId = "BUSINESS_AVG_WAIT_TIME";
      } else if (businessType === "PRICE") {
        promptId = "BUSINESS_AVG_PRICE";
      } else if (businessType === "ALLERGEN") {
        promptId = "BUSINESS_ALLERGEN_NOTICE";
      } else if (businessType === "REFUND") {
        promptId = "BUSINESS_REFUND_POLICY";
      } else if (businessType === "SAFETY") {
        promptId = "BUSINESS_SAFETY_SANITATION";
      } else if (businessType === "RAW_FOOD") {
        promptId = "BUSINESS_RAW_FOOD_NOTICE";
      }

      if (promptId) {
        const text = resolvePromptText(config.promptMap, promptId, state, ctxBiz);
        systemSay([text]);
        // Re-ask pending slot after off-topic interruption.
        // If the user asked a business question mid-order (e.g. hours during AWAITING_BREAD_TYPE),
        // answer their question and then re-prompt the pending slot so they know where to pick up.
        const _reaskPids = new Set([
          "ASK_SANDWICH_FORMAT", "ASK_SANDWICH_FORMAT_MULTI",
          "ASK_SUB_BREAD_TYPE", "ASK_ROLL_BREAD_TYPE", "ASK_BREAD_TYPE_FOR_WRAP",
          "ASK_CONDIMENTS_OR_TOPPINGS", "ASK_CONDIMENTS_MULTI",
          "ASK_DELI_WEIGHT", "ASK_DELI_MODE_AMBIGUOUS",
          "ASK_DISH_SIZE", "ASK_TEMP_HOT_OR_COLD",
        ]);
        const _lastPid = state?.last_prompt_id;
        if (_lastPid && _reaskPids.has(_lastPid) && state?.order?.pending_item?.exists) {
          const _reaskCtx = buildCtx(state, config);
          const _reaskText = resolvePromptText(config.promptMap, _lastPid, state, _reaskCtx);
          if (_reaskText) systemSay([_reaskText]);
        }
        continue;
      }
    }


    // ---- Thanks / acknowledgement intercept (read-only; do not start an order) ----
    if (detectThanks(trimmed)) {
      const pendingExists = Boolean(state.order?.pending_item?.exists);
      const awaitingName = Boolean(state.order?.awaiting_name) || state.phase === "AWAITING_NAME";
      // Only auto-respond when we're not mid-order and not waiting on a required slot.
      if (!pendingExists && !awaitingName && state.phase == null) {
        const ctxThanks = buildCtx(state, config);
        const text = resolvePromptText(config.promptMap, "THANKS_YOURE_WELCOME", state, ctxThanks);
        systemSay([text]);
        continue;
      }
      // Otherwise, fall through to normal flow (the system will reprompt if needed).
    }


    // Slot/phase-first: interpret short replies (e.g., "yes", "plain", "white") based on what we just asked.
    // This MUST run before name-capture gating so that availability add confirmations ("Would you like to add it?")
    // cannot be accidentally consumed as a customer name.
    // ---------------------------
    // Multi-item: per-item format split for quantity>1 while awaiting format
    // Example: "two ham..." -> ask format -> user replies "one plain sub one poppy roll"
    // This must split into distinct items deterministically (no inference).
    // ---------------------------
    let phaseHandled = false;
    if (
      state?.phase === "AWAITING_FORMAT" &&
      state?.order?.pending_item?.exists === true &&
      Number(state.order.pending_item.quantity || 0) >= 2 &&
      Array.isArray(state?.order?.item_queue)
    ) {
      const qty = Number(state.order.pending_item.quantity || 0) || 0;
      const sels = extractFormatBreadSelections(userText, config.breadIndex);

      const n = normalizeText(userText);
      const wantsBoth = /\bboth\b/.test(n) || /\ball\b/.test(n);

      // Issue 4: "different" at DUO format step → split into N individual items,
      // each with format=null so the format question re-fires for each one separately.
      const _wantsDifferent = /\b(different(ly)?|each\s+(one\s+)?different|different\s+for\s+(each|all)|not\s+the\s+same)\b/i.test(n);
      if (_wantsDifferent && qty >= 2 && sels.length === 0) {
        const _baseClone = JSON.parse(JSON.stringify(state.order.pending_item));
        _baseClone.quantity = 1;
        _baseClone.format = null;
        _baseClone.format_source = null;
        _baseClone.bread_type = null;
        _baseClone.bread_type_prompted = false;
        // Queue items 2..N as snapshots (each will get its own format/bread/condiment questions).
        const _diffRest = [];
        for (let _di = 1; _di < qty; _di++) {
          const _diffClone = JSON.parse(JSON.stringify(_baseClone));
          _diffClone._batch_index = _di + 1;
          _diffClone._total_batch_qty = qty;
          _diffRest.push({ kind: "snapshot", item: _diffClone });
        }
        if (_diffRest.length) state.order.item_queue = [..._diffRest, ...state.order.item_queue];
        // Reset current item to qty=1 with no format so rules re-ask the format question.
        state.order.pending_item = { ...state.order.pending_item, quantity: 1, format: null, format_source: null, bread_type: null, bread_type_prompted: false, _batch_index: 1, _total_batch_qty: qty };
        // Fall through: phaseHandled stays false → applyPhaseInput returns false → rules re-ask format.
      } else {

      // Fix Part3-2: "both the same" / "same for both" at the DUO format step with no format specified.
      // User is confirming identical builds but hasn't specified WHAT format (roll/sub/wrap) yet.
      // Boost confidence + set a valid intent so the guardrail (nlu.confidence < 0.95) doesn't fire.
      // The DUO rule (priority 77015) then re-asks "same or different? You can say both plain rolls..."
      // which is exactly the right guidance for the user to specify their format.
      const _sameBuildOnlyRe = /\b(both\s+the\s+same|same\s+(for\s+)?both|make\s+(them|both)\s+(the\s+)?same|same\s+(on\s+)?both|they(['']?ll?|['']?re)\s+(the\s+)?same|all\s+the\s+same)\b/i;
      if (_sameBuildOnlyRe.test(n) && sels.length === 0 && qty >= 2) {
        // Fix Part4-3: "both the same" — user wants identical builds but hasn't named the format yet.
        // Use a sentinel format to block the DUO rule from re-firing, and show a targeted prompt.
        state.order.pending_item.format = "_same_tbd";
        state.order.pending_item.format_source = "same_sentinel";
        const _qty2Label = qty === 2 ? "both" : `all ${qty}`;
        systemSay([`Got it — what should ${_qty2Label} be on? You can say 'plain rolls', 'plain subs', 'wraps', or choose differently for each.`]);
        state.phase = "AWAITING_FORMAT";
        phaseHandled = true;
        continue; // sentinel shown — skip the rules/combinedResponses loop for this turn
      } else {

      let normalized = sels.map((x) => ({ format: x.format, bread_type: x.bread_type }));
      if (normalized.length === 1 && qty > 1 && wantsBoth) {
        normalized = Array.from({ length: qty }, () => ({ ...normalized[0] }));
      }
      if (normalized.length === 1 && qty > 1 && !wantsBoth) {
        // Still accept a single selection as "apply to all" when quantity is already known.
        normalized = Array.from({ length: qty }, () => ({ ...normalized[0] }));
      }

      if (qty > 0 && normalized.length === qty) {
        // Clone the pending item N times, apply per-item format/bread, and queue the rest.
        const base = JSON.parse(JSON.stringify(state.order.pending_item));

        let perItemConds = Array.isArray(state.session?.multi_qty_per_item_condiments) ? state.session.multi_qty_per_item_condiments : null;
        if (!perItemConds && state?.session?.last_order_utterance) {
          const bind = parseExplicitPerItemCondimentBinding(state.session.last_order_utterance, config);
          if (bind && Array.isArray(bind.lists) && bind.lists.length === 2) {
            perItemConds = bind.lists;
            state.session.multi_qty_per_item_condiments = bind.lists;
            state.session.multi_qty_per_item_condiments_source = bind.source || "explicit";
          }
        }

        const makeItem = (sel, idx) => {
          const it = JSON.parse(JSON.stringify(base));
          it.exists = true;
          it.quantity = 1;
          it.format = sel.format || null;
          it.format_source = sel.format ? "user" : null;
          // If the selection includes a specific bread type, set it. Otherwise clear it.
          it.bread_type = sel.bread_type || null;
          it.bread_type_prompted = Boolean(sel.bread_type);
          it._batch_index = idx + 1;
          it._total_batch_qty = normalized.length;

          // Deterministic per-item topping binding (explicit patterns only).
          if (perItemConds && Array.isArray(perItemConds[idx])) {
            it.condiments = [...perItemConds[idx]];
            it.condiments_specified = true;
            it.condiments_prompted = true;
            it.prep_applied = true;
          }
          return it;
        };

        const firstItem = makeItem(normalized[0], 0);
        state.order.pending_item = firstItem;

        // Issue 3: "all same" batch only when user explicitly says same-build language.
        // Same bread type alone does NOT mean same condiments — each item needs its own toppings Q.
        const _explicitSameRe = /\b(same(\s+(as|for)\s+(the\s+)?(first|all|both|each|every|last|one|them|other))?|identical|exact(ly)?\s+the\s+same|make\s+(them|it|all)\s+(the\s+)?same|both\s+the\s+same|all\s+the\s+same)\b/i;
        const _isBatchAllSame = _explicitSameRe.test(n) && sels.length === 1 && qty > 1;

        // Queue remaining clones to be processed immediately after the first one is finalized.
        const rest = [];
        for (let i = 1; i < normalized.length; i++) {
          const _snapItem = makeItem(normalized[i], i);
          // Mark as batch sibling only when condiments aren't already explicitly bound per-item.
          if (_isBatchAllSame && !(_snapItem.condiments_specified === true)) {
            _snapItem._batch_condiment_sibling = true;
          }
          rest.push({ kind: "snapshot", item: _snapItem });
        }
        if (rest.length) {
          // Put these at the front of the queue so they are handled before any later "and also" items.
          state.order.item_queue = [...rest, ...state.order.item_queue];
        }

        // Clear explicit per-item binding after applying it to this split.
        if (state.session) {
          state.session.multi_qty_per_item_condiments = null;
          state.session.multi_qty_per_item_condiments_source = null;
        }

        // Surface to rules as a format-provide turn.
        state.intent = "provide_format";
        state.entities = {
          ...state.entities,
          ...(firstItem.format ? { format: firstItem.format } : {}),
          ...(firstItem.bread_type ? { bread_type: firstItem.bread_type } : {}),
        };
        state.nlu.confidence = 0.99;
        state.nlu.success = true;
        state.phase = null;
        phaseHandled = true;
      }
      } // end else (not sameBuildOnly)
      } // end else (!_wantsDifferent)
    }

    if (!phaseHandled) {
      phaseHandled = applyPhaseInput(state, userText, config);
    }

    // Group 4: AWAITING_DELI_MODE re-ask — when input was unclear (neither sandwich nor weight signal).
    if (phaseHandled && state.phase === "AWAITING_DELI_MODE" && state.intent === "deli_mode_reask") {
      const _piDm = state?.order?.pending_item;
      const _dmName = _piDm?.name || "that";
      if (_piDm?.meatball_alt_is_side === true) {
        systemSay([`I'm not quite getting that — did you want a meatball sub, or a side order of meatballs?`]);
      } else {
        const _dmIsSalad = /^deli\.salad_/.test(_piDm?.item_id || "");
        const _dmWeightPhrase = _dmIsSalad ? "by the pound" : "sliced by the pound";
        systemSay([`I'm not quite getting that — for the ${_dmName}, do you want it as a sandwich or ${_dmWeightPhrase}?`]);
      }
      continue;
    }

    // If we are awaiting an availability add confirmation and the user's reply was unclear,
    // deterministically re-ask the yes/no without going through rules.
    if (phaseHandled && state.phase === "AWAITING_AVAILABILITY_ADD" && state.nlu?.success === false) {
      const pending = state?.availability;
      if (pending && pending.item_display) {
        const ctxA = buildCtx(state, config);
        ctxA.availability = { item_display: pending.item_display };
        const askAgain = resolvePromptText(config.promptMap, "AVAIL_HAVE_YES_ADD", state, ctxA);
        systemSay([askAgain]);
        continue;
      }
    }

    // If we were previously asking for the customer's name, do not allow availability add confirmations
    // to advance the normal slot flow (e.g., bread-type prompts) before the name is captured.
    // Deterministic: re-emit ASK_NAME_FOR_ORDER (and the availability add confirmation if present).
    if (
      phaseHandled &&
      state?.order?.awaiting_name === true &&
      state?.order?.customer_name == null &&
      state?.last_prompt_id === "ASK_NAME_FOR_ORDER"
    ) {
      const lines = [];
      if (state._availability_added) {
        const ctx = buildCtx(state, config);
        ctx.availability = { item_display: state._availability_added.item_display || "" };
        lines.push(resolvePromptText(config.promptMap, "AVAIL_ADD_APPLIED", state, ctx));
        state._availability_added = null;
      }

      // Keep phase/awaiting_name consistent with the name prompt.
      setPhaseFromPromptId(state, "ASK_NAME_FOR_ORDER");
      lines.push(resolvePromptText(config.promptMap, "ASK_NAME_FOR_ORDER", state, buildCtx(state, config)));
      systemSay(lines);
      continue;
    }


    // Absolute guard: if we're awaiting a name, treat the user's reply strictly as a name answer.
    // This must happen BEFORE any normal NLU/intent detection so we don't override provide_name.
    if (!phaseHandled && (state.phase === "AWAITING_NAME" || state.order?.awaiting_name === true) && isLikelyName(userText)) {
      state.intent = "provide_name";
      state.entities = { ...state.entities, customer_name: String(userText).trim() };
      state.nlu.confidence = 0.99;
      state.nlu.success = true;      // Do not commit name or flip order.active here; rules own those fields.
      state.phase = null;

      const outName = runRulesStepped(state, config);

      // If the user ordered before giving a name, replay the deferred order immediately after the name is committed.
      // Only replay when a pending item was NOT already created from the earlier utterance.
      if (state._deferred_order_text && state.order?.customer_name && !(state?.order?.pending_item?.exists)) {
        const replay = state._deferred_order_text;
        state._deferred_order_text = null;
        const nlu2 = mockNLU(replay, state, config, config.menuIndex, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, engine, config.menuItemAliases);
        state.intent = nlu2.intent;
        state.entities = { ...state.entities, ...nlu2.entities };
        state.nlu.confidence = nlu2.confidence;
        state.nlu.success = nlu2.success;
        const out2 = runRulesStepped(state, config);
        if (out2.responses.length) {
          systemSay(out2.responses);
        } else {
          systemSay(outName.responses);
        }
      } else {
        systemSay(outName.responses);
      }
      continue;
    }

    if (!phaseHandled && (state.phase === "AWAITING_NAME" || state.order?.awaiting_name === true)) {
      // Exception: info/menu queries should pass through to NLU + handleMenuQuestion
      // so they can be answered without consuming the name slot.
      const _nameInfoPassRe = /\bwhat\s+(comes?\s+on|does\s+it\s+come|breads?|rolls?|wraps?|subs?|is\s+(on|included))\b/i;
      const _nameInfoPassRe2 = /\bdo\s+you\s+(have|carry|sell|make)\b/i;
      if (!_nameInfoPassRe.test(userText) && !_nameInfoPassRe2.test(userText)) {
        // We are explicitly waiting on a name, but the input doesn't look like a name.
        // Do not fall into general NLU; deterministically re-ask for the name.
        const again = resolvePromptText(config.promptMap, "ASK_NAME_FOR_ORDER", state, buildCtx(state, config));
        systemSay([again]);
        continue;
      }
    }

    // If the user placed an order before giving their name, capture that raw text
    // so we can parse it after name capture without forcing them to repeat it.
    // Only set once per flow, and ONLY when we truly expect a name capture to occur.
    //
    // Guard against accidental duplication when the customer name is already present
    // (e.g., "Turkey... for Tyler") — in that case we should NOT defer/replay.
    if (
      state?._deferred_order_text == null &&
      state?.order?.customer_name == null &&
      state?.session?.inline_name == null &&
      detectIntent(userText, state) === "place_order"
    ) {
      state._deferred_order_text = userText;
      if (state.session) state.session.last_order_utterance = userText;
    }

    let nlu;
    if (!phaseHandled) {
      nlu = mockNLU(userText, state, config, config.menuIndex, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, engine, config.menuItemAliases);

      state.intent = nlu.intent;
      state.entities = { ...state.entities, ...nlu.entities };
      state.nlu.confidence = nlu.confidence;
      state.nlu.success = nlu.success;

      // Post-NLU confidence override: if a panini item has pressing captured (pressed !== null)
      // but prep has not yet been applied, the system is in a post-press transition state.
      // Override low confidence so NLU_REPHRASE_IF_CONFIDENCE_LOW doesn't intercept the turn
      // before PREP_APPLY_HOT/COLD_FOR_PANINI_WHEN_PRESSED_SET can fire.
      if (
        state.order?.pending_item?.exists === true &&
        state.order?.pending_item?.format === "panini" &&
        state.order?.pending_item?.pressed != null &&
        state.order?.pending_item?.prep_applied !== true &&
        state.nlu.confidence < 0.95
      ) {
        state.nlu.confidence = 0.99;
        state.nlu.success = true;
      }
    } else {
      // applyPhaseInput already wrote intent/entities/nlu fields
      nlu = { intent: state.intent, entities: state.entities, confidence: state.nlu.confidence, success: state.nlu.success };
    }

    // Inline "for <name>" + order in the same utterance:
    // Only after NLU deterministically proves we have an order payload, flip order.active
    // so downstream ordering rules can proceed in the same turn (without firing start prompts).
    if (state._auto_activate_from_inline_name === true) {
      const hasPending = state?.order?.pending_item?.exists === true;
      const hasMenuId = Boolean(state?.entities?.menu_item_id);
      if (state?.order?.customer_name && state.intent === "place_order" && (hasPending || hasMenuId)) {
        state.order.active = true;
      }
      state._auto_activate_from_inline_name = false;
    }

    // Deferred order replay: if the user provides an order before the name is committed,
    // store the raw order text so it can be replayed immediately after name capture.
    // Use the actual NLU result (not detectIntent), because bare orders like "ham and cheese"
    // may not match the simple keyword intent detector.
    if (
      state?._deferred_order_text == null &&
      state?.order?.customer_name == null &&
      state?.session?.inline_name == null &&
      state.intent === "place_order" &&
      typeof userText === "string" &&
      userText.trim().length
    ) {
      state._deferred_order_text = userText;
      if (state.session) state.session.last_order_utterance = userText;
    }

    // session failed attempts reset on success
    if (config.rulesJson.session_defaults?.failed_attempts_reset_on_success && state.nlu.success) {
      state.session.failed_attempts = 0;
    }

    // Name capture is handled by rules (FLOW_ORDER_CAPTURE_NAME) via set using {entities.customer_name}.

    // Issue 1: detect category-specific bread/roll/wrap query; stored for resolvePromptText intercept.
    if (state.intent === "ask_bread_options") {
      const _rawBo = normalizeText(userText);
      if (/\bwraps?\b/.test(_rawBo) && !/\b(roll|sub|bread)\b/.test(_rawBo)) {
        state._bread_opt_category = "wrap";
      } else if (/\brolls?\b/.test(_rawBo) && !/\b(wrap|sub|bread)\b/.test(_rawBo)) {
        state._bread_opt_category = "roll";
      } else if (/\bsubs?\b/.test(_rawBo) && !/\b(wrap|roll|bread)\b/.test(_rawBo)) {
        state._bread_opt_category = "sub";
      } else {
        state._bread_opt_category = null;
      }
    }

    const menuAnswer = handleMenuQuestion(nlu, config.menuIndex, state);
    if (menuAnswer) {
      systemSay([menuAnswer]);
      continue;
    }

    // Bug 3: if start-over was triggered, skip the rules loop entirely and just output the message.
    if (state._start_over_complete) {
      state._start_over_complete = false;
      if (state._pending_which_item_clarification) {
        systemSay([state._pending_which_item_clarification]);
        state._pending_which_item_clarification = null;
      }
      continue;
    }

    // Run rules until we produce a user-visible response (or no rule matches).
    const combinedResponses = [];
    let steps = 0;

    while (steps < 15) {
      const out = runRulesStepped(state, config);

      // If we auto-captured a name from an inline "for <name>" AND we have stashed order text,
      // immediately replay that order text now that the name is committed. This prevents the
      // system from asking "What would you like to order?" after already receiving a full order.
      if (state._inline_replay_pending && state._deferred_order_text && state.order?.customer_name && !state._inline_replay_done) {
        state._inline_replay_done = true;
        state._inline_replay_pending = false;
        const replay = state._deferred_order_text;
        state._deferred_order_text = null;
        state._auto_name_from_inline = false;
        if (state.session) state.session.inline_name = null;

        const nlu2 = mockNLU(replay, state, config, config.menuIndex, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, engine, config.menuItemAliases);
        state.intent = nlu2.intent;
        state.entities = { ...state.entities, ...nlu2.entities };
        state.nlu.confidence = nlu2.confidence;
        state.nlu.success = nlu2.success;

        const out2 = runRulesStepped(state, config);
        if (out2.responses.length) {
          combinedResponses.push(...out2.responses);
          break;
        }
      }


      // If we captured a name via the name prompt (provide_name) and we stashed order text from earlier,
      // replay it now that the name is committed.
      // Only replay deferred order text if the item was NOT already created (pending_item.exists = false).
      // If pending_item already exists, the item was matched upfront; replaying would re-process it.
      if (state._replay_after_name_pending && state._deferred_order_text && state.order?.customer_name && !state._replay_after_name_done && !(state.order?.pending_item?.exists)) {
        state._replay_after_name_done = true;
        state._replay_after_name_pending = false;

        const replay = state._deferred_order_text;
        state._deferred_order_text = null;

        const nlu2 = mockNLU(replay, state, config, config.menuIndex, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, engine, config.menuItemAliases);
        state.intent = nlu2.intent;
        state.entities = { ...state.entities, ...nlu2.entities };
        state.nlu.confidence = nlu2.confidence;
        state.nlu.success = nlu2.success;

        const out2 = runRulesStepped(state, config);
        if (out2.responses.length) {
          combinedResponses.push(...out2.responses);
          break;
        }
      }

      if (out.responses.length) {
        combinedResponses.push(...out.responses);

        // Multi-item queue replay: if the last rule finalized an item and scheduled
        // a queued follow-up, process the next queued entry immediately (same user turn).
        // Use a while-loop so that batch-sibling items (pre-filled condiments) chain through
        // without requiring a new user turn for each one. The loop only continues when
        // finalize_pending_item_add_to_order schedules the next replay (_queue_replay_pending),
        // so items that still need user input (format, condiments, etc.) break naturally.
        // Fix 1B: After readback "no [correction text]" fires CLOSE_HANDLE_READBACK_NEEDS_CHANGES
        // and transitions to AWAITING_ORDER_CORRECTION, immediately replay the inline correction
        // text so the user's change is applied in the same turn (no extra prompt round-trip).
        if (state._correction_inline_text && state.phase === "AWAITING_ORDER_CORRECTION") {
          // The rules just emitted "No problem — what should I change?" (OKAY_WHAT_SHOULD_I_FIX).
          // Since we already have the inline correction text, suppress that prompt so we don't
          // ask a question that the user already answered.
          if (state.last_prompt_id === "OKAY_WHAT_SHOULD_I_FIX" && combinedResponses.length > 0) {
            combinedResponses.pop();
          }
          const _corrText = state._correction_inline_text;
          state._correction_inline_text = null;
          clearTransientInput(state);
          // Try applyPhaseInput first (AWAITING_ORDER_CORRECTION) since it correctly
          // handles removal phrases like "take off the lettuce" via extractEntities.
          // Only fall back to mockNLU if applyPhaseInput does not handle the text.
          const _corrPhaseHandled = applyPhaseInput(state, _corrText, config);
          if (!_corrPhaseHandled) {
            const _corrNLU = mockNLU(_corrText, state, config, config.menuIndex, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, engine, config.menuItemAliases);
            state.intent = _corrNLU.intent;
            state.entities = { ...state.entities, ..._corrNLU.entities };
            state.nlu.confidence = _corrNLU.confidence;
            state.nlu.success = _corrNLU.success;
          }
          // If applyPhaseInput triggered a start-over reset, skip rules and surface the
          // fresh-start message directly (don't let _start_over_complete bleed into the
          // next readline turn, which would cause the next user input to be silently skipped).
          if (state._start_over_complete) {
            state._start_over_complete = false;
            if (state._pending_which_item_clarification) {
              combinedResponses.push(state._pending_which_item_clarification);
              state._pending_which_item_clarification = null;
            }
          } else {
            const _corrOut = runRulesStepped(state, config);
            if (_corrOut.responses && _corrOut.responses.length) {
              combinedResponses.push(..._corrOut.responses);
            }
          }
        }

        while (state._queue_replay_pending && state._queue_replay_entry) {
          const entry = state._queue_replay_entry;
          state._queue_replay_pending = false;
          state._queue_replay_entry = null;

          // Clear transient input before replaying.
          clearTransientInput(state);

          if (entry.kind === "snapshot" && entry.item && typeof entry.item === "object") {
            state.order.pending_item = entry.item;
            state.order.pending_item.exists = true;
            state.intent = "place_order";
            state.nlu.confidence = 0.99;
            state.nlu.success = true;
          } else if (entry.kind === "text" && typeof entry.text === "string") {
            const nlu2 = mockNLU(entry.text, state, config, config.menuIndex, config.keywordPhrases, config.breadIndex, config.condimentIndex, config.cheeseIndex, config.meatIndex, engine, config.menuItemAliases);
            state.intent = nlu2.intent;
            state.entities = { ...state.entities, ...nlu2.entities };
            state.nlu.confidence = nlu2.confidence;
            state.nlu.success = nlu2.success;
          }

          const out2 = runRulesStepped(state, config);
          if (out2.responses && out2.responses.length) {
            combinedResponses.push(...out2.responses);
          }
        }

        break;
      }

      if (!out.matched) break;

      // Matched a rule but it only performed sets/emits (no respond).
      clearTransientInput(state);

      steps += 1;
    }

    // Availability question answer ("do you have X?") can occur at any point.
    // It must not mutate order state. If the item is an addable condiment/topping and an order is active,
    // we can offer to add it with explicit confirmation.
    if (doYouHaveQuery) {
      const res = resolveAvailability(doYouHaveQuery, config);
      const ctxAvail = buildCtx(state, config);
      ctxAvail.availability = { item_display: res.item_display };

      // Only offer to add when we deterministically resolved a single condiment/topping.
      const canOfferAdd = res.found && res.type === "condiment" && /^((topping|condiment)\.)/.test(String(res.id || ""));
      const hasActiveOrder = state?.order?.active === true || state?.order?.pending_item?.exists === true;

      if (canOfferAdd && hasActiveOrder) {
        // Remember the offer so a later "yes/no" can be handled deterministically.
        state.availability = {
          pending_id: res.id,
          pending_type: res.type,
          item_display: res.item_display,
          resume_phase: state.phase || null,
        };
        state.phase = "AWAITING_AVAILABILITY_ADD";
        const offer = resolvePromptText(config.promptMap, "AVAIL_HAVE_YES_ADD", state, ctxAvail);
        systemSay([offer]);
        continue;
      }

      // Otherwise, answer yes/no and then continue with normal responses (if any).
      // When the availability query was the entire utterance, suppress rule fallbacks that
      // fired on the empty effective text (e.g. CLARIFY_REQUEST from unknown intent).
      const pid = res.found ? "AVAIL_HAVE_YES" : "AVAIL_HAVE_NO";
      const ans = resolvePromptText(config.promptMap, pid, state, ctxAvail);
      const outLines = doYouHaveIsEntireUtterance ? [ans] : [ans, ...combinedResponses];
      // Store resolved non-condiment item for pronoun follow-up next turn
      // ("I want that", "okay give me that on a roll"). Condiments have their own
      // offer-to-add flow above, so we only store menu items, meats, cheeses, breads.
      if (res.found && res.id && res.type !== "condiment") {
        state._last_queried_item = { id: res.id, type: res.type, display: res.item_display };
      } else {
        state._last_queried_item = null;
      }
      systemSay(outLines);
      continue;
    }

    // Issue 2: inject "which item?" clarification when condiment removal is ambiguous
    // (no rules fire for this case, so we inject directly into combinedResponses here).
    if (state._pending_which_item_clarification) {
      combinedResponses.push(state._pending_which_item_clarification);
      state._pending_which_item_clarification = null;
    }

    if (combinedResponses.length) {
      // If an availability add was just applied ("Yes, add it"), surface a deterministic confirmation
      // before continuing the normal flow.
      if (state._availability_added) {
        const ctx = buildCtx(state, config);
        ctx.availability = {
          item_display: state._availability_added.item_display || "",
        };
        const msg = resolvePromptText(config.promptMap, "AVAIL_ADD_APPLIED", state, ctx);
        combinedResponses.unshift(msg);
        state._availability_added = null;
      }
      systemSay(combinedResponses);
    } else {
      // Issue 2: AWAITING_NAME handler sets customer_name before rules run, so
      // FLOW_ORDER_CAPTURE_NAME (which requires customer_name=null) cannot fire.
      // If _name_captured_in_phase is true and pending_item already exists (user said
      // item + name in sequence), run a place_order pass to fire the format/bread question.
      if (state._name_captured_in_phase) {
        state._name_captured_in_phase = false;
        state.intent = "place_order";
        state.nlu.confidence = 0.99;
        state.nlu.success = true;
        const outName = runRulesStepped(state, config);
        if (outName.responses.length) {
          systemSay(outName.responses);
        }
      } else {
      // Fallback: if we failed to match any rule but the utterance looks like an order,
      // force intent=place_order and try once more (prevents "no rule matched" on clear orders).
      const normFallback = normalizeText(userText);
      const hasOrderSignal =
        /\b(roll|sub|wrap|panini)\b/.test(normFallback) ||
        /\b(can i (get|have)|i\s*(?:'d| would)\s*like|i\s*want|gimme|give me|let me get|lemme get|order)\b/.test(normFallback) ||
        (state?.lexicon ? normFallback.split(/\s+/).some((t) => state.lexicon.meats?.has(t) || state.lexicon.cheeses?.has(t) || state.lexicon.toppings?.has(t) || state.lexicon.condiments?.has(t)) : false);

      if (hasOrderSignal && state.intent !== "place_order") {
        state.intent = "place_order";
        state.nlu.confidence = 0.99;
        state.nlu.success = true;
        const outRetry = runRulesStepped(state, config);
        if (outRetry.responses.length) {
          systemSay(outRetry.responses);
        } else {
          console.log("SYSTEM: Sorry, I didn't catch that — could you say it another way?");
        }
      } else {
        console.log("SYSTEM: Sorry, I didn't catch that — could you say it another way?");
      }
      } // end else (_name_captured_in_phase fallback)
    }
  }

  rl.close();
}

if (require.main === module) {
  main().catch((e) => {
    console.error("Runner error:", e);
    process.exit(1);
  });
}

module.exports = {
  loadConfig,
  initState,
  processTurn,
  computeTotalBeforeTax,
  buildCtx,
  resolvePromptText,
};
