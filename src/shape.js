"use strict";
/**
 * Pure shapers: public API payload in → compact, citation-ready object out.
 *
 * Every shaper attaches the canonical thrifle.com URL for the thing it
 * describes, built the way THE LINK RULE says (utils/merchantSlug.js for the
 * return-policy / price-match / discounts space, utils/merchantResolver.js
 * merchantSlug for the stores space — never a hand-rolled slugify). The
 * assistant on the other end is expected to cite that URL; a tool answer with
 * no link is a citation we never get.
 *
 * Shapers drop what the site keeps for itself (Pinterest bookkeeping, Mongo
 * ids, admin audit trails, 600-point histories) and keep the facts. No DB, no
 * network — everything here is unit-testable from fixtures.
 */

const { merchantSlug } = require("./merchant-slug");
const { merchantSlug: storeSlug } = require("./store-slug");
const { isDeadDeal } = require("./deal-lifecycle");

const SITE = process.env.SITE_URL || "https://thrifle.com";

// ── URLs ────────────────────────────────────────────────────────────────────
const url = {
  site: SITE,
  returnPolicyHub: () => `${SITE}/return-policy`,
  returnPolicy: (key) => `${SITE}/return-policy/${merchantSlug(key)}`,
  returnCompare: (a, b) => `${SITE}/return-policy/compare/${merchantSlug(a)}-vs-${merchantSlug(b)}`,
  priceMatchHub: () => `${SITE}/price-match`,
  priceMatch: (key) => `${SITE}/price-match/${encodeURIComponent(String(key || "").toLowerCase())}`,
  discountsHub: () => `${SITE}/discounts`,
  // Public discount URLs are hyphenated; merchant_key is stored snake_case.
  discount: (key) => `${SITE}/discounts/${encodeURIComponent(String(key || "").toLowerCase().replace(/_/g, "-"))}`,
  cancelHub: () => `${SITE}/how-to-cancel`,
  cancel: (key) => `${SITE}/how-to-cancel/${encodeURIComponent(String(key || "").toLowerCase())}`,
  birthdayHub: () => `${SITE}/birthday-freebies`,
  dealsHub: () => `${SITE}/deals`,
  deal: (deal) => {
    if (!deal || !deal.slug) return null;
    const cat = String(deal.category_name || "others")
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-");
    return `${SITE}/deals/${cat}/${deal.slug}`;
  },
  store: (name) => `${SITE}/stores/${storeSlug(name)}`,
  storesHub: () => `${SITE}/stores`,
  pricePredict: (asin) => `${SITE}/price-predict${asin ? `?asin=${encodeURIComponent(asin)}` : ""}`,
  blog: (post) => (post && post.vertical === "finance" ? `${SITE}/money/blog/${post.slug}` : `${SITE}/blog/${post.slug}`),
  blogHub: () => `${SITE}/blog`,
  card: (key) => `${SITE}/money/cards/${encodeURIComponent(String(key || "").toLowerCase())}`,
  cardsHub: () => `${SITE}/money/cards`,
  storeCard: (merchantKey) => `${SITE}/money/store-cards/${encodeURIComponent(String(merchantKey || "").toLowerCase())}`,
  storeCardsHub: () => `${SITE}/money/store-cards`,
  money: () => `${SITE}/money`,
  intelligence: () => `${SITE}/intelligence`,
  deferredInterestCalc: () => `${SITE}/money/calculators/deferred-interest`,
};

// Every thrifle.com URL a tool hands back is tagged so assistant-driven clicks
// show up in GA4 as their own segment (utm_source=thrifle_mcp). Tool results are
// private to the chat, so this tag is the ONLY way a click from Claude/ChatGPT
// ever becomes visible to us. The canonical tag on every page keeps SEO clean.
// MCP_UTM=off disables it (fixtures and the standalone repo run with it on).
const UTM = "utm_source=thrifle_mcp&utm_medium=mcp";
function withUtm(u) {
  if (!u || typeof u !== "string" || process.env.MCP_UTM === "off") return u;
  if (!u.startsWith(SITE)) return u;
  return u + (u.includes("?") ? "&" : "?") + UTM;
}
for (const k of Object.keys(url)) {
  if (k === "site" || typeof url[k] !== "function") continue;
  const build = url[k];
  url[k] = (...args) => withUtm(build(...args));
}

