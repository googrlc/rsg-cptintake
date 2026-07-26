import { reconcileFields, ReviewReason, FieldStatus } from "../documents/extraction.js";
import { assessDuplicateRisk } from "../documents/duplicate-search.js";
import { normalizeEntityType } from "../policy.js";
import { citationToSource } from "./intake-schema.js";
import { CRM_DESTINATION, NOWCERTS_WRITE_MANUAL } from "./crm-records.js";

// Turns a parsed new-business intake into (a) a reviewable draft for the panel
// and (b), when a verified write contract is supplied, a shadow NowCerts
// proposal for the primary insured routed through the unchanged gateway.
//
// Routing is three-way (updated 2026-07-25). AMS identity fields go to NowCerts
// through the gateway; pipeline context (per-LOB opportunities, stage, current
// carriers) goes to Hermes as crm_records and is NEVER written to the AMS as a
// speculative quote; everything else cited stays on the PDF record.
// Fields that match an AMS entity
// schema become proposed writes; cited-but-non-AMS fields are kept as pdf_only;
// missing/ambiguous/conflicting fields are surfaced for review and never
// guessed. Enriched values are allowed only because they carry a real source
// citation — enrichment finds information, it does not invent it.

const CONFLICT_REASONS = new Set([ReviewReason.CONFLICT, ReviewReason.AMBIGUOUS]);

function toReconcileField(field) {
  // The citation is the evidence: an ok field without one cannot be proposed.
  return { field: field.field, value: field.value, status: field.status, evidence: field.citation };
}

function insuredDisplayName(values) {
  return (
    values.commercial_name ||
    [values.first_name, values.last_name].filter(Boolean).join(" ") ||
    "New insured"
  );
}

/**
 * Reconcile one intake record and, for enrichment, merge sourced fields first.
 */
async function reconcileRecord(record, enricher) {
  const enriched = await enricher.enrich(record, {});
  const allFields = [...record.fields, ...enriched];
  const reconciled = reconcileFields(record.entity, record.operation, allFields.map(toReconcileField), {
    unknownDisposition: "pdf_only",
  });
  // Re-attach the original field (with citation) to each partition entry so the
  // draft/PDF keep provenance.
  const byName = new Map(allFields.map((f) => [f.field, f]));
  const attach = (entries) => entries.map((e) => ({ ...e, source_field: byName.get(e.field) }));
  return {
    record,
    enriched_count: enriched.length,
    proposed: reconciled.proposed.map((p) => byName.get(p.field)),
    pdf_only: reconciled.pdf_only.map((p) => byName.get(p.field)),
    needs_review: attach(reconciled.needs_review),
    missing_required: reconciled.missing_required,
    unknown_entity: reconciled.unknown_entity,
  };
}

/**
 * Build the primary-insured NowCerts proposal from reconciled fields, running a
 * duplicate search first. Returns either a proposal object or a stop status.
 */
async function buildInsuredProposal({ reconciledRecord, actor, search, writeContract, readBackPath, capturedAt }) {
  const entity = reconciledRecord.record.entity;
  const proposedFields = reconciledRecord.proposed;
  const valueMap = Object.fromEntries(proposedFields.map((f) => [f.field, f.value]));

  const searchResult = await search.search(entity, valueMap);
  const risk = assessDuplicateRisk("create", searchResult);
  if (!risk.match_ok) {
    return { status: "DUPLICATE_FOUND", search: searchResult, message: risk.reason };
  }

  const changes = proposedFields.map((f) => ({
    field: f.field,
    current: null,
    proposed: f.value,
    clear: f.value === null || f.value === "",
    source: citationToSource(f.citation, capturedAt),
  }));
  if (changes.length === 0) {
    return { status: "NOTHING_TO_WRITE", search: searchResult };
  }
  if (!writeContract) {
    return { status: "NEEDS_WRITE_CONTRACT", search: searchResult };
  }

  const conflicts = [];
  const missingFields = [...reconciledRecord.missing_required];
  for (const item of reconciledRecord.needs_review) {
    if (CONFLICT_REASONS.has(item.reason)) {
      conflicts.push({ field: item.field, description: `Field ${item.field} needs review: ${item.reason}.` });
    } else {
      missingFields.push(item.field);
    }
  }

  const proposal = {
    actor,
    operation: "create",
    entity_type: normalizeEntityType(entity),
    target: {
      database_id: null,
      display_name: insuredDisplayName(valueMap),
      match_status: "NONE",
      match_reason: searchResult.reason,
      snapshot: null,
    },
    changes,
    duplicate_risk: risk.duplicate_risk,
    missing_fields: [...new Set(missingFields)],
    conflicts,
    write_contract: writeContract,
    read_back_path: readBackPath ?? writeContract.path,
    read_back_fields: changes.map((c) => c.field),
    master_data: null,
  };
  return { status: "PROPOSAL_BUILT", proposal, search: searchResult };
}

