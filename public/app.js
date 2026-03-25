"use strict";

const SESSION_ID = "demo-" + Math.random().toString(36).slice(2, 10);

const messagesEl    = document.getElementById("messages");
const inputEl       = document.getElementById("user-input");
const sendBtn       = document.getElementById("btn-send");
const resetBtn      = document.getElementById("btn-reset");
const orderItemsEl  = document.getElementById("order-items");
const orderTotalEl  = document.getElementById("order-total");
const orderHeaderEl = document.getElementById("order-header");
const menuTabsEl    = document.getElementById("menu-tabs");
const menuContentEl = document.getElementById("menu-content");

let orderDone = false;

// ── helpers ──────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function appendMsg(text, role) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendMessages(lines, role) {
  const combined = lines.filter(Boolean).join("\n").trim();
  if (combined) appendMsg(combined, role);
}

function setInputEnabled(enabled) {
  inputEl.readOnly = !enabled;
  sendBtn.disabled = !enabled;
}

function fmt(cents) {
  if (cents == null) return "";
  return "$" + Number(cents).toFixed(2);
}

// ── order summary ─────────────────────────────────────────────────────────────

function renderOrderSummary(summary) {
  if (!summary) return;

  orderHeaderEl.textContent = summary.customer_name
    ? summary.customer_name + "'s order"
    : "Your Order";

  orderItemsEl.innerHTML = "";

  const allItems  = [...summary.items];
  const hasPending = summary.pending && summary.pending.name;

  if (allItems.length === 0 && !hasPending) {
    orderItemsEl.innerHTML = '<p class="empty-note">Nothing yet — start by telling us what you\'d like!</p>';
    orderTotalEl.textContent = "";
    return;
  }

  allItems.forEach((it) => {
    const div = document.createElement("div");
    div.className = "order-item";

    const qtyLabel = it.quantity > 1 ? `${it.quantity}x ` : "";
    div.innerHTML = `<div class="item-name">${qtyLabel}${esc(it.name)}</div>`;

    const meta = [];
    if (it.format)           meta.push(it.format.toLowerCase());
    if (it.bread_type_label) meta.push(it.bread_type_label.toLowerCase());
    if (it.condiments_labels && it.condiments_labels.length)
      meta.push(it.condiments_labels.map((l) => l.toLowerCase()).join(", "));
    if (meta.length) {
      div.innerHTML += `<div class="item-meta">${esc(meta.join(" · "))}</div>`;
    }

    if (it.total_price != null) {
      div.innerHTML += `<div class="item-price">${fmt(it.total_price)}</div>`;
    }

    orderItemsEl.appendChild(div);
  });

  if (hasPending) {
    const p   = summary.pending;
    const div = document.createElement("div");
    div.className = "order-item pending-item";
    div.innerHTML = `<div class="pending-label">In progress\u2026</div><div class="item-name">${esc(p.name)}</div>`;
    const meta = [];
    if (p.format)           meta.push(p.format.toLowerCase());
    if (p.bread_type_label) meta.push(p.bread_type_label.toLowerCase());
    if (meta.length) div.innerHTML += `<div class="item-meta">${esc(meta.join(" · "))}</div>`;
    orderItemsEl.appendChild(div);
  }

  if (summary.total != null) {
    orderTotalEl.textContent = "Total: " + fmt(summary.total);
  } else {
    orderTotalEl.textContent = "";
  }
}

// ── menu rendering ────────────────────────────────────────────────────────────

let _menuData   = null;
let _activeTabKey = null;

function renderMenuTab(tab) {
  menuContentEl.innerHTML = "";

  if (tab.guide) {
    // Build Your Own guide
    const g = tab.guide;
    const intro = document.createElement("div");
    intro.className = "guide-intro";
    intro.innerHTML = `<p>${esc(g.note)}</p><div class="guide-pricing">${esc(g.pricing)}</div>`;
    menuContentEl.appendChild(intro);

    for (const step of g.steps) {
      const section = document.createElement("div");
      section.className = "guide-step";
      section.innerHTML = `<div class="guide-step-label">${esc(step.label)}</div>`;

      if (step.groups) {
        // Bread groups
        for (const grp of step.groups) {
          const gl = document.createElement("div");
          gl.className = "guide-group-label";
          gl.textContent = grp.label;
          section.appendChild(gl);

          const tags = document.createElement("div");
          tags.className = "guide-tags";
          for (const opt of grp.options) {
            const tag = document.createElement("span");
            tag.className = "guide-tag";
            tag.textContent = opt;
            tags.appendChild(tag);
          }
          section.appendChild(tags);
        }
      } else {
        const tags = document.createElement("div");
        tags.className = "guide-tags";
        for (const opt of step.options || []) {
          const tag = document.createElement("span");
          tag.className = "guide-tag";
          tag.textContent = opt;
          tags.appendChild(tag);
        }
        section.appendChild(tags);
      }

      menuContentEl.appendChild(section);
    }
    return;
  }

  // Regular sections with items
  for (const sec of (tab.sections || [])) {
    const section = document.createElement("div");
    section.className = "menu-section";

    let headingHtml = `<div class="menu-section-heading">${esc(sec.heading)}</div>`;
    if (sec.note) headingHtml += `<div class="menu-section-note">${esc(sec.note)}</div>`;
    section.innerHTML = headingHtml;

    for (const item of sec.items) {
      const row = document.createElement("div");
      row.className = "menu-item";
      row.innerHTML =
        `<div class="menu-item-left">` +
          `<div class="menu-item-name">${esc(item.name)}</div>` +
          (item.description ? `<div class="menu-item-desc">${esc(item.description)}</div>` : "") +
        `</div>` +
        (item.price ? `<div class="menu-item-price">${esc(item.price)}</div>` : "");
      section.appendChild(row);
    }

    menuContentEl.appendChild(section);
  }
}

