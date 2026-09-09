#!/usr/bin/env node
"use strict";
/**
 * Standalone runner: `npm start` serves the Thrifle MCP server on
 * http://127.0.0.1:8787/mcp, reading Thrifle's public API. This is the same
 * code that runs at https://api.thrifle.com/api/mcp — run it locally to hack
 * on tools, or point THRIFLE_API_BASE elsewhere for a mirror.
 */
process.env.THRIFLE_API_BASE = process.env.THRIFLE_API_BASE || "https://api.thrifle.com/api";
process.env.MCP_PUBLIC_URL = process.env.MCP_PUBLIC_URL || "https://api.thrifle.com/api/mcp";

const express = require("express");
const router = require("./src/router");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/mcp", router);
app.use("/api/mcp", router);
app.get("/", (req, res) => res.redirect(302, "/mcp"));

const PORT = Number(process.env.PORT) || 8787;
app.listen(PORT, () => {
  console.log(`thrifle-mcp listening on http://127.0.0.1:${PORT}/mcp (api: ${process.env.THRIFLE_API_BASE})`);
});
