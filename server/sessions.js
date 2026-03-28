"use strict";

const path   = require("path");
const logger = require("./session-logger.js");
const {
  loadConfig,
  initState,
  processTurn,
  computeTotalBeforeTax,
  buildCtx,
  resolvePromptText,
} = require("../tools/run-cli.cjs");

// Load config once at startup (shared across sessions — read-only)
const ROOT = path.join(__dirname, "..");
const config = loadConfig(ROOT);

// session map: sessionId → { state }
const sessions = new Map();

function _emitGreeting(state) {
  const ctx = buildCtx(state, config);
  const greetText = resolvePromptText(config.promptMap, "GREETING", state, ctx);
  state.session.start = false;
  return Array.isArray(greetText) ? greetText : [greetText];
}

function createSession(sessionId) {
  const state = initState(config);
  const greeting = _emitGreeting(state);
  sessions.set(sessionId, { state });
  logger.init(sessionId);
  return { messages: greeting, orderSummary: _orderSummary(state) };
}

function resetSession(sessionId) {
  logger.markReset(sessionId);
  sessions.delete(sessionId);
  return createSession(sessionId);
}

function sendMessage(sessionId, text) {
  if (!sessions.has(sessionId)) {
    return createSession(sessionId);
  }
  const { state } = sessions.get(sessionId);
  const { responses, done } = processTurn(state, config, text);
  logger.appendTurn(sessionId, { userText: text, systemMessages: responses, state, done });
  if (done) logger.finalize(sessionId, state);
  return {
    messages: responses,
    orderSummary: _orderSummary(state),
    done,
  };
}

function _orderSummary(state) {
  const dm = config.displayMaps || {};
  const breadMap = dm.breads || {};
  const condMap = dm.condiments || {};

  const _breadLabel = (id) => (id ? (breadMap[id] || id.replace(/^bread\./, "").replace(/_/g, " ")) : null);
  const _condLabels = (arr) =>
    Array.isArray(arr)
      ? arr.map((c) => condMap[c] || c.replace(/^(?:topping|condiment)\./, "").replace(/_/g, " ")).filter(Boolean)
      : [];

  const items = (state.order.items || []).map((it) => ({
    name: it.name || it.item_id,
    format: it.format || null,
    bread_type: it.bread_type || null,
    bread_type_label: _breadLabel(it.bread_type),
    condiments: it.condiments || [],
    condiments_labels: _condLabels(it.condiments),
    addons: it.addons || [],
    quantity: it.quantity || 1,
    unit_price: it.price != null ? it.price : null,
    total_price: it.total_price != null ? it.total_price : it.price != null ? it.price * (it.quantity || 1) : null,
  }));

  const pending = state.order.pending_item && state.order.pending_item.exists
    ? {
        name: state.order.pending_item.name || state.order.pending_item.item_id,
        format: state.order.pending_item.format || null,
        bread_type: state.order.pending_item.bread_type || null,
        bread_type_label: _breadLabel(state.order.pending_item.bread_type),
        quantity: state.order.pending_item.quantity || 1,
      }
    : null;

  const total = computeTotalBeforeTax(state);

  return { items, pending, total, customer_name: state.order.customer_name || null };
}

module.exports = { createSession, resetSession, sendMessage };
