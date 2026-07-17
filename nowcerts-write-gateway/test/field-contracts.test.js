import assert from "node:assert/strict";
import test from "node:test";
import { listFieldContracts, resolveFieldContract } from "../src/contracts/nowcerts-field-contracts.js";

test("every enabled field contract has both an exact write and read-back mapping", () => {
  const contracts = listFieldContracts();
  for (const [field, contract] of Object.entries(contracts)) {
    assert.ok(contract.read?.[0], `${field} read tool`);
    assert.ok(contract.read?.[1], `${field} read field`);
    for (const operation of ["create", "update"]) {
      if (!contract[operation]) continue;
      assert.ok(contract[operation][0], `${field} ${operation} tool`);
      assert.ok(contract[operation][1], `${field} ${operation} field`);
    }
  }
});

test("field contracts are operation-specific and never fall through", () => {
  assert.equal(resolveFieldContract("Insured.Phone", "update"), null);
  assert.equal(resolveFieldContract("Insured.NAICS", "create"), null);
  assert.equal(resolveFieldContract("Insured.LegalName", "create"), null);
  assert.equal(resolveFieldContract("Insured.Phone", "create").write_field, "phone");
  assert.equal(resolveFieldContract("Insured.NAICS", "update").read_field, "naics");
});
