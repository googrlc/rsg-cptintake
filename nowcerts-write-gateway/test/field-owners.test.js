import test from "node:test";
import assert from "node:assert/strict";
import { classifyFieldOwner, partitionByOwner, OWNER_AMS, OWNER_CRM, OWNER_ASSESSMENT } from "../src/intake/field-owners.js";

test("insured and policy fields are AMS-owned", () => {
  assert.equal(classifyFieldOwner("Insured.Name"), OWNER_AMS);
  assert.equal(classifyFieldOwner("Policy.Number"), OWNER_AMS);
  assert.equal(classifyFieldOwner("Endorsement.Type"), OWNER_AMS);
});

test("lead/pipeline/case/note fields are CRM-owned", () => {
  assert.equal(classifyFieldOwner("Lead.Status"), OWNER_CRM);
  assert.equal(classifyFieldOwner("Opportunity.Stage"), OWNER_CRM);
  assert.equal(classifyFieldOwner("Case.Notes"), OWNER_CRM);
});

test("partitionByOwner groups rows", () => {
  const parts = partitionByOwner([
    { field: "Insured.Name", value: "Acme" },
    { field: "Lead.Status", value: "new" },
    { field: "Annual revenue", value: 1 },
  ]);
  assert.equal(parts.ams_fields.length, 1);
  assert.equal(parts.crm_fields.length, 1);
  assert.equal(parts.assessment_only.length, 1);
  assert.equal(parts.assessment_only[0].owner, OWNER_ASSESSMENT);
});
