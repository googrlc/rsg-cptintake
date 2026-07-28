import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCrmSubmission,
  buildFacts,
  enrichPayload,
  submissionAgent,
  INTAKE_SOURCE,
  AGENT_LAMAR,
  AGENT_GRETCHEN,
} from "../src/intake/crm-submission.js";
import { submitToCrm, CrmWriteStatus } from "../src/intake/crm-writer.js";

const CITATION = 'SRC-001 Golden Rose Risk Profile.pdf';

function bundle({ payload = {}, research = null, existingClientId = null } = {}) {
  return {
    intake_id: "3f9d1c22-4a7e-4b31-9c02-2f5b8a6d7e10",
    created_at: "2026-06-03T12:00:00.000Z",
    client: { display_name: "Jarah Group LLC", existing_client_id: existingClientId },
    source_index: [{
      source_id: "SRC-001", kind: "pdf",
      reference: "Golden Rose Risk Profile.pdf", captured_at: "2026-06-03T12:00:00.000Z",
    }],
    research,
    assessment: { summary: "Commercial plumbing contractor, 14 employees." },
    synthesis: { payload },
  };
}

const fullPayload = {
  action: "crm_intake_upsert",
  approval_required: true,
  duplicate_search: { account: ["name"] },
  account: {
    account_name: "Jarah Group LLC",
    legal_name: "Jarah Group Limited Liability Company",
    fein: "12-3456789",
    entity_type: "LLC",
    address: "14 Mill Road", city: "Trenton", state: "NJ", zip: "08610",
    phone: "609-555-0134", email: "ops@jarah.example",
    account_type: "Commercial Lines",
    operations_summary: "Commercial plumbing contractor.",
    annual_revenue: 2400000, estimated_payroll: 780000, employee_count: 14,
  },
  contacts: [
    { full_name: "Jane Ukoh", role: "Owner", phone: "609-555-0135", email: "jane@jarah.example", date_of_birth: "1979-04-02" },
  ],
  opportunities: [
    { line_of_business: "workers compensation", stage: "Discovery" },
    { line_of_business: "GL" },
  ],
  underwriting_flags: [{ flag: "Prior pollution claim", severity: "high", why_needed: "Affects GL appetite" }],
  note: { title: "Discovery call", note_type: "Underwriting Summary", body: "Facts vs assumptions." },
};

// --- facts -----------------------------------------------------------------

test("account detail that used to die on the report becomes cited CRM facts", () => {
  const facts = buildFacts(fullPayload, { citation: CITATION, sourceRef: "Golden Rose Risk Profile.pdf" });
  const byLabel = Object.fromEntries(facts.map((f) => [f.fact_label, f]));

  // Revenue, payroll and headcount had no certified AMS contract, so they were
  // stranded in `assessment_only`. They are real CRM data and now land as facts.
  assert.equal(byLabel["Annual Revenue"].fact_value, "2400000");
  assert.equal(byLabel["Estimated Payroll"].fact_value, "780000");
  assert.equal(byLabel["Employee Count"].fact_value, "14");
  assert.equal(byLabel["Operations Summary"].fact_value, "Commercial plumbing contractor.");

  // Every fact says where it came from — client_facts has the columns for it.
  for (const fact of facts) {
    assert.equal(fact.source, CITATION);
    assert.equal(fact.source_ref, "Golden Rose Risk Profile.pdf");
  }
});

test("EIN and date of birth are restricted; ordinary contact detail is not", () => {
  const facts = buildFacts(fullPayload, { citation: CITATION });
  const byLabel = Object.fromEntries(facts.map((f) => [`${f.entity_type}:${f.fact_label}`, f]));
  assert.equal(byLabel["Account:EIN"].sensitivity, "restricted");
  assert.equal(byLabel["Contact:Date of Birth"].sensitivity, "restricted");
  assert.equal(byLabel["Account:Phone"].sensitivity, "standard");
  assert.equal(byLabel["Contact:Email"].sensitivity, "standard");
});

