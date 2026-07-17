import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileProposalStore } from "../src/store.js";
import { NowCertsGateway } from "../src/gateway.js";
import { assessPrewriteConcurrency } from "../src/validator.js";
import { FieldStatus, reconcileExtraction, ReviewReason, StubExtractor } from "../src/documents/extraction.js";
import { InMemoryNowCertsSearch } from "../src/documents/duplicate-search.js";
import { buildProposal, prepareFromExtraction } from "../src/documents/proposal-builder.js";
import { cleanPolicyExtraction, makeExtraction, validPdf } from "./fixtures.js";
import { inspectPdf } from "../src/documents/pdf-intake.js";
import { classifyDocument } from "../src/documents/classification.js";

test("document class cannot be paired with a different writable entity", () => {
  const result = classifyDocument({
    document_class: "declaration_page",
    candidate_entity: "insured",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "NEEDS_CLASSIFICATION");
  assert.match(result.message, /expects entity "policy"/);
});

const POLICY_CREATE_CONTRACT = {
  method: "api",
  path: "POST api/Policy/InsertPolicy",
  contract_source: "official NowCerts API catalog v2.1.5",
  checked_at: "2026-07-17",
  supports_operation: "create",
};

const CONTACT_UPDATE_CONTRACT = {
  method: "ui",
  path: "Insured > Contacts > Edit Contact",
  contract_source: "live authenticated form inspection",
  checked_at: "2026-07-17",
  supports_operation: "update",
};

async function makeGateway() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "nowcerts-docs-test-"));
  return new NowCertsGateway({ store: new FileProposalStore(dataDir), mode: "shadow" });
}

function field(name, value, status = FieldStatus.OK, excerpt, page = 1) {
  return [name, value, status, excerpt, page];
}

// --- Extractor interface ---------------------------------------------------

test("stub extractor returns registered result keyed by document hash", async () => {
  const accepted = inspectPdf(validPdf(), { filename: "dec.pdf" }).document;
  const seed = cleanPolicyExtraction();
  const extractor = new StubExtractor({ [accepted.sha256]: seed });
  const out = await extractor.extract(accepted);
  assert.equal(out.candidate_entity, "policy");
  assert.equal(out.document_id, accepted.document_id);
});

// --- Happy path: evidence preserved on every field -------------------------

test("clean declaration page becomes an approvable create with per-field evidence", async () => {
  const gateway = await makeGateway();
  const search = new InMemoryNowCertsSearch();
  const { prepared, status } = await prepareFromExtraction(gateway, {
    extraction: cleanPolicyExtraction(),
    actor: "gretchen",
    search,
    write_contract: POLICY_CREATE_CONTRACT,
  });
  assert.equal(status, "PREPARED");
  assert.equal(prepared.status, "READY_FOR_APPROVAL");
  assert.equal(prepared.proposal.duplicate_risk, "LOW");
  for (const change of prepared.proposal.changes) {
    assert.equal(change.source.reference, "doc.pdf");
    assert.match(change.source.location, /^page \d+$/);
    assert.ok(change.source.excerpt.length > 0);
  }
});

// --- Never guess: unsupported / uncited values are quarantined -------------

test("never guesses: an ok field without evidence is quarantined, not proposed", () => {
  const extraction = makeExtraction({
    candidate_entity: "policy",
    fields: [field("policy_number", "P-1"), field("premium", "100.00", FieldStatus.OK, null)],
  });
  const reconciled = reconcileExtraction(extraction);
  const premium = reconciled.needs_review.find((r) => r.field === "premium");
  assert.equal(premium.reason, ReviewReason.NO_EVIDENCE);
  assert.ok(!reconciled.proposed.some((p) => p.field === "premium"));
});

// --- Scanned: unreadable fields, nothing to write --------------------------

test("scanned page with unreadable fields yields nothing to write (no guessing)", async () => {
  const gateway = await makeGateway();
  const extraction = makeExtraction({
    candidate_entity: "policy",
    fields: [
      field("policy_number", null, FieldStatus.UNREADABLE),
      field("carrier_name", null, FieldStatus.UNREADABLE),
      field("effective_date", null, FieldStatus.UNREADABLE),
    ],
  });
  const result = await prepareFromExtraction(gateway, {
    extraction,
    actor: "gretchen",
    search: new InMemoryNowCertsSearch(),
    write_contract: POLICY_CREATE_CONTRACT,
  });
  assert.equal(result.status, "NOTHING_TO_WRITE");
  assert.equal(result.prepared, null);
});

