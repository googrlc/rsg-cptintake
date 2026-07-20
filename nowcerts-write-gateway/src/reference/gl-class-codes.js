// General Liability classification-code reference (ISO/RSG Term Store) — the RSG
// reference table the never-guess rule points to for GL codes. Deterministic
// local lookup over a cached snapshot; the master lives in Supabase (reference-db/).
//
// Note: one source row (441105, "Governmental: Municipalities") is 6 digits — a
// likely CSV data-entry error, preserved as-is rather than guessed into a 5-digit
// code. Correct it in the Supabase master against the authoritative ISO code.

import { readFileSync } from "node:fs";
import { ReferenceCodeTable } from "./reference-code-table.js";

const doc = JSON.parse(readFileSync(new URL("./gl-class-codes.json", import.meta.url), "utf8"));

const table = new ReferenceCodeTable({
  codes: doc.codes,
  source: doc.source,
  codeWidth: 5, // ISO GL codes are 5-digit (e.g. 10010)
});

export const glSource = table.source;
export const glCodeCount = table.count;
export const normalizeGlCode = (code) => table.normalize(code);
export const getGlClass = (code) => table.get(code);
export const searchGlClasses = (text, opts) => table.search(text, opts);
