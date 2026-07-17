// Guarded live-write executor for insured create — the "Send to AMS" action.
// Runs ONLY on a reviewed + approved (SHADOW_APPROVED), fingerprinted proposal.
// Sequence: pre-write duplicate reread -> idempotency guard -> single commit ->
// read-back by returned id -> field-by-field compare -> VERIFIED. Any failure
// stops and reports honestly; success is never inferred from the write response
// alone. Connectors are injected so the whole path is unit-testable offline.

const CORE_COMPARE_FIELDS = ["commercialName", "addressLine1", "city", "state", "zipCode"];

export function normalizeValue(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function extractInsuredFields(changes = []) {
  const fields = {};
  for (const change of changes) fields[change.field] = change.proposed;
  return fields;
}

function readbackValue(record, field) {
  if (record == null) return null;
  const capitalized = field.charAt(0).toUpperCase() + field.slice(1);
  return record[field] ?? record[capitalized] ?? null;
}

function buildLiveReceipt({ record, insuredId, idempotencyKey, verified, mismatches = [], nowIso, note = null }) {
  return {
    result: verified ? "VERIFIED" : mismatches.length ? "MISMATCH" : "UNVERIFIED",
    proposal_id: record.id,
    insured_database_id: insuredId,
    written_to_nowcerts: true,
    verified,
    mismatched_fields: mismatches,
    idempotency_key: idempotencyKey,
    fingerprint: record.fingerprint,
    committed_by: record.receipt?.approved_by ?? record.proposal.actor,
    committed_at: nowIso,
    note,
  };
}

async function persistCommit(store, record, liveReceipt, status) {
  record.status = status;
  record.live_receipt = liveReceipt;
  record.updated_at = liveReceipt.committed_at;
  await store.save(record);
  await store.audit({
    event: "live_commit",
    proposal_id: record.id,
    status,
    insured_database_id: liveReceipt.insured_database_id,
    verified: liveReceipt.verified,
    idempotency_key: liveReceipt.idempotency_key,
    fingerprint: record.fingerprint,
  });
}

export async function commitApprovedInsured({ record, store, writeClient, readClient, now = () => new Date().toISOString() }) {
  if (!record) return { ok: false, status: "NOT_FOUND", message: "Proposal not found." };

  // Idempotency: a completed live write is never repeated.
  if (record.live_receipt?.written_to_nowcerts) {
    return {
      ok: Boolean(record.live_receipt.verified),
      status: "ALREADY_COMMITTED",
      message: `Already written to NowCerts (insured ${record.live_receipt.insured_database_id}).`,
      receipt: record.live_receipt,
    };
  }
  if (record.status !== "SHADOW_APPROVED") {
    return { ok: false, status: "NOT_APPROVED", message: "Review and approve the proposal before sending it to the AMS." };
  }
  if (record.proposal.entity_type !== "insured" || record.proposal.operation !== "create") {
    return { ok: false, status: "UNSUPPORTED", message: "Live send currently supports insured create only." };
  }
  if (!writeClient) return { ok: false, status: "NOT_ENABLED", message: "The AMS write connector is not configured; live send is disabled." };
  if (!readClient) return { ok: false, status: "NOT_ENABLED", message: "The read connector is required for pre-write and read-back checks." };

  const fields = extractInsuredFields(record.proposal.changes);
  const commercialName = fields.commercialName;
  if (!commercialName) return { ok: false, status: "INVALID", message: "Proposal is missing commercialName; cannot send." };

  // 1) Pre-write duplicate reread — do not create a second record for a client
  //    that already exists (or was added since the preview).
  let candidates;
  try {
    candidates = await readClient.searchInsureds(commercialName, 10);
  } catch (error) {
    return { ok: false, status: "REREAD_FAILED", message: `Pre-write duplicate check failed; nothing was written: ${error.message}` };
  }
  const duplicates = (candidates ?? []).filter(
    (candidate) => normalizeValue(candidate.commercialName ?? candidate.CommercialName ?? candidate.name) === normalizeValue(commercialName),
  );
  if (duplicates.length) {
    return {
      ok: false,
      status: "DUPLICATE_STOP",
      message: `An insured named "${commercialName}" already exists in NowCerts — not creating a duplicate.`,
      matches: duplicates.map((d) => String(d.databaseId ?? d.DatabaseId ?? d.id ?? "")).filter(Boolean),
    };
  }

  // 2) Idempotency key bound to the approved payload fingerprint.
  const idempotencyKey = `insured-create:${record.fingerprint}`;

  // 3) Commit exactly once. Prospect (type 1) per the reviewed decision.
  const payload = { ...fields, type: 1 };
  let insert;
  try {
    insert = await writeClient.insertInsuredProspect(payload);
  } catch (error) {
    return { ok: false, status: "WRITE_FAILED", message: `NowCerts insert failed; treat as not written and re-check the AMS: ${error.message}` };
  }
  if (!insert?.ok || !insert.insured_database_id) {
    return { ok: false, status: "WRITE_FAILED", message: insert?.message ?? "NowCerts did not return an insuredDatabaseId." };
  }
  const insuredId = insert.insured_database_id;

  // 4) Read back the saved record and compare every intended field.
  let readback;
  try {
    readback = await readClient.getInsured(insuredId);
  } catch (error) {
    const receipt = buildLiveReceipt({ record, insuredId, idempotencyKey, verified: false, nowIso: now(), note: `Read-back failed: ${error.message}` });
    await persistCommit(store, record, receipt, "COMMITTED_UNVERIFIED");
    return { ok: false, status: "COMMITTED_UNVERIFIED", message: `Record was created (${insuredId}) but read-back failed — verify it manually in NowCerts: ${error.message}`, receipt };
  }

  const mismatches = CORE_COMPARE_FIELDS.filter((field) => normalizeValue(readbackValue(readback, field)) !== normalizeValue(fields[field]));
  const verified = mismatches.length === 0;
  const receipt = buildLiveReceipt({ record, insuredId, idempotencyKey, verified, mismatches, nowIso: now() });
  await persistCommit(store, record, receipt, verified ? "COMMITTED_VERIFIED" : "COMMITTED_MISMATCH");
  return {
    ok: verified,
    status: verified ? "VERIFIED" : "MISMATCH",
    message: verified
      ? `Created and verified in NowCerts (insured ${insuredId}).`
      : `Created (${insuredId}) but ${mismatches.length} field(s) did not match on read-back: ${mismatches.join(", ")}. Verify manually.`,
    receipt,
  };
}
