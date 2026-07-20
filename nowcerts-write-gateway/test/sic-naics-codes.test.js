import { test } from "node:test";
import assert from "node:assert/strict";
import { getSicCode, normalizeSicCode, searchSicCodes, sicCodeCount } from "../src/reference/sic-codes.js";
import { getNaicsCode, normalizeNaicsCode, searchNaicsCodes, naicsCodeCount } from "../src/reference/naics-codes.js";

// ---- SIC (4-digit, zero-padded) ----
test("SIC table loaded and validates a padded code", () => {
  assert.equal(sicCodeCount, 444);
  assert.equal(normalizeSicCode("100"), "0100");      // leading-zero canonicalization
  assert.equal(getSicCode("100").description, "AGRICULTURAL PRODUCTION-CROPS");
  assert.equal(getSicCode("0100").code, "0100");
  assert.equal(getSicCode("9999"), null);
});

test("SIC search is deterministic and empty on no match", () => {
  const a = searchSicCodes("forestry");
  assert.ok(a.length > 0 && a.some((e) => /forestry/i.test(e.description)));
  assert.deepEqual(searchSicCodes("forestry"), a);
  assert.deepEqual(searchSicCodes("zzzz qqqq"), []);
});

// ---- NAICS (variable width, no padding) ----
test("NAICS snapshot loaded across all depths", () => {
  assert.equal(naicsCodeCount, 2125);
});

test("NAICS validates variable-width codes without zero-padding", () => {
  assert.equal(normalizeNaicsCode("11"), "11");        // 2-digit sector kept as-is
  assert.equal(getNaicsCode("11").description, "Agriculture, Forestry, Fishing and Hunting");
  assert.equal(getNaicsCode("111110").code, "111110"); // 6-digit leaf
  assert.equal(getNaicsCode("999999"), null);
});

test("NAICS search resolves an industry term deterministically", () => {
  const a = searchNaicsCodes("roofing contractors");
  assert.ok(a.some((e) => e.code === "238160"));
  assert.deepEqual(searchNaicsCodes("roofing contractors"), a);
});