// --- Rotated: ambiguous field is quarantined and blocks approval -----------

test("rotated page with an ambiguous field blocks approval", async () => {
  const gateway = await makeGateway();
  const extraction = cleanPolicyExtraction({
    fields: [
      field("policy_number", "APV-100200", FieldStatus.OK, "Policy Number: APV-100200"),
      field("carrier_name", "Example Insurance Co", FieldStatus.OK, "Carrier: Example Insurance Co"),
      field("line_of_business", "Commercial Auto", FieldStatus.OK, "Line: Commercial Auto"),
      field("effective_date", "2026-08-01", FieldStatus.AMBIGUOUS),
      field("expiration_date", "2027-08-01", FieldStatus.OK, "Expires 08/01/2027"),
    ],
  });
  const reconciled = reconcileExtraction(extraction);
  assert.ok(reconciled.needs_review.some((r) => r.field === "effective_date" && r.reason === ReviewReason.AMBIGUOUS));

  const { prepared } = await prepareFromExtraction(gateway, {
    extraction,
    actor: "gretchen",
    search: new InMemoryNowCertsSearch(),
    write_contract: POLICY_CREATE_CONTRACT,
  });
  assert.notEqual(prepared.status, "READY_FOR_APPROVAL");
});

// --- Incomplete: missing required field blocks approval --------------------

test("incomplete document missing a required field needs information", async () => {
  const gateway = await makeGateway();
  const extraction = makeExtraction({
    candidate_entity: "policy",
    fields: [
      field("policy_number", "P-2", FieldStatus.OK, "Policy Number: P-2"),
      field("carrier_name", "Example Insurance Co", FieldStatus.OK, "Carrier: Example Insurance Co"),
      field("line_of_business", "GL", FieldStatus.OK, "Line: GL"),
      field("effective_date", "2026-08-01", FieldStatus.OK, "Effective 08/01/2026"),
      // expiration_date (required) omitted entirely
    ],
  });
  const { prepared } = await prepareFromExtraction(gateway, {
    extraction,
    actor: "gretchen",
    search: new InMemoryNowCertsSearch(),
    write_contract: POLICY_CREATE_CONTRACT,
  });
  assert.equal(prepared.status, "NEEDS_INFORMATION");
  assert.ok(prepared.proposal.missing_fields.includes("expiration_date"));
});

// --- Conflicting: an explicit conflict field routes to conflicts -----------

test("conflicting non-required field surfaces as a CONFLICT that stops approval", async () => {
  const gateway = await makeGateway();
  const extraction = cleanPolicyExtraction({
    fields: [
      field("policy_number", "APV-100200", FieldStatus.OK, "Policy Number: APV-100200"),
      field("carrier_name", "Example Insurance Co", FieldStatus.OK, "Carrier: Example Insurance Co"),
      field("line_of_business", "Commercial Auto", FieldStatus.OK, "Line: Commercial Auto"),
      field("effective_date", "2026-08-01", FieldStatus.OK, "Effective 08/01/2026"),
      field("expiration_date", "2027-08-01", FieldStatus.OK, "Expires 08/01/2027"),
      field("premium", "4200.00", FieldStatus.CONFLICT),
    ],
  });
  const { prepared } = await prepareFromExtraction(gateway, {
    extraction,
    actor: "gretchen",
    search: new InMemoryNowCertsSearch(),
    write_contract: POLICY_CREATE_CONTRACT,
  });
  assert.equal(prepared.status, "CONFLICT");
  assert.ok(prepared.proposal.conflicts.some((c) => c.field === "premium"));
});

// --- Conflicting: two readings of one field are both quarantined -----------

test("two conflicting readings of one field are both quarantined", () => {
  const extraction = makeExtraction({
    candidate_entity: "policy",
    fields: [
      field("policy_number", "P-A", FieldStatus.OK, "Policy Number: P-A", 1),
      field("policy_number", "P-B", FieldStatus.OK, "Policy Number: P-B", 2),
    ],
  });
  const reconciled = reconcileExtraction(extraction);
  assert.ok(!reconciled.proposed.some((p) => p.field === "policy_number"));
  assert.ok(reconciled.needs_review.some((r) => r.field === "policy_number" && r.reason === ReviewReason.DUPLICATE_FIELD));
});

