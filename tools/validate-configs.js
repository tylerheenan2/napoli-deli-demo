// tools/Validate-configs.js
// Run: node .\tools\Validate-configs.js

const fs = require("fs");
const path = require("path");

const REQUIRED = [
  "reference.json",
  "addons.json",
  "rules.json",
  "PromptID.json",
  "business.json",
  "hours.json",
  "stock.json",
  "menu_breakfast.json",
  "menu_lunch_sandwiches.json",
  "menu_panini.json",
  "menu_sides_dishes.json",
  "menu_deli_by_weight.json",
];

function loadJson(fileName) {
  const full = path.join(process.cwd(), fileName);
  if (!fs.existsSync(full)) throw new Error(`Missing file: ${fileName} (expected at ${full})`);
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

function collectAllCanonicalIds(obj, ids = new Set()) {
  if (!obj || typeof obj !== "object") return ids;
  if (Array.isArray(obj)) {
    for (const v of obj) collectAllCanonicalIds(v, ids);
    return ids;
  }
  if (typeof obj.id === "string") ids.add(obj.id);
  for (const v of Object.values(obj)) collectAllCanonicalIds(v, ids);
  return ids;
}

function collectMenuItemIds(menuObj, ids = new Set()) {
  if (!menuObj || typeof menuObj !== "object") return ids;
  const items = Array.isArray(menuObj.items) ? menuObj.items : [];
  for (const it of items) if (it && typeof it.id === "string") ids.add(it.id);
  return ids;
}

function collectAddonIds(addonsObj, ids = new Set()) {
  const arr = addonsObj && Array.isArray(addonsObj.addons) ? addonsObj.addons : [];
  for (const a of arr) if (a && typeof a.id === "string") ids.add(a.id);
  return ids;
}

function collectPromptIdsAnyShape(promptFile) {
  const ids = new Set();

  // PromptID.json structure you have: { ..., "prompts": { "PROMPT_ID": {...}, ... } }
  if (
    promptFile &&
    typeof promptFile === "object" &&
    promptFile.prompts &&
    typeof promptFile.prompts === "object" &&
    !Array.isArray(promptFile.prompts)
  ) {
    for (const k of Object.keys(promptFile.prompts)) ids.add(k);
  }

  // Top-level dictionary style { "PROMPT_ID": "text", ... }
  if (promptFile && typeof promptFile === "object" && !Array.isArray(promptFile)) {
    for (const [k, v] of Object.entries(promptFile)) {
      if (typeof v === "string" || (v && typeof v === "object")) ids.add(k);
    }
  }

  // Nested/array style: recursively collect any string at keys "id" or "prompt_id"
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) {
      for (const v of o) walk(v);
      return;
    }
    if (typeof o.id === "string") ids.add(o.id);
    if (typeof o.prompt_id === "string") ids.add(o.prompt_id);
    for (const v of Object.values(o)) walk(v);
  })(promptFile);

  return ids;
}

function findAllPromptRefs(obj, refs = []) {
  if (!obj || typeof obj !== "object") return refs;
  if (Array.isArray(obj)) {
    for (const v of obj) findAllPromptRefs(v, refs);
    return refs;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === "prompt_id" && typeof v === "string") refs.push(v);
    else findAllPromptRefs(v, refs);
  }
  return refs;
}

function findAllLinkIds(obj, out = []) {
  if (!obj || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    for (const v of obj) findAllLinkIds(v, out);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k.endsWith("_id") && typeof v === "string") out.push(v);
    else findAllLinkIds(v, out);
  }
  return out;
}

// ---------- hours.json validation ----------

function parseTimeToMinutes(t) {
  if (typeof t !== "string") return null;
  const s = t.trim();

  // 24h: HH:MM
  let m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);

  // 12h: H:MM AM/PM or H AM/PM
  m = s.match(/^(\d{1,2})(?::([0-5]\d))?\s*([AaPp][Mm])$/);
  if (m) {
    let hh = parseInt(m[1], 10);
    const mm = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3].toLowerCase();
    if (hh < 1 || hh > 12) return null;
    if (ap === "pm" && hh !== 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;
    return hh * 60 + mm;
  }

  return null;
}

