import assert from "node:assert/strict";
import test from "node:test";
import { applyHermesPreview, buildEvidenceText } from "../src/intake/live-pipeline.js";
import { prepareSourceBundle } from "../src/intake/source-bundle.js";

const capturedAt = "2026-07-17T12:00:00.000Z";

function bundle() {
  return prepareSourceBundle({
    client_name: "Integration Test LLC",
    existing_client_id: "insured-123",
    sources: [{ kind: "notes", title: "Call notes", content: "The client performs electrical contracting.", captured_at: capturedAt }],
  }, { now: capturedAt, intakeId: "00000000-0000-4000-8000-000000000001" });
}

test("evidence text preserves source markers for synthesis", () => {
  const text = buildEvidenceText(bundle());
  assert.match(text, /SRC-001 \| Call notes/);
  assert.match(text, /electrical contracting/);
});

test("Hermes preview maps account and contacts but keeps approval locked", () => {
  const value = applyHermesPreview(bundle(), {
    draft_id: "draft-1",
    validation_warnings: ["Confirm years in business"],
    payload_preview: {
      account: { account_name: "Integration Test LLC", phone: "404-555-0100", operations_summary: "Electrical contracting" },
      contacts: [{ full_name: "Jamie Example", email: "jamie@example.test" }],
      opportunities: [{ line_of_business: "General Liability" }],
      underwriting_flags: [{ flag: "Work at height", severity: "medium" }],
    },
  }, { naics: "238210", sic: "1731", confidence: "high", short_summary: "Electrical contractor." });

  assert.equal(value.assessment.status, "COMPLETE");
  assert.deepEqual(value.assessment.naics, ["238210"]);
  assert.equal(value.routing.ams_fields.find((item) => item.field === "Insured.NAICS").value, "238210");
  assert.equal(value.routing.ams_fields.find((item) => item.field === "Insured.NAICS").contract.write_tool, "update_cl_rating_data_tool");
  assert.equal(value.routing.ams_fields.some((item) => item.field === "Insured.Phone"), false);
  // Contacts now route to the AMS via the certified contact insert tool instead
  // of being dropped into the report as unsupported.
  const contactEmail = value.routing.ams_fields.find((item) => item.field === "Contact[1].Email");
  assert.ok(contactEmail, "contact email must route to the AMS");
  assert.equal(contactEmail.contract.write_tool, "insert_insured_prospect_primary_contact_in_ams_tool");
  assert.equal(value.routing.assessment_only.some((item) => item.field === "Contact[1].Email"), false);
  // The full name is split so it matches the tool's firstName/lastName contract.
  assert.equal(value.routing.ams_fields.find((item) => item.field === "Contact[1].FirstName").value, "Jamie");
  assert.equal(value.routing.ams_fields.find((item) => item.field === "Contact[1].LastName").value, "Example");
  assert.equal(value.approval.status, "LOCKED");
  assert.equal(value.pipeline.nowcerts_preview, "SCHEMA_ALIGNED");
});
