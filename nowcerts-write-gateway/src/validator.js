import { createHash } from "node:crypto";
import { z } from "zod";
import { isMasterEntity, normalizeEntityType } from "./policy.js";

const sourceSchema = z
  .object({
    kind: z.enum(["document", "user_message", "nowcerts", "trusted_system"]),
    reference: z.string().trim().min(1),
    location: z.string().trim().min(1).nullable(),
    excerpt: z.string().trim().min(1).max(500).nullable(),
    captured_at: z.string().datetime({ offset: true }),
  })
  .strict();

const changeSchema = z
  .object({
    field: z.string().trim().min(1),
    current: z.unknown(),
    proposed: z.unknown(),
    clear: z.boolean(),
    source: sourceSchema,
  })
  .strict();

const proposalSchema = z
  .object({
    actor: z.enum(["lamar", "gretchen"]),
    operation: z.enum(["create", "update", "import", "archive", "deactivate"]),
    entity_type: z.string().trim().min(1),
    target: z
      .object({
        database_id: z.string().trim().min(1).nullable(),
        display_name: z.string().trim().min(1),
        match_status: z.enum(["EXACT", "LIKELY", "AMBIGUOUS", "NONE"]),
        match_reason: z.string().trim().min(1),
        snapshot: z
          .object({
            observed_at: z.string().datetime({ offset: true }),
            version_token: z.string().trim().min(1).nullable(),
            values: z.record(z.unknown()),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    changes: z.array(changeSchema).min(1),
    duplicate_risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
    missing_fields: z.array(z.string().trim().min(1)),
    conflicts: z.array(
      z
        .object({
          field: z.string().trim().min(1),
          description: z.string().trim().min(1),
        })
        .strict(),
    ),
    write_contract: z
      .object({
        method: z.enum(["api", "ui", "import"]),
        path: z.string().trim().min(1),
        contract_source: z.string().trim().min(1),
        checked_at: z.string().date(),
        supports_operation: z.enum(["create", "update", "import", "archive", "deactivate"]),
      })
      .strict(),
    read_back_path: z.string().trim().min(1),
    read_back_fields: z.array(z.string().trim().min(1)).min(1),
    master_data: z
      .object({
        is_master: z.boolean(),
        downstream_scope: z.string().trim().min(1).nullable(),
        named_confirmation: z.string().trim().min(1).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintProposal(proposal) {
  return createHash("sha256").update(stableJson(proposal)).digest("hex");
}

export function validateProposal(input) {
  const parsed = proposalSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      status: "INVALID",
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      warnings: [],
    };
  }

  const proposal = {
    ...parsed.data,
    entity_type: normalizeEntityType(parsed.data.entity_type),
  };
  const errors = [];
  const warnings = [];
  const changedFields = proposal.changes.map((change) => change.field);

  if (new Set(changedFields).size !== changedFields.length) {
    errors.push("Each changed field may appear only once.");
  }

  for (const change of proposal.changes) {
    const blank = change.proposed === null || change.proposed === "";
    if (blank !== change.clear) {
      errors.push(`${change.field}: clear must be true exactly when proposed is blank.`);
    }
    if (JSON.stringify(change.current) === JSON.stringify(change.proposed)) {
      warnings.push(`${change.field}: proposed value is unchanged.`);
    }
  }

  if (["update", "archive", "deactivate"].includes(proposal.operation)) {
    if (!proposal.target.database_id) errors.push(`${proposal.operation} requires database_id.`);
    if (proposal.target.match_status !== "EXACT") {
      errors.push(`${proposal.operation} requires an EXACT record match.`);
    }
    if (!proposal.target.snapshot) {
      errors.push(`${proposal.operation} requires a fresh target snapshot.`);
    }
  }

  if (["create", "import"].includes(proposal.operation)) {
    if (proposal.target.database_id) errors.push(`${proposal.operation} must not include database_id.`);
    if (proposal.target.match_status !== "NONE") {
      errors.push(`${proposal.operation} requires match_status NONE.`);
    }
    if (proposal.target.snapshot) errors.push(`${proposal.operation} must not include a target snapshot.`);
  }

  if (proposal.target.snapshot) {
    for (const change of proposal.changes) {
      if (!(change.field in proposal.target.snapshot.values)) {
        errors.push(`${change.field}: target snapshot is missing the current value.`);
      } else if (
        JSON.stringify(proposal.target.snapshot.values[change.field]) !==
        JSON.stringify(change.current)
      ) {
        errors.push(`${change.field}: change.current does not match the target snapshot.`);
      }
    }
  }

  if (proposal.duplicate_risk !== "LOW") {
    errors.push("Duplicate risk must be LOW before approval.");
  }

  if (proposal.write_contract.supports_operation !== proposal.operation) {
    errors.push("write_contract.supports_operation must equal operation.");
  }

  const missingReadBack = changedFields.filter(
    (field) => !proposal.read_back_fields.includes(field),
  );
  if (missingReadBack.length) {
    errors.push(`Read-back fields missing: ${missingReadBack.join(", ")}.`);
  }

  const master = isMasterEntity(proposal.entity_type, proposal.master_data?.is_master);
  if (master) {
    if (!proposal.master_data?.downstream_scope) {
      errors.push("Master data requires downstream_scope.");
    }
    if (!proposal.master_data?.named_confirmation) {
      errors.push("Master data requires named_confirmation.");
    }
  }

  if (errors.length) {
    return { ok: false, status: "INVALID", errors, warnings, proposal };
  }
  if (proposal.missing_fields.length) {
    return {
      ok: true,
      status: "NEEDS_INFORMATION",
      errors: [],
      warnings,
      proposal,
    };
  }
  if (proposal.conflicts.length) {
    return { ok: true, status: "CONFLICT", errors: [], warnings, proposal };
  }

  return {
    ok: true,
    status: "READY_FOR_APPROVAL",
    errors: [],
    warnings,
    proposal,
  };
}

export function assessPrewriteConcurrency(proposal, liveRecord) {
  if (!proposal.target.database_id || !proposal.target.snapshot) {
    return { status: "NOT_APPLICABLE", changed_fields: [] };
  }
  if (liveRecord.database_id !== proposal.target.database_id) {
    return { status: "BLOCK", changed_fields: [], reason: "Live record ID does not match target." };
  }

  const snapshot = proposal.target.snapshot;
  if (
    snapshot.version_token &&
    liveRecord.version_token &&
    snapshot.version_token === liveRecord.version_token
  ) {
    return { status: "SAFE", changed_fields: [] };
  }

  const proposedFields = new Set(proposal.changes.map((change) => change.field));
  const changedFields = Object.keys(snapshot.values).filter(
    (field) => JSON.stringify(snapshot.values[field]) !== JSON.stringify(liveRecord.values?.[field]),
  );
  const overlapping = changedFields.filter((field) => proposedFields.has(field));

  if (overlapping.length) {
    return {
      status: "BLOCK_CONFLICT",
      changed_fields: changedFields,
      overlapping_fields: overlapping,
      reason: "At least one proposed field changed in NowCerts after preview.",
    };
  }

  return {
    status: "REPREVIEW",
    changed_fields: changedFields,
    overlapping_fields: [],
    reason: "The record changed after preview; preserve unrelated updates and reconfirm.",
  };
}
