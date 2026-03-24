"use strict";

const path = require("path");
const fs   = require("fs");

const ROOT = path.join(__dirname, "..");

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, name), "utf8"));
}

function fmtPrice(v) {
  return "$" + Number(v).toFixed(2);
}

function sandwichPrice(pbf) {
  const roll = pbf.roll ?? pbf.wrap ?? pbf.small_dish;
  const sub  = pbf.sub  ?? pbf.large_dish;
  if (roll != null && sub != null && Math.abs(roll - sub) > 0.01) {
    return `Roll ${fmtPrice(roll)} / Sub ${fmtPrice(sub)}`;
  }
  if (roll != null) return fmtPrice(roll);
  const vals = Object.values(pbf);
  return vals.length ? fmtPrice(vals[0]) : "";
}

function sizePrice(pbf) {
  const vals = Object.values(pbf);
  if (vals.length === 1) return fmtPrice(vals[0]);
  if (Math.abs(vals[1] - vals[0]) > 0.01) {
    return `Small ${fmtPrice(vals[0])} / Large ${fmtPrice(vals[1])}`;
  }
  return fmtPrice(vals[0]);
}

// ─── BREAKFAST ────────────────────────────────────────────────────────────────

function buildBreakfastTab(bfast) {
  return {
    key:   "breakfast",
    label: "Breakfast",
    sections: [{
      heading: "Breakfast Sandwiches",
      note:    "Served hot. Available on roll, wrap, or sub.",
      items: bfast.items.map(it => ({
        name:        it.name,
        description: it.ingredients_text,
        price:       sandwichPrice(it.price_by_format),
      })),
    }],
  };
}

// ─── LUNCH ───────────────────────────────────────────────────────────────────

function buildLunchTab(lunch, panini) {
  const paninis = panini.items.map(it => ({
    name:        it.name,
    description: it.ingredients_text,
    price:       `${fmtPrice(it.price_by_format.panini)} / Sub ${fmtPrice(it.price_by_format.sub)}`,
  }));

  const hotItems  = [];
  const coldItems = [];
  for (const it of lunch.items) {
    const entry = {
      name:        it.name,
      description: it.ingredients_text,
      price:       sandwichPrice(it.price_by_format),
    };
    if (it.default_temp === "hot") hotItems.push(entry);
    else coldItems.push(entry);
  }

  return {
    key:   "lunch",
    label: "Lunch",
    sections: [
      {
        heading: "Paninis",
        note:    "Signature pressed sandwiches. Also available on roll, wrap, or sub.",
        items:   paninis,
      },
      {
        heading: "Hot Sandwiches",
        note:    "Available on roll, wrap, or sub.",
        items:   hotItems,
      },
      {
        heading: "Cold Sandwiches",
        note:    "Available on roll, wrap, or sub. Can be served hot on request.",
        items:   coldItems,
      },
    ],
  };
}

// ─── DELI & SIDES ─────────────────────────────────────────────────────────────

function buildDeliTab(sides, deli) {
  const deliMeats   = [];
  const deliCheeses = [];
  const deliSalads  = [];

  for (const it of deli.items) {
    const entry = {
      name:  it.name,
      price: fmtPrice(it.price_per_lb) + "/lb",
    };
    if (it.id.startsWith("deli.salad_")) {
      deliSalads.push(entry);
    } else if (it.name.toLowerCase().includes("cheese")) {
      deliCheeses.push(entry);
    } else {
      deliMeats.push(entry);
    }
  }

  const hotSides = sides.items
    .filter(it => it.default_temp === "hot")
    .map(it => ({
      name:        it.name,
      description: it.meta && it.meta.portion_description ? it.meta.portion_description : "",
      price:       fmtPrice(Object.values(it.price_by_format)[0]),
    }));

  const gardenSalads = sides.items
    .filter(it => it.category === "salad_dish")
    .map(it => ({
      name:        it.name,
      description: it.ingredients_text || "",
      price:       sizePrice(it.price_by_format),
    }));

  return {
    key:   "deli",
    label: "Deli & Sides",
    sections: [
      {
        heading: "Deli Meats",
        note:    "Sliced to order. Minimum 1/4 lb. Prices per pound.",
        items:   deliMeats,
      },
      {
        heading: "Deli Cheeses",
        note:    "Sliced to order. Minimum 1/4 lb. Prices per pound.",
        items:   deliCheeses,
      },
      {
        heading: "Prepared Salads",
        note:    "Available by the pound or by portion.",
        items:   deliSalads,
      },
      {
        heading: "Hot Sides",
        items:   hotSides,
      },
      {
        heading: "Garden Salads",
        items:   gardenSalads,
      },
    ],
  };
}

