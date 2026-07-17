import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInsuredProposal, INSURED_REQUIRED_WRITE_FIELDS } from "../src/intake/intake-proposal.js";
import { validateProposal } from "../src/validator.js";
import { expectedConfirmation } from "../src/policy.js";

const NOW = "2026-07-17T20:00:00.000Z";

function amsField(field, writeField, value) {
  return {
    field,
    current: null,
    value,
    citation: "SRC-001 acme.pdf",
    contract_status: "SCHEMA_ALIGNED",
    contract: {
      write_tool: "insert_insured_prospect_tool",
      write_field: writeField,
      read_tool: "get_insured_details_tool",
      read_field: writeField,
      schema_status: "SCHEMA_ALIGNED",
    },
  };
}

function bundleWith(amsFields, { operation = "create", displayName = "Acme Welding LLC" } = {}) {
  return {
    intake_id: "11111111-1111-4111-8111-111111111111",
    client: { display_name: displayName, intended_operation: operation },
    routing: { ams_fields: amsFields },
  };
}

const COMPLETE = [
  ["Insured.Name", "commercialName", "Acme Welding LLC"],
  ["Insured.Address", "addressLine1", "123 Industrial Way"],
  ["Insured.City", "city", "Dayton"],
  ["Insured.State", "state", "OH"],
  ["Insured.Zip", "zipCode", "45402"],
  ["Insured.Type", "insuredType", "Commercial"],
].map(([f, w, v]) => amsField(f, w, v));

test("a complete new prospect builds a proposal that is ready for approval", () => {
  const built = buildInsuredProposal(bundleWith(COMPLETE), "gretchen", { now: NOW });
  assert.equal(built.ok, true);
  assert.equal(built.proposal.operation, "create");
  assert.equal(built.proposal.entity_type, "insured");
  assert.equal(built.proposal.target.match_status, "NONE");
  assert.equal(built.proposal.changes[0].field, "commercialName");
  assert.equal(built.proposal.changes[0].source.kind, "trusted_system");
  assert.deepEqual([...built.proposal.read_back_fields].sort(), [...INSURED_REQUIRED_WRITE_FIELDS].sort());
  assert.deepEqual(built.proposal.missing_fields, []);

  const validation = validateProposal(built.proposal);
  assert.equal(validation.status, "READY_FOR_APPROVAL");
  assert.equal(expectedConfirmation(built.proposal), "CONFIRM CREATE Acme Welding LLC");
});

test("a missing required insured field blocks with NEEDS_INFORMATION", () => {
  const partial = COMPLETE.filter((item) => item.contract.write_field !== "addressLine1");
  const built = buildInsuredProposal(bundleWith(partial), "gretchen", { now: NOW });
  assert.equal(built.ok, true);
  assert.ok(built.proposal.missing_fields.includes("addressLine1"));
  assert.equal(validateProposal(built.proposal).status, "NEEDS_INFORMATION");
});

test("existing-client update is not supported by the standalone door yet", () => {
  const built = buildInsuredProposal(bundleWith(COMPLETE, { operation: "update" }), "lamar", { now: NOW });
  assert.equal(built.ok, false);
  assert.equal(built.status, "UNSUPPORTED");
});

test("no certified create fields yields NO_FIELDS", () => {
  const built = buildInsuredProposal(bundleWith([]), "lamar", { now: NOW });
  assert.equal(built.ok, false);
  assert.equal(built.status, "NO_FIELDS");
});
