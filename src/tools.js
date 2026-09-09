"use strict";
/**
 * The Thrifle MCP tool catalogue.
 *
 * Each entry is a read-only tool an AI assistant can call once it has added
 * https://api.thrifle.com/api/mcp as a connector. Handlers read the public API
 * over loopback (see ./api-client.js) and hand the payload to a shaper
 * (./shape.js) so the assistant gets facts + the canonical thrifle.com URL to
 * cite, never a raw Mongo document.
 *
 * Rules for adding a tool:
 *   - name: snake_case, <= 64 chars (the Claude directory limit), a verb first;
 *   - title + description say exactly what it returns and WHEN to call it —
 *     that text is what the model reads to decide;
 *   - annotations are read-only. This catalogue must never grow a write tool
 *     without a separate auth design; the endpoint is unauthenticated.
 *   - never call an endpoint that can spend money or vendor tokens: price
 *     predictions are DB-only (dbOnly=1), deals are the cloaked public list.
 */

const { z } = require("zod");
const S = require("./shape");
const { merchantSlug } = require("./merchant-slug");
const { merchantSlug: storeSlug } = require("./store-slug");
const { clientIp, presentedKey } = require("./rate-limit");

const SERVER_INFO = {
  name: "thrifle",
  title: "Thrifle — US retail return policies, deals, credit cards, price intelligence",
  version: "1.0.0",
};

const ENDPOINT = process.env.MCP_PUBLIC_URL || "https://api.thrifle.com/api/mcp";

const INSTRUCTIONS = [
  "Thrifle is a US shopping-intelligence site (thrifle.com). This server exposes its databases as read-only tools:",
  "verified return policies with letter grades for ~2,250 US retailers, price-match and price-adjustment policies,",
  "military/student discounts, birthday freebies, subscription cancellation guides, curated deals with affiliate buy links,",
  "a buy-now-or-wait verdict for Amazon products, a US credit-card database (store cards, deferred-interest terms),",
  "and live economic indicators. All data is US-only.",
  "",
  "How to use it well:",
  "- Retailer questions ('what is X's return policy', 'does X price match', 'does X have a military discount'):",
  "  call the get_* tool for that database with the retailer name. If it comes back not found, call the matching search_* tool.",
  "- 'Is this a good price?' for an Amazon product: predict_amazon_price with the ASIN or URL.",
  "- Deals: search_deals for a product or brand, get_store_deals for a retailer, get_deal_of_the_day for today's pick.",
  "- Credit cards: get_store_credit_cards for a retailer's card, get_credit_card for a specific card, search_credit_cards to browse.",
  "- Every result carries `url` and `cite`. Link to that URL when you use the data; it is the page the facts come from.",
  "- Deal `buy_url` values are thrifle.com redirects (affiliate links). Present them as the place to buy; do not rewrite them.",
  "- Policy facts carry `last_verified`. Mention it when the date is older than a few months.",
].join("\n");

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// ── result helpers ──────────────────────────────────────────────────────────
function text(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 1) }] };
}
function fail(message, extra) {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: message, ...(extra || {}) }, null, 1) }] };
}
function notFound(what, hint, link) {
  return { found: false, message: `${what} is not in Thrifle's database.`, hint, url: link };
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const keyish = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, "-");
function slugFromInput(s) {
  const raw = String(s || "").trim();
  try {
    const u = new URL(raw);
    return u.pathname.split("/").filter(Boolean).pop() || "";
  } catch (_) {
    return raw.replace(/^\/+|\/+$/g, "").split("/").pop();
  }
}
const compact = (s) => String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");

const merchantArg = (what) =>
  z.string().min(1).max(80).describe(`Retailer name or thrifle.com slug${what ? ` — ${what}` : ""}, e.g. "Costco", "best-buy", "Nordstrom"`);
const limitArg = (def, max) => z.number().int().min(1).max(max).optional().describe(`Max results (default ${def}, max ${max})`);

