import { notifyHermesAmsWrite } from "../connectors/hermes-audit.js";

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

// Canonical business name for leeway: drop punctuation and common entity
// suffixes so "ZZZZ Enterprise LLC" and "ZZZZ Enterprise" compare as the same.
const ENTITY_SUFFIXES = /\b(l\.?l\.?c\.?|inc\.?|incorporated|corp\.?|corporation|co\.?|company|ltd\.?|limited|l\.?l\.?p\.?|l\.?p\.?|pllc|p\.?c\.?)\b/g;

export function canonicalName(value) {
  return normalizeValue(value)
    .replace(/\./g, "")
    .replace(/[,'"&/]/g, " ")
    .replace(ENTITY_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// EXACT (identical), LIKELY (same after canonicalization, or one contains the
// other), or NONE. EXACT/LIKELY both prompt a human confirmation rather than a
// silent create or a hard block.
export function classifyMatch(candidateName, targetName) {
  const candidate = normalizeValue(candidateName);
  const target = normalizeValue(targetName);
  if (!candidate || !target) return "NONE";
  if (candidate === target) return "EXACT";
  const canonCandidate = canonicalName(candidateName);
  const canonTarget = canonicalName(targetName);
  if (!canonCandidate || !canonTarget) return "NONE";
  if (canonCandidate === canonTarget) return "LIKELY";
  if (canonCandidate.includes(canonTarget) || canonTarget.includes(canonCandidate)) return "LIKELY";
  return "NONE";
}


export function candidateEmail(candidate) {
  return normalizeValue(
    candidate.email ?? candidate.eMail ?? candidate.EMail ?? candidate.Email ?? ""
  );
}

export function candidateDob(candidate) {
  const raw = candidate.dateOfBirth ?? candidate.DateOfBirth ?? candidate.dob ?? candidate.DOB ?? "";
  if (!raw) return "";
  // Compare on YYYY-MM-DD when possible.
  const s = String(raw).trim();
  const m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : normalizeValue(s);
}

export function proposalEmail(fields) {
  return normalizeValue(fields.eMail ?? fields.email ?? fields.Email ?? "");
}

export function proposalDob(fields) {
  const raw = fields.dateOfBirth ?? fields.DateOfBirth ?? fields.dob ?? "";
  if (!raw) return "";
  const s = String(raw).trim();
  const m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : normalizeValue(s);
}

/**
 * Pre-create existence check: adopt an existing GUID when name matches AND
 * (email or DOB) matches. Name-only near matches still require DUPLICATE_REVIEW.
 */
export function findAdoptableMatch(candidates, fields) {
  const commercialName = fields.commercialName;
  const email = proposalEmail(fields);
  const dob = proposalDob(fields);
  const scored = [];
  for (const candidate of candidates ?? []) {
    const name = candidate.commercialName ?? candidate.CommercialName ?? candidate.name ?? "";
    const match = classifyMatch(name, commercialName);
    if (match === "NONE") continue;
    const row = {
      database_id: String(candidate.databaseId ?? candidate.DatabaseId ?? candidate.id ?? ""),
      name: String(name),
      match,
      email: candidateEmail(candidate),
      dob: candidateDob(candidate),
    };
    const emailHit = Boolean(email && row.email && email === row.email);
    const dobHit = Boolean(dob && row.dob && dob === row.dob);
    if ((match === "EXACT" || match === "LIKELY") && (emailHit || dobHit) && row.database_id) {
      return { adopt: row, reason: emailHit ? "name+email" : "name+dob", matches: scored };
    }
    scored.push(row);
  }
  return { adopt: null, reason: null, matches: scored };
}

export function extractInsuredFields(changes = []) {
  const fields = {};
  for (const change of changes) fields[change.field] = change.proposed;
  return fields;
}

// NowCerts read-back records vary in field casing/naming, so try known aliases.
const READBACK_VARIANTS = {
  commercialName: ["commercialName", "CommercialName", "commercialname", "name", "Name"],
  addressLine1: ["addressLine1", "AddressLine1", "addressline1", "address", "Address"],
  city: ["city", "City"],
  state: ["state", "State"],
  zipCode: ["zipCode", "ZipCode", "zipcode", "zip", "Zip"],
};

function readbackValue(record, field) {
  if (record == null) return null;
  for (const key of READBACK_VARIANTS[field] ?? [field]) {
    if (record[key] != null && record[key] !== "") return record[key];
  }
  return null;
}

function buildLiveReceipt({ record, insuredId, idempotencyKey, verified, mismatches = [], nowIso, note = null, noteAttached = null, noteError = null }) {
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
    note_attached: noteAttached,
    ...(noteError ? { note_error: noteError } : {}),
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


async function auditHermes(hermesClient, receipt, record, operation) {
  if (!receipt?.insured_database_id) return null;
  return notifyHermesAmsWrite(hermesClient, {
    object_type: "client",
    object_id: receipt.insured_database_id,
    action: operation,
    approved_by: receipt.committed_by ?? record.proposal?.actor ?? null,
    fingerprint: record.fingerprint,
    adopted: Boolean(receipt.adopted),
    verified: Boolean(receipt.verified),
    source: "cptintake_gateway",
  });
}

export async function commitApprovedInsured({ record, store, writeClient, readClient, override = false, intakeNote = null, hermesClient = null, now = () => new Date().toISOString() }) {
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

  // 1) Pre-write existence check — adopt an existing GUID on name+email/DOB,
  //    otherwise ask on name-only near matches, otherwise create.
  let candidates;
  try {
    candidates = await readClient.searchInsureds(commercialName, 10);
  } catch (error) {
    return { ok: false, status: "REREAD_FAILED", message: `Pre-write duplicate check failed; nothing was written: ${error.message}` };
  }
  const { adopt, reason: adoptReason, matches } = findAdoptableMatch(candidates, fields);
  if (adopt) {
    const idempotencyKey = `insured-adopt:${adopt.database_id}:${record.fingerprint}`;
    const receipt = buildLiveReceipt({
      record,
      insuredId: adopt.database_id,
      idempotencyKey,
      verified: true,
      nowIso: now(),
      note: `Adopted existing NowCerts insured (${adoptReason}).`,
    });
    receipt.adopted = true;
    receipt.adopt_reason = adoptReason;
    await persistCommit(store, record, receipt, "COMMITTED_VERIFIED");
    const hermes_audit = await auditHermes(hermesClient, receipt, record, "adopt");
    return {
      ok: true,
      status: "ADOPTED",
      message: `Adopted existing NowCerts insured ${adopt.database_id} (${adoptReason}); no duplicate create.`,
      receipt,
      matches: [adopt],
      hermes_audit,
    };
  }
  if (matches.length && !override) {
    return {
      ok: false,
      status: "DUPLICATE_REVIEW",
      requires_confirmation: true,
      message: `Possible existing match in NowCerts: ${matches.map((m) => `"${m.name}"`).join(", ")}. Confirm to create a new record anyway, or cancel if it is the same client.`,
      matches,
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
    readback = await writeClient.getInsuredById(insuredId);
    if (!readback) throw new Error("the created record was not returned by the read-back tool.");
  } catch (error) {
    const receipt = buildLiveReceipt({ record, insuredId, idempotencyKey, verified: false, nowIso: now(), note: `Read-back failed: ${error.message}` });
    await persistCommit(store, record, receipt, "COMMITTED_UNVERIFIED");
    return { ok: false, status: "COMMITTED_UNVERIFIED", message: `Record was created (${insuredId}) but read-back failed — verify it manually in NowCerts: ${error.message}`, receipt };
  }

  // Read-back compare with leeway: the business name is compared canonically so
  // the AMS normalizing "ZZZZ Enterprise LLC" to "ZZZZ Enterprise" is not a
  // false mismatch; the rest compare on trimmed/case-folded value.
  const mismatches = CORE_COMPARE_FIELDS.filter((field) => {
    const sent = fields[field];
    const saved = readbackValue(readback, field);
    return field === "commercialName"
      ? canonicalName(saved) !== canonicalName(sent)
      : normalizeValue(saved) !== normalizeValue(sent);
  });
  const verified = mismatches.length === 0;

  // Attach the risk assessment as a NowCerts note on the new insured. Additive
  // and non-blocking: a note failure does not undo the (verified) create.
  let noteAttached = null;
  let noteError = null;
  const noteSubject = intakeNote?.body
    ? [intakeNote.title, intakeNote.body].filter(Boolean).join("\n\n").slice(0, 20000)
    : null;
  if (noteSubject && typeof writeClient.insertNote === "function") {
    try {
      await writeClient.insertNote({ insuredDatabaseId: insuredId, subject: noteSubject });
      noteAttached = true;
    } catch (error) {
      noteAttached = false;
      noteError = error.message;
    }
  }

  const receipt = buildLiveReceipt({ record, insuredId, idempotencyKey, verified, mismatches, nowIso: now(), noteAttached, noteError });
  await persistCommit(store, record, receipt, verified ? "COMMITTED_VERIFIED" : "COMMITTED_MISMATCH");
  const hermes_audit = await auditHermes(hermesClient, receipt, record, "create");
  const noteSuffix = noteAttached ? " Risk assessment note attached." : noteAttached === false ? " (Note attach failed — add it manually.)" : "";
  return {
    ok: verified,
    status: verified ? "VERIFIED" : "MISMATCH",
    message: verified
      ? `Created and verified in NowCerts (insured ${insuredId}).${noteSuffix}`
      : `Created (${insuredId}) but ${mismatches.length} field(s) did not match on read-back: ${mismatches.join(", ")}. Verify manually.${noteSuffix}`,
    receipt,
    hermes_audit,
  };
}
