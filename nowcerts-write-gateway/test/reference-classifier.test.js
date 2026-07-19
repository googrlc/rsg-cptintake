import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyText, lookupCode, searchCodes, attachClassification, REFERENCE_TYPES } from "../src/intake/reference-classifier.js";

test("exposes the four reference types", () => {
  assert.deepEqual(REFERENCE_TYPES.sort(), ["gl", "naics", "sic", "wc"]);
});

test("lookupCode validates against the right table and errors on a bad type", () => {
  assert.equal(lookupCode("naics", "238160").entry.description, "Roofing Contractors");
  assert.equal(lookupCode("wc", "0042").entry.description, "Landscape Gardening & Drivers");
  assert.equal(lookupCode("naics", "999999").entry, null);
  assert.ok(lookupCode("bogus", "1").error);
});

test("searchCodes ranks candidates deterministically", () => {
  const a = searchCodes("gl", "amusement parks");
  assert.equal(a.results[0].code, "10020");
  assert.deepEqual(searchCodes("gl", "amusement parks"), a);
});

test("classifyText validates an existing NAICS and offers candidates for all types", () => {
  const c = classifyText("roofing contractor, residential roof replacement and repair", { naics: "238160" });
  assert.equal(c.naics.validated.code, "238160"); // existing code confirmed against the table
  assert.ok(c.naics.candidates.some((e) => e.code === "238160"));
  assert.ok(Array.isArray(c.sic.candidates));
  assert.ok(Array.isArray(c.gl.candidates));
  assert.ok(Array.isArray(c.wc.candidates));
});

test("attachClassification reads operations text off a bundle and marks it SUGGESTED", () => {
  const bundle = {
    synthesis: { payload: { account: { operations_summary: "landscape gardening and lawn care", naics: "561730" } } },
    assessment: { operations: [{ name: "landscape gardening and lawn care" }], naics: ["561730"] },
  };
  attachClassification(bundle);
  assert.equal(bundle.classification.status, "SUGGESTED");
  assert.ok(bundle.classification.wc.candidates.length); // WC candidates found from the text
});

test("attachClassification is a no-op when there is no operations text", () => {
  const bundle = { synthesis: { payload: { account: {} } }, assessment: {} };
  attachClassification(bundle);
  assert.equal(bundle.classification, undefined);
});
