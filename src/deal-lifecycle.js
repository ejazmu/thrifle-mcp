// Dead-deal policy — decided by Haider 2026-08-28.
//
// Context: Googlebot was spending 53% of its crawl on /deals while the entire
// section earned 8 clicks / 1,236 impressions in 90 days, and a further ~20%
// of crawl on permanent redirects (old category spellings + repost slugs).
// The fix: a deal page LIVES for a bounded window; after that it answers
// HTTP 410 (with a helpful "expired" body for humans), leaves the sitemap,
// and leaves every internal listing — all driven by this ONE predicate so the
// sitemap, the listings, and the page can never disagree about which URLs
// exist (the class of bug behind the 198 redirecting sitemap entries).
//
// Phase 1 (now): fixed cutoff — anything posted/last-revived before
// 2026-06-01 is dead unless explicitly marked evergreen. ~11,100 of 12,190
// deals. Zero measured search cost (those pages earned 8 clicks/90d; GSC
// lists no external links to any deal page).
// Phase 2 (after the crawl curve settles): move the cutoff to a rolling
// 60-day window by setting DEAL_DEAD_CUTOFF_DAYS=60 in .env — no deploy.
//
// The DB records, price history, and S3 images are all KEPT — "dead" is a
// URL-lifecycle state, not a data deletion. `PUT /revive/:id` stamps
// lastRevivedAt, which brings a page back to life (Google re-accepts a URL
// that returns 200 after a 410). The API detail endpoint keeps serving dead
// deals (with `dead: true`) so the web can render the 410 body and the iOS
// app's deep links keep resolving.

function deadCutoff() {
  const days = Number(process.env.DEAL_DEAD_CUTOFF_DAYS);
  if (Number.isFinite(days) && days > 0) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }
  return new Date(process.env.DEAL_DEAD_CUTOFF || "2026-06-01T00:00:00Z");
}

function isDeadDeal(deal) {
  if (!deal) return false;
  if (deal.evergreen === true) return false;
  const basis = deal.lastRevivedAt || deal.date;
  if (!basis) return true;
  return new Date(basis) < deadCutoff();
}

// Mongo filter fragment selecting only LIVE deals. Wrap in $and when the
// surrounding query may carry its own $or (chained .find() merges by key and
// silently clobbers a duplicate $or).
function liveDealFilter() {
  const cut = deadCutoff();
  return {
    $or: [
      { evergreen: true },
      { lastRevivedAt: { $gte: cut } },
      { date: { $gte: cut } },
    ],
  };
}

module.exports = { isDeadDeal, liveDealFilter, deadCutoff };