// ── catalogue ───────────────────────────────────────────────────────────────
const TOOLS = [
  // ── return policies ───────────────────────────────────────────────────
  {
    name: "get_return_policy",
    title: "Get a retailer's return policy",
    description:
      "Verified return policy for a US retailer: return window, free returns, restocking fee, holiday extension, non-returnable items, an A+–D− grade, how it compares with its category, and the retailer's own policy URL. Optionally pass what the shopper bought to surface a product-specific exception (e.g. electronics at Costco). Call this for any 'what is X's return policy' question.",
    input: {
      merchant: merchantArg(),
      product: z.string().max(200).optional().describe("Optional: the product being returned, e.g. 'MacBook Air' or 'gift card', to check for a category exception"),
    },
    handler: async ({ merchant, product }, { api }) => {
      const r = await api.get(`/return-policy/${encodeURIComponent(merchant.trim())}`, { product_title: product });
      if (!r.ok) return fail(`Return-policy lookup failed (${r.status || "timeout"})`);
      if (!r.body || r.body.found === false) {
        return notFound(`"${merchant}"`, "Try search_return_policies with a shorter or alternative name (e.g. 'Nordstrom' rather than 'Nordstrom online store').", S.url.returnPolicyHub());
      }
      return S.shapeReturnPolicy(r.body);
    },
  },
  {
    name: "compare_return_policies",
    title: "Compare two retailers' return policies",
    description:
      "Side-by-side comparison of two US retailers' return policies with grades, per-axis winners (window, free returns, restocking fee, holiday extension) and an overall winner. Use for 'is it easier to return to X or Y' questions.",
    input: { merchant_a: merchantArg("first retailer"), merchant_b: merchantArg("second retailer") },
    handler: async ({ merchant_a, merchant_b }, { api }) => {
      const r = await api.get(`/return-policy/compare/${encodeURIComponent(merchant_a.trim())}/${encodeURIComponent(merchant_b.trim())}`);
      if (!r.ok) return fail(`Comparison failed (${r.status || "timeout"})`);
      if (!r.body || r.body.found === false) {
        return notFound(`"${(r.body && r.body.missing) || merchant_a}"`, "Use search_return_policies to find the retailer's name as Thrifle spells it.", S.url.returnPolicyHub());
      }
      return S.shapeReturnCompare(r.body);
    },
  },
  {
    name: "search_return_policies",
    title: "Search the return-policy database",
    description:
      "Find retailers in Thrifle's return-policy database by name fragment and/or category (e.g. 'Fashion', 'Electronics', 'Home'). Returns slim rows with the return window and a link. With no arguments it returns the category list and total count. Use it when get_return_policy says a retailer was not found, or to list retailers in a category.",
    input: {
      query: z.string().max(80).optional().describe("Name fragment, e.g. 'best' matches Best Buy"),
      category: z.string().max(60).optional().describe("Category name as shown on thrifle.com/return-policy"),
      limit: limitArg(10, 25),
    },
    handler: async ({ query, category, limit }, { api }) => {
      const r = await api.get("/return-policy", {}, { ttlMs: 10 * 60 * 1000 });
      if (!r.ok || !Array.isArray(r.body)) return fail(`Return-policy list unavailable (${r.status || "timeout"})`);
      const rows = r.body;
      const cats = {};
      for (const p of rows) if (p.category) cats[p.category] = (cats[p.category] || 0) + 1;
      if (!query && !category) {
        return {
          total_in_database: rows.length,
          categories: Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
          hint: "Pass `query` (name fragment) and/or `category` to get rows.",
          url: S.url.returnPolicyHub(),
        };
      }
      const catNorm = category ? compact(category) : null;
      const q = query ? String(query).trim().toLowerCase() : "";
      const qc = compact(q);
      const scored = [];
      for (const p of rows) {
        if (catNorm && compact(p.category) !== catNorm) continue;
        if (!q) {
          scored.push([1, p]);
          continue;
        }
        const names = [p.merchant_name, p.search_name, p.merchant_key].filter(Boolean).map((s) => String(s).toLowerCase());
        let score = 0;
        for (const n of names) {
          if (n === q || compact(n) === qc) score = Math.max(score, 100);
          else if (n.startsWith(q) || compact(n).startsWith(qc)) score = Math.max(score, 60);
          else if (n.includes(q) || (qc.length >= 3 && compact(n).includes(qc))) score = Math.max(score, 30);
        }
        if (score) scored.push([score, p]);
      }
      scored.sort((a, b) => b[0] - a[0] || String(a[1].merchant_name).localeCompare(String(b[1].merchant_name)));
      const n = limit || 10;
      return {
        query: query || null,
        category: category || null,
        total_matches: scored.length,
        results: scored.slice(0, n).map(([, p]) => S.shapeReturnRow(p)),
        total_in_database: rows.length,
        url: S.url.returnPolicyHub(),
      };
    },
  },

  // ── price match ───────────────────────────────────────────────────────
  {
    name: "get_price_match_policy",
    title: "Get a retailer's price-match policy",
    description:
      "Whether a US retailer matches competitors' prices (which competitors, proof required, exclusions, how to claim) and whether it offers a post-purchase price adjustment (window in days). Call for 'does X price match' or 'will X refund the difference if the price drops' questions.",
    input: { merchant: merchantArg() },
    handler: async ({ merchant }, { api }) => {
      const r = await api.get(`/price-match/${encodeURIComponent(merchant.trim())}`);
      if (!r.ok) return fail(`Price-match lookup failed (${r.status || "timeout"})`);
      if (!r.body || r.body.found === false) return notFound(`"${merchant}"`, "Thrifle's price-match database covers ~40 major US retailers; see the hub for the list.", S.url.priceMatchHub());
      return S.shapePriceMatch(r.body.policy || {});
    },
  },
  {
    name: "who_will_price_match",
    title: "Which retailers will match a given store's price",
    description:
      "Reverse lookup: the US retailers whose price-match policy explicitly names the given store as an accepted competitor. Optionally filter by the product category being bought so only stores that plausibly stock it are listed. Use for 'who will match Amazon's price on this' questions.",
    input: {
      merchant: merchantArg("the store whose price you found"),
      category: z.string().max(60).optional().describe("Optional deal category, e.g. 'Tech & Electronics', 'Home & Furniture', 'Toys & Hobbies'"),
    },
    handler: async ({ merchant, category }, { api }) => {
      const r = await api.get(`/price-match/matchers/${encodeURIComponent(merchant.trim())}`, { category });
      if (!r.ok || !r.body) return fail(`Matcher lookup failed (${r.status || "timeout"})`);
      return {
        merchant: r.body.merchant,
        category: r.body.deal_category || null,
        count: r.body.count || 0,
        matchers: (r.body.matchers || []).map((m) => ({ merchant: m.merchant_name, category: m.category, offers: m.offers, confidence: m.confidence, url: S.url.priceMatch(m.merchant_key) })),
        url: S.url.priceMatchHub(),
        cite: { source: "Thrifle Price Match Database", url: S.url.priceMatchHub() },
      };
    },
  },

  // ── discounts ─────────────────────────────────────────────────────────
  {
    name: "get_merchant_discounts",
    title: "Get a retailer's military and student discounts",
    description:
      "Verified military (active duty, veterans, reserve) and student discount programmes for a US retailer: value, eligibility, verification method (e.g. ID.me, SheerID), online vs in-store, stackability, exclusions, whether it is running right now, and the source URL. Call for 'does X have a military/student discount' questions.",
    input: { merchant: merchantArg() },
    handler: async ({ merchant }, { api }) => {
      const r = await api.get(`/discounts/${encodeURIComponent(keyish(merchant))}`);
      if (r.status === 404) return notFound(`"${merchant}"`, "Try search_discounts with a name fragment, or type=military / type=student to browse.", S.url.discountsHub());
      if (!r.ok || !r.body) return fail(`Discount lookup failed (${r.status || "timeout"})`);
      return S.shapeDiscount(r.body);
    },
  },
  {
    name: "search_discounts",
    title: "Search military and student discounts",
    description:
      "Browse Thrifle's discount database: filter by programme type (military, student, or both), retail category, and/or a name fragment. Returns slim rows with the discount value and a link per retailer.",
    input: {
      type: z.enum(["military", "student", "both"]).optional().describe("Only retailers with this programme"),
      category: z.string().max(60).optional().describe("Retail category, e.g. 'Apparel', 'Electronics'"),
      query: z.string().max(80).optional().describe("Name fragment, e.g. 'nike'"),
      limit: limitArg(15, 50),
    },
    handler: async ({ type, category, query, limit }, { api }) => {
      const r = await api.get("/discounts", { type, category, search: query ? esc(query.trim()) : undefined, limit: limit || 15, page: 1 });
      if (!r.ok || !r.body) return fail(`Discount search failed (${r.status || "timeout"})`);
      return {
        filters: { type: type || null, category: category || null, query: query || null },
        total_matches: r.body.count || 0,
        results: (r.body.merchants || []).map(S.shapeDiscountRow),
        url: type === "military" ? `${S.url.site}/military-discounts` : type === "student" ? `${S.url.site}/student-discounts` : S.url.discountsHub(),
      };
    },
  },

  // ── cancellation ──────────────────────────────────────────────────────
  {
    name: "get_cancellation_guide",
    title: "How to cancel a subscription or membership",
    description:
      "Step-by-step guide to cancelling a US subscription or membership: available channels (online, app, phone, in person), notice period, fees, refund after cancelling, retention tactics to expect, and an ease-of-cancellation grade. Coverage is still small; the response lists what is available when the merchant is not found.",
    input: { merchant: merchantArg("the service, e.g. 'Planet Fitness'") },
    handler: async ({ merchant }, { api }) => {
      const r = await api.get(`/cancellation/${encodeURIComponent(keyish(merchant))}`);
      if (r.status === 404) {
        const list = await api.get("/cancellation", {}, { ttlMs: 10 * 60 * 1000 });
        const available = Array.isArray(list.body) ? list.body.map((g) => ({ merchant: g.merchant_name, url: S.url.cancel(g.merchant_key) })) : [];
        return { ...notFound(`"${merchant}"`, "Thrifle's cancellation guides are a new, growing database.", S.url.cancelHub()), available };
      }
      if (!r.ok || !r.body) return fail(`Cancellation lookup failed (${r.status || "timeout"})`);
      return S.shapeCancellation(r.body);
    },
  },

  // ── birthday freebies ─────────────────────────────────────────────────
  {
    name: "get_birthday_freebie",
    title: "Get a brand's birthday freebie",
    description:
      "What a US restaurant or retailer gives away for your birthday, whether it is actually free or needs a purchase or prior spend, how to sign up and how far ahead, the validity window, ID requirements, and known gotchas. Call for 'what does X give you on your birthday' questions.",
    input: { merchant: merchantArg("brand, e.g. 'Starbucks', 'Sephora'") },
    handler: async ({ merchant }, { api }) => {
      const r = await api.get(`/birthday-freebies/${encodeURIComponent(keyish(merchant))}`);
      if (r.status === 404) return notFound(`"${merchant}"`, "Try search_birthday_freebies with a name fragment.", S.url.birthdayHub());
      if (!r.ok || !r.body) return fail(`Birthday-freebie lookup failed (${r.status || "timeout"})`);
      return S.shapeBirthday(r.body);
    },
  },
  {
    name: "search_birthday_freebies",
    title: "Search birthday freebies",
    description:
      "Browse verified birthday offers from US brands. Filters: actually_free (no purchase and no prior spend required), kids (child-eligible), no_signup, category (e.g. 'Restaurant', 'Beauty'), name fragment. Returns slim rows; use get_birthday_freebie for the full terms of one brand.",
    input: {
      query: z.string().max(80).optional(),
      category: z.string().max(60).optional(),
      actually_free: z.boolean().optional().describe("Only offers with no purchase or prior-spend requirement"),
      kids: z.boolean().optional(),
      no_signup: z.boolean().optional(),
      limit: limitArg(15, 50),
    },
    handler: async ({ query, category, actually_free, kids, no_signup, limit }, { api }) => {
      const r = await api.get("/birthday-freebies", {
        search: query ? query.trim() : undefined,
        category,
        actually_free: actually_free ? "true" : undefined,
        kids: kids ? "true" : undefined,
        no_signup: no_signup ? "true" : undefined,
        limit: limit || 15,
        page: 1,
      });
      if (!r.ok || !r.body) return fail(`Birthday-freebie search failed (${r.status || "timeout"})`);
      return { total_matches: r.body.count || 0, results: (r.body.merchants || []).map(S.shapeBirthdayRow), url: S.url.birthdayHub() };
    },
  },

  // ── deals ─────────────────────────────────────────────────────────────
  {
    name: "search_deals",
    title: "Search current deals",
    description:
      "Search Thrifle's curated US deals by product, brand or keyword. Returns live deals with price, list price, discount %, merchant, coupon code when there is one, the thrifle.com deal page, and a buy link. Expired deals are excluded unless include_expired is set. Use for 'is there a deal on X' or 'best price on X right now' questions.",
    input: {
      query: z.string().min(2).max(120).describe("Product, brand or keyword, e.g. 'AirPods Pro', 'Dyson', 'robot vacuum'"),
      sort: z.enum(["newest", "popular"]).optional().describe("Default newest"),
      include_expired: z.boolean().optional(),
      limit: limitArg(8, 20),
    },
    handler: async ({ query, sort, include_expired, limit }, { api }) => {
      const n = limit || 8;
      const r = await api.get("/deals", { searchText: esc(query.trim()), limit: Math.min(n * 3, 60), page: 1, sorted: sort === "popular" ? "views" : "mostRecent" });
      if (!r.ok || !r.body) return fail(`Deal search failed (${r.status || "timeout"})`);
      const all = Array.isArray(r.body.deals) ? r.body.deals : Array.isArray(r.body) ? r.body : [];
      const rows = all.map(S.shapeDealRow).filter((d) => include_expired || !d.expired).slice(0, n);
      return { query, count: rows.length, results: rows, url: `${S.url.site}/search/${encodeURIComponent(query.trim())}`, cite: { source: "Thrifle Deals", url: S.url.dealsHub() } };
    },
  },
  {
    name: "get_deal",
    title: "Get one deal's full details",
    description:
      "Everything Thrifle knows about one deal, by its thrifle.com URL or slug: price and list price, merchant, coupon, why it's great, the editorial verdict, the price-history verdict for Amazon items, FAQ, and the buy link. Use after search_deals when the shopper wants detail on one item.",
    input: { deal: z.string().min(3).max(300).describe("thrifle.com deal URL or the slug at the end of it") },
    handler: async ({ deal }, { api }) => {
      const slug = slugFromInput(deal);
      if (!slug) return fail("Could not read a deal slug from the input.");
      const r = await api.get(`/deals/${encodeURIComponent(slug)}`);
      if (r.status === 404) return notFound(`Deal "${slug}"`, "Use search_deals to find current deals.", S.url.dealsHub());
      if (!r.ok || !r.body) return fail(`Deal lookup failed (${r.status || "timeout"})`);
      return S.shapeDealDetail(r.body);
    },
  },
  {
    name: "get_deal_of_the_day",
    title: "Get today's featured deal",
    description: "Thrifle's editor-picked deal of the day with price, merchant and buy link. Cheap to call; returns found:false when none is set.",
    input: {},
    handler: async (_args, { api }) => {
      const r = await api.get("/deals/deal-of-the-day", {}, { ttlMs: 5 * 60 * 1000 });
      if (r.status === 404) return { found: false, message: "No deal of the day is set right now.", url: S.url.dealsHub() };
      if (!r.ok || !r.body) return fail(`Deal-of-the-day lookup failed (${r.status || "timeout"})`);
      return S.shapeDealDetail(r.body);
    },
  },
  {
    name: "get_store_deals",
    title: "Get current deals at a retailer",
    description:
      "A retailer's store page on Thrifle: how many live deals it has, the most recent ones with prices and buy links, and its military/student discount summary when known. Use for 'what deals does Costco have right now' questions.",
    input: { merchant: merchantArg(), limit: limitArg(8, 8) },
    handler: async ({ merchant, limit }, { api }) => {
      const slug = storeSlug(merchant.trim());
      const r = await api.get(`/merchants/${encodeURIComponent(slug)}`);
      if (r.status === 404) return notFound(`Store "${merchant}"`, "Thrifle store pages exist for merchants with at least one deal or coupon; try search_deals with the retailer name instead.", S.url.storesHub());
      if (!r.ok || !r.body || !r.body.merchant) return fail(`Store lookup failed (${r.status || "timeout"})`);
      const m = r.body.merchant;
      const out = {
        found: true,
        merchant: m.name,
        website: m.website || null,
        live_deal_count: m.dealCount || 0,
        url: S.url.store(m.name),
        // The store route's sample projection omits `merchant` (it is implied
        // by the page); fill it so each row stands on its own in a chat.
        recent_deals: (r.body.recentDeals || []).slice(0, limit || 8).map((d) => S.shapeDealRow({ ...d, merchant: d.merchant || m.name })),
      };
      if (m.discountIntel) {
        out.discounts = {
          military: m.discountIntel.military && m.discountIntel.military.has_discount ? m.discountIntel.military.discount_value || "yes" : null,
          student: m.discountIntel.student && m.discountIntel.student.has_discount ? m.discountIntel.student.discount_value || "yes" : null,
          url: S.url.discount(m.discountIntel.merchant_key),
        };
      }
      out.cite = { source: "Thrifle Deals", url: out.url };
      return out;
    },
  },

  // ── price predict ─────────────────────────────────────────────────────
  {
    name: "predict_amazon_price",
    title: "Buy now or wait? Verdict for an Amazon product",
    description:
      "Thrifle's Price Predict verdict for an Amazon product (ASIN or amazon.com URL): BUY / HOLD / WAIT with a buy score, current vs typical price, all-time low, 30/90/365-day averages, probability of a drop in the next 30/60 days, the expected low and timing basis. Reads Thrifle's tracked-price database (US and major international Amazon stores); untracked products return found:false with a link to run a live check on the site.",
    input: { asin_or_url: z.string().min(5).max(500).describe("10-character ASIN (e.g. B0CHX3QBCH) or any Amazon product URL") },
    handler: async ({ asin_or_url }, { api }) => {
      const r = await api.get("/price-predict", { asin: asin_or_url.trim(), dbOnly: 1 });
      const b = r.body || {};
      if (r.status === 400 || r.status === 404) return { found: false, message: b.msg || "Could not read an ASIN from the input.", url: S.url.pricePredict() };
      if (!r.ok) return fail(`Price Predict lookup failed (${r.status || "timeout"})`, { message: b.msg });
      if (b.tracked === false) {
        return { found: false, asin: b.asin, message: "This product is not in Thrifle's tracked-price database yet. Opening the URL runs a live check.", url: S.url.pricePredict(b.asin) };
      }
      if (b.gated) return { found: false, asin: b.asin, message: "The verdict for this product is available on the site.", url: S.url.pricePredict(b.asin) };
      if (!b.prediction) return fail("Unexpected Price Predict response.");
      return S.shapePrediction(b);
    },
  },

  // ── blog ──────────────────────────────────────────────────────────────
  {
    name: "search_blog",
    title: "Search Thrifle's articles and data studies",
    description:
      "Find Thrifle articles by keyword: original data studies (e.g. what actually dropped on Black Friday, Prime Day fact-checks), buying guides, and the Money section's credit and BNPL explainers. Returns title, one-line summary, date, author and URL. Use get_blog_post to read one.",
    input: {
      query: z.string().min(2).max(120),
      section: z.enum(["all", "shopping", "money"]).optional().describe("Default all"),
      limit: limitArg(8, 20),
    },
    handler: async ({ query, section, limit }, { api }) => {
      const n = limit || 8;
      const q = esc(query.trim());
      const want = section === "money" ? ["finance"] : section === "shopping" ? [undefined] : [undefined, "finance"];
      const results = [];
      for (const vertical of want) {
        const r = await api.get("/blog/posts/get-all", { searchText: q, limit: n, pageNumber: 1, vertical });
        if (r.ok && r.body && Array.isArray(r.body.posts)) results.push(...r.body.posts.map(S.shapePostRow));
      }
      results.sort((a, b) => String(b.published || "").localeCompare(String(a.published || "")));
      return { query, count: Math.min(results.length, n), results: results.slice(0, n), url: S.url.blogHub() };
    },
  },
  {
    name: "get_blog_post",
    title: "Read one Thrifle article",
    description:
      "The full text of one Thrifle article by URL or slug (HTML stripped, long posts truncated at ~20,000 characters), plus its FAQ, author, date and URL for citation.",
    input: { post: z.string().min(3).max(300).describe("thrifle.com article URL or its slug") },
    handler: async ({ post }, { api }) => {
      const slug = slugFromInput(post);
      if (!slug) return fail("Could not read an article slug from the input.");
      const r = await api.get(`/blog/posts/by-slug/${encodeURIComponent(slug)}`);
      if (r.status === 404) return notFound(`Article "${slug}"`, "Use search_blog to find articles.", S.url.blogHub());
      if (!r.ok || !r.body) return fail(`Article lookup failed (${r.status || "timeout"})`);
      return S.shapePostFull(r.body);
    },
  },

  // ── credit cards / money ──────────────────────────────────────────────
  {
    name: "search_credit_cards",
    title: "Search the credit-card database",
    description:
      "Browse Thrifle's US credit-card database (store and co-branded cards first): filter by issuer, retailer, store cards only, or cards that use deferred-interest promotional financing. Rows carry purchase APR range, annual fee, financing type, data confidence and the verification date. Numbers come from issuer pricing pages, never roundups.",
    input: {
      query: z.string().max(80).optional().describe("Name fragment matched against card name, issuer or partner retailer"),
      issuer: z.string().max(80).optional().describe("Exact issuer name, e.g. 'Synchrony Bank', 'Citi Retail Services'"),
      merchant: z.string().max(80).optional().describe("Partner retailer, e.g. 'Amazon', 'Lowe's'"),
      store_cards_only: z.boolean().optional(),
      deferred_interest_only: z.boolean().optional().describe("Only cards whose promo financing is deferred interest (retroactive interest if not paid in full)"),
      limit: limitArg(20, 60),
    },
    handler: async ({ query, issuer, merchant, store_cards_only, deferred_interest_only, limit }, { api }) => {
      const r = await api.get("/credit-cards", { issuer, merchant_key: merchant ? merchantSlug(merchant.trim()) : undefined, store: store_cards_only ? "true" : undefined }, { ttlMs: 10 * 60 * 1000 });
      if (!r.ok || !r.body) return fail(`Card search failed (${r.status || "timeout"})`);
      let cards = Array.isArray(r.body.cards) ? r.body.cards : [];
      if (deferred_interest_only) cards = cards.filter((c) => c.financing && c.financing.deferred_interest === true);
      if (query) {
        const q = query.trim().toLowerCase();
        cards = cards.filter((c) => [c.name, c.issuer, c.co_brand_partner, c.merchant_key].some((s) => s && String(s).toLowerCase().includes(q)));
      }
      const n = limit || 20;
      return {
        total_matches: cards.length,
        results: cards.slice(0, n).map(S.shapeCardRow),
        note: "confidence 'low' means the collector could not settle the numbers against the issuer's pricing page — do not quote those APRs as fact.",
        url: S.url.cardsHub(),
        cite: { source: "Thrifle Credit Card Database", url: S.url.cardsHub() },
      };
    },
  },
  {
    name: "get_credit_card",
    title: "Get one credit card's full terms",
    description:
      "Full record for one card by its card_key (from search_credit_cards): APR tiers, intro and penalty APRs, fees, promotional financing terms with the issuer's own fine-print quote, rewards, perks, welcome offer, and provenance (pricing-terms URL, verification date, confidence). Store cards link to the partner retailer's return policy.",
    input: { card_key: z.string().min(2).max(120).describe("card_key from search_credit_cards, e.g. 'amazon-store-card'") },
    handler: async ({ card_key }, { api }) => {
      const r = await api.get(`/credit-cards/${encodeURIComponent(card_key.trim().toLowerCase())}`);
      if (r.status === 404) return notFound(`Card "${card_key}"`, "Use search_credit_cards to find the card_key.", S.url.cardsHub());
      if (!r.ok || !r.body || !r.body.card) return fail(`Card lookup failed (${r.status || "timeout"})`);
      return S.shapeCard(r.body.card);
    },
  },
  {
    name: "get_store_credit_cards",
    title: "Get a retailer's store credit cards",
    description:
      "The store and co-branded credit cards a US retailer offers, with APR, annual fee, whether promotional financing is deferred interest, and links to each card's full terms, the retailer's store-card page and its return policy. Call for 'is the X store card worth it' or 'does X card have deferred interest' questions.",
    input: { merchant: merchantArg("e.g. 'Lowe's', 'Amazon', 'Best Buy'") },
    handler: async ({ merchant }, { api }) => {
      const key = merchantSlug(merchant.trim());
      const r = await api.get("/credit-cards", { merchant_key: key }, { ttlMs: 10 * 60 * 1000 });
      if (!r.ok || !r.body) return fail(`Card lookup failed (${r.status || "timeout"})`);
      const cards = Array.isArray(r.body.cards) ? r.body.cards : [];
      if (!cards.length) return notFound(`A store card for "${merchant}"`, "Use search_credit_cards with store_cards_only to browse the retailers covered.", S.url.storeCardsHub());
      return {
        found: true,
        merchant: cards[0].co_brand_partner || merchant,
        url: S.url.storeCard(key),
        return_policy_url: S.url.returnPolicy(key),
        deferred_interest_calculator: S.url.deferredInterestCalc(),
        cards: cards.map(S.shapeCardRow),
        cite: { source: "Thrifle Credit Card Database", url: S.url.storeCard(key) },
      };
    },
  },
  {
    name: "get_money_monitor",
    title: "US economic indicators and rates",
    description:
      "Current US macro numbers from Thrifle's Money Monitor: GDP growth, personal saving rate, average credit-card APR, revolving and total consumer credit, the federal debt, and mortgage / fed funds / 10-year Treasury rates, each with the previous reading and year-ago value. Sourced from FRED and the U.S. Treasury; refreshed daily.",
    input: {},
    handler: async (_args, { api }) => {
      const [fin, rates] = await Promise.all([api.get("/finance/indicators", {}, { ttlMs: 60 * 60 * 1000 }), api.get("/intelligence/rates", {}, { ttlMs: 60 * 60 * 1000 })]);
      if (!fin.ok && !rates.ok) return fail("Economic data unavailable right now.");
      return S.shapeIndicators(fin.ok ? fin.body : null, rates.ok ? rates.body : null);
    },
  },
  {
    name: "get_price_pulse",
    title: "US consumer prices: CPI by category and gas",
    description:
      "Latest US Consumer Price Index by spending category (headline, food, energy, shelter, apparel, etc.) with month-over-month and year-over-year change, plus average gas prices by grade with week-ago and year-ago comparisons. Sourced from BLS and EIA.",
    input: {},
    handler: async (_args, { api }) => {
      const [cpi, gas] = await Promise.all([api.get("/intelligence/cpi", {}, { ttlMs: 60 * 60 * 1000 }), api.get("/intelligence/gas", {}, { ttlMs: 60 * 60 * 1000 })]);
      if (!cpi.ok && !gas.ok) return fail("Price data unavailable right now.");
      return S.shapePricePulse(cpi.ok ? cpi.body : null, gas.ok ? gas.body : null);
    },
  },
  {
    name: "check_product_recalls",
    title: "Check a product for US safety recalls",
    description:
      "Matches a product name (and optional brand) against recent U.S. CPSC recalls using a strict matcher tuned for zero false positives. Returns matching recalls with hazard and remedy, or an empty list. Useful before recommending a product.",
    input: {
      product: z.string().min(3).max(200).describe("Product title as sold, e.g. 'Peloton Tread+ treadmill'"),
      brand: z.string().max(80).optional(),
    },
    handler: async ({ product, brand }, { api }) => {
      const r = await api.get("/intelligence/recalls/check", { product: product.trim(), brand });
      if (!r.ok || !r.body) return fail(`Recall check failed (${r.status || "timeout"})`);
      return {
        product: product.trim(),
        brand: brand || null,
        match_count: (r.body.matches || []).length,
        matches: (r.body.matches || []).slice(0, 5),
        source: "U.S. Consumer Product Safety Commission via Thrifle",
      };
    },
  },

  // ── about ─────────────────────────────────────────────────────────────
  {
    name: "about_thrifle",
    title: "About Thrifle and this server",
    description: "What Thrifle is, what each database covers and how big it is, how to cite it, and which tool answers which kind of question.",
    input: {},
    handler: async (_args, { api }) => {
      const r = await api.get("/about", {}, { ttlMs: 60 * 60 * 1000 });
      const about = r.ok && r.body ? r.body : {};
      return {
        name: "Thrifle",
        url: S.url.site,
        description: about.description || "US deal-discovery and shopping-intelligence platform.",
        databases: about.capabilities || null,
        mcp_endpoint: ENDPOINT,
        tools: TOOLS.map((t) => ({ name: t.name, use_for: t.title })),
        citation: "Link to the `url` returned with each result. Data is verified by Thrifle's editors and refreshed on a schedule; each record carries its own last_verified date.",
        contact: about.contact || "hello@thrifle.com",
        licensing: `${S.url.site}/data-licensing`,
      };
    },
  },
];

