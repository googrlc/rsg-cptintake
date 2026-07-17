import { test } from "node:test";
import assert from "node:assert/strict";
import { commitApprovedInsured, extractInsuredFields, normalizeValue, classifyMatch, canonicalName } from "../src/executor/insured-executor.js";

const NOW = () => "2026-07-17T21:00:00.000Z";

function approvedRecord(overrides = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    status: "SHADOW_APPROVED",
    fingerprint: "fp-abc",
    receipt: { approved_by: "gretchen" },
    proposal: {
      actor: "gretchen",
      entity_type: "insured",
      operation: "create",
      changes: [
        { field: "commercialName", proposed: "Acme Welding LLC" },
        { field: "addressLine1", proposed: "123 Industrial Way" },
        { field: "city", proposed: "Dayton" },
        { field: "state", proposed: "OH" },
        { field: "zipCode", proposed: "45402" },
        { field: "insuredType", proposed: "0" },
      ],
    },
    ...overrides,
  };
}

function makeStore() {
  return { saved: [], audits: [], async save(r) { this.saved.push(r); }, async audit(e) { this.audits.push(e); } };
}

const SAVED_MATCH = {
  commercialName: "Acme Welding LLC",
  addressLine1: "123 Industrial Way",
  city: "Dayton",
  state: "OH",
  zipCode: "45402",
};

function makeWriteClient(result = { ok: true, insured_database_id: "NEW-INSURED-1" }, readback = SAVED_MATCH) {
  return {
    calls: [],
    async insertInsuredProspect(payload) { this.calls.push(payload); return result; },
    async getInsuredById() { return readback; },
  };
}

test("happy path: no duplicate, commit once, read-back matches -> VERIFIED", async () => {
  const store = makeStore();
  const writeClient = makeWriteClient();
  const readClient = { async searchInsureds() { return []; }, async getInsured() { return SAVED_MATCH; } };
  const record = approvedRecord();

  const result = await commitApprovedInsured({ record, store, writeClient, readClient, now: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.receipt.written_to_nowcerts, true);
  assert.equal(result.receipt.insured_database_id, "NEW-INSURED-1");
  assert.equal(writeClient.calls.length, 1);
  assert.equal(writeClient.calls[0].type, 1, "creates a Prospect");
  assert.equal(record.status, "COMMITTED_VERIFIED");
  assert.ok(store.audits.some((a) => a.event === "live_commit" && a.verified === true));
});

test("near/exact match -> DUPLICATE_REVIEW (confirm, not silent create), nothing written", async () => {
  const store = makeStore();
  const writeClient = makeWriteClient();
  // Existing "Acme Welding" vs incoming "Acme Welding LLC" -> LIKELY, needs confirm.
  const readClient = { async searchInsureds() { return [{ databaseId: "EXISTING-9", commercialName: "Acme Welding" }]; }, async getInsured() { throw new Error("should not be called"); } };

  const result = await commitApprovedInsured({ record: approvedRecord(), store, writeClient, readClient, now: NOW });

  assert.equal(result.ok, false);
  assert.equal(result.status, "DUPLICATE_REVIEW");
  assert.equal(result.requires_confirmation, true);
  assert.equal(result.matches[0].match, "LIKELY");
  assert.equal(writeClient.calls.length, 0, "no write until confirmed");
});

test("override=true confirms past the duplicate review and writes", async () => {
  const store = makeStore();
  const writeClient = makeWriteClient();
  const readClient = { async searchInsureds() { return [{ databaseId: "EXISTING-9", commercialName: "Acme Welding" }]; }, async getInsured() { return SAVED_MATCH; } };

  const result = await commitApprovedInsured({ record: approvedRecord(), store, writeClient, readClient, override: true, now: NOW });

  assert.equal(result.status, "VERIFIED");
  assert.equal(writeClient.calls.length, 1);
});

test("read-back tolerates entity-suffix normalization on the name -> VERIFIED", async () => {
  const store = makeStore();
  // Sent "Acme Welding LLC"; AMS saved it as "Acme Welding" -> still VERIFIED.
  const writeClient = makeWriteClient(undefined, { ...SAVED_MATCH, commercialName: "Acme Welding" });
  const readClient = { async searchInsureds() { return []; } };

  const result = await commitApprovedInsured({ record: approvedRecord(), store, writeClient, readClient, now: NOW });

  assert.equal(result.status, "VERIFIED");
  assert.deepEqual(result.receipt.mismatched_fields, []);
});

test("classifyMatch and canonicalName handle entity suffixes", () => {
  assert.equal(classifyMatch("Acme Welding", "Acme Welding LLC"), "LIKELY");
  assert.equal(classifyMatch("Acme Welding LLC", "Acme Welding LLC"), "EXACT");
  assert.equal(classifyMatch("Globex Corp", "Acme Welding LLC"), "NONE");
  assert.equal(canonicalName("ZZZZ Enterprise, L.L.C."), "zzzz enterprise");
});

test("read-back mismatch -> MISMATCH, not reported as success", async () => {
  const store = makeStore();
  const writeClient = makeWriteClient(undefined, { ...SAVED_MATCH, city: "Columbus" });
  const readClient = { async searchInsureds() { return []; } };
  const record = approvedRecord();

  const result = await commitApprovedInsured({ record, store, writeClient, readClient, now: NOW });

  assert.equal(result.ok, false);
  assert.equal(result.status, "MISMATCH");
  assert.deepEqual(result.receipt.mismatched_fields, ["city"]);
  assert.equal(record.status, "COMMITTED_MISMATCH");
});

test("already committed -> idempotent, no second write", async () => {
  const store = makeStore();
  const writeClient = makeWriteClient();
  const readClient = { async searchInsureds() { return []; }, async getInsured() { return SAVED_MATCH; } };
  const record = approvedRecord({ live_receipt: { written_to_nowcerts: true, verified: true, insured_database_id: "ALREADY-1" } });

  const result = await commitApprovedInsured({ record, store, writeClient, readClient, now: NOW });

  assert.equal(result.status, "ALREADY_COMMITTED");
  assert.equal(writeClient.calls.length, 0);
});

test("not approved -> blocked before any write", async () => {
  const writeClient = makeWriteClient();
  const readClient = { async searchInsureds() { return []; }, async getInsured() { return SAVED_MATCH; } };
  const result = await commitApprovedInsured({ record: approvedRecord({ status: "READY_FOR_APPROVAL" }), store: makeStore(), writeClient, readClient, now: NOW });
  assert.equal(result.status, "NOT_APPROVED");
  assert.equal(writeClient.calls.length, 0);
});

test("write connector not configured -> NOT_ENABLED, no write", async () => {
  const readClient = { async searchInsureds() { return []; }, async getInsured() { return SAVED_MATCH; } };
  const result = await commitApprovedInsured({ record: approvedRecord(), store: makeStore(), writeClient: null, readClient, now: NOW });
  assert.equal(result.status, "NOT_ENABLED");
});

test("field helpers", () => {
  assert.equal(normalizeValue("  Acme   Welding  "), "acme welding");
  assert.deepEqual(extractInsuredFields([{ field: "city", proposed: "Dayton" }]), { city: "Dayton" });
});
