import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NoopProtectionClassClient,
  StubProtectionClassClient,
  protectionClassClientFromEnv,
  NoopReplacementCostClient,
  StubReplacementCostClient,
  replacementCostClientFromEnv,
} from "../src/connectors/property-risk-clients.js";

test("Noop providers contribute nothing (fields stay null)", async () => {
  assert.equal(await new NoopProtectionClassClient().protectionClass({ address: "x" }), null);
  assert.equal(await new NoopReplacementCostClient().replacementCost({ square_feet: 2000 }), null);
});

test("Stub protection class returns a seeded value for a known address only", async () => {
  const c = new StubProtectionClassClient({ "4529 WINONA CT, DENVER, CO 80212": "4" });
  assert.equal((await c.protectionClass({ address: "4529 WINONA CT, DENVER, CO 80212" })).protection_class, "4");
  assert.equal(await c.protectionClass({ address: "unknown" }), null);
});

test("Stub replacement cost estimates from square footage, or null without a rate", async () => {
  assert.equal((await new StubReplacementCostClient({ perSqFt: 250 }).replacementCost({ square_feet: 1147 })).replacement_cost, 286750);
  assert.equal(await new StubReplacementCostClient({}).replacementCost({ square_feet: 1147 }), null); // no rate → null
  assert.equal(await new StubReplacementCostClient({ perSqFt: 250 }).replacementCost({}), null);       // no sqft → null
});

test("factories default to Noop; RCE stub only activates on an explicit rate env", async () => {
  assert.ok(protectionClassClientFromEnv() instanceof NoopProtectionClassClient);
  assert.ok(replacementCostClientFromEnv({}) instanceof NoopReplacementCostClient);
  assert.ok(replacementCostClientFromEnv({ RCE_STUB_PER_SQFT: "250" }) instanceof StubReplacementCostClient);
});
