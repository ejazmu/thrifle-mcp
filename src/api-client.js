"use strict";
/**
 * Loopback client for the MCP tools.
 *
 * Every MCP tool reads Thrifle's own PUBLIC API over 127.0.0.1 instead of
 * touching Mongoose directly. That is a deliberate choice, not laziness: the
 * public routes are where the rules live — affiliate-link cloaking
 * (utils/cloakDealLinks.js, routes/api/returnPolicy.js), the canary
 * projection (models/ReturnPolicy.js), the dead-deal policy, serve-time
 * grading, the DB-only price-predict path that never spends a Keepa token.
 * A tool that re-implemented any of those would drift from the website the
 * first time the website changed. Going through the front door means the MCP
 * answer is, by construction, the same answer thrifle.com gives.
 *
 * The hop never carries `X-Thrifle-SSR`, so utils/internal-request.js treats
 * it as public traffic — which it is. No canary marker, no SSR identity. It does
 * carry the MCP client's address in X-Thrifle-MCP-Client: every MCP user reaches
 * the API from 127.0.0.1, and per-IP rules behind this hop (/api/price-predict's
 * burst limit and datacenter gate) need to tell them apart. The API believes
 * that header only on a loopback hop with this UA (isInternalMcpRequest).
 */

const UA = "Thrifle-MCP/1.0 (+https://thrifle.com/mcp)";
const CLIENT_HEADER = "x-thrifle-mcp-client";
const TIMEOUT_MS = 12000;
const CACHE_MAX = 200;

// Shared across requests: the list endpoints behind search_* tools are heavy
// (the return-policy list is ~2,250 rows) and change rarely.
const cache = new Map(); // url -> { at, value }

function makeApiClient({ port, host, clientIp } = {}) {
  // Standalone runs (this repo's server.js) point at the public API; inside the
  // Thrifle backend the router passes the port it is listening on and the hop
  // stays on loopback. THRIFLE_API_BASE always wins when set.
  const p = Number(process.env.MCP_API_PORT) || Number(port) || Number(process.env.PORT) || 8000;
  const base = process.env.THRIFLE_API_BASE
    ? String(process.env.THRIFLE_API_BASE).replace(/\/+$/, "")
    : `http://${host || "127.0.0.1"}:${p}/api`;
  const headers = { "user-agent": UA, accept: "application/json" };
  // Loopback hop only: a standalone run never sends its users' addresses to the API.
  if (clientIp && !process.env.THRIFLE_API_BASE) headers[CLIENT_HEADER] = String(clientIp).slice(0, 100);

  /**
   * GET <base><path>?<params>. Never throws on an HTTP error — returns
   * { ok, status, body } so each tool can turn a 404 into a helpful
   * "not found, try …" instead of a stack trace.
   */
  async function get(path, params, { ttlMs = 0 } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
    const key = url.toString();
    if (ttlMs) {
      const c = cache.get(key);
      if (c && Date.now() - c.at < ttlMs) return c.value;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(key, { headers, signal: ctrl.signal });
      const text = await r.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch (_) {
        body = { msg: text.slice(0, 200) };
      }
      const out = { ok: r.ok, status: r.status, body };
      if (ttlMs && r.ok) {
        if (cache.size >= CACHE_MAX) cache.clear();
        cache.set(key, { at: Date.now(), value: out });
      }
      return out;
    } catch (e) {
      return { ok: false, status: 0, body: { msg: e.name === "AbortError" ? "timeout" : e.message } };
    } finally {
      clearTimeout(timer);
    }
  }

  return { get, base };
}

module.exports = { makeApiClient, UA, CLIENT_HEADER, _cache: cache };