// Records targeted at Hermes (the RSG CRM) are not AMS entities. They carry
// pipeline context — per-LOB opportunities, stage, requested coverage, current
// carriers — which must NEVER become a NowCerts quote or policy. Speculative
// per-LOB records in the AMS corrupt renewal urgency and scoreboard metrics; a
// NowCerts quote/policy is created by a human when the risk is actually
// marketed. `nowcerts_write: "manual"` is the tripwire that says so explicitly.
//
// These records skip AMS entity validation (they have no AMS schema to validate
// against) but obey the same never-guess rule: only status-ok, cited fields are
// carried forward; everything else is surfaced for review, never guessed.
function buildCrmRecord(reconciledRecord, capturedAt) {
  const { record } = reconciledRecord;
  const fields = [];
  const needsReview = [];

  for (const field of record.fields) {
    if (field.status !== FieldStatus.OK) {
      needsReview.push({ field: field.field, reason: reasonForFieldStatus(field.status) });
      continue;
    }
    if (!field.citation) {
      needsReview.push({ field: field.field, reason: ReviewReason.NO_EVIDENCE });
      continue;
    }
    fields.push({
      field: field.field,
      value: field.value,
      source: citationToSource(field.citation, capturedAt),
    });
  }

  return {
    destination: CRM_DESTINATION,
    entity: record.entity,
    role: record.role,
    operation: record.operation,
    fields,
    needs_review: needsReview,
    nowcerts_write: NOWCERTS_WRITE_MANUAL,
  };
}

function reasonForFieldStatus(status) {
  switch (status) {
    case FieldStatus.MISSING:
      return ReviewReason.MISSING;
    case FieldStatus.AMBIGUOUS:
      return ReviewReason.AMBIGUOUS;
    case FieldStatus.CONFLICT:
      return ReviewReason.CONFLICT;
    default:
      return ReviewReason.UNREADABLE;
  }
}

// Assemble the full intake record that the PDF will carry — everything parsed,
// with provenance, whether or not it lands in the AMS.
function assemblePdfRecord(parsedIntake, reconciledRecords, capturedAt) {
  return {
    submitted_by: parsedIntake.submitted_by,
    captured_at: capturedAt,
    raw_text: parsedIntake.raw_text,
    coverage_lines: parsedIntake.coverage_lines,
    records: reconciledRecords.map((r) => ({
      entity: r.record.entity,
      role: r.record.role,
      write_target: r.record.write_target,
      ams_fields: r.proposed.map((f) => ({ field: f.field, value: f.value, citation: f.citation })),
      pdf_only_fields: r.pdf_only.map((f) => ({ field: f.field, value: f.value, citation: f.citation })),
      needs_review: r.needs_review.map((n) => ({ field: n.field, reason: n.reason })),
    })),
  };
}

/**
 * Run the intake pipeline end to end for the current (shadow) stage.
 *
 * @param {object} gateway the NowCertsGateway (shadow)
 * @param {object} params
 * @param {import("./parser.js").StubIntakeParser} params.parser
 * @param {string} params.raw_text
 * @param {"lamar"|"gretchen"} params.submitted_by
 * @param {object} params.enricher Enricher (NoopEnricher by default)
 * @param {object} params.search NowCertsSearch
 * @param {object} [params.write_contracts] { insured?: writeContract }
 * @param {string} [params.read_back_path]
 * @param {string} [params.captured_at]
 */
export async function runIntake(gateway, params) {
  const {
    parser,
    raw_text: rawText,
    submitted_by: submittedBy,
    enricher,
    search,
    write_contracts: writeContracts = {},
    read_back_path: readBackPath,
    captured_at: capturedAt,
  } = params;

  const parsedIntake = await parser.parse({ raw_text: rawText, submitted_by: submittedBy });
  const capture = capturedAt ?? new Date().toISOString();

  const reconciledRecords = [];
  for (const record of parsedIntake.records) {
    reconciledRecords.push(await reconcileRecord(record, enricher));
  }

  const pdfRecord = assemblePdfRecord(parsedIntake, reconciledRecords, capture);

  // The primary insured is the record queued to NowCerts.
  const primary = reconciledRecords.find(
    (r) => r.record.role === "primary_insured" && r.record.write_target === "nowcerts",
  );

  let insured = { status: "NO_PRIMARY_INSURED", prepared: null };
  if (primary) {
    const built = await buildInsuredProposal({
      reconciledRecord: primary,
      actor: submittedBy,
      search,
      writeContract: writeContracts.insured,
      readBackPath,
      capturedAt: capture,
    });
    if (built.status === "PROPOSAL_BUILT") {
      const prepared = await gateway.prepare(built.proposal);
      insured = { status: "PREPARED", prepared, search: built.search };
    } else {
      insured = { ...built, prepared: null };
    }
  }

  // Hermes-targeted records (per-LOB opportunities, pipeline context) are built
  // out now. They are NOT written here — this is still shadow — but unlike the
  // deferred AMS entities they carry their full cited payload so the CRM write
  // stage has something to consume.
  const crmRecords = reconciledRecords
    .filter((r) => r !== primary && r.record.write_target === "hermes")
    .map((r) => buildCrmRecord(r, capture));

  // Remaining AMS-bound records (contacts, additional insureds) are captured now
  // and queued entity-by-entity in a later reviewed stage; they are shown in the
  // draft but not yet prepared.
  const deferred = reconciledRecords
    .filter((r) => r !== primary && r.record.write_target !== "hermes")
    .map((r) => ({ entity: r.record.entity, role: r.record.role, write_target: r.record.write_target }));

  return {
    status: "INTAKE_DRAFTED",
    submitted_by: submittedBy,
    insured,
    pdf_record: pdfRecord,
    crm_records: crmRecords,
    deferred,
    // Hermes/Supabase write is a separate reviewed stage; crm_records above is
    // its input. Nothing here writes to the CRM.
    crm_write: "deferred",
    // The PDF and Nextcloud archival stages are deferred; the assembled record
    // above is their input.
    pdf_generation: "deferred",
    archive: "deferred",
  };
}
