"use strict";
// Slug rule for thrifle.com/stores/<slug> (verbatim from the Thrifle backend's
// utils/merchantResolver.js). Different from merchant-slug.js on purpose: the
// stores URL space collapses "&" to "and" without spaces and drops "+".
function merchantSlug(name) {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/'/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
module.exports = { merchantSlug };