// ── registration ────────────────────────────────────────────────────────────
function summarizeArgs(args) {
  try {
    const s = JSON.stringify(args || {});
    return s.length > 160 ? s.slice(0, 157) + "…" : s;
  } catch (_) {
    return "";
  }
}

/**
 * Register every tool on an McpServer. `ctx` = { api, req } — a fresh loopback
 * client per request (so the port is right) and the inbound request for logs.
 */
function registerTools(server, ctx) {
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.input || {},
        annotations: { ...RO, title: t.title },
      },
      async (args) => {
        const t0 = Date.now();
        let ok = true;
        try {
          const out = await t.handler(args || {}, ctx);
          if (out && out.isError) ok = false;
          return out && out.content ? out : text(out);
        } catch (e) {
          ok = false;
          console.error(`[mcp] ${t.name} threw:`, e && e.message);
          return fail(`Thrifle tool error: ${e && e.message ? e.message : "unknown"}`);
        } finally {
          const req = ctx.req;
          console.log(
            JSON.stringify({
              tag: "mcp",
              tool: t.name,
              ok,
              ms: Date.now() - t0,
              ip: req ? clientIp(req) : null,
              keyed: !!(req && presentedKey(req) && process.env.MCP_API_KEYS),
              ua: req ? String(req.headers["user-agent"] || "").slice(0, 80) : null,
              args: summarizeArgs(args),
            })
          );
        }
      }
    );
  }
}

module.exports = { TOOLS, SERVER_INFO, INSTRUCTIONS, ENDPOINT, registerTools, _internal: { text, fail, notFound, esc, keyish, slugFromInput, compact } };
