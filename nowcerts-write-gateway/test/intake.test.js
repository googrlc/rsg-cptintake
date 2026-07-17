import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileProposalStore } from "../src/store.js";
import { NowCertsGateway } from "../src/gateway.js";
import { InMemoryNowCertsSearch } from "../src/documents/duplicate-search.js";
import { StubIntakeParser } from "../src/intake/parser.js";
import { NoopEnricher, StubEnricher } from "../src/intake/enricher.js";
import { runIntake } from "../src/intake/intake-builder.js";
import { INTAKE_SCHEMA_VERSION } from "../src/intake/intake-schema.js";

const INSURED_CREATE_CONTRACT = {
  method: "api",
  path: "POST api/Insured/Insert",
  contract_source: "official NowCerts API catalog v2.1.5",
  checked_at: "2026-07-17",
  supports_operation: "create",
};

async function makeGateway() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "nowcerts-intake-test-"));
  return new NowCertsGateway({ store: new FileProposalStore(dataDir), mode: "shadow" });
}

function iField(field, value, status = "ok", { enriched = false } = {}) {
  const cite =
    status === "ok"
      ? {
          provenance: enriched ? "enrichment" : "intake_text",
          reference: enriched ? "Secretary of State — GA" : "new-business intake",
          excerpt: `${field}: ${value}`,
        }
      : null;
  return { field, value, status, citation: cite };
}

// Build a parsed-intake fixture with one insured record (+ optional overrides).
function intakeFixture({ fields, coverage_lines = ["General Liability", "Workers Comp"], extraRecords = [] } = {}) {
  return {
    schema_version: INTAKE_SCHEMA_VERSION,
    submitted_by: "gretchen",
    raw_text: "placeholder",
    coverage_lines,
    records: [
      {
        entity: "insured",
        operation: "create",
        role: "primary_insured",
        write_target: "nowcerts",
        fields:
          fields ?? [
            iField("commercial_name", "Blue Ridge Landscaping LLC"),
            iField("email", "owner@blueridge.example"),
            iField("phone", "770-555-0100"),
            iField("address_line", "12 Peachtree St"),
            iField("city", "Atlanta"),
            iField("state", "GA"),
            iField("zip", "30303"),
            // Not part of the insured AMS schema -> must live on the PDF.
            iField("current_carrier", "Old Mutual"),
            iField("renewal_date", "2026-11-01"),
          ],
      },
      ...extraRecords,
    ],
  };
}

function makeRun(gateway, parsed, { enricher = new NoopEnricher(), search = new InMemoryNowCertsSearch(), write_contracts } = {}) {
  const rawText = "raw intake text";
  const parser = new StubIntakeParser({ [rawText]: parsed });
  return runIntake(gateway, {
    parser,
    raw_text: rawText,
    submitted_by: "gretchen",
    enricher,
    search,
    write_contracts,
  });
}

test("clean intake queues an approvable insured and keeps non-AMS fields on the PDF", async () => {
  const gateway = await makeGateway();
  const result = await makeRun(gateway, intakeFixture(), { write_contracts: { insured: INSURED_CREATE_CONTRACT } });

  assert.equal(result.status, "INTAKE_DRAFTED");
  assert.equal(result.insured.status, "PREPARED");
  assert.equal(result.insured.prepared.status, "READY_FOR_APPROVAL");

  // AMS routing: schema fields land in ams_fields; current_carrier/renewal_date
  // are not insured fields, so they live only on the PDF.
  const rec = result.pdf_record.records[0];
  const ams = rec.ams_fields.map((f) => f.field);
  const pdfOnly = rec.pdf_only_fields.map((f) => f.field);
  assert.ok(ams.includes("commercial_name"));
  assert.ok(pdfOnly.includes("current_carrier"));
  assert.ok(pdfOnly.includes("renewal_date"));
  assert.ok(!ams.includes("current_carrier"));
});

test("intake with no name (identity) needs information before any AMS write", async () => {
  const gateway = await makeGateway();
  const parsed = intakeFixture({
    fields: [iField("email", "someone@example.com"), iField("phone", "770-555-0100")],
  });
  const result = await makeRun(gateway, parsed, { write_contracts: { insured: INSURED_CREATE_CONTRACT } });
  assert.equal(result.insured.prepared.status, "NEEDS_INFORMATION");
});

test("duplicate existing insured blocks the create", async () => {
  const gateway = await makeGateway();
  const search = new InMemoryNowCertsSearch([
    { entity: "insured", database_id: "INS-1", values: { email: "owner@blueridge.example" } },
  ]);
  const result = await makeRun(gateway, intakeFixture(), {
    search,
    write_contracts: { insured: INSURED_CREATE_CONTRACT },
  });
  assert.equal(result.insured.status, "DUPLICATE_FOUND");
  assert.equal(result.insured.prepared, null);
});

test("an ambiguous AMS field surfaces as a conflict and stops approval", async () => {
  const gateway = await makeGateway();
  const parsed = intakeFixture({
    fields: [
      iField("commercial_name", "Blue Ridge Landscaping LLC"),
      iField("email", "owner@blueridge.example"),
      iField("state", "GA", "ambiguous"),
    ],
  });
  const result = await makeRun(gateway, parsed, { write_contracts: { insured: INSURED_CREATE_CONTRACT } });
  assert.equal(result.insured.prepared.status, "CONFLICT");
  assert.ok(result.insured.prepared.proposal.conflicts.some((c) => c.field === "state"));
});

test("enrichment fills a missing field but only with a real source citation", async () => {
  const gateway = await makeGateway();
  const parsed = intakeFixture({
    fields: [
      iField("commercial_name", "Blue Ridge Landscaping LLC"),
      iField("email", "owner@blueridge.example"),
      // state intentionally absent from the intake
    ],
  });
  const enricher = new StubEnricher([
    { entity: "insured", field: "state", value: "GA", reference: "Secretary of State — GA", excerpt: "Registered agent state: GA" },
  ]);
  const result = await makeRun(gateway, parsed, {
    enricher,
    write_contracts: { insured: INSURED_CREATE_CONTRACT },
  });
  const stateChange = result.insured.prepared.proposal.changes.find((c) => c.field === "state");
  assert.ok(stateChange, "enriched state should be proposed");
  assert.equal(stateChange.source.kind, "trusted_system");
  assert.equal(stateChange.proposed, "GA");
});

test("enricher never fabricates: a fact without a source is not returned", async () => {
  const enricher = new StubEnricher([{ entity: "insured", field: "state", value: "GA" }]);
  const out = await enricher.enrich({ entity: "insured", fields: [] });
  assert.deepEqual(out, []);
});

test("draft is produced even without a verified write contract (nothing queued yet)", async () => {
  const gateway = await makeGateway();
  const result = await makeRun(gateway, intakeFixture());
  assert.equal(result.status, "INTAKE_DRAFTED");
  assert.equal(result.insured.status, "NEEDS_WRITE_CONTRACT");
  assert.equal(result.insured.prepared, null);
  // The full record is still assembled for the PDF.
  assert.ok(result.pdf_record.records[0].ams_fields.length > 0);
  assert.deepEqual(result.pdf_record.coverage_lines, ["General Liability", "Workers Comp"]);
});
