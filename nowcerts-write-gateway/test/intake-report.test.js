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
  const outputDir = process.env.REPORT_TEST_OUTPUT_DIR ?? await mkdtemp(path.join(os.tmpdir(), "rsg-report-"));
  const out = await generateIntakeReport(bundle, outputDir);
  assert.equal(out.bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(out.bytes.length > 3000);
});

test("unfinished assessment cannot generate a final PDF", async () => {
  const bundle = prepareSourceBundle({ client_name: "Example LLC", existing_client_id: null, sources: [{ kind: "notes", title: "Notes", content: "Some notes", captured_at: "2026-07-17T12:00:00.000Z" }] });
  await assert.rejects(() => generateIntakeReport(bundle, os.tmpdir()), /must be complete/i);
});