// --- Duplicate: search finds an existing record, create is refused ---------

test("duplicate existing record blocks a create", async () => {
  const gateway = await makeGateway();
  const search = new InMemoryNowCertsSearch([
    { entity: "policy", database_id: "POL-9", values: { policy_number: "APV-100200" } },
  ]);
  const result = await prepareFromExtraction(gateway, {
    extraction: cleanPolicyExtraction(),
    actor: "gretchen",
    search,
    write_contract: POLICY_CREATE_CONTRACT,
  });
  assert.equal(result.status, "DUPLICATE_FOUND");
  assert.equal(result.search.match_status, "EXACT");
  assert.equal(result.prepared, null);
});

// --- Concurrent create: a record created after preview is caught on re-run --

test("a record created by someone else after preview is caught on the next run", async () => {
  const gateway = await makeGateway();
  const search = new InMemoryNowCertsSearch();
  const first = await prepareFromExtraction(gateway, {
    extraction: cleanPolicyExtraction(),
    actor: "gretchen",
    search,
    write_contract: POLICY_CREATE_CONTRACT,
  });
  assert.equal(first.prepared.status, "READY_FOR_APPROVAL");

  // Simulate another employee/client creating the record in NowCerts meanwhile.
  search.add({ entity: "policy", database_id: "POL-NEW", values: { policy_number: "APV-100200" } });

  const second = await prepareFromExtraction(gateway, {
    extraction: cleanPolicyExtraction(),
    actor: "gretchen",
    search,
    write_contract: POLICY_CREATE_CONTRACT,
  });
  assert.equal(second.status, "DUPLICATE_FOUND");
});

// --- Concurrent update: client changed the same field after preview --------

test("update caught by pre-write reread when the client changed the same field", async () => {
  const gateway = await makeGateway();
  const search = new InMemoryNowCertsSearch([
    {
      entity: "contact",
      database_id: "C-1",
      version_token: "v1",
      values: { business_email: "old@example.com", phone: "5551112222", title: "Manager" },
    },
  ]);
  const extraction = makeExtraction({
    document_class: "contact_document",
    candidate_entity: "contact",
    candidate_operation: "update",
    fields: [
      field("business_email", "old@example.com", FieldStatus.OK, "Email: old@example.com"),
      field("phone", "5559998888", FieldStatus.OK, "Phone: 555-999-8888"),
    ],
  });
  const { prepared, status } = await prepareFromExtraction(gateway, {
    extraction,
    actor: "gretchen",
    search,
    write_contract: CONTACT_UPDATE_CONTRACT,
  });
  assert.equal(status, "PREPARED");
  assert.equal(prepared.status, "READY_FOR_APPROVAL");

  // Client changed the same field in NowCerts after the preview.
  const conflict = assessPrewriteConcurrency(prepared.proposal, {
    database_id: "C-1",
    version_token: "v2",
    values: { business_email: "old@example.com", phone: "5550000000" },
  });
  assert.equal(conflict.status, "BLOCK_CONFLICT");
  assert.deepEqual(conflict.overlapping_fields, ["phone"]);

  // An unrelated change (title — not a proposed field) forces a re-preview
  // rather than a silent overwrite, preserving the client's edit.
  const unrelated = assessPrewriteConcurrency(prepared.proposal, {
    database_id: "C-1",
    version_token: "v3",
    values: { business_email: "old@example.com", phone: "5551112222", title: "Director" },
  });
  assert.equal(unrelated.status, "REPREVIEW");
});

// --- Unclassified document stops before any proposal -----------------------

test("unrecognized document class stops for classification", async () => {
  const gateway = await makeGateway();
  const extraction = makeExtraction({ document_class: "mystery_form", candidate_entity: "policy" });
  const result = await prepareFromExtraction(gateway, {
    extraction,
    actor: "gretchen",
    search: new InMemoryNowCertsSearch(),
    write_contract: POLICY_CREATE_CONTRACT,
  });
  assert.equal(result.status, "NEEDS_CLASSIFICATION");
});

// --- A verified write contract is mandatory --------------------------------

test("missing verified write contract blocks proposal construction", async () => {
  const result = await buildProposal({
    extraction: cleanPolicyExtraction(),
    actor: "gretchen",
    search: new InMemoryNowCertsSearch(),
    write_contract: null,
  });
  assert.equal(result.status, "NEEDS_WRITE_CONTRACT");
});
