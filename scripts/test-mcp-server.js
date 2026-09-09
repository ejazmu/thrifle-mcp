#!/usr/bin/env node
/**
 * Fixtures for the MCP server — run in CI (main.yml) and by hand:
 *   node scripts/test-mcp-server.js
 *
 * No database. An Express app serves stub copies of the public API routes the
 * tools read, the real MCP router is mounted on the same app, and a real MCP
 * client (the SDK's StreamableHTTPClientTransport) talks to it over loopback —
 * so this exercises the protocol handshake, the tool catalogue, the loopback
 * hop, the shapers and the rate limiter end to end.
 *
 * Guards:
 *  1. every tool is read-only, titled, described, snake_case, <= 64 chars
 *     (Claude directory requirements) and unique;
 *  2. shapers keep the facts + canonical URL and drop internals (Mongo ids,
 *     collection notes, histories) — a URL built any other way is a bug;
 *  3. dead deals are filtered, Price Predict never leaves the DB-only path,
 *     "not found" is a normal result (not an error) so the model can recover;
 *  4. the per-IP limiter blocks and the partner key bypasses it;
 *  5. GET is a discovery document for humans and a 405 for event-stream
 *     clients; DELETE is 405.
 */
"use strict";
const assert = require("assert");
const express = require("express");

process.env.SITE_URL = "https://thrifle.com";
const T = "?utm_source=thrifle_mcp&utm_medium=mcp"; // every returned thrifle.com URL carries the MCP click tag
process.env.MCP_RATE_PER_MIN = "1000";
process.env.MCP_RATE_PER_DAY = "100000";
delete process.env.MCP_API_KEYS;

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const S = require("../src/shape");
const { checkRateLimit, _reset } = require("../src/rate-limit");
const { TOOLS } = require("../src/tools");
const mcpRouter = require("../src/router");

let n = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      n++;
      console.log("  ok  " + name);
    });
}

