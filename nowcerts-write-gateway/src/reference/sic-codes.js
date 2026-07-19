// Standard Industrial Classification (SIC) reference — the RSG reference table
// the never-guess rule points to for SIC codes. Deterministic local lookup over a
// cached snapshot; the master lives in Supabase (reference-db/).

import { readFileSync } from "node:fs";
import { ReferenceCodeTable } from "./reference-code-table.js";

const doc = JSON.parse(readFileSync(new URL("./sic-codes.json", import.meta.url), "utf8"));

const table = new ReferenceCodeTable({
  codes: doc.codes,
  source: doc.source,
  codeWidth: 4, // SIC codes are 4-digit (e.g. 0100)
});

export const sicSource = table.source;
export const sicCodeCount = table.count;
export const normalizeSicCode = (code) => table.normalize(code);
export const getSicCode = (code) => table.get(code);
export const searchSicCodes = (text, opts) => table.search(text, opts);
