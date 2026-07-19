// Deterministic Workers' Comp classification-code reference — the RSG reference
// table the intake's never-guess rule points to for WC codes ("NAICS, SIC, GL,
// and WC codes must be found in the RSG reference tables — never guessed"). Local
// data (NCCI DN0059), no external API: validating a code or ranking candidates
// from operation text is fully reproducible.

import { readFileSync } from "node:fs";

const DATA_URL = new URL("./wc-class-codes.json", import.meta.url);
const doc = JSON.parse(readFileSync(DATA_URL, "utf8"));

// Indexed by canonical 4-digit code for O(1) validation.
const byCode = new Map(doc.codes.map((entry) => [entry.code, entry]));

export const wcSource = doc.source;
export const wcCodeCount = doc.codes.length;

// Canonicalize any user form ("5", 5, "0005", " 42 ") to the 4-digit NCCI code.
export function normalizeWcCode(code) {
  const digits = String(code ?? "").trim().replace(/[^0-9]/g, "");
  return digits ? digits.padStart(4, "0") : null;
}

// Validate a code → its reference entry, or null if it isn't a real WC class.
export function getWcClass(code) {
  const key = normalizeWcCode(code);
  return key ? byCode.get(key) ?? null : null;
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "with", "at",
  "by", "from", "as", "is", "are", "&", "noc", "drivers", "driver", "employees",
  "clerical", "inc", "llc", "co", "corp",
]);

function tokens(text) {
  return [...new Set(
    String(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  )];
}

// Deterministic keyword ranking over description (+ category/subcategory). Same
// input always yields the same ordered candidates. Returns [] when nothing
// meaningfully matches — a caller must never invent a code from an empty result.
export function searchWcClasses(text, { limit = 5 } = {}) {
  const queryTokens = tokens(text);
  if (!queryTokens.length) return [];
  const scored = [];
  for (const entry of doc.codes) {
    const descTokens = new Set(tokens(`${entry.description} ${entry.subcategory ?? ""} ${entry.category ?? ""}`));
    let score = 0;
    for (const qt of queryTokens) {
      if (descTokens.has(qt)) score += 3;                                   // whole-word hit
      else if ([...descTokens].some((dt) => dt.includes(qt) || qt.includes(dt))) score += 1; // partial
    }
    if (score > 0) scored.push({ entry, score });
  }
  // Rank by score desc, then shorter description (more specific), then code asc —
  // all deterministic tiebreakers.
  scored.sort((a, b) =>
    b.score - a.score
    || a.entry.description.length - b.entry.description.length
    || a.entry.code.localeCompare(b.entry.code));
  return scored.slice(0, limit).map((s) => ({ ...s.entry, score: s.score }));
}
