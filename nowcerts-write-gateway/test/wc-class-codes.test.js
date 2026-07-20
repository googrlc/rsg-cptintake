import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getWcClass, normalizeWcCode, searchWcClasses, wcCodeCount,
} from "../src/reference/wc-class-codes.js";

test("the bundled reference table loaded", () => {
  assert.equal(wcCodeCount, 423);
});

test("normalizeWcCode canonicalizes any input form to a 4-digit code", () => {
  assert.equal(normalizeWcCode("42"), "0042");
  assert.equal(normalizeWcCode(5), "0005");
  assert.equal(normalizeWcCode("0042"), "0042");
  assert.equal(normalizeWcCode(" 9,985 "), "9985"); // thousands-separator input tolerated
  assert.equal(normalizeWcCode("abc"), null);
});

test("getWcClass validates a code and returns its reference entry", () => {
  assert.equal(getWcClass("42").description, "Landscape Gardening & Drivers");
  assert.equal(getWcClass("0005").description, "Nursery Employees & Drivers");
  // The high code that the comma bug previously broke:
  assert.equal(getWcClass("9985").code, "9985");
  assert.equal(getWcClass("0000"), null); // not a real class
  assert.equal(getWcClass(""), null);
});

test("searchWcClasses ranks by description keywords and is deterministic", () => {
  const a = searchWcClasses("landscape gardening");
  assert.ok(a.length > 0);
  assert.equal(a[0].code, "0042"); // Landscape Gardening & Drivers
  // Same input → identical ordered result (no nondeterminism).
  assert.deepEqual(searchWcClasses("landscape gardening"), a);
});

test("searchWcClasses returns [] when nothing matches — caller must not invent a code", () => {
  assert.deepEqual(searchWcClasses("zzzzz qqqqq"), []);
  assert.deepEqual(searchWcClasses(""), []);
});
