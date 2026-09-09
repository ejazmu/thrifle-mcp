"use strict";
/**
 * Per-IP throttle for the MCP endpoint.
 *
 * The tools hand out the same structured facts the website renders, one
 * merchant at a time. That is fine for an assistant answering a shopper and
 * not fine for a script paging through 2,250 merchants to rebuild the
 * database (see llms-full.txt's 2026-08 trim and the canary programme). Two
 * ceilings, both in-memory (single PM2 process, resets on restart — good
 * enough for a first line; nginx logs are the durable record):
 *
 *   MCP_RATE_PER_MIN   sliding-window calls per IP per minute   (default 60)
 *   MCP_RATE_PER_DAY   calls per IP per UTC day                 (default 1500)
 *
 * A caller presenting a key from MCP_API_KEYS (comma-separated, .env) skips
 * both — that is the licensing / partner lane. Keys are opaque strings we
 * mint by hand; there is no self-serve issuance on purpose.
 */

const WINDOW_MS = 60 * 1000;
const buckets = new Map(); // ip -> { hits: number[], day: string, dayCount: number }
const BUCKETS_MAX = 5000;

function limits() {
  return {
    perMin: Number(process.env.MCP_RATE_PER_MIN) > 0 ? Number(process.env.MCP_RATE_PER_MIN) : 60,
    perDay: Number(process.env.MCP_RATE_PER_DAY) > 0 ? Number(process.env.MCP_RATE_PER_DAY) : 1500,
  };
}

function trustedKeys() {
  return String(process.env.MCP_API_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function clientIp(req) {
  const h = (req && req.headers) || {};
  return (
    String(h["cf-connecting-ip"] || "").trim() ||
    String(h["x-forwarded-for"] || "").split(",")[0].trim() ||
    (req && req.ip) ||
    "anon"
  );
}

function presentedKey(req) {
  const h = (req && req.headers) || {};
  const auth = String(h.authorization || "");
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  return String(h["x-api-key"] || "").trim();
}

/**
 * @returns {{allowed: boolean, keyed: boolean, retryAfterSec?: number, reason?: string}}
 */
function checkRateLimit(req, now = Date.now()) {
  const key = presentedKey(req);
  if (key && trustedKeys().includes(key)) return { allowed: true, keyed: true };

  const { perMin, perDay } = limits();
  const ip = clientIp(req);
  const today = new Date(now).toISOString().slice(0, 10);
  let b = buckets.get(ip);
  if (!b || b.day !== today) b = { hits: [], day: today, dayCount: 0 };
  b.hits = b.hits.filter((t) => now - t < WINDOW_MS);

  if (b.dayCount >= perDay) {
    buckets.set(ip, b);
    const midnight = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate() + 1
    );
    return {
      allowed: false,
      keyed: false,
      reason: `Daily limit of ${perDay} MCP calls reached for this address.`,
      retryAfterSec: Math.max(1, Math.ceil((midnight - now) / 1000)),
    };
  }
  if (b.hits.length >= perMin) {
    buckets.set(ip, b);
    return {
      allowed: false,
      keyed: false,
      reason: `Rate limit of ${perMin} MCP calls per minute reached for this address.`,
      retryAfterSec: Math.max(1, Math.ceil((WINDOW_MS - (now - b.hits[0])) / 1000)),
    };
  }
  b.hits.push(now);
  b.dayCount += 1;
  if (buckets.size >= BUCKETS_MAX && !buckets.has(ip)) buckets.clear();
  buckets.set(ip, b);
  return { allowed: true, keyed: false };
}

function _reset() {
  buckets.clear();
}

module.exports = { checkRateLimit, clientIp, presentedKey, _reset };
