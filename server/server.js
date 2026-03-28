"use strict";

const express = require("express");
const path = require("path");
const { createSession, resetSession, sendMessage } = require("./sessions.js");
const { getMenu } = require("./menu-data.js");
const logger = require("./session-logger.js");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// POST /api/session — create a new session and get the greeting
app.post("/api/session", (req, res) => {
  const sessionId = req.body.sessionId || "default";
  const result = createSession(sessionId);
  res.json(result);
});

// POST /api/reset — reset a session
app.post("/api/reset", (req, res) => {
  const sessionId = req.body.sessionId || "default";
  const result = resetSession(sessionId);
  res.json(result);
});

// POST /api/message — send a message to the ordering engine
app.post("/api/message", (req, res) => {
  const sessionId = req.body.sessionId || "default";
  const text = (req.body.text || "").trim();
  if (!text) return res.json({ messages: [], orderSummary: null, done: false });
  const result = sendMessage(sessionId, text);
  res.json(result);
});

// GET /api/menu — customer-facing menu data (display layer only)
app.get("/api/menu", (_req, res) => {
  res.json(getMenu());
});

// POST /api/report — tester manually flags a session for review
app.post("/api/report", (req, res) => {
  const sessionId = req.body.sessionId || "default";
  logger.markReported(sessionId);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Napoli Deli demo running at http://localhost:${PORT}`);
});

// Flush in-progress session logs on graceful shutdown.
function shutdown() { logger.flush(); server.close(); process.exit(0); }
process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