function validateHoursEntry(label, openVal, closeVal, errors) {
  const openM = parseTimeToMinutes(openVal);
  const closeM = parseTimeToMinutes(closeVal);
  if (openM === null) errors.push(`hours.json ${label}: invalid open time "${openVal}"`);
  if (closeM === null) errors.push(`hours.json ${label}: invalid close time "${closeVal}"`);
  if (openM !== null && closeM !== null && closeM <= openM) {
    errors.push(`hours.json ${label}: close "${closeVal}" must be after open "${openVal}"`);
  }
}

function validateHours(hoursObj, errors, warnings) {
  if (!hoursObj || typeof hoursObj !== "object") {
    errors.push("hours.json: must be an object");
    return;
  }

  // Recognize YOUR schema:
  // { "hours": { "timezone": "...", "weekly_hours": { "monday": {open,close,closed}, ... } } }
  if (
    hoursObj.hours &&
    typeof hoursObj.hours === "object" &&
    hoursObj.hours.weekly_hours &&
    typeof hoursObj.hours.weekly_hours === "object" &&
    !Array.isArray(hoursObj.hours.weekly_hours)
  ) {
    const tz = hoursObj.hours.timezone;
    if (typeof tz !== "string" || tz.trim().length === 0) {
      errors.push('hours.json: hours.timezone must be a non-empty string (e.g. "America/New_York")');
    }

    const wh = hoursObj.hours.weekly_hours;
    const allowedDays = new Set([
      "monday","tuesday","wednesday","thursday","friday","saturday","sunday",
    ]);

    for (const [day, cfg] of Object.entries(wh)) {
      if (!allowedDays.has(day)) {
        warnings.push(`hours.json: unexpected day key "${day}" (expected monday..sunday)`);
        continue;
      }
      if (!cfg || typeof cfg !== "object") {
        errors.push(`hours.json ${day}: must be an object`);
        continue;
      }

      const isClosed = cfg.closed === true;
      const openVal = (cfg.open === undefined ? null : cfg.open);
      const closeVal = (cfg.close === undefined ? null : cfg.close);

      if (isClosed) {
        if (openVal !== null) errors.push(`hours.json ${day}: closed=true but open is not null`);
        if (closeVal !== null) errors.push(`hours.json ${day}: closed=true but close is not null`);
        continue;
      }

      validateHoursEntry(day, openVal, closeVal, errors);
    }

    return;
  }

  // fallback: unknown schema
  warnings.push("hours.json parsed OK, but schema not recognized — only syntax validated.");
}

// ---------- stock.json validation ----------

function collectStockReferencedIds(stockObj) {
  const ids = new Set();

  const likelyIdKeys = new Set([
    "id",
    "item_id",
    "ingredient_id",
    "meat_id",
    "cheese_id",
    "topping_id",
    "condiment_id",
    "addon_id",
    "format_id",
    "bread_id",
  ]);

  const likelyListKeys = new Set([
    "out_of_stock",
    "outOfStock",
    "unavailable",
    "unavailable_ids",
    "unavailableIds",
    "oos",
    "disabled",
    "disabled_ids",
  ]);

  (function walk(o) {
    if (!o) return;
    if (Array.isArray(o)) {
      for (const v of o) walk(v);
      return;
    }
    if (typeof o !== "object") return;

    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string") {
        if (likelyIdKeys.has(k) || k.endsWith("_id")) ids.add(v);
        if (/^(meat|cheese|topping|condiment|addon|breakfast|lunch|deli|sides)\./.test(v)) ids.add(v);
      } else if (Array.isArray(v)) {
        if (likelyListKeys.has(k)) {
          for (const s of v) if (typeof s === "string") ids.add(s);
        }
        walk(v);
      } else if (v && typeof v === "object") {
        walk(v);
      }
    }
  })(stockObj);

  return ids;
}

