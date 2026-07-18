import { test } from "node:test";
import assert from "node:assert/strict";
import { AttomClient, toPropertyProfile } from "../src/connectors/attom-client.js";

// Real /property/detail response shape (captured live from ATTOM for the sample
// Denver address) — deep nesting, mixed key casing, and the real-world gap that
// construction/roof cover are absent while wallType is present.
const ATTOM_HIT = {
  status: { code: 0, msg: "SuccessWithResult", total: 1 },
  property: [{
    identifier: { Id: 184713191, attomId: 184713191 },
    address: { line1: "4529 WINONA CT", line2: "DENVER, CO 80212", oneLine: "4529 WINONA CT, DENVER, CO 80212" },
    summary: { proptype: "SFR", yearbuilt: 1900 },
    building: {
      size: { bldgsize: 1147, livingsize: 1147, universalsize: 1147 },
      construction: { condition: "GOOD", wallType: "BRICK" },
      summary: { levels: 1, unitsCount: "1" },
    },
  }],
};

const ATTOM_NO_RESULT = { status: { code: 1, msg: "SuccessWithoutResult", total: 0 }, property: [] };

function fakeFetch({ ok = true, status = 200, body }) {
  return async () => ({ ok, status, json: async () => body });
}

test("normalizes ATTOM's nested response to the report's property_profile keys", () => {
  const p = toPropertyProfile(ATTOM_HIT.property[0]);
  assert.equal(p.address, "4529 WINONA CT, DENVER, CO 80212");
  assert.equal(p.year_built, 1900);
  assert.equal(p.square_feet, 1147);
  assert.equal(p.construction, "BRICK"); // wallType fallback — constructiontype absent
  assert.equal(p.roof, null);            // not in the response → null, never guessed
  assert.equal(p.stories, 1);
  // Fields ATTOM doesn't provide here stay null.
  assert.equal(p.protection_class, null);
  assert.equal(p.flood_zone, null);
  assert.equal(p.replacement_cost, null);
  assert.equal(p._source.attom_id, 184713191);
});

test("propertyProfile returns the normalized entry on a hit", async () => {
  const client = new AttomClient({ apiKey: "k", fetchImpl: fakeFetch({ body: ATTOM_HIT }) });
  const p = await client.propertyProfile({ address1: "4529 Winona Court", address2: "Denver, CO" });
  assert.equal(p.construction, "BRICK");
});

test("SuccessWithoutResult (HTTP 400 envelope) resolves to null, not an error", async () => {
  const client = new AttomClient({ apiKey: "k", fetchImpl: fakeFetch({ ok: false, status: 400, body: ATTOM_NO_RESULT }) });
  assert.equal(await client.propertyProfile({ address1: "1 Nowhere Rd", address2: "Nowhereville, ZZ" }), null);
});

test("a real error (bad key / 401) throws with a statusCode", async () => {
  const client = new AttomClient({ apiKey: "bad", fetchImpl: fakeFetch({ ok: false, status: 401, body: { status: { msg: "Unauthorized" } } }) });
  await assert.rejects(() => client.propertyProfile({ address: "x" }), (e) => e.statusCode === 502 && /Unauthorized/.test(e.message));
});

test("requires an API key", () => {
  assert.throws(() => new AttomClient({}), /requires an APIKey/);
});
