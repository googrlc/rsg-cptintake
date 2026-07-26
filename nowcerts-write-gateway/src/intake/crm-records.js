// The three-way routing rule, in one place.
//
// AMS identity fields go to NowCerts through the gateway. Pipeline context —
// per-LOB opportunities, requested coverage, stage, current carriers — goes to
// Hermes (the RSG CRM). Everything else cited stays on the report.
//
// Per-LOB records are NEVER written to the AMS as speculative quotes. A
// NowCerts quote or policy is created by a human when the risk is actually
// marketed; speculative per-LOB records corrupt renewal urgency and scoreboard
// metrics. `nowcerts_write: "manual"` is the explicit tripwire that says so, and
// it is asserted in tests rather than left as a convention.
//
// This module is shared by both intake paths so the rule cannot drift between
// them: the live Hermes-synthesis path in live-pipeline.js, and the
// parser-driven path in intake-builder.js.

export const CRM_DESTINATION = "hermes";
export const NOWCERTS_WRITE_MANUAL = "manual";

function present(value) {
  return value != null && value !== "" && !(Array.isArray(value) && value.length === 0);
}

function field(name, value, citation) {
  return { field: name, value, citation };
}

/**
 * Build Hermes-bound CRM records from a synthesized Hermes payload.
 *
 * One record per opportunity (line of business), plus a single account-context
 * record when there is pipeline context worth carrying. Only values actually
 * present in the payload are emitted — nothing is defaulted or inferred.
 *
 * @param {object} payload the Hermes `payload_preview`
 * @param {object} options
 * @param {string} options.citation evidence string for every emitted field
 * @param {string} [options.clientName]
 * @returns {object[]}
 */
export function buildCrmRecords(payload = {}, { citation, clientName = null } = {}) {
  const account = payload.account ?? {};
  const opportunities = Array.isArray(payload.opportunities) ? payload.opportunities : [];
  const records = [];

  for (const [index, opportunity] of opportunities.entries()) {
    if (!opportunity || typeof opportunity !== "object") continue;
    const lineOfBusiness = opportunity.line_of_business ?? opportunity.lob ?? null;
    // A line of business is the identity of an opportunity record. Without one
    // there is nothing to open a pipeline record against, so it is surfaced for
    // review rather than filed under a guessed line.
    if (!present(lineOfBusiness)) {
      records.push({
        destination: CRM_DESTINATION,
        entity: "opportunity",
        role: "opportunity",
        operation: "create",
        index: index + 1,
        fields: [],
        needs_review: [{ field: "line_of_business", reason: "MISSING" }],
        nowcerts_write: NOWCERTS_WRITE_MANUAL,
      });
      continue;
    }

    const candidates = [
      ["line_of_business", lineOfBusiness],
      ["account_name", clientName ?? account.account_name],
      ["stage", opportunity.stage],
      ["requested_coverage", opportunity.requested_coverage ?? opportunity.coverage],
      ["current_carrier", opportunity.current_carrier],
      ["current_premium", opportunity.current_premium],
      ["expiration_date", opportunity.expiration_date ?? opportunity.x_date],
      ["target_effective_date", opportunity.effective_date],
      ["notes", opportunity.notes],
    ];

    records.push({
      destination: CRM_DESTINATION,
      entity: "opportunity",
      role: "opportunity",
      operation: "create",
      index: index + 1,
      fields: candidates.filter(([, value]) => present(value)).map(([name, value]) => field(name, value, citation)),
      needs_review: [],
      nowcerts_write: NOWCERTS_WRITE_MANUAL,
    });
  }

  // Account-level pipeline context that has no certified AMS contract but is
  // real CRM data (revenue, payroll, headcount, operations narrative).
  const contextCandidates = [
    ["account_name", clientName ?? account.account_name],
    ["operations_summary", account.operations_summary],
    ["annual_revenue", account.annual_revenue],
    ["estimated_payroll", account.estimated_payroll],
    ["employee_count", account.employee_count],
    ["website", account.website],
    ["account_type", account.account_type],
  ].filter(([, value]) => present(value));

  // One field alone is just the name echoed back — not context worth a record.
  if (contextCandidates.length > 1) {
    records.push({
      destination: CRM_DESTINATION,
      entity: "account",
      role: "account_context",
      operation: "update",
      index: null,
      fields: contextCandidates.map(([name, value]) => field(name, value, citation)),
      needs_review: [],
      nowcerts_write: NOWCERTS_WRITE_MANUAL,
    });
  }

  return records;
}
