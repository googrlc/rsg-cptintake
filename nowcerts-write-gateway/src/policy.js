const MASTER_ENTITIES = new Set([
  "carrier",
  "mga",
  "finance_company",
  "agency_location",
  "agent",
  "csr",
  "tag_definition",
  "referral_source",
]);

const GRETCHEN_COMMIT_ENTITIES = new Set([
  "insured",
  "prospect",
  "contact",
  "principal",
  "policy",
  "quote",
  "driver",
  "vehicle",
  "property",
  "claim",
  "note",
  "task",
  "file",
  "custom_field",
  "certificate_holder",
]);

export function normalizeEntityType(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function isMasterEntity(entityType, proposalMasterFlag = false) {
  return proposalMasterFlag || MASTER_ENTITIES.has(normalizeEntityType(entityType));
}

export function canApprove({ approver, proposal }) {
  const normalizedApprover = String(approver ?? "").trim().toLowerCase();
  if (normalizedApprover === "lamar") {
    return { allowed: true, reason: "Lamar may approve all validated proposals." };
  }

  if (normalizedApprover !== "gretchen") {
    return { allowed: false, reason: "Unknown approver." };
  }

  if (proposal.actor !== "gretchen") {
    return {
      allowed: false,
      reason: "Gretchen may only approve proposals she prepared.",
    };
  }

  if (!GRETCHEN_COMMIT_ENTITIES.has(normalizeEntityType(proposal.entity_type))) {
    return {
      allowed: false,
      reason: "This entity requires Lamar approval.",
    };
  }

  if (!["create", "update"].includes(proposal.operation)) {
    return {
      allowed: false,
      reason: "Imports, archives, and deactivations require Lamar approval.",
    };
  }

  if (isMasterEntity(proposal.entity_type, proposal.master_data?.is_master)) {
    return {
      allowed: false,
      reason: "Shared master-data changes require Lamar approval.",
    };
  }

  return { allowed: true, reason: "Routine validated write is within Gretchen's role." };
}

export function expectedConfirmation(proposal) {
  return `CONFIRM ${proposal.operation.toUpperCase()} ${proposal.target.display_name}`;
}
