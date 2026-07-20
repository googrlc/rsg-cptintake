import { test } from "node:test";
import assert from "node:assert/strict";
import { propertyAddress, lookupPropertyProfile } from "../src/intake/property-lookup.js";

const bundleWith = (account) => ({ synthesis: { payload: { account } } });

// Minimal fake ATTOM client: returns a profile for the known address, null else.
const fakeClient = (profileByAddr = {}) => ({
  async propertyProfile({ address1 }) {
    return profileByAddr[address1] ?? null;
  },
});

test("propertyAddress builds ATTOM split-address parts from the insured account", () => {
  const parts = propertyAddress(bundleWith({ address: "4529 Winona Ct", city: "Denver", state: "CO", zip: "80212" }));
  assert.deepEqual(parts, { address1: "4529 Winona Ct", address2: "Denver, CO 80212" });
});

test("propertyAddress returns null when there is no street address (never guessed)", () => {
  assert.equal(propertyAddress(bundleWith({ city: "Denver", state: "CO" })), null);
  assert.equal(propertyAddress({}), null);
});

test("lookup returns a suggested profile on an ATTOM match", async () => {
  const client = fakeClient({ "4529 Winona Ct": { year_built: 1900, construction: "BRICK" } });
  const out = await lookupPropertyProfile(bundleWith({ address: "4529 Winona Ct", city: "Denver", state: "CO", zip: "80212" }), client);
  assert.equal(out.status, "OK");
  assert.equal(out.property_profile.length, 1);
  assert.equal(out.property_profile[0].construction, "BRICK");
  assert.equal(out.property_profile[0].status, "suggested"); // tagged as a suggestion, not verified
});

test("chains FEMA flood zone onto an ATTOM match when coordinates are present", async () => {
  const client = fakeClient({ "4529 Winona Ct": { year_built: 1900, latitude: 39.78, longitude: -105.05, flood_zone: null } });
  const floodClient = { async floodZone({ latitude }) { return latitude ? { label: "Zone X — minimal flood hazard" } : null; } };
  const out = await lookupPropertyProfile(bundleWith({ address: "4529 Winona Ct", city: "Denver", state: "CO", zip: "80212" }), client, { floodClient });
  assert.equal(out.property_profile[0].flood_zone, "Zone X — minimal flood hazard");
});

test("a FEMA failure does not sink a good property match (flood_zone stays null)", async () => {
  const client = fakeClient({ "4529 Winona Ct": { year_built: 1900, latitude: 39.78, longitude: -105.05, flood_zone: null } });
  const floodClient = { async floodZone() { throw new Error("NFHL down"); } };
  const out = await lookupPropertyProfile(bundleWith({ address: "4529 Winona Ct", city: "Denver", state: "CO", zip: "80212" }), client, { floodClient });
  assert.equal(out.status, "OK");
  assert.equal(out.property_profile[0].flood_zone, null);
});

test("stub protection-class and replacement-cost providers fill their fields", async () => {
  const client = fakeClient({ "4529 Winona Ct": { square_feet: 1147, address: "4529 WINONA CT, DENVER, CO 80212", latitude: 1, longitude: 2 } });
  const protectionClassClient = { async protectionClass() { return { protection_class: "4" }; } };
  const replacementCostClient = { async replacementCost({ square_feet }) { return { replacement_cost: square_feet * 250 }; } };
  const out = await lookupPropertyProfile(
    bundleWith({ address: "4529 Winona Ct", city: "Denver", state: "CO", zip: "80212" }),
    client,
    { protectionClassClient, replacementCostClient },
  );
  assert.equal(out.property_profile[0].protection_class, "4");
  assert.equal(out.property_profile[0].replacement_cost, 286750);
});

test("lookup reports NO_ADDRESS without calling the API", async () => {
  let called = false;
  const client = { async propertyProfile() { called = true; return {}; } };
  const out = await lookupPropertyProfile(bundleWith({ city: "Denver" }), client);
  assert.equal(out.status, "NO_ADDRESS");
  assert.equal(called, false);
});

test("lookup reports NO_MATCH when ATTOM has no record for the address", async () => {
  const out = await lookupPropertyProfile(bundleWith({ address: "1 Nowhere Rd", city: "Nowhereville", state: "ZZ" }), fakeClient());
  assert.equal(out.status, "NO_MATCH");
  assert.deepEqual(out.property_profile, []);
});