// ── fixtures (trimmed copies of real 2026-09-08 payloads) ───────────────────
const FIX = {
  costco: {
    found: true,
    policy: {
      _id: "x", __v: 0, merchant_key: "costco", merchant_name: "Costco", category: "Warehouse club", status: "open",
      return_window: "Unlimited (most items)", return_window_days: 9999, free_returns: "Yes", return_shipping_cost: "Free",
      restocking_fee: "None", holiday_extension: "N/A", non_returnable: ["Alcohol", "Cigarettes"], thrifle_tip: "Bring the membership card.",
      policy_url: "https://api.thrifle.com/api/go/policy/costco", policy_url_is_affiliate: true, last_verified: "2026-08-31T00:00:00.000Z",
      seo_demand: { volume: 99999 }, pinterest_pin_url: "https://pin", aliases: ["costco wholesale"],
    },
    context: { merchant: "Costco", verdict: "lifetime", primary_message: "♾️ Lifetime returns — return anytime.", secondary_message: "Free returns", is_holiday_active: false },
    faqs: [{ question: "Can I return a TV?", answer: "Within 90 days.", category: "electronics" }],
    grade: { grade: "A", applicable: true, label: "Excellent", score: 4.5, max: 5, electronics: { applied: true, days: 90, label: "TVs, computers…", note: "Carved out.", source_url: "https://customerservice.costco.com/x" }, axes: {} },
    rivals: [{ merchant_key: "sam's club", merchant_name: "Sam's Club", grade: "A", score: 4.4, return_window: "Unlimited" }],
    category_stats: { category: "Warehouse club", window_days: 9999, peers: 12, pct_longer_than: 91, median_window_days: 90 },
    logo: {}, about: "Long about text", what_they_sell: "Groceries, electronics, furniture, and more.", our_take: "x",
  },
  list: [
    { merchant_key: "best buy", merchant_name: "Best Buy", category: "Electronics", return_window: "15 days", free_returns: "Yes", status: "open" },
    { merchant_key: "costco", merchant_name: "Costco", category: "Warehouse club", return_window: "Unlimited", free_returns: "Yes" },
    { merchant_key: "at&t", merchant_name: "AT&T", category: "Telecom", return_window: "14 days", free_returns: "No" },
  ],
  liveDeal: {
    _id: "6a8fddb9a911d446860c7aa2", title: "Apple AirPods Pro 3 - Open Box Deal", price: "144", retail_price: 249, merchant: "Walmart", brand: "Apple",
    category_name: "Tech & Electronics", slug: "apple-airpods-pro-3-open-box-deal", link: "https://api.thrifle.com/api/go/deal/6a8fddb9a911d446860c7aa2?ref=api",
    link_is_affiliate: true, date: new Date().toISOString(), evergreen: false, images: [{ imageUrl: "https://s3/x.jpg" }], priceHistory: [1, 2, 3],
  },
  deadDeal: { _id: "6a8fddb9a911d446860c7aa3", title: "Old AirPods deal", price: "99", retail_price: 199, category_name: "Tech & Electronics", slug: "old-airpods", link: "https://amazon.com/dp/B0?tag=x", date: "2024-01-01T00:00:00.000Z", evergreen: false },
  prediction: {
    source: "database",
    product: { asin: "0783225784", title: "Animal House", brand: null, marketplace: "US", currency: "USD", currentPrice: 13.74, priceIsLive: false, typicalPrice: 14.64, allTimeLow: 2.64, allTimeLowDate: "2015-05-01", avg30: 14.1, avg90: 16.11, avg365: 15.2, dealScore: 100, historyPoints: 101, historySpanDays: 274 },
    prediction: { verdict: "HOLD", buyLabel: "Likely to drop", buyScore: 32, confidence: "high", confidencePct: 89, currentPrice: 13.74, typicalPrice: 14.64, vsAvgPct: -6.15, pricePercentile: 68.3, expectedLow: 10.67, dropProb30: 0.31, dropProb60: 0.52, reasons: ["r1", "r2"], asOf: "2026-09-08", confidenceNote: "Your call." },
    priceHistory: [[1, 2]], related: null,
  },
  card: {
    _id: "y", __v: 0, card_key: "citi-bloomingdales-amex-card", name: "Bloomingdale's American Express® Card", issuer: "Citi Retail Services", network: "Amex", card_type: "co_brand",
    is_store_card: true, co_brand_partner: "Bloomingdale's", merchant_key: "bloomingdales", annual_fee: 0, purchase_apr: { min: 32.74, max: 32.74, variable: true },
    financing: { offers_promotional_financing: true, deferred_interest: true, fine_print_quote: "Interest will be charged…" },
    provenance: { pricing_terms_url: "https://citi/terms", rates_verified_at: "2026-08-04T00:00:00.000Z", confidence: "low", collected_by: "agent-7" },
    collection_notes: "INTERNAL rejected sources…", batch: "batch-02", schema_version: 2,
  },
  post: {
    _id: "z", title: "Black Friday Was Real.", slug: "black-friday-2025-amazon-what-actually-dropped", description: "We tracked 329,920 products.", category_name: "Deals", vertical: "shopping",
    published_at: "2026-09-01T00:00:00.000Z", posted_by: "Haider Ejaz", geo_snippet: "Thrifle tracked 329,920 Amazon products.",
    content: "<h2>Method &amp; results</h2><p>We tracked <strong>329,920</strong> products.</p><ul><li>42% real</li><li>Nov 20 &rsquo;lows&rsquo;</li></ul><script>alert(1)</script>",
    faq_items: [{ question: "Was it real?", answer: "Yes." }],
  },
};

// ── stub API + real MCP router on one app ───────────────────────────────────
const app = express();
app.use(express.json());
app.get("/api/return-policy", (req, res) => res.json(FIX.list));
app.get("/api/return-policy/compare/:a/:b", (req, res) => res.json({ found: true, a: { policy: FIX.costco.policy, grade: FIX.costco.grade }, b: { policy: { ...FIX.costco.policy, merchant_key: "target", merchant_name: "Target" }, grade: { grade: "B+", score: 3.6, applicable: true } }, comparison: { comparable: true, axis_winners_v2: { window: "a", restocking: "tie" }, overall_winner_v2: "a" } }));
app.get("/api/return-policy/:m", (req, res) => (req.params.m === "costco" ? res.json(FIX.costco) : res.json({ found: false })));
app.get("/api/deals/deal-of-the-day", (req, res) => res.status(404).json({ msg: "none" }));
app.get("/api/deals", (req, res) => {
  res.locals.q = req.query;
  res.json({ deals: [FIX.liveDeal, FIX.deadDeal], totalPages: 1, currentPage: 1, count: 2 });
});
app.get("/api/deals/:slug", (req, res) => (req.params.slug === FIX.liveDeal.slug ? res.json({ ...FIX.liveDeal, description: "<p>Desc</p>", why_its_great: { summary: "s", bullets: ["b1", "b2"] }, dead: false }) : res.status(404).json({ msg: "Deal not found" })));
let ppSeen = null;
app.get("/api/price-predict", (req, res) => {
  ppSeen = req.query;
  if (req.query.asin === "B000000000") return res.json({ tracked: false, asin: "B000000000" });
  res.json(FIX.prediction);
});
app.get("/api/credit-cards", (req, res) => res.json({ count: 1, cards: [FIX.card] }));
app.get("/api/credit-cards/:key", (req, res) => (req.params.key === FIX.card.card_key ? res.json({ card: FIX.card }) : res.status(404).json({ msg: "Card not found" })));
app.get("/api/blog/posts/get-all", (req, res) => res.json({ page: 1, pages: 1, posts: req.query.vertical === "finance" ? [] : [FIX.post] }));
app.get("/api/blog/posts/by-slug/:slug", (req, res) => (req.params.slug === FIX.post.slug ? res.json(FIX.post) : res.status(404).json({ msg: "Post not found" })));
app.get("/api/discounts/:key", (req, res) => (req.params.key === "home-depot" ? res.json({ merchant_key: "home_depot", merchant_name: "Home Depot", category: "Home improvement", military: { has_discount: true, discount_value: "10%", status: { state: "standing", claimable: true } }, student: { has_discount: false } }) : res.status(404).json({ msg: "Not found" })));
app.get("/api/cancellation", (req, res) => res.json([{ merchant_key: "planet-fitness", merchant_name: "Planet Fitness" }]));
app.get("/api/cancellation/:key", (req, res) => res.status(404).json({ msg: "no" }));
app.get("/api/about", (req, res) => res.json({ description: "d", capabilities: { return_policy_db: {} }, contact: "hello@thrifle.com" }));
app.use("/api/mcp", mcpRouter);

