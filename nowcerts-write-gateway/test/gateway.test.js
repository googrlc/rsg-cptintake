import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileProposalStore } from "../src/store.js";
import { NowCertsGateway } from "../src/gateway.js";
import { assessPrewriteConcurrency } from "../src/validator.js";

async function makeGateway() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "nowcerts-gateway-test-"));
  return new NowCertsGateway({ store: new FileProposalStore(dataDir), mode: "shadow" });
}

function proposal(overrides = {}) {
  const base = {
    actor: "gretchen",
    operation: "update",
    entity_type: "contact",
    target: {
      database_id: "0012345",
      display_name: "Alex Example",
      match_status: "EXACT",
      match_reason: "databaseId and email match",
      snapshot: {
        observed_at: "2026-07-17T14:01:00-04:00",
        version_token: "change-100",
        values: { business_email: "old@example.com" },
      },
    },
    changes: [
      {
        field: "business_email",
        current: "old@example.com",
        proposed: "new@example.com",
        clear: false,
        source: {
          kind: "document",
          reference: "signed-application.pdf",
          location: "page 2",
          excerpt: "Business email: new@example.com",
          captured_at: "2026-07-17T14:00:00-04:00",
        },
      },
    ],
    duplicate_risk: "LOW",
    missing_fields: [],
    conflicts: [],
    write_contract: {
      method: "ui",
      path: "Insured > Contacts > Edit Contact",
      contract_source: "live authenticated form inspection",
      checked_at: "2026-07-17",
      supports_operation: "update",
    },
    read_back_path: "Insured > Contacts > Contact Detail",
    read_back_fields: ["business_email"],
    master_data: null,
  };
  return { ...base, ...overrides };
}

test("valid proposal becomes ready and keeps field-level evidence", async () => {
  const gateway = await makeGateway();
  const result = await gateway.prepare(proposal());
  assert.equal(result.status, "READY_FOR_APPROVAL");
  assert.equal(result.proposal.changes[0].source.location, "page 2");
  assert.equal(result.expected_confirmation, "CONFIRM UPDATE Alex Example");
});

test("missing information stops approval", async () => {
  const gateway = await makeGateway();
  const result = await gateway.prepare(proposal({ missing_fields: ["last_name"] }));
  assert.equal(result.status, "NEEDS_INFORMATION");
  const approval = await gateway.approve({
    proposal_id: result.id,
    approver: "gretchen",
    confirmation: "CONFIRM UPDATE Alex Example",
  });
  assert.equal(approval.ok, false);
});

test("conflicts stop approval", async () => {
  const gateway = await makeGateway();
  const result = await gateway.prepare(
    proposal({ conflicts: [{ field: "business_email", description: "Two sources disagree" }] }),
  );
  assert.equal(result.status, "CONFLICT");
});

test("Gretchen cannot approve carrier master data", async () => {
  const gateway = await makeGateway();
  const carrier = proposal({
    operation: "create",
    entity_type: "carrier",
    target: {
      database_id: null,
      display_name: "Example Insurance Company",
      match_status: "NONE",
      match_reason: "No legal-name or NAIC match",
      snapshot: null,
    },
    write_contract: {
      method: "ui",
      path: "Agency Setup > Carriers > Add Carrier",
      contract_source: "live authenticated form inspection",
      checked_at: "2026-07-17",
      supports_operation: "create",
    },
    master_data: {
      is_master: true,
      downstream_scope: "Agency-wide carrier selection",
      named_confirmation: "Confirm create carrier: Example Insurance Company",
    },
  });
  const ready = await gateway.prepare(carrier);
  assert.equal(ready.status, "READY_FOR_APPROVAL");
  const denied = await gateway.approve({
    proposal_id: ready.id,
    approver: "gretchen",
    confirmation: ready.expected_confirmation,
  });
  assert.equal(denied.status, "FORBIDDEN");
});

test("approval is exact, idempotent, and never writes in shadow mode", async () => {
  const gateway = await makeGateway();
  const ready = await gateway.prepare(proposal());
  const wrong = await gateway.approve({
    proposal_id: ready.id,
    approver: "gretchen",
    confirmation: "yes",
  });
  assert.equal(wrong.status, "CONFIRMATION_REQUIRED");

  const approved = await gateway.approve({
    proposal_id: ready.id,
    approver: "gretchen",
    confirmation: ready.expected_confirmation,
  });
  assert.equal(approved.status, "SHADOW_APPROVED");
  assert.equal(approved.receipt.written_to_nowcerts, false);

  const repeated = await gateway.approve({
    proposal_id: ready.id,
    approver: "gretchen",
    confirmation: ready.expected_confirmation,
  });
  assert.equal(repeated.status, "SHADOW_APPROVED");
  assert.equal(repeated.receipt.approved_at, approved.receipt.approved_at);
});

test("overlapping pending proposals for one client are blocked", async () => {
  const gateway = await makeGateway();
  const first = await gateway.prepare(proposal());
  assert.equal(first.status, "READY_FOR_APPROVAL");
  const second = await gateway.prepare(proposal());
  assert.equal(second.status, "CONFLICT");
  assert.match(second.proposal.conflicts[0].description, /Another active proposal/);
});

test("same-field live change blocks and unrelated change forces a new preview", () => {
  const prepared = proposal();
  const conflict = assessPrewriteConcurrency(prepared, {
    database_id: "0012345",
    version_token: "change-101",
    values: { business_email: "client-updated@example.com" },
  });
  assert.equal(conflict.status, "BLOCK_CONFLICT");
  assert.deepEqual(conflict.overlapping_fields, ["business_email"]);

  prepared.target.snapshot.values.phone = "5551112222";
  const unrelated = assessPrewriteConcurrency(prepared, {
    database_id: "0012345",
    version_token: "change-102",
    values: { business_email: "old@example.com", phone: "5559990000" },
  });
  assert.equal(unrelated.status, "REPREVIEW");
  assert.deepEqual(unrelated.overlapping_fields, []);
});

test("server refuses an unimplemented live mode", async () => {
  const store = new FileProposalStore(await mkdtemp(path.join(os.tmpdir(), "nowcerts-live-test-")));
  assert.throws(
    () => new NowCertsGateway({ store, mode: "live" }),
    /Live mode is not implemented/,
  );
});
