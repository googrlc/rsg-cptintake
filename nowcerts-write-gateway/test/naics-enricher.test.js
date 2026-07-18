import { test } from "node:test";
import assert from "node:assert/strict";
import { NaicsClient } from "../src/connectors/naics-client.js";
import { NaicsEnricher } from "../src/intake/enricher.js";

// Fake fetch answering the NAICS endpoints from a fixture map, using the real
// response envelope: /api/search → {data:[...]}, /api/details/{code} → {data:{}}.
// Each route value is a function of the parsed query so we can vary per keyword.
function fakeFetch(routes) {
  return async (url) => {
    const u = new URL(url);
    const path = u.pathname;
    const q = u.searchParams.get("q");
    for (const [matcher, handler] of routes) {
      if (matcher.test(path)) {
        const body = typeof handler === "function" ? handler(q, path) : handler;
        if (body == null) return { ok: false, status: 404, json: async () => ({ message: "not found" }) };
        return { ok: true, status: 200, json: async () => body };
      }
    }
    return { ok: false, status: 404, json: async () => ({ message: "not found" }) };
  };
}

function makeEnricher(routes, opts) {
  const client = new NaicsClient({ url: "https://naics.example", apiKey: "pk_test", fetchImpl: fakeFetch(routes) });
  return new NaicsEnricher(client, opts);
}

const searchData = (rows) => ({ data: rows });
const record = (fields) => ({ entity: "insured", operation: "create", fields });

test("suggests NAICS candidates from a description as a REVIEW item, not an auto-write", async () => {
  // Phrase search hits directly (keywords co-occur in one entry).
  const enricher = makeEnricher([
    [/\/api\/search/, (q) => q === "plumbing heating air conditioning"
      ? searchData([
          { code: "238220", title: "Plumbing, Heating, and Air-Conditioning Contractors" },
          { code: "423720", title: "Plumbing and Heating Equipment Merchant Wholesalers" },
        ])
      : searchData([])],
  ]);
  const out = await enricher.enrich(record([
    { field: "commercial_name", value: "Acme Mechanical" },
    { field: "operations_summary", value: "residential and commercial plumbing heating air conditioning" },
  ]));
  assert.equal(out.length, 1);
  assert.equal(out[0].field, "naics");
  assert.equal(out[0].value, "238220");
  assert.equal(out[0].status, "review"); // suggestion, human confirms — never silently proposed
  assert.match(out[0].citation.excerpt, /Suggested: 238220/);
  assert.match(out[0].citation.excerpt, /Alternatives: 423720/);
  assert.match(out[0].citation.excerpt, /Confirm the correct NAICS/);
});

test("falls back to per-keyword union when the phrase search returns nothing", async () => {
  // "roof replacement repair" as a phrase → 0; per-keyword "roof" leads.
  const enricher = makeEnricher([
    [/\/api\/search/, (q) => {
      if (q === "roof replacement repair") return searchData([]);
      if (q === "roof") return searchData([{ code: "238160", title: "Roofing Contractors" }]);
      if (q === "replacement") return searchData([{ code: "811122", title: "Automotive Glass Replacement Shops" }]);
      if (q === "repair") return searchData([{ code: "811111", title: "General Automotive Repair" }]);
      return searchData([]);
    }],
  ]);
  const out = await enricher.enrich(record([{ field: "operations_summary", value: "residential and commercial roof replacement and repair" }]));
  assert.equal(out.length, 1);
  assert.equal(out[0].value, "238160"); // roofing leads because "roof" is the salient keyword
  assert.match(out[0].citation.reference, /\[roof, replacement, repair\]/);
});

test("never fabricates: no candidates from any keyword → nothing emitted", async () => {
  const enricher = makeEnricher([[/\/api\/search/, () => searchData([])]]);
  const out = await enricher.enrich(record([{ field: "operations_summary", value: "widget flimflam" }]));
  assert.deepEqual(out, []);
});

test("no description field → nothing emitted (gap left open for review)", async () => {
  const enricher = makeEnricher([[/\/api\/search/, () => searchData([{ code: "1", title: "x" }])]]);
  const out = await enricher.enrich(record([{ field: "state", value: "GA" }]));
  assert.deepEqual(out, []);
});

test("existing valid code is left untouched (validate, don't overwrite)", async () => {
  const enricher = makeEnricher([[/\/api\/details\/238220/, { data: { code: "238220", title: "HVAC" } }]]);
  const out = await enricher.enrich(record([{ field: "naics", value: "238220" }, { field: "operations_summary", value: "hvac" }]));
  assert.deepEqual(out, []);
});

test("existing invalid code is surfaced for review, not silently kept", async () => {
  const enricher = makeEnricher([]); // details 404s
  const out = await enricher.enrich(record([{ field: "naics", value: "000000" }]));
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "review");
  assert.match(out[0].citation.excerpt, /not found/i);
});

test("non-insured records are ignored", async () => {
  const enricher = makeEnricher([[/\/api\/search/, () => searchData([{ code: "1", title: "x" }])]]);
  const out = await enricher.enrich({ entity: "contact", operation: "create", fields: [{ field: "operations_summary", value: "hvac" }] });
  assert.deepEqual(out, []);
});
