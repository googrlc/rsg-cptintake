import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getGlClass, normalizeGlCode, searchGlClasses, glCodeCount,
} from "../src/reference/gl-class-codes.js";

test("the bundled GL reference table loaded", () => {
  assert.equal(glCodeCount, 1154);
});

test("normalizeGlCode canonicalizes to a 5-digit code, tolerating thousands commas", () => {
  assert.equal(normalizeGlCode("10,010"), "10010");
  assert.equal(normalizeGlCode("10010"), "10010");
  assert.equal(normalizeGlCode(" 16,819 "), "16819");
  assert.equal(normalizeGlCode("xx"), null);
});

test("getGlClass validates a code and returns its reference entry", () => {
  assert.equal(getGlClass("10010").description, "Air Conditioning Equipment--Dealers or Distributors Only");
  assert.equal(getGlClass("10,020").description, "Amusement Parks");
  assert.equal(getGlClass("00000"), null);
});

test("searchGlClasses ranks by description keywords and is deterministic", () => {
  const a = searchGlClasses("amusement parks");
  assert.equal(a[0].code, "10020"); // Amusement Parks
  assert.deepEqual(searchGlClasses("amusement parks"), a);
});

test("searchGlClasses returns [] on no match — never invents a code", () => {
  assert.deepEqual(searchGlClasses("zzzz qqqq"), []);
});

test("the known 6-digit source anomaly is preserved, not silently corrected", () => {
  // Faithful to source (never-guessed); flagged for correction in the master.
  assert.equal(getGlClass("441105").code, "441105");
});