function activateTab(key) {
  _activeTabKey = key;
  for (const btn of menuTabsEl.querySelectorAll(".menu-tab")) {
    btn.classList.toggle("active", btn.dataset.key === key);
  }
  const tab = (_menuData || { tabs: [] }).tabs.find(t => t.key === key);
  if (tab) {
    renderMenuTab(tab);
    menuContentEl.scrollTop = 0;
  }
}

function renderMenuTabs(menuData) {
  _menuData = menuData;
  menuTabsEl.innerHTML = "";
  for (const tab of menuData.tabs) {
    const btn = document.createElement("button");
    btn.className    = "menu-tab";
    btn.dataset.key  = tab.key;
    btn.textContent  = tab.label;
    btn.setAttribute("role", "tab");
    btn.addEventListener("click", () => activateTab(tab.key));
    menuTabsEl.appendChild(btn);
  }
  // Activate first tab by default
  if (menuData.tabs.length) activateTab(menuData.tabs[0].key);
}

async function loadMenu() {
  try {
    const res  = await fetch("/api/menu");
    if (!res.ok) throw new Error("menu fetch failed");
    const data = await res.json();
    renderMenuTabs(data);
  } catch (e) {
    menuContentEl.innerHTML = '<p class="empty-note" style="padding:20px">Menu unavailable</p>';
  }
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function apiPost(url, body) {
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function startSession() {
  messagesEl.innerHTML = "";
  orderItemsEl.innerHTML = '<p class="empty-note">Nothing yet — start by telling us what you\'d like!</p>';
  orderTotalEl.textContent = "";
  orderHeaderEl.textContent = "Your Order";
  orderDone = false;
  setInputEnabled(true);
  inputEl.focus();

  try {
    const data = await apiPost("/api/session", { sessionId: SESSION_ID });
    appendMessages(data.messages, "system");
    renderOrderSummary(data.orderSummary);
  } catch (e) {
    appendMsg("Connection error — is the server running?", "system");
  }
}

async function resetSession() {
  messagesEl.innerHTML = "";
  orderItemsEl.innerHTML = '<p class="empty-note">Nothing yet — start by telling us what you\'d like!</p>';
  orderTotalEl.textContent = "";
  orderHeaderEl.textContent = "Your Order";
  orderDone = false;
  setInputEnabled(true);
  inputEl.focus();

  try {
    const data = await apiPost("/api/reset", { sessionId: SESSION_ID });
    appendMessages(data.messages, "system");
    renderOrderSummary(data.orderSummary);
  } catch (e) {
    appendMsg("Connection error.", "system");
  }
}

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || orderDone || inputEl.readOnly) return;
  inputEl.value = "";
  appendMsg(text, "user");
  setInputEnabled(false);

  try {
    const data = await apiPost("/api/message", { sessionId: SESSION_ID, text });
    appendMessages(data.messages, data.done ? "done" : "system");
    renderOrderSummary(data.orderSummary);
    if (data.done) {
      orderDone = true;
    } else {
      setInputEnabled(true);
      inputEl.focus();
    }
  } catch (e) {
    appendMsg("Error communicating with server.", "system");
    setInputEnabled(true);
  }
}

// ── mobile navigation ─────────────────────────────────────────────────────────

document.getElementById("btn-start-order").addEventListener("click", () => {
  document.body.classList.add("show-ordering");
  inputEl.focus();
});

document.getElementById("btn-view-menu").addEventListener("click", () => {
  document.body.classList.remove("show-ordering");
});

// ── event listeners ───────────────────────────────────────────────────────────

sendBtn.addEventListener("click", sendMessage);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
resetBtn.addEventListener("click", resetSession);

// ── mobile viewport (keyboard-aware layout) ───────────────────────────────────

function setupMobileViewport() {
  if (!window.visualViewport) return;
  const panel = document.getElementById('ordering-panel');
  function resize() {
    if (window.innerWidth > 767) {
      panel.style.height = '';
      panel.style.flex = '';
      return;
    }
    panel.style.flex = 'none';
    panel.style.height = window.visualViewport.height + 'px';
  }
  window.visualViewport.addEventListener('resize', resize);
  window.visualViewport.addEventListener('scroll', resize);
  resize(); // apply immediately on load
}

// ── init ──────────────────────────────────────────────────────────────────────

setupMobileViewport();
loadMenu();
startSession();
