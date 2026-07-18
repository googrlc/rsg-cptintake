import { test } from "node:test";
import assert from "node:assert/strict";
import { FemaFloodClient } from "../src/connectors/fema-flood-client.js";

const nfhl = (features) => ({ ok: true, status: 200, json: async () => ({ features }) });
const feature = (attrs) => ({ attributes: attrs });

test("returns the FEMA zone for a mapped point, with a readable label", async () => {
  const client = new FemaFloodClient({ fetchImpl: async () => nfhl([feature({ FLD_ZONE: "AE", ZONE_SUBTY: "", SFHA_TF: "T" })]) });
  const out = await client.floodZone({ latitude: 29.9, longitude: -90.0 });
  assert.equal(out.zone, "AE");
  assert.equal(out.sfha, true);
  assert.match(out.label, /Special Flood Hazard Area/);
});

test("minimal-hazard zone X reads as minimal, not SFHA", async () => {
  const client = new FemaFloodClient({ fetchImpl: async () => nfhl([feature({ FLD_ZONE: "X", ZONE_SUBTY: "AREA OF MINIMAL FLOOD HAZARD", SFHA_TF: "F" })]) });
  const out = await client.floodZone({ latitude: 39.7, longitude: -105.0 });
  assert.equal(out.sfha, false);
  assert.match(out.label, /minimal flood hazard/);
});

test("unmapped point (no features) returns null — never assumed safe", async () => {
  const client = new FemaFloodClient({ fetchImpl: async () => nfhl([]) });
  assert.equal(await client.floodZone({ latitude: 0, longitude: 0 }), null);
});

test("missing coordinates → null without a network call", async () => {
  let called = false;
  const client = new FemaFloodClient({ fetchImpl: async () => { called = true; return nfhl([]); } });
  assert.equal(await client.floodZone({}), null);
  assert.equal(called, false);
});