// ── helpers ─────────────────────────────────────────────────────────────────
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…" };

function htmlToText(html, max = 20000) {
  if (!html) return "";
  let s = String(html)
    .replace(/\r/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/table|\/section|\/article|\/details|\/summary|\/blockquote)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (m, e) => (ENTITIES[e] !== undefined ? ENTITIES[e] : /^#\d+$/.test(e) ? String.fromCodePoint(Number(e.slice(1))) : m))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, "") + " …[truncated]";
  return s;
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function pct(price, retail) {
  const p = num(price);
  const r = num(retail);
  if (p === null || r === null || r <= 0 || p >= r) return null;
  return Math.round(((r - p) / r) * 100);
}

function pick(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") out[k] = obj[k];
  return out;
}

function stripHistory(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const { history, ...rest } = obj;
  return rest;
}

function short(s, n) {
  if (!s) return null;
  const t = String(s).trim();
  return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, "") + "…" : t;
}

// ── return policies ─────────────────────────────────────────────────────────
function shapeReturnPolicy(body) {
  const p = body.policy || {};
  const g = body.grade || null;
  const c = body.context || {};
  const link = url.returnPolicy(p.merchant_key);
  const out = {
    found: true,
    merchant: p.merchant_name,
    category: p.category || null,
    url: link,
    status: p.status || "open",
  };
  if (p.status === "closed" && p.closed_note) out.closed_note = p.closed_note;
  if (p.returns_applicable === false) {
    out.returns_applicable = false;
    out.returns_na_reason = p.returns_na_reason || null;
  }
  out.grade = g
    ? g.applicable === false
      ? { letter: "N/A", label: g.label || "Returns don't apply", applicable: false }
      : { letter: g.grade, label: g.label, score: g.score, max: g.max, applicable: true }
    : null;
  Object.assign(
    out,
    pick(p, [
      "return_window",
      "return_window_days",
      "free_returns",
      "return_shipping_cost",
      "restocking_fee",
      "holiday_extension",
      "holiday_purchase_start",
      "holiday_purchase_end",
      "holiday_return_deadline",
      "non_returnable",
      "time_bomb_items",
      "thrifle_tip",
    ])
  );
  if (out.return_window_days >= 3650) out.return_window_days = "no deadline";
  if (g && g.electronics && g.electronics.applied) {
    out.electronics_exception = pick(g.electronics, ["days", "label", "note", "restocking_fee", "source_url", "general_window"]);
  }
  if (Array.isArray(p.category_exceptions) && p.category_exceptions.length) {
    out.category_exceptions = p.category_exceptions
      .slice(0, 10)
      .map((e) => pick(e, ["type", "category", "label", "days", "window", "non_returnable", "restocking_fee", "note"]));
  }
  if (c.product_exception) out.product_exception = c.product_exception;
  out.today = pick(c, ["verdict", "primary_message", "secondary_message", "is_holiday_active", "effective_deadline", "days_to_return"]);
  if (body.category_stats) {
    const s = body.category_stats;
    out.vs_category = {
      category: s.category,
      longer_than_pct_of_peers: s.pct_longer_than,
      peers: s.peers,
      category_median_window_days: s.median_window_days,
    };
  }
  if (Array.isArray(body.rivals) && body.rivals.length) {
    out.top_rated_alternatives = body.rivals.map((r) => ({
      merchant: r.merchant_name,
      grade: r.grade,
      return_window: r.return_window,
      url: url.returnPolicy(r.merchant_key),
    }));
  }
  if (p.policy_url) {
    out.policy_url = p.policy_url;
    if (p.policy_url_is_affiliate) out.policy_url_note = "first-party redirect to the retailer's policy page";
  }
  if (body.what_they_sell) out.what_they_sell = short(body.what_they_sell, 200);
  if (Array.isArray(body.faqs) && body.faqs.length) {
    out.faq_sample = body.faqs.slice(0, 3).map((f) => ({ q: f.question, a: short(f.answer, 400) }));
  }
  out.last_verified = p.last_verified || null;
  out.cite = { source: "Thrifle Return Policy Database", url: link };
  return out;
}

function shapeReturnCompare(body) {
  const a = body.a || {};
  const b = body.b || {};
  const cmp = body.comparison || {};
  const side = (s) => {
    const p = s.policy || {};
    const g = s.grade || {};
    return {
      merchant: p.merchant_name,
      grade: g.applicable === false ? "N/A" : g.grade,
      score: g.score,
      ...pick(p, ["return_window", "free_returns", "restocking_fee", "holiday_extension", "return_shipping_cost"]),
      url: url.returnPolicy(p.merchant_key),
    };
  };
  const A = side(a);
  const B = side(b);
  const winner = (w) => (w === "a" ? A.merchant : w === "b" ? B.merchant : "tie");
  const axes = {};
  for (const [k, v] of Object.entries(cmp.axis_winners_v2 || cmp.axis_winners || {})) axes[k] = winner(v);
  const link = url.returnCompare((a.policy || {}).merchant_key, (b.policy || {}).merchant_key);
  return {
    found: true,
    a: A,
    b: B,
    comparable: cmp.comparable !== false,
    overall_winner: winner(cmp.overall_winner_v2 || cmp.overall_winner),
    axis_winners: axes,
    url: link,
    cite: { source: "Thrifle Return Policy Database", url: link },
  };
}

function shapeReturnRow(r) {
  return {
    merchant: r.search_name || r.merchant_name,
    category: r.category || null,
    return_window: r.return_window || null,
    free_returns: r.free_returns || null,
    status: r.status || "open",
    url: url.returnPolicy(r.merchant_key),
  };
}

// ── price match ─────────────────────────────────────────────────────────────
function shapePriceMatch(p) {
  const link = url.priceMatch(p.merchant_key);
  return {
    found: true,
    merchant: p.merchant_name,
    category: p.category || null,
    url: link,
    price_match: pick(p.competitor_match || {}, ["offers", "competitors_accepted", "in_store_vs_online", "request_window", "proof_required", "key_exclusions", "how_to_claim"]),
    price_adjustment: pick(p.price_adjustment || {}, ["offers", "window_days", "in_store_vs_online", "key_exclusions", "how_to_claim"]),
    confidence: p.confidence || null,
    notes: p.notes || null,
    official_source_url: p.official_source_url || null,
    policy_change_date: p.policy_change_date || null,
    last_verified: p.last_verified || null,
    cite: { source: "Thrifle Price Match Database", url: link },
  };
}

// ── discounts ───────────────────────────────────────────────────────────────
function shapeDiscountProgram(d) {
  if (!d) return null;
  const out = pick(d, ["has_discount", "discount_value", "discount_description", "eligibility", "verification", "online", "in_store", "stackable", "notes", "exclusions", "source_url"]);
  if (d.status) out.status = pick(d.status, ["state", "label", "headline", "claimable", "starts_at", "ends_at", "days_left", "annual", "certain"]);
  if (Array.isArray(d.windows) && d.windows.length) out.windows = d.windows.slice(0, 5).map((w) => pick(w, ["label", "starts_at", "ends_at", "annual", "approximate"]));
  return out;
}
function shapeDiscount(d) {
  const link = url.discount(d.merchant_key);
  return {
    found: true,
    merchant: d.merchant_name,
    category: d.category || null,
    website: d.website || null,
    url: link,
    military: shapeDiscountProgram(d.military),
    student: shapeDiscountProgram(d.student),
    last_verified: d.last_verified || null,
    cite: { source: "Thrifle Discount Database", url: link },
  };
}
function shapeDiscountRow(d) {
  return {
    merchant: d.merchant_name,
    category: d.category || null,
    military: d.military && d.military.has_discount ? d.military.discount_value || "yes" : null,
    student: d.student && d.student.has_discount ? d.student.discount_value || "yes" : null,
    url: url.discount(d.merchant_key),
  };
}

// ── cancellation ────────────────────────────────────────────────────────────
function shapeCancellation(g) {
  const link = url.cancel(g.merchant_key);
  const out = {
    found: true,
    merchant: g.merchant_name,
    service: g.service_name || null,
    category: g.category || null,
    url: link,
    ease_grade: g.grade ? pick(g.grade, ["grade", "label", "score", "max"]) : null,
    ...pick(g, ["cancel_anytime", "notice_period_days", "cancellation_fee", "fee_details", "notice_details", "written_confirmation", "refund_after_cancel", "proof_of_cancellation", "retention_tactics", "thrifle_tip", "policy_url", "status", "closed_note"]),
    methods: (g.methods || []).map((m) => pick(m, ["method", "steps", "url", "phone", "notes", "limited"])),
    last_verified: g.last_verified || null,
    cite: { source: "Thrifle Cancellation Guides", url: link },
  };
  return out;
}

// ── birthday freebies ───────────────────────────────────────────────────────
function shapeBirthday(b) {
  return {
    found: true,
    merchant: b.merchant_name,
    category: b.category || null,
    url: url.birthdayHub(),
    ...pick(b, ["has_offer", "offer", "offer_type", "offer_value_usd", "how_to_get", "signup_url", "signup_lead_days", "valid_window", "valid_window_note", "redemption", "purchase_required", "purchase_note", "id_required", "kid_eligible", "no_signup", "tiered", "tier_note", "gotchas", "status", "status_note", "source_url", "last_verified"]),
    cite: { source: "Thrifle Birthday Freebies Database", url: url.birthdayHub() },
  };
}
function shapeBirthdayRow(b) {
  return pick(
    { merchant: b.merchant_name, category: b.category, offer: b.offer, offer_type: b.offer_type, offer_value_usd: b.offer_value_usd, purchase_required: b.purchase_required, status: b.status },
    ["merchant", "category", "offer", "offer_type", "offer_value_usd", "purchase_required", "status"]
  );
}

// ── deals ───────────────────────────────────────────────────────────────────
function shapeDealRow(d) {
  const out = {
    title: d.title,
    price: num(d.price),
    retail_price: num(d.retail_price),
    discount_pct: pct(d.price, d.retail_price),
    merchant: d.merchant || null,
    brand: d.brand || null,
    category: d.category_name || null,
    coupon: d.coupon || null,
    posted: d.date || null,
    evergreen: d.evergreen === true,
    expired: isDeadDeal(d),
    url: url.deal(d),
    buy_url: d.link || null,
  };
  if (d.link_is_affiliate) out.buy_url_note = "affiliate redirect via thrifle.com";
  if (Array.isArray(d.images) && d.images[0] && d.images[0].imageUrl) out.image = d.images[0].imageUrl;
  return out;
}

function shapeDealDetail(d) {
  const out = shapeDealRow(d);
  out.found = true;
  if (d.excerpt) out.excerpt = d.excerpt;
  if (d.why_its_great && (d.why_its_great.summary || (d.why_its_great.bullets || []).length)) {
    out.why_its_great = pick(d.why_its_great, ["summary", "bullets"]);
  }
  if (d.editorial_verdict && d.editorial_verdict.published === true) {
    out.editorial_verdict = pick(d.editorial_verdict, ["summary", "pros", "cons", "generated_at"]);
  }
  if (d.verdict && typeof d.verdict === "object") {
    const { chart, history, priceHistory, ...v } = d.verdict;
    out.price_verdict = v;
  }
  if (d.description) out.description = htmlToText(d.description, 1500);
  if (Array.isArray(d.faqs) && d.faqs.length) out.faq = d.faqs.slice(0, 5).map((f) => ({ q: f.question, a: short(f.answer, 300) }));
  if (d.amazon_meta && d.amazon_meta.asin) out.asin = d.amazon_meta.asin;
  if (d.dead === true) out.expired = true;
  out.cite = { source: "Thrifle Deals", url: out.url };
  return out;
}

// ── price predict ───────────────────────────────────────────────────────────
function shapePrediction(body) {
  const p = body.product || {};
  const v = body.prediction || {};
  const link = url.pricePredict(p.asin);
  const out = {
    found: true,
    asin: p.asin,
    title: p.title || null,
    brand: p.brand || null,
    marketplace: p.marketplace || "US",
    url: link,
    verdict: {
      call: v.verdict,
      label: v.buyLabel || null,
      buy_score: v.buyScore,
      confidence: v.confidence,
      confidence_pct: v.confidencePct,
      note: v.confidenceNote || null,
      as_of: v.asOf || null,
    },
    price: {
      current: p.currentPrice ?? v.currentPrice ?? null,
      currency: p.currency || "USD",
      is_live: p.priceIsLive === true,
      typical: p.typicalPrice ?? v.typicalPrice ?? null,
      vs_typical_pct: v.vsAvgPct ?? null,
      percentile_of_history: v.pricePercentile ?? null,
      avg_30d: p.avg30 ?? null,
      avg_90d: p.avg90 ?? null,
      avg_365d: p.avg365 ?? null,
      all_time_low: p.allTimeLow ?? v.allTimeLow ?? null,
      all_time_low_date: p.allTimeLowDate || null,
      all_time_high: p.allTimeHigh ?? null,
      retail: p.retailPrice ?? null,
      coupon: p.coupon || null,
    },
    forecast: pick(v, ["expectedLow", "expectedLowRange", "expectedDropInDays", "dropProb30", "dropProb60", "typicalDropDepthPct", "timingBasis", "seasonalHeadsUp"]),
    history: pick(p, ["historyPoints", "historySpanDays", "dataDepthText", "dropFrequencyPerYear", "avgDropDepthPct", "dealScore", "isDealNow"]),
    reasons: Array.isArray(v.reasons) ? v.reasons.slice(0, 6) : [],
    caveat: "Snapshot from Thrifle's price database, not a live Amazon fetch — confirm the current price on the product page before buying.",
    cite: { source: "Thrifle Price Predict", url: link },
  };
  return out;
}

// ── blog ────────────────────────────────────────────────────────────────────
function shapePostRow(p) {
  return {
    title: p.title,
    summary: p.geo_snippet || p.meta_description || p.description || null,
    section: p.vertical === "finance" ? "money" : "shopping",
    category: p.category_name || null,
    published: p.published_at || p.createdAt || null,
    author: p.posted_by || null,
    url: url.blog(p),
  };
}
function shapePostFull(p, maxChars = 20000) {
  const out = shapePostRow(p);
  out.found = true;
  out.text = htmlToText(p.content, maxChars);
  if (Array.isArray(p.faq_items) && p.faq_items.length) out.faq = p.faq_items.slice(0, 8).map((f) => ({ q: f.question, a: f.answer }));
  out.cite = { source: "Thrifle", url: out.url };
  return out;
}

// ── credit cards ────────────────────────────────────────────────────────────
function shapeCardRow(c) {
  const f = c.financing || {};
  const prov = c.provenance || {};
  return {
    name: c.name,
    card_key: c.card_key,
    issuer: c.issuer || null,
    network: c.network || null,
    card_type: c.card_type || null,
    store_card: c.is_store_card === true,
    merchant: c.co_brand_partner || null,
    merchant_key: c.merchant_key || null,
    purchase_apr: c.purchase_apr ? pick(c.purchase_apr, ["min", "max", "variable"]) : null,
    annual_fee: c.annual_fee ?? null,
    deferred_interest: f.deferred_interest === true,
    promotional_financing: f.offers_promotional_financing === true,
    confidence: prov.confidence || null,
    rates_verified_at: prov.rates_verified_at || null,
    url: url.card(c.card_key),
  };
}
const CARD_INTERNAL = new Set(["_id", "__v", "collection_notes", "batch", "schema_version", "createdAt", "updatedAt"]);
function shapeCard(c) {
  const out = { found: true };
  for (const [k, v] of Object.entries(c)) if (!CARD_INTERNAL.has(k)) out[k] = v;
  if (out.provenance && typeof out.provenance === "object") {
    const { collection_notes, collected_by, ...prov } = out.provenance;
    out.provenance = prov;
  }
  out.url = url.card(c.card_key);
  if (c.merchant_key) {
    out.store_card_page = url.storeCard(c.merchant_key);
    out.merchant_return_policy = url.returnPolicy(c.merchant_key);
  }
  if (out.provenance && out.provenance.confidence === "low") {
    out.warning = "Low-confidence record: the collector could not settle these numbers against the issuer's pricing page. Do not quote the APR or promo terms as fact.";
  }
  if (c.financing && c.financing.deferred_interest) out.deferred_interest_calculator = url.deferredInterestCalc();
  out.cite = { source: "Thrifle Credit Card Database", url: out.url };
  return out;
}

// ── money ───────────────────────────────────────────────────────────────────
function shapeIndicators(fin, rates) {
  const out = { url: url.money(), indicators: {}, federal_debt: null, rates: {}, attribution: (fin && fin.attribution) || null };
  for (const [k, v] of Object.entries((fin && fin.indicators) || {})) {
    out.indicators[k] = pick(stripHistory(v), ["label", "sublabel", "unit", "current", "current_date", "previous", "previous_date", "year_ago", "year_ago_date", "change", "direction", "source", "period"]);
  }
  if (fin && fin.federal_debt) out.federal_debt = pick(stripHistory(fin.federal_debt), ["total", "total_date", "held_by_public", "intragovernmental", "year_ago", "year_ago_date", "change_1y", "source"]);
  for (const [k, v] of Object.entries((rates && rates.rates) || {})) {
    out.rates[k] = typeof v === "object" ? stripHistory(v) : v;
  }
  out.cite = { source: "Thrifle Money Monitor (FRED / U.S. Treasury)", url: url.money() };
  return out;
}
function shapePricePulse(cpi, gas) {
  const out = { url: url.intelligence(), cpi: {}, gas: {} };
  for (const [k, v] of Object.entries((cpi && cpi.categories) || {})) {
    out.cpi[k] = pick(stripHistory(v), ["label", "latest_value", "latest_period", "mom_pct", "yoy_pct", "direction_yoy"]);
  }
  for (const [k, v] of Object.entries((gas && gas.prices) || {})) {
    out.gas[k] = pick(stripHistory(v), ["label", "scope", "current", "current_date", "week_ago", "year_ago", "change_week_cents", "change_year_pct", "direction"]);
  }
  out.cite = { source: "Thrifle Price Pulse (BLS CPI / EIA)", url: url.intelligence() };
  return out;
}

module.exports = {
  url,
  withUtm,
  htmlToText,
  num,
  pct,
  pick,
  short,
  shapeReturnPolicy,
  shapeReturnCompare,
  shapeReturnRow,
  shapePriceMatch,
  shapeDiscount,
  shapeDiscountRow,
  shapeCancellation,
  shapeBirthday,
  shapeBirthdayRow,
  shapeDealRow,
  shapeDealDetail,
  shapePrediction,
  shapePostRow,
  shapePostFull,
  shapeCardRow,
  shapeCard,
  shapeIndicators,
  shapePricePulse,
};
