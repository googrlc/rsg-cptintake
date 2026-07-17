// Build a NowCerts write proposal from a synthesized intake bundle so the
// standalone /app door can drive prepare/approve over REST — the same guarded
// path as the MCP tools, with no ChatGPT involvement.
//
// Scope: new-prospect (create) of the primary insured only. Existing-client
// updates need a live pre-write reread + snapshot and are intentionally not
// enabled here yet. Contacts, policies, and NAICS/SIC (update-only tools) are
// follow-up entities. The result is fed verbatim into gateway.prepare(), so the
// deterministic validator/policy/fingerprint guardrails still apply unchanged.

// Required create fields for insert_insured_prospect_tool (NowCerts write-field
// names), mirroring the audit's 6 required fields and the pipeline's create gate.
export const INSURED_REQUIRED_WRITE_FIELDS = [
  "commercialName",
  "addressLine1",
  "city",
  "state",
  "zipCode",
  "insuredType",
];

const INSURED_CREATE_TOOL = "insert_insured_prospect_tool";

export function buildInsuredProposal(bundle, actor, { now = new Date().toISOString() } = {}) {
  const operation = bundle?.client?.intended_operation ?? "create";
  if (operation !== "create") {
    return {
      ok: false,
      status: "UNSUPPORTED",
      message:
        "The standalone door currently proposes new-prospect (create) insureds only. Existing-client updates require a live pre-write reread and are not enabled yet.",
    };
  }

  const amsFields = (bundle?.routing?.ams_fields ?? []).filter(
    (item) =>
      item?.contract?.write_tool === INSURED_CREATE_TOOL &&
      item?.contract?.write_field &&
      item.value != null &&
      item.value !== "",
  );
  if (!amsFields.length) {
    return {
      ok: false,
      status: "NO_FIELDS",
      message:
        "No insured fields with a certified create contract were synthesized; extracted facts remain on the retained PDF.",
    };
  }

  const changes = amsFields.map((item) => ({
    field: item.contract.write_field,
    current: null,
    proposed: item.value,
    clear: false,
    source: {
      kind: "trusted_system",
      reference: item.citation || `rsg-intake-gate:${bundle.intake_id}`,
      location: null,
      excerpt: null,
      captured_at: now,
    },
  }));

  const writeFields = changes.map((change) => change.field);
  const missingFields = INSURED_REQUIRED_WRITE_FIELDS.filter((field) => !writeFields.includes(field));

  const proposal = {
    actor,
    operation: "create",
    entity_type: "insured",
    target: {
      database_id: null,
      display_name: bundle.client.display_name,
      match_status: "NONE",
      match_reason: "New prospect; operator confirmed no existing NowCerts insured in the live lookup.",
      snapshot: null,
    },
    changes,
    duplicate_risk: "LOW",
    missing_fields: missingFields,
    conflicts: [],
    write_contract: {
      method: "api",
      path: INSURED_CREATE_TOOL,
      contract_source: "nowcerts-read-connector/MOMENTUM-CONTRACT-AUDIT.md",
      checked_at: now.slice(0, 10),
      supports_operation: "create",
    },
    read_back_path: "get_insured_details_tool",
    read_back_fields: writeFields,
    master_data: null,
  };

  return { ok: true, proposal };
}