test("facts name the entity exactly as the entity will be created", () => {
  // Hermes resolves a fact to its entity by display name. A name that does not
  // match the account/contact it was built from is silently dropped at the far
  // end, so this is the assertion that keeps facts attached to anything at all.
  const facts = buildFacts(fullPayload, { citation: CITATION });
  const names = new Set(facts.map((f) => f.entity));
  assert.deepEqual([...names].sort(), ["Jane Ukoh", "Jarah Group LLC"]);
});

test("an underwriting flag is flattened to one readable line, not a JSON blob", () => {
  const facts = buildFacts(fullPayload, { citation: CITATION });
  const flag = facts.find((f) => f.fact_label === "Underwriting Flag");
  assert.equal(flag.fact_value, "Prior pollution claim (high) — Affects GL appetite");
  assert.ok(!flag.fact_value.includes("{"));
});

test("absent values produce no fact at all, rather than an empty one", () => {
  const facts = buildFacts({ account: { account_name: "Solo Co" } }, { citation: CITATION });
  assert.deepEqual(facts, [], "nothing sourced means nothing emitted");
});

test("a contact with no resolvable name contributes no facts", () => {
  const facts = buildFacts(
    { account: { account_name: "Solo Co" }, contacts: [{ phone: "609-555-0100" }] },
    { citation: CITATION },
  );
  assert.deepEqual(facts, []);
});

// --- enrichment ------------------------------------------------------------

test("research fills a blank NAICS but never overwrites a sourced one", () => {
  const filled = enrichPayload(bundle({ research: { naics: "238220", sic: "1711" } }), fullPayload);
  assert.equal(filled.account.naics, "238220");

  const sourced = { ...fullPayload, account: { ...fullPayload.account, naics: "111111" } };
  const kept = enrichPayload(bundle({ research: { naics: "238220" } }), sourced);
  assert.equal(kept.account.naics, "111111", "a sourced value is never corrected by research");
});

test("lines of business are normalized so the pipeline does not fragment", () => {
  const { opportunities } = enrichPayload(bundle(), fullPayload);
  assert.deepEqual(opportunities.map((o) => o.line_of_business), ["Worker's Compensation", "General Liability"]);
});

test("each opportunity carries its own owner and its provenance", () => {
  const { opportunities } = enrichPayload(bundle(), {
    ...fullPayload,
    opportunities: [{ line_of_business: "Homeowners" }, { line_of_business: "General Liability" }],
  });
  // The agency's split is per LINE, not per intake. Losing it puts every line of
  // every intake on one desk.
  assert.deepEqual(JSON.parse(opportunities[0].assigned_to), ["Gretchen Coates"]);
  assert.deepEqual(JSON.parse(opportunities[1].assigned_to), ["Lamar Coates"]);
  assert.match(opportunities[0].description, /^Source: pdf "Golden Rose Risk Profile\.pdf"/);
});

test("the contract fields Hermes validates are always present", () => {
  const stripped = enrichPayload(bundle(), { account: { account_name: "Solo Co" } });
  assert.equal(stripped.action, "crm_intake_upsert");
  assert.equal(stripped.approval_required, true);
  assert.deepEqual(stripped.duplicate_search, {});
});

// --- agent routing ---------------------------------------------------------

test("an all-personal-lines intake goes to Gretchen; anything commercial to Lamar", () => {
  assert.equal(submissionAgent({ opportunities: [{ line_of_business: "Homeowners" }, { line_of_business: "Personal Auto" }] }), AGENT_GRETCHEN);
  assert.equal(submissionAgent({ opportunities: [{ line_of_business: "Homeowners" }, { line_of_business: "General Liability" }] }), AGENT_LAMAR);
  assert.equal(submissionAgent({ account: { account_type: "Personal Lines" }, opportunities: [] }), AGENT_GRETCHEN);
  assert.equal(submissionAgent({}), AGENT_LAMAR);
});

// --- submission ------------------------------------------------------------

