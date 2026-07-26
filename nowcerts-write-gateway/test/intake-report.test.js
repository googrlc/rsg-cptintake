import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareSourceBundle } from "../src/intake/source-bundle.js";
import { generateIntakeReport } from "../src/reports/intake-report.js";

test("completed assessment generates a downloadable PDF", async () => {
  const bundle = prepareSourceBundle(
    {
      client_name: "Example Contracting LLC",
      existing_client_id: null,
      sources: [{ kind: "notes", title: "Client notes", content: "Commercial plumbing contractor with ten employees.", captured_at: "2026-07-17T12:00:00.000Z" }],
    },
    { intakeId: "44444444-4444-4444-8444-444444444444", now: "2026-07-17T12:00:00.000Z" },
  );
  bundle.assessment = {
    ...bundle.assessment,
    status: "COMPLETE",
    review_status: "Needs Review",
    summary: "The client reports commercial plumbing operations.",
    confidence: 82,
    operations: [{ name: "Commercial plumbing", naics: "238220", gl_codes: ["91580"], wc_codes: ["5183"], evidence: "SRC-001: Client notes" }],
    coverage_requirements: ["General Liability", "Workers Compensation"],
    endorsements: ["Additional Insured"],
    red_flags: ["Subcontractor use not established"],
    favorable_factors: ["Tenured workforce"],
    missing_items: ["Loss runs"],
    evidence_map: [{ source: "Client notes", reference: "SRC-001", fact: "Commercial plumbing operations" }],
  };
  bundle.routing.ams_fields = [{ field: "commercial_name", value: "Example Contracting LLC", citation: "SRC-001" }];
  bundle.routing.assessment_only = [{ field: "operations narrative", value: "Commercial plumbing contractor", citation: "SRC-001" }];
  // Hermes-bound pipeline records, including one needing review, so the CRM
  // routing section of the appendix is exercised rather than only parsed.
  bundle.crm_records = [
    {
      destination: "hermes", entity: "opportunity", role: "opportunity", operation: "create", index: 1,
      fields: [{ field: "line_of_business", value: "General Liability", citation: "SRC-001" }],
      needs_review: [], nowcerts_write: "manual",
    },
    {
      destination: "hermes", entity: "opportunity", role: "opportunity", operation: "create", index: 2,
      fields: [], needs_review: [{ field: "line_of_business", reason: "MISSING" }], nowcerts_write: "manual",
    },
  ];
  const outputDir = process.env.REPORT_TEST_OUTPUT_DIR ?? await mkdtemp(path.join(os.tmpdir(), "rsg-report-"));
  const out = await generateIntakeReport(bundle, outputDir);
  assert.equal(out.bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(out.bytes.length > 3000);
});

test("unfinished assessment cannot generate a final PDF", async () => {
  const bundle = prepareSourceBundle({ client_name: "Example LLC", existing_client_id: null, sources: [{ kind: "notes", title: "Notes", content: "Some notes", captured_at: "2026-07-17T12:00:00.000Z" }] });
  await assert.rejects(() => generateIntakeReport(bundle, os.tmpdir()), /must be complete/i);
});

test("personal-lines bundle with property profile and scores renders both audiences", async () => {
  const bundle = prepareSourceBundle(
    {
      client_name: "The Okafor Household",
      existing_client_id: null,
      sources: [{ kind: "notes", title: "Client notes", content: "Homeowner, two vehicles, prior AmFam 6 years.", captured_at: "2026-07-17T12:00:00.000Z" }],
    },
    { intakeId: "55555555-5555-4555-8555-555555555555", now: "2026-07-17T12:00:00.000Z" },
  );
  // Personal-lines shape: household snapshot, property profile, loss history, 1-5 scores.
  bundle.lines_of_business = ["Homeowners", "Personal Auto"];
  bundle.property_profile = [
    { address: "123 Maple St, Austin, TX", year_built: "1998", square_feet: "2,450", construction: "Frame", roof: "8 yr / comp", protection_class: "3", flood_zone: "X", replacement_cost: "$412,000" },
  ];
  bundle.assessment = {
    ...bundle.assessment,
    status: "COMPLETE",
    review_status: "Ready for Review",
    summary: "Homeowner with two vehicles and continuous prior coverage.",
    confidence: 70,
    household: { named_insured: "Ada Okafor", co_applicant: "N. Okafor", prior_carrier: "American Family", prior_liability_limit: "100/300/100", continuous_coverage: "Yes", umbrella: "None" },
    coverage_requirements: ["Homeowners HO-3", "Personal Auto", "Personal Umbrella"],
    favorable_factors: ["Continuous prior coverage", "No lapses"],
    red_flags: ["Umbrella gap given asset profile"],
    loss_history: [{ date: "2024-05", line: "Home", description: "Wind/hail", amount_paid: "$6,200", status: "Closed" }],
    scores: { "Loss / Claims History": 4, "Coverage Adequacy": 3, "Household Stability / Retention Likelihood": 4, "Monoline -> Multiline Upside": 5, "Household Lifetime Value": 4 },
    evidence_map: [{ source: "SRC-001", reference: "Client notes", fact: "Homeowner with two vehicles" }],
  };
  const outputDir = process.env.REPORT_TEST_OUTPUT_DIR ?? await mkdtemp(path.join(os.tmpdir(), "rsg-report-pl-"));
  const internal = await generateIntakeReport(bundle, outputDir);
  const client = await generateIntakeReport(bundle, outputDir, { audience: "client" });
  assert.equal(internal.bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.equal(client.bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(internal.bytes.length > 3000);
  assert.ok(client.bytes.length > 2000);
});