// ─── BUILD YOUR OWN ──────────────────────────────────────────────────────────

const EXCLUDE_MEAT_IDS = new Set([
  "meat.sausage",
  "meat.chicken_salad",
  "meat.cranberry_chicken_salad",
  "meat.egg_salad",
  "meat.potato_salad",
  "meat.macaroni_salad",
  "meat.tuna_salad",
  "meat.olive_salad",
  "meat.cole_slaw",
  "meat.pasta_salad",
  "meat.tuna_mac_salad",
  "meat.pickle_pimento",
  "meat.tomato_onion_cucumber_salad",
  "meat.meatball",
]);

const BREAD_GROUP_ORDER  = ["roll", "sub", "wrap", "toast", "bread", "panini"];
const BREAD_GROUP_LABELS = {
  roll:   "Rolls",
  sub:    "Subs",
  wrap:   "Wraps",
  toast:  "Toasted",
  bread:  "Bread",
  panini: "Panini",
};

function buildGuideTab(ref) {
  const proteins = ref.meats
    .filter(m => !EXCLUDE_MEAT_IDS.has(m.id))
    .map(m => m.display_name);

  const cheeses = ref.cheeses.map(c => c.display_name);

  const breadsByGroup = {};
  for (const b of ref.breads) {
    if (!breadsByGroup[b.group]) breadsByGroup[b.group] = [];
    breadsByGroup[b.group].push(b.display_name);
  }
  const breadGroups = BREAD_GROUP_ORDER
    .filter(g => breadsByGroup[g] && breadsByGroup[g].length)
    .map(g => ({ label: BREAD_GROUP_LABELS[g], options: breadsByGroup[g] }));

  const toppings = (ref.toppings || [])
    .filter(t => !Array.isArray(t.category) || t.category.includes("lunch"))
    .map(t => t.display_name);

  const condiments = (ref.condiments || []).map(c => c.display_name);

  return {
    key:   "guide",
    label: "Build Your Own",
    guide: {
      note:    "Build your own sandwich from scratch — just tell us what you'd like!",
      pricing: "Roll or Wrap from $6.95  ·  Sub from $8.95",
      steps: [
        { label: "Choose a protein",               options: proteins },
        { label: "Choose a cheese (optional)",     options: cheeses  },
        { label: "Choose your bread",              groups:  breadGroups },
        { label: "Toppings",    options: toppings },
        { label: "Condiments", options: condiments },
      ],
    },
  };
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

let _cache = null;

function getMenu() {
  if (_cache) return _cache;
  const bfast  = readJson("menu_breakfast.json");
  const lunch  = readJson("menu_lunch_sandwiches.json");
  const panini = readJson("menu_panini.json");
  const sides  = readJson("menu_side_dishes.json");
  const deli   = readJson("menu_deli_by_weight.json");
  const ref    = readJson("reference.json");
  _cache = {
    tabs: [
      buildBreakfastTab(bfast),
      buildLunchTab(lunch, panini),
      buildDeliTab(sides, deli),
      buildGuideTab(ref),
    ],
  };
  return _cache;
}

module.exports = { getMenu };
