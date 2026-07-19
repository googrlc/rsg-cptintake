// NAICS 2022 reference — snapshotted from the naics.com API (the authoritative
// source) into a deterministic local table so intake lookups don't depend on the
// API being up per quote. The master lives in Supabase (reference-db/); refresh
// by re-pulling the API. The live NaicsClient/NaicsEnricher remain available for
// optional fuzzy assist, but classification lookups resolve here deterministically.
//
// NAICS codes are variable width (2–6 digits), so they are NOT zero-padded.

import { readFileSync } from "node:fs";
import { ReferenceCodeTable } from "./reference-code-table.js";

const doc = JSON.parse(readFileSync(new URL("./naics-codes.json", import.meta.url), "utf8"));

const table = new ReferenceCodeTable({
  codes: doc.codes,
  source: doc.source,
  codeWidth: 0, // variable-width — strip non-digits, no padding
});

export const naicsSource = table.source;
export const naicsCodeCount = table.count;
export const normalizeNaicsCode = (code) => table.normalize(code);
export const getNaicsCode = (code) => table.get(code);
export const searchNaicsCodes = (text, opts) => table.search(text, opts);
