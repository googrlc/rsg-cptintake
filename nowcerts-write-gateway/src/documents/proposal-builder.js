import { classifyDocument } from "./classification.js";
import { reconcileExtraction, ReviewReason } from "./extraction.js";
import { assessDuplicateRisk } from "./duplicate-search.js";
import { isMasterEntity, normalizeEntityType } from "../policy.js";

// Turns a cited extraction result into the exact proposal contract consumed by
// the existing gateway, then routes it through gateway.prepare(). It NEVER
// writes and NEVER invents a value, a write path, or a target: every field it
// proposes is evidence-backed, and anything unresolved is handed to the
// gateway's existing missing_fields / conflicts channels so approval is blocked.
//
// The builder short-circuits only when a valid proposal cannot be constructed at
// all (unclassified document, duplicate found on create, no unique update
// target, missing verified write contract, or nothing left to write after
// quarantine). Everything else is decided by the unchanged gateway validator.

const CONFLICT_REASONS = new Set([ReviewReason.CONFLICT, ReviewReason.AMBIGUOUS]);

function displayName(entity, values) {
  switch (normalizeEntityType(entity)) {
    case "insured":
      return values.commercial_name || [values.first_name, values.last_name].filter(Boolean).join(" ") || "New insured";
    case "contact":
    case "driver":
      return [values.first_name, values.last_name].filter(Boolean).join(" ") || `New ${entity}`;
    case "policy":
      return values.policy_number ? `Policy ${values.policy_number}` : "New policy";
    case "carrier":
      return values.legal_name || "New carrier";
    case "vehicle":
      return values.vin ? `Vehicle ${values.vin}` : "New vehicle";
    case "location":
      return values.address_line || "New location";
    default:
      return `New ${entity}`;
  }
}

function evidenceToSource(evidence, capturedAt) {
  return {
    kind: "document",
    reference: evidence.filename,
    location: `page ${evidence.page}`,
    excerpt: evidence.excerpt,
    captured_at: capturedAt,
  };
}

/**
 * Build a proposal object (or a stop status) from a raw extraction result.
 *
 * @param {object} params
 * @param {object} params.extraction raw extraction result
 * @param {"lamar"|"gretchen"} params.actor
 * @param {import("./duplicate-search.js").InMemoryNowCertsSearch} params.search
 * @param {object} params.write_contract verified capability (never invented here)
 * @param {string} [params.read_back_path]
 * @param {object} [params.master_data] required for master entities
 * @param {string} [params.captured_at] evidence capture timestamp
 * @returns {Promise<{status: string, proposal?: object, reconciliation: object, search?: object, message?: string}>}
 */
export async function buildProposal({
  extraction,
  actor,
  search,
  write_contract: writeContract,
  read_back_path: readBackPath,
  master_data: masterData = null,
  captured_at: capturedAt,
}) {
  const classification = classifyDocument(extraction ?? {});
  if (!classification.ok) {
    return { status: classification.status, reconciliation: null, message: classification.message };
  }

  const reconciliation = reconcileExtraction(extraction);
  if (!reconciliation.ok) {
    return { status: "INVALID_EXTRACTION", reconciliation, message: reconciliation.error };
  }

  const entity = reconciliation.candidate_entity;
  const operation = reconciliation.candidate_operation;
  const isCreate = operation === "create" || operation === "import";
  const valueMap = Object.fromEntries(reconciliation.proposed.map((f) => [f.field, f.value]));
  const capture = capturedAt ?? new Date().toISOString();

  // Search NowCerts for existing/duplicate records before proposing a create.
  const searchResult = await search.search(entity, valueMap);
  const risk = assessDuplicateRisk(operation, searchResult);

  if (isCreate && !risk.match_ok) {
    return {
      status: "DUPLICATE_FOUND",
      reconciliation,
      search: searchResult,
      message: `${risk.reason} Resolve the match before creating a new record.`,
    };
  }

  // Resolve target + per-field current values.
  let target;
  let snapshotValues = {};
  if (isCreate) {
    target = {
      database_id: null,
      display_name: displayName(entity, valueMap),
      match_status: "NONE",
      match_reason: searchResult.reason,
      snapshot: null,
    };
  } else {
    if (searchResult.match_status !== "EXACT" || searchResult.candidates.length !== 1) {
      return {
        status: "NO_UNIQUE_TARGET",
        reconciliation,
        search: searchResult,
        message: `${operation} requires exactly one existing record; search returned ${searchResult.match_status}.`,
      };
    }
    const candidate = searchResult.candidates[0];
    snapshotValues = candidate.values ?? {};
    target = {
      database_id: candidate.database_id,
      display_name: displayName(entity, { ...snapshotValues, ...valueMap }),
      match_status: "EXACT",
      match_reason: searchResult.reason,
      snapshot: {
        observed_at: capture,
        version_token: candidate.version_token ?? null,
        values: snapshotValues,
      },
    };
  }

  // Build changes from evidence-backed proposed fields. For updates, a field the
  // snapshot cannot corroborate is quarantined rather than written blind.
  const changes = [];
  const extraMissing = [];
  for (const item of reconciliation.proposed) {
    if (!isCreate && !(item.field in snapshotValues)) {
      extraMissing.push(item.field);
      continue;
    }
    const current = isCreate ? null : snapshotValues[item.field];
    const proposedBlank = item.value === null || item.value === "";
    changes.push({
      field: item.field,
      current: isCreate ? null : current,
      proposed: item.value,
      clear: proposedBlank,
      source: evidenceToSource(item.evidence, capture),
    });
  }

  if (changes.length === 0) {
    return {
      status: "NOTHING_TO_WRITE",
      reconciliation,
      search: searchResult,
      message: "No evidence-backed field survived review; nothing can be proposed without guessing.",
    };
  }

  if (!writeContract) {
    return {
      status: "NEEDS_WRITE_CONTRACT",
      reconciliation,
      search: searchResult,
      message: "A verified write_contract is required; the builder does not invent write paths.",
    };
  }

  // Route quarantined fields through the gateway's existing block channels.
  const conflicts = [];
  const missingFields = [...reconciliation.missing_required, ...extraMissing];
  for (const item of reconciliation.needs_review) {
    if (CONFLICT_REASONS.has(item.reason)) {
      conflicts.push({ field: item.field, description: `Field ${item.field} needs review: ${item.reason}.` });
    } else {
      missingFields.push(item.field);
    }
  }

  const master = isMasterEntity(entity, masterData?.is_master);
  const proposal = {
    actor,
    operation,
    entity_type: entity,
    target,
    changes,
    duplicate_risk: risk.duplicate_risk,
    missing_fields: [...new Set(missingFields)],
    conflicts,
    write_contract: writeContract,
    read_back_path: readBackPath ?? writeContract.path,
    read_back_fields: changes.map((c) => c.field),
    master_data: master
      ? masterData ?? { is_master: true, downstream_scope: null, named_confirmation: null }
      : masterData,
  };

  return { status: "PROPOSAL_BUILT", proposal, reconciliation, search: searchResult };
}

/**
 * Build a proposal from an extraction result and, if one was produced, route it
 * through the unchanged gateway.prepare(). Returns the builder stop-status when
 * no proposal could be constructed, otherwise the gateway's prepared record.
 */
export async function prepareFromExtraction(gateway, params) {
  const built = await buildProposal(params);
  if (built.status !== "PROPOSAL_BUILT") {
    return { prepared: null, ...built };
  }
  const record = await gateway.prepare(built.proposal);
  return { prepared: record, status: "PREPARED", reconciliation: built.reconciliation, search: built.search };
}