test("the submission is idempotent on the intake id", () => {
  const submission = buildCrmSubmission(bundle({ payload: fullPayload }));
  assert.equal(submission.idempotency_key, "rsg-intake-gate:3f9d1c22-4a7e-4b31-9c02-2f5b8a6d7e10");
  assert.equal(submission.source, INTAKE_SOURCE);
  assert.equal(submission.captured_at, "2026-06-03T12:00:00.000Z");
  assert.equal(submission.intake_kind, "full_intake");
});

test("the submission carries the whole intake, not just the pipeline", () => {
  const { synthesized_payload: payload } = buildCrmSubmission(bundle({ payload: fullPayload }));
  assert.equal(payload.account.account_name, "Jarah Group LLC");
  assert.equal(payload.contacts.length, 1);
  assert.equal(payload.opportunities.length, 2);
  assert.ok(payload.facts.length > 5, "facts[] is what the retrieval layer reads");
  assert.equal(payload.note.title, "Discovery call");
});

test("source metadata travels, but the source text itself does not", () => {
  const submission = buildCrmSubmission(bundle({ payload: fullPayload }), { submittedBy: "lamar" });
  assert.deepEqual(submission.documents, [{ type: "pdf", source_file: "Golden Rose Risk Profile.pdf" }]);
  assert.equal(submission.synthesized_payload.source.submitted_by, "lamar");
  assert.equal(submission.synthesized_payload.source.date, "2026-06-03");
  assert.match(submission.synthesized_payload.source.source_ref, /^rsg-intake-gate:/);
});

// --- the writer ------------------------------------------------------------

const okClient = (response = {}) => ({
  canSubmitIntake: true,
  submitIntake: async () => ({ submission_id: "sub-1", status: "received", ...response }),
});

test("the writer is off unless the flag is set", async () => {
  const report = await submitToCrm(bundle({ payload: fullPayload }), { client: okClient(), enabled: false });
  assert.equal(report.status, CrmWriteStatus.DISABLED);
  assert.equal(report.submission_id, null);
});

test("no configured client reports NOT_CONFIGURED instead of crashing", async () => {
  const report = await submitToCrm(bundle({ payload: fullPayload }), { client: null, enabled: true });
  assert.equal(report.status, CrmWriteStatus.NOT_CONFIGURED);
});

test("a missing intake key is named as the fix, not reported as an outage", async () => {
  const client = { canSubmitIntake: false, submitIntake: async () => { throw new Error("unreachable"); } };
  const report = await submitToCrm(bundle({ payload: fullPayload }), { client, enabled: true });
  assert.equal(report.status, CrmWriteStatus.NOT_CONFIGURED);
  assert.match(report.detail, /HERMES_INTAKE_KEY_FILE/);
});

test("a successful submission reports what it sent", async () => {
  const report = await submitToCrm(bundle({ payload: fullPayload }), {
    client: okClient(), enabled: true, approvedBy: "lamar",
  });
  assert.equal(report.status, CrmWriteStatus.SUBMITTED);
  assert.equal(report.submission_id, "sub-1");
  assert.equal(report.approved_by, "lamar");
  // Approved before sending, so the CRM commits rather than parking it.
  assert.equal(report.awaiting_approval, false);
  assert.equal(report.opportunity_count, 2);
  assert.equal(report.contact_count, 1);
  assert.ok(report.fact_count > 5);
});

test("an unapproved submission is reported as still waiting on someone", async () => {
  const report = await submitToCrm(bundle({ payload: fullPayload }), { client: okClient(), enabled: true });
  assert.equal(report.approved_by, null);
  assert.equal(report.awaiting_approval, true, "no approver means it parks in the CRM queue");
});

test("the approver rides on the submission so the CRM does not ask a second time", () => {
  // RSG has no Slack. A submission that arrives unapproved waits for a button
  // nobody will ever press, so the approval has to travel with it.
  const approved = buildCrmSubmission(bundle({ payload: fullPayload }), { approvedBy: "lamar" });
  assert.equal(approved.approved_by, "lamar");
  assert.equal(approved.approval_token, "APPROVE ALL");

  const unapproved = buildCrmSubmission(bundle({ payload: fullPayload }));
  assert.ok(!("approved_by" in unapproved), "absent, not null — absent means 'wait for an approver'");
  assert.ok(!("approval_token" in unapproved));
});

