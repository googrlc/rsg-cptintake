// Wires the four RSG classification reference tables (NAICS/SIC/GL/WC) into the
// intake. Deterministic: validates any code already on the synthesis and searches
// the operations text for candidates — surfaced for review, never auto-asserted
// ("codes must be found in the reference tables — never guessed").

import { getNaicsCode, searchNaicsCodes } from "../reference/naics-codes.js";
import { getSicCode, searchSicCodes } from "../reference/sic-codes.js";
import { getGlClass, searchGlClasses } from "../reference/gl-class-codes.js";
import { getWcClass, searchWcClasses } from "../reference/wc-class-codes.js";

const TABLES = {
  naics: { get: getNaicsCode, search: searchNaicsCodes, label: "NAICS" },
  sic: { get: getSicCode, search: searchSicCodes, label: "SIC" },
  gl: { get: getGlClass, search: searchGlClasses, label: "GL class" },
  wc: { get: getWcClass, search: searchWcClasses, label: "WC class" },
};

export const REFERENCE_TYPES = Object.keys(TABLES);

// Validate one code against a table → its entry, or null if not a real code.
export function lookupCode(type, code) {
  const table = TABLES[type];
  if (!table) return { error: `Unknown reference type "${type}". Use one of: ${REFERENCE_TYPES.join(", ")}.` };
  return { type, code, entry: table.get(code) };
}

// Deterministic keyword search over a table.
export function searchCodes(type, text, { limit = 5 } = {}) {
  const table = TABLES[type];
  if (!table) return { error: `Unknown reference type "${type}". Use one of: ${REFERENCE_TYPES.join(", ")}.` };
  return { type, query: text, results: table.search(text, { limit }) };
}

// Classify a business-operations description against every table: validate an
// existing NAICS, and offer candidates for each type. Candidates are suggestions
// a human confirms; nothing here selects a code.
export function classifyText(text, { naics = null, limit = 5 } = {}) {
  const query = String(text ?? "").trim();
  return {
    naics: {
      validated: naics ? getNaicsCode(naics) : null,
      candidates: query ? searchNaicsCodes(query, { limit }) : [],
    },
    sic: { candidates: query ? searchSicCodes(query, { limit }) : [] },
    gl: { candidates: query ? searchGlClasses(query, { limit }) : [] },
    wc: { candidates: query ? searchWcClasses(query, { limit }) : [] },
  };
}

// Pull the operations text off a synthesized bundle and attach a `classification`
// block (review suggestions). No-op when there's no operations text to classify.
export function attachClassification(bundle) {
  const account = bundle?.synthesis?.payload?.account ?? {};
  const operationNames = (bundle?.assessment?.operations ?? []).map((op) => op?.name).filter(Boolean);
  const text = [account.operations_summary, ...operationNames, bundle?.assessment?.summary]
    .filter((part) => part && part !== "INSUFFICIENT EVIDENCE")
    .join(". ")
    .trim();
  if (!text) return bundle;
  const existingNaics = account.naics ?? bundle?.assessment?.naics?.[0] ?? null;
  bundle.classification = {
    status: "SUGGESTED",
    note: "Candidates from RSG reference tables (deterministic) — confirm before use; never auto-selected.",
    source_text: text,
    ...classifyText(text, { naics: existingNaics }),
  };
  return bundle;
}
