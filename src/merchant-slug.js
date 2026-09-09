// Deterministic merchant_key -> URL slug mapper.
//
// ⚠️  CANONICAL SOURCE: Thrifle-NextJS/utils/merchantSlug.js
//     This mirrors the frontend implementation of merchantSlug(). The two
//     MUST stay in sync — the public return-policy URL is built by the frontend
//     copy, and the card DB importer joins against slugs produced here. If they
//     diverge, card->merchant joins silently break for the affected merchants.
//     (The frontend file also exports resolveSlug(), which is browser/SSR-only
//     and deliberately not mirrored.)
//
// Why this is not a naive slugify: stored merchant_key values contain spaces,
// ampersands, apostrophes, parentheses, commas and plus signs
// (e.g. "at&t", "bj's wholesale club", "academy sports + outdoors").
// The "&" and "+" expansions are load-bearing — the live public URLs are
// /return-policy/at-and-t and /return-policy/academy-sports-plus-outdoors.
// A normalizer that only strips punctuation would produce "at-t" and
// "academy-sports-outdoors" and fail to match either one.
//
// merchantSlug() is IDEMPOTENT: applying it to an already-slugged value returns
// that value unchanged. That is what makes it safe to normalize both sides of
// the join.

function merchantSlug(merchantKey) {
  if (!merchantKey || typeof merchantKey !== 'string') return '';
  return merchantKey
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/['`’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { merchantSlug };