test("a committed intake reports the rows that exist, not the rows we sent", async () => {
  // Hermes commits an approved, already-synthesized intake inline and says what
  // it wrote. That is the truth about the intake — the payload counts are not.
  const client = okClient({
    commit: {
      ok: true, status: "complete", client_identifier: "jarah-group-llc:123456789",
      opportunity_count: 2, entity_count: 2, fact_count: 14, note_count: 1,
      opportunity_ids: ["opp-1", "opp-2"], warnings: [],
    },
  });
  const report = await submitToCrm(bundle({ payload: fullPayload }), {
    client, enabled: true, approvedBy: "lamar",
  });
  assert.equal(report.committed, true);
  assert.equal(report.awaiting_approval, false);
  assert.equal(report.submission_status, "complete");
  assert.equal(report.client_identifier, "jarah-group-llc:123456789");
  assert.equal(report.fact_count, 14, "the committed count wins over the payload count");
  assert.equal(report.contact_count, 1, "entities minus the account itself");
  assert.deepEqual(report.opportunity_ids, ["opp-1", "opp-2"]);
});

test("a queued submission is never reported as committed", async () => {
  const report = await submitToCrm(bundle({ payload: fullPayload }), {
    client: okClient({ status: "received" }), enabled: true, approvedBy: "lamar",
  });
  assert.equal(report.committed, false, "'accepted' and 'in the CRM' are different claims");
  assert.equal(report.submission_status, "received");
});

test("a replay is a success, not a duplicate", async () => {
  const report = await submitToCrm(bundle({ payload: fullPayload }), {
    client: okClient({ idempotent_replay: true, status: "awaiting_approval" }),
    enabled: true,
  });
  assert.equal(report.status, CrmWriteStatus.SUBMITTED);
  assert.equal(report.idempotent_replay, true);
});

test("a Hermes outage is reported, never thrown — the intake must still finish", async () => {
  const client = { canSubmitIntake: true, submitIntake: async () => { throw new Error("connect ECONNREFUSED"); } };
  const report = await submitToCrm(bundle({ payload: fullPayload }), { client, enabled: true });
  assert.equal(report.status, CrmWriteStatus.ERROR);
  assert.match(report.detail, /ECONNREFUSED/);
});

test("Hermes' own rejection detail is surfaced, not swallowed", async () => {
  const client = {
    canSubmitIntake: true,
    submitIntake: async () => { throw Object.assign(new Error("source is not a valid value"), { statusCode: 502 }); },
  };
  const report = await submitToCrm(bundle({ payload: fullPayload }), { client, enabled: true });
  assert.match(report.detail, /source is not a valid value/);
  assert.equal(report.status_code, 502);
});

test("an intake with nothing to file is reported rather than submitted", async () => {
  let called = false;
  const client = { canSubmitIntake: true, submitIntake: async () => { called = true; return {}; } };
  const empty = bundle({ payload: { account: {}, opportunities: [] } });
  empty.client.display_name = "";
  const report = await submitToCrm(empty, { client, enabled: true });
  assert.equal(report.status, CrmWriteStatus.NOTHING_TO_WRITE);
  assert.equal(called, false, "an empty intake must not reach the CRM at all");
});

test("nothing in the submission path names NowCerts", () => {
  // The load-bearing rule: an intake is a prospect, and a prospect is not a
  // record of insurance. If an AMS key ever appears in this payload, the intake
  // has started writing to the system of record again.
  const submission = buildCrmSubmission(bundle({ payload: fullPayload }));
  const serialized = JSON.stringify(submission);
  assert.ok(!/nowcerts/i.test(serialized), "the intake submission must never carry an AMS write");
  assert.ok(!/insured_id|insuredDatabaseId/.test(serialized));
});
