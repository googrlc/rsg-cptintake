// Shared deterministic engine for RSG classification-code reference tables
// (WC, GL, and future SIC/NAICS-local sets). Local data, no external API: the
// same input always yields the same validation / ranked candidates, so a code
// is "found in the reference table", never guessed. An empty search result must
// never be turned into an invented code by the caller.

const BASE_STOPWORDS = [
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "with", "at",
  "by", "from", "as", "is", "are", "&", "not", "other", "than", "only", "inc",
  "llc", "co", "corp",
];

export class ReferenceCodeTable {
  // codes: [{ code, description, category?, subcategory? }]
  // codeWidth: zero-pad width for canonical codes (WC=4, GL=5)
  // extraStopwords: table-specific noise words to ignore in search
  constructor({ codes, source, codeWidth, extraStopwords = [] }) {
    this.source = source;
    this.count = codes.length;
    this.codeWidth = codeWidth;
    this.stopwords = new Set([...BASE_STOPWORDS, ...extraStopwords]);
    this.codes = codes;
    this.byCode = new Map(codes.map((entry) => [entry.code, entry]));
  }

  // Any user form ("5", 5, "10,010", " 42 ") → the canonical zero-padded code.
  normalize(code) {
    const digits = String(code ?? "").replace(/[^0-9]/g, "");
    return digits ? digits.padStart(this.codeWidth, "0") : null;
  }

  // Validate → reference entry, or null if the code isn't in the table.
  get(code) {
    const key = this.normalize(code);
    return key ? this.byCode.get(key) ?? null : null;
  }

  #tokens(text) {
    return [...new Set(
      String(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
        .filter((w) => w.length > 2 && !this.stopwords.has(w)),
    )];
  }

  // Deterministic keyword ranking over description (+ category/subcategory).
  // Returns [] when nothing meaningfully matches.
  search(text, { limit = 5 } = {}) {
    const queryTokens = this.#tokens(text);
    if (!queryTokens.length) return [];
    const scored = [];
    for (const entry of this.codes) {
      const descTokens = new Set(this.#tokens(`${entry.description} ${entry.subcategory ?? ""} ${entry.category ?? ""}`));
      let score = 0;
      for (const qt of queryTokens) {
        if (descTokens.has(qt)) score += 3;                                       // whole-word hit
        else if ([...descTokens].some((dt) => dt.includes(qt) || qt.includes(dt))) score += 1; // partial
      }
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort((a, b) =>
      b.score - a.score
      || a.entry.description.length - b.entry.description.length
      || a.entry.code.localeCompare(b.entry.code));
    return scored.slice(0, limit).map((s) => ({ ...s.entry, score: s.score }));
  }
}