function parse(result) {
  assert.ok(result && Array.isArray(result.content) && result.content[0] && result.content[0].type === "text", "tool must return a text block");
  return JSON.parse(result.content[0].text);
}

(async () => {
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}/api/mcp`;

  const client = new Client({ name: "fixture-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base)));
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args || {} }));

  await t("handshake works and lists every catalogued tool", async () => {
    const { tools } = await client.listTools();
    assert.strictEqual(tools.length, TOOLS.length);
    assert.ok(tools.length >= 20, "catalogue shrank");
  });

  await t("every tool is read-only, titled, described, snake_case and <= 64 chars (directory rules)", async () => {
    const { tools } = await client.listTools();
    const seen = new Set();
    for (const tool of tools) {
      assert.ok(!seen.has(tool.name), "duplicate " + tool.name);
      seen.add(tool.name);
      assert.ok(/^[a-z][a-z0-9_]*$/.test(tool.name), "name not snake_case: " + tool.name);
      assert.ok(tool.name.length <= 64, "name too long: " + tool.name);
      assert.ok(tool.title && tool.title.length >= 8, "missing title: " + tool.name);
      assert.ok(tool.description && tool.description.length >= 60, "thin description: " + tool.name);
      assert.strictEqual(tool.annotations && tool.annotations.readOnlyHint, true, "not read-only: " + tool.name);
      assert.strictEqual(tool.annotations.destructiveHint, false, "destructive: " + tool.name);
      assert.ok(tool.inputSchema && tool.inputSchema.type === "object", "no input schema: " + tool.name);
    }
  });

  await t("get_return_policy: facts + grade + canonical URL, internals dropped", async () => {
    const out = await call("get_return_policy", { merchant: "costco" });
    assert.strictEqual(out.found, true);
    assert.strictEqual(out.grade.letter, "A");
    assert.strictEqual(out.url, "https://thrifle.com/return-policy/costco" + T);
    assert.strictEqual(out.cite.url, out.url);
    assert.strictEqual(out.return_window_days, "no deadline");
    assert.strictEqual(out.electronics_exception.days, 90);
    assert.strictEqual(out.vs_category.longer_than_pct_of_peers, 91);
    assert.strictEqual(out.top_rated_alternatives[0].url, "https://thrifle.com/return-policy/sams-club" + T);
    assert.ok(out.policy_url_note, "affiliate hop must be labelled");
    assert.strictEqual(out.today.verdict, "lifetime");
    for (const k of ["_id", "__v", "seo_demand", "pinterest_pin_url", "aliases", "about", "our_take"]) assert.ok(!(k in out), k + " leaked");
  });

  await t("get_return_policy: unknown merchant is a normal not-found result, not an error", async () => {
    const raw = await client.callTool({ name: "get_return_policy", arguments: { merchant: "nowhere" } });
    assert.ok(!raw.isError);
    const out = parse(raw);
    assert.strictEqual(out.found, false);
    assert.ok(/search_return_policies/.test(out.hint));
  });

  await t("compare_return_policies: winners named, compare URL built from slugs", async () => {
    const out = await call("compare_return_policies", { merchant_a: "costco", merchant_b: "target" });
    assert.strictEqual(out.overall_winner, "Costco");
    assert.strictEqual(out.axis_winners.restocking, "tie");
    assert.strictEqual(out.url, "https://thrifle.com/return-policy/compare/costco-vs-target" + T);
  });

  await t("search_return_policies: no args → categories; query → ranked rows; & slug rule honoured", async () => {
    const cats = await call("search_return_policies", {});
    assert.strictEqual(cats.total_in_database, 3);
    assert.ok(cats.categories.some((c) => c.name === "Electronics"));
    const hit = await call("search_return_policies", { query: "best" });
    assert.strictEqual(hit.results[0].merchant, "Best Buy");
    assert.strictEqual(hit.results[0].url, "https://thrifle.com/return-policy/best-buy" + T);
    const att = await call("search_return_policies", { query: "at&t" });
    assert.strictEqual(att.results[0].url, "https://thrifle.com/return-policy/at-and-t" + T);
  });

  await t("search_deals: dead deals dropped, buy link is the cloaked hop, page URL from category", async () => {
    const out = await call("search_deals", { query: "airpods (pro)" });
    assert.strictEqual(out.count, 1);
    assert.strictEqual(out.results[0].url, "https://thrifle.com/deals/tech-and-electronics/apple-airpods-pro-3-open-box-deal" + T);
    assert.strictEqual(out.results[0].buy_url, FIX.liveDeal.link);
    assert.strictEqual(out.results[0].discount_pct, 42);
    assert.strictEqual(out.results[0].expired, false);
    const withDead = await call("search_deals", { query: "airpods", include_expired: true });
    assert.strictEqual(withDead.count, 2);
    assert.strictEqual(withDead.results[1].expired, true);
  });

  await t("get_deal / get_deal_of_the_day: URL input accepted; no DOTD is found:false", async () => {
    const out = await call("get_deal", { deal: "https://thrifle.com/deals/tech-and-electronics/apple-airpods-pro-3-open-box-deal" });
    assert.strictEqual(out.found, true);
    assert.deepStrictEqual(out.why_its_great.bullets, ["b1", "b2"]);
    assert.strictEqual(out.description, "Desc");
    const none = await call("get_deal_of_the_day", {});
    assert.strictEqual(none.found, false);
  });

  await t("predict_amazon_price: always DB-only; tracked → verdict, untracked → link to live check", async () => {
    const out = await call("predict_amazon_price", { asin_or_url: "https://www.amazon.com/dp/0783225784" });
    assert.strictEqual(ppSeen.dbOnly, "1", "must never leave the dbOnly path");
    assert.strictEqual(out.verdict.call, "HOLD");
    assert.strictEqual(out.price.all_time_low, 2.64);
    assert.strictEqual(out.url, "https://thrifle.com/price-predict?asin=0783225784&utm_source=thrifle_mcp&utm_medium=mcp");
    assert.ok(out.caveat);
    const un = await call("predict_amazon_price", { asin_or_url: "B000000000" });
    assert.strictEqual(un.found, false);
    assert.strictEqual(un.url, "https://thrifle.com/price-predict?asin=B000000000&utm_source=thrifle_mcp&utm_medium=mcp");
  });

  await t("get_credit_card: internals stripped, low-confidence warning, cross-links", async () => {
    const out = await call("get_credit_card", { card_key: "Citi-Bloomingdales-Amex-Card" });
    assert.strictEqual(out.found, true);
    for (const k of ["_id", "__v", "collection_notes", "batch", "schema_version"]) assert.ok(!(k in out), k + " leaked");
    assert.ok(!("collected_by" in out.provenance));
    assert.ok(/Low-confidence/.test(out.warning));
    assert.strictEqual(out.url, "https://thrifle.com/money/cards/citi-bloomingdales-amex-card" + T);
    assert.strictEqual(out.merchant_return_policy, "https://thrifle.com/return-policy/bloomingdales" + T);
    assert.ok(out.deferred_interest_calculator);
  });

  await t("get_store_credit_cards + search_credit_cards: slug join and filters", async () => {
    const store = await call("get_store_credit_cards", { merchant: "Bloomingdale's" });
    assert.strictEqual(store.url, "https://thrifle.com/money/store-cards/bloomingdales" + T);
    assert.strictEqual(store.cards[0].deferred_interest, true);
    const s = await call("search_credit_cards", { query: "nothing-matches" });
    assert.strictEqual(s.total_matches, 0);
  });

  await t("get_blog_post: HTML stripped, entities decoded, scripts gone, FAQ kept", async () => {
    const out = await call("get_blog_post", { post: "https://thrifle.com/blog/black-friday-2025-amazon-what-actually-dropped" });
    assert.ok(!/<|alert\(/.test(out.text), "html leaked: " + out.text);
    assert.ok(/Method & results/.test(out.text));
    assert.ok(/• 42% real/.test(out.text));
    assert.strictEqual(out.faq.length, 1);
    assert.strictEqual(out.url, "https://thrifle.com/blog/black-friday-2025-amazon-what-actually-dropped" + T);
    assert.strictEqual(out.author, "Haider Ejaz");
  });

  await t("get_merchant_discounts / get_cancellation_guide: key normalisation and helpful not-found", async () => {
    const d = await call("get_merchant_discounts", { merchant: "Home Depot" });
    assert.strictEqual(d.url, "https://thrifle.com/discounts/home-depot" + T);
    assert.strictEqual(d.military.discount_value, "10%");
    const c = await call("get_cancellation_guide", { merchant: "Netflix" });
    assert.strictEqual(c.found, false);
    assert.strictEqual(c.available[0].url, "https://thrifle.com/how-to-cancel/planet-fitness" + T);
  });

  await t("about_thrifle lists the catalogue", async () => {
    const out = await call("about_thrifle", {});
    assert.strictEqual(out.tools.length, TOOLS.length);
  });

  await client.close();

  await t("GET /api/mcp: discovery JSON for humans, 405 for event-stream clients, DELETE 405", async () => {
    const r = await fetch(base);
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.transport, "streamable-http");
    assert.ok(j.tools.length === TOOLS.length);
    const es = await fetch(base, { headers: { accept: "text/event-stream" } });
    assert.strictEqual(es.status, 405);
    const del = await fetch(base, { method: "DELETE" });
    assert.strictEqual(del.status, 405);
  });

  await t("rate limiter: blocks after the per-minute ceiling, partner key bypasses", async () => {
    _reset();
    process.env.MCP_RATE_PER_MIN = "2";
    process.env.MCP_API_KEYS = "partner-abc";
    const req = (h) => ({ headers: h || {}, ip: "203.0.113.9" });
    assert.strictEqual(checkRateLimit(req()).allowed, true);
    assert.strictEqual(checkRateLimit(req()).allowed, true);
    const blocked = checkRateLimit(req());
    assert.strictEqual(blocked.allowed, false);
    assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 60);
    assert.strictEqual(checkRateLimit(req({ authorization: "Bearer partner-abc" })).keyed, true);
    assert.strictEqual(checkRateLimit({ headers: { "cf-connecting-ip": "198.51.100.1" }, ip: "10.0.0.1" }).allowed, true, "different ip has its own bucket");
    // and the HTTP surface says 429 with Retry-After
    const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    assert.strictEqual(r.status, 429);
    assert.ok(r.headers.get("retry-after"));
    process.env.MCP_RATE_PER_MIN = "1000";
    delete process.env.MCP_API_KEYS;
    _reset();
  });

  await t("shape helpers: URL rules and text cleanup", async () => {
    assert.strictEqual(S.url.discount("home_depot"), "https://thrifle.com/discounts/home-depot" + T);
    assert.strictEqual(S.url.returnPolicy("academy sports + outdoors"), "https://thrifle.com/return-policy/academy-sports-plus-outdoors" + T);
    assert.strictEqual(S.url.deal({ category_name: "Tools & Home Improvement", slug: "x" }), "https://thrifle.com/deals/tools-and-home-improvement/x" + T);
    assert.strictEqual(S.url.blog({ vertical: "finance", slug: "k" }), "https://thrifle.com/money/blog/k" + T);
    assert.strictEqual(S.withUtm("https://example.com/x"), "https://example.com/x", "only thrifle.com URLs are tagged");
    assert.strictEqual(S.withUtm("https://thrifle.com/a?b=1"), "https://thrifle.com/a?b=1&utm_source=thrifle_mcp&utm_medium=mcp");
    assert.strictEqual(S.htmlToText("<p>a&amp;b</p><p>c</p>"), "a&b\nc");
    assert.ok(S.htmlToText("x".repeat(50), 10).endsWith("[truncated]"));
    assert.strictEqual(S.pct("144", 249), 42);
    assert.strictEqual(S.pct("300", 249), null);
  });

  srv.close();
  console.log(`\n${n} fixtures passed`);
})().catch((e) => {
  console.error("\nFAILED:", e && e.stack ? e.stack : e);
  process.exit(1);
});
