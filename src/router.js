"use strict";
/**
 * POST /api/mcp — Thrifle's Model Context Protocol server (Streamable HTTP).
 *
 * Any MCP client (Claude.ai custom connectors, Claude Code, ChatGPT apps,
 * Cursor, VS Code…) can add https://api.thrifle.com/api/mcp and get Thrifle's
 * databases as tools. Catalogue + handlers: services/mcp/tools.js.
 *
 * Design notes:
 *  - STATELESS. One McpServer + transport per request, no session ids, plain
 *    JSON responses (enableJsonResponse) — nothing for nginx/Cloudflare to
 *    buffer, nothing to resume, nothing to leak between callers. The cost is
 *    re-registering ~24 tools per request, which is microseconds.
 *  - GET without an MCP Accept header is a human-readable discovery document
 *    (the URL people will paste into a connector dialog and then open in a
 *    browser to see what it is). GET with text/event-stream is the MCP
 *    notification stream, which a stateless server does not offer → 405.
 *  - Unauthenticated by design (read-only public data, same as the API it
 *    wraps), throttled per IP by services/mcp/rate-limit.js; MCP_API_KEYS
 *    lifts the throttle for partners.
 *  - Mounted under /api because nginx's api.thrifle.com vhost only proxies
 *    /api/* (location / is `deny all`). A `location = /mcp` block would let
 *    the short URL work too; not needed for launch.
 */

const express = require("express");
const router = express.Router();
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { registerTools, SERVER_INFO, INSTRUCTIONS, TOOLS, ENDPOINT } = require("./tools");
const { makeApiClient } = require("./api-client");
const { checkRateLimit, clientIp } = require("./rate-limit");

const SITE = process.env.SITE_URL || "https://thrifle.com";

function wantsEventStream(req) {
  return /text\/event-stream/i.test(String(req.headers.accept || ""));
}

function rpcError(res, status, code, message, extraHeaders) {
  if (extraHeaders) res.set(extraHeaders);
  return res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

// Discovery document — what a person sees when they open the connector URL.
router.get("/", (req, res) => {
  if (wantsEventStream(req)) {
    return rpcError(res, 405, -32000, "This server is stateless: no server-initiated event stream. Send JSON-RPC requests with POST.", { Allow: "POST" });
  }
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    name: SERVER_INFO.name,
    title: SERVER_INFO.title,
    version: SERVER_INFO.version,
    protocol: "Model Context Protocol",
    transport: "streamable-http",
    endpoint: ENDPOINT,
    auth: "none (read-only public data). Optional `Authorization: Bearer <key>` for partner rate limits.",
    how_to_connect: {
      claude: "Claude.ai → Settings → Connectors → Add custom connector → paste the endpoint URL.",
      claude_code: `claude mcp add --transport http thrifle ${ENDPOINT}`,
      chatgpt: "ChatGPT → Settings → Apps & Connectors → Create (developer mode) → paste the endpoint URL.",
      cursor_vscode: `{ "mcpServers": { "thrifle": { "url": "${ENDPOINT}" } } }`,
    },
    tools: TOOLS.map((t) => ({ name: t.name, title: t.title })),
    docs: `${SITE}/mcp`,
    site: SITE,
    contact: "hello@thrifle.com",
  });
});

router.delete("/", (req, res) => rpcError(res, 405, -32000, "Stateless server: nothing to terminate.", { Allow: "POST" }));

router.post("/", async (req, res) => {
  const rl = checkRateLimit(req);
  if (!rl.allowed) {
    return rpcError(res, 429, -32000, `${rl.reason} Retry after ${rl.retryAfterSec}s.`, { "Retry-After": String(rl.retryAfterSec) });
  }

  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  registerTools(server, { api: makeApiClient({ port: req.socket && req.socket.localPort, clientIp: clientIp(req) }), req });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });

  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp] request failed:", e && e.message);
    if (!res.headersSent) rpcError(res, 500, -32603, "Internal error");
  }
});

module.exports = router;
