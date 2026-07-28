import test from "node:test";
import assert from "node:assert/strict";
import { buildCrmRecords, CRM_DESTINATION, NOWCERTS_WRITE_MANUAL } from "../src/intake/crm-records.js";
import { applyHermesPreview } from "../src/intake/live-pipeline.js";
import { bundle } from "./fixtures.js";

const CITATION = "SRC-001 Golden Rose Risk Profile.pdf";

const payload = {
  account: {
    account_name: "Jarah Group LLC",
    operations_summary: "24-bed personal care and memory care facility",
    annual_revenue: 1_000_000,
    estimated_payroll: 160_000,
    employee_count: 6,
    account_type: "Commercial Lines",
  },
  opportunities: [
    { line_of_business: "General Liability", stage: "Pre-market", current_carrier: "None" },
    { line_of_business: "Workers Compensation", expiration_date: "2026-09-01" },
  ],
};

test("each line of business becomes its own Hermes opportunity record", () => {
  const records = buildCrmRecords(payload, { citation: CITATION });
  const opportunities = records.filter((r) => r.entity === "opportunity");
  assert.equal(opportunities.length, 2);
  assert.equal(opportunities[0].destination, CRM_DESTINATION);
  const lobs = opportunities.map((r) => r.fields.find((f) => f.field === "line_of_business").value);
  assert.deepEqual(lobs, ["General Liability", "Workers Compensation"]);
});

test("every CRM record carries the manual-write tripwire", () => {
  // The rule that stops speculative per-LOB quotes reaching the AMS.
  for (const record of buildCrmRecords(payload, { citation: CITATION })) {
    assert.equal(record.nowcerts_write, NOWCERTS_WRITE_MANUAL, `${record.entity} must be marked manual`);
    assert.equal(record.destination, CRM_DESTINATION);
  }
});

test("pipeline context becomes one account record", () => {
  const records = buildCrmRecords(payload, { citation: CITATION });
  const context = records.find((r) => r.entity === "account");
  assert.ok(context);
  const byField = Object.fromEntries(context.fields.map((f) => [f.field, f.value]));
  assert.equal(byField.annual_revenue, 1_000_000);
  assert.equal(byField.estimated_payroll, 160_000);
  assert.equal(byField.employee_count, 6);
});

test("absent values are omitted rather than defaulted", () => {
  const records = buildCrmRecords(payload, { citation: CITATION });
  const wc = records.find((r) => r.fields.some((f) => f.value === "Workers Compensation"));
  const names = wc.fields.map((f) => f.field);
  assert.ok(!names.includes("current_carrier"), "a field with no value must not be emitted");
  assert.ok(!names.includes("current_premium"));
  assert.ok(names.includes("expiration_date"));
});

test("an opportunity with no line of business is surfaced, never filed under a guess", () => {
  const records = buildCrmRecords({ opportunities: [{ stage: "Pre-market" }] }, { citation: CITATION });
  const orphan = records.find((r) => r.entity === "opportunity");
  assert.deepEqual(orphan.fields, []);
  assert.deepEqual(orphan.needs_review, [{ field: "line_of_business", reason: "MISSING" }]);
  assert.equal(orphan.nowcerts_write, NOWCERTS_WRITE_MANUAL);
});

test("every emitted field carries its evidence", () => {
  for (const record of buildCrmRecords(payload, { citation: CITATION })) {
    for (const f of record.fields) assert.equal(f.citation, CITATION, `${f.field} must be cited`);
  }
});

test("an empty payload produces no records rather than an empty shell", () => {
  assert.deepEqual(buildCrmRecords({}, { citation: CITATION }), []);
  assert.deepEqual(buildCrmRecords({ account: { account_name: "Solo" } }, { citation: CITATION }), []);
});

test("malformed opportunity entries are skipped, not crashed on", () => {
  const records = buildCrmRecords({ opportunities: [null, "General Liability", 42] }, { citation: CITATION });
  assert.deepEqual(records, []);
});

test("the live pipeline now emits crm_records instead of dropping pipeline context", () => {
  const value = applyHermesPreview(bundle(), {
    draft_id: "draft-1",
    validation_warnings: [],
    payload_preview: payload,
  });

  assert.ok(Array.isArray(value.crm_records), "crm_records must be on the live bundle");
  assert.equal(value.crm_records.length, 3, "two opportunities plus account context");
  assert.equal(value.crm_write, "PENDING", "unsubmitted is visibly unsubmitted, not a clean no-op");
  assert.equal(value.pipeline.crm_preview, "READY");
  // Per-LOB records must never appear as AMS writes.
  assert.ok(!value.routing.ams_fields.some((f) => /line_of_business|opportunity/i.test(f.field)));
});