function main() {
  const errors = [];
  const warnings = [];

  // Load all required files
  const loaded = {};
  try {
    for (const f of REQUIRED) loaded[f] = loadJson(f);
  } catch (e) {
    console.error("FAILED: " + e.message);
    process.exit(1);
  }

  const reference = loaded["reference.json"];
  const referenceIds = collectAllCanonicalIds(reference);

  const formats = new Set();
  if (Array.isArray(reference.formats)) {
    for (const f of reference.formats) if (f && typeof f.id === "string") formats.add(f.id);
  }

  const promptIds = collectPromptIdsAnyShape(loaded["PromptID.json"]);

  // Collect menu item IDs + addon IDs for stock validation
  const menuItemIds = new Set();
  collectMenuItemIds(loaded["menu_breakfast.json"], menuItemIds);
  collectMenuItemIds(loaded["menu_lunch_sandwiches.json"], menuItemIds);
  collectMenuItemIds(loaded["menu_panini.json"], menuItemIds);
  collectMenuItemIds(loaded["menu_sides_dishes.json"], menuItemIds);
  collectMenuItemIds(loaded["menu_deli_by_weight.json"], menuItemIds);

  const addonIds = new Set();
  collectAddonIds(loaded["addons.json"], addonIds);

  const validStockTargets = new Set([...referenceIds, ...menuItemIds, ...addonIds]);

  // Validate menus (skip ingredient_ids.unmapped on purpose)
  const menuFiles = [
    "menu_breakfast.json",
    "menu_lunch_sandwiches.json",
    "menu_panini.json",
    "menu_sides_dishes.json",
    "menu_deli_by_weight.json",
  ];

  for (const mf of menuFiles) {
    const menu = loaded[mf];
    const items = Array.isArray(menu.items) ? menu.items : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;

      // formats
      for (const fmt of (item.allowed_formats || [])) {
        if (!formats.has(fmt)) errors.push(`${mf} ${item.id}: unknown format "${fmt}"`);
      }

      // ingredient_ids
      const ing = item.ingredient_ids || {};
      for (const [k, arr] of Object.entries(ing)) {
        if (k === "unmapped") continue;
        if (!Array.isArray(arr)) continue;
        for (const id of arr) {
          if (typeof id === "string" && !referenceIds.has(id)) {
            errors.push(`${mf} ${item.id}: ingredient_ids.${k} missing id "${id}"`);
          }
        }
      }
    }
  }

  // Validate addons
  const addons = loaded["addons.json"];
  const addonList = Array.isArray(addons.addons) ? addons.addons : [];
  for (const a of addonList) {
    if (!a || typeof a !== "object") continue;

    const pbf = a.price_by_format || {};
    for (const fmt of Object.keys(pbf)) {
      if (!formats.has(fmt)) errors.push(`addons.json ${a.id}: price_by_format unknown format "${fmt}"`);
    }

    const links = a.links || {};
    for (const id of findAllLinkIds(links)) {
      if (!referenceIds.has(id)) errors.push(`addons.json ${a.id}: links missing id "${id}"`);
    }
  }

  // Validate rules prompt references
  const rulePromptRefs = findAllPromptRefs(loaded["rules.json"]);
  for (const pid of rulePromptRefs) {
    if (!promptIds.has(pid)) errors.push(`rules.json: missing prompt_id "${pid}"`);
  }

  // Validate hours.json
  validateHours(loaded["hours.json"], errors, warnings);

  // Validate stock.json (ID references, if any)
  const stockObj = loaded["stock.json"];
  const stockIds = collectStockReferencedIds(stockObj);
  if (stockIds.size > 0) {
    for (const id of stockIds) {
      if (!validStockTargets.has(id)) {
        errors.push(`stock.json: references unknown id "${id}" (not in reference/menu/addons)`);
      }
    }
  }

  if (warnings.length) {
    console.log(`WARNINGS: ${warnings.length}`);
    for (const w of warnings) console.log(" - " + w);
    console.log("");
  }

  if (errors.length) {
    console.log(`FAILED: ${errors.length} issue(s)`);
    for (const e of errors) console.log(" - " + e);
    process.exit(1);
  }

  console.log("PASSED: JSON parses + cross-references look good (including hours.json + stock.json).");
}

main();
