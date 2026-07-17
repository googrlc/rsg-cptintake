import { test } from "node:test";
import assert from "node:assert/strict";
import { commitApprovedInsured, extractInsuredFields, normalizeValue } from "../src/executor/insured-executor.js";

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

function makeWriteClient(result = { ok: true, insured_database_id: "NEW-INSURED-1" }) {
  return { calls: [], async insertInsuredProspect(payload) { this.calls.push(payload); return result; } };
}

const SAVED_MATCH = {
  commercialName: "Acme Welding LLC",
  addressLine1: "123 Industrial Way",
  city: "Dayton",
  state: "OH",
  zipCode: "45402",
};

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

test("duplicate found in pre-write reread -> DUPLICATE_STOP, nothing written", async () => {
  const store = makeStore();
  const writeClient = makeWriteClient();
  const readClient = { async searchInsureds() { return [{ databaseId: "EXISTING-9", commercialName: "acme welding llc" }]; }, async getInsured() { throw new Error("should not be called"); } };

  const result = await commitApprovedInsured({ record: approvedRecord(), store, writeClient, readClient, now: NOW });

  assert.equal(result.ok, false);
  assert.equal(result.status, "DUPLICATE_STOP");
  assert.equal(writeClient.calls.length, 0, "no write attempted");
});

test("read-back mismatch -> MISMATCH, not reported as success", async () => {
  const store = makeStore();
  const writeClient = makeWriteClient();
  const readClient = { async searchInsureds() { return []; }, async getInsured() { return { ...SAVED_MATCH, city: "Columbus" }; } };
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
