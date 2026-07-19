// Workers' Comp classification-code reference (NCCI DN0059) — the RSG reference
// table the never-guess rule points to for WC codes. Deterministic local lookup
// over a cached snapshot; the master lives in Supabase (reference-db/).

import { readFileSync } from "node:fs";
import { ReferenceCodeTable } from "./reference-code-table.js";

const doc = JSON.parse(readFileSync(new URL("./wc-class-codes.json", import.meta.url), "utf8"));

const table = new ReferenceCodeTable({
  codes: doc.codes,
  source: doc.source,
  codeWidth: 4, // NCCI WC codes are 4-digit (e.g. 0005)
  extraStopwords: ["noc", "drivers", "driver", "employees", "clerical"],
});

export const wcSource = table.source;
export const wcCodeCount = table.count;
export const normalizeWcCode = (code) => table.normalize(code);
export const getWcClass = (code) => table.get(code);
export const searchWcClasses = (text, opts) => table.search(text, opts);
