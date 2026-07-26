// Fan intake opportunities out to Hermes.
//
// Two rules from the contract shape everything here:
//
//  - Partial success is success. Four of six landing is four created and two
//    failed with reasons, never a rollback of the four.
//  - Never block the intake on Hermes. If Hermes is down the insured proposal
//    and the retained report must still complete; opportunities are additive.
//
// Both are why this uses Promise.allSettled and why every throw is caught and
// turned into a reported failure rather than propagated.

import { toOpportunityPayloads } from "./opportunity-payloads.js";

export const CrmWriteStatus = {
  DISABLED: "DISABLED",
  NOT_CONFIGURED: "NOT_CONFIGURED",
  NOTHING_TO_WRITE: "NOTHING_TO_WRITE",
  COMPLETE: "COMPLETE",
};

/**
 * @param {object} bundle intake bundle carrying crm_records
 * @param {object} options
 * @param {object|null} options.client HermesPreviewClient (or null)
 * @param {boolean} options.enabled HERMES_CRM_WRITES flag
 * @param {string|null} [options.insuredId] NowCerts GUID when known
 * @returns {Promise<object>} the `crm` report block
 */
export async function writeOpportunities(bundle, { client, enabled, insuredId = null } = {}) {
  if (!enabled) {
    return { status: CrmWriteStatus.DISABLED, attempted: 0, created: 0, adopted: 0, failed: [], skipped: [] };
  }
  if (!client) {
    return { status: CrmWriteStatus.NOT_CONFIGURED, attempted: 0, created: 0, adopted: 0, failed: [], skipped: [] };
  }

  const { payloads, skipped } = toOpportunityPayloads(bundle, { insuredId });
  if (payloads.length === 0) {
    return { status: CrmWriteStatus.NOTHING_TO_WRITE, attempted: 0, created: 0, adopted: 0, failed: [], skipped };
  }

  const settled = await Promise.allSettled(payloads.map((payload) => client.createOpportunity(payload)));

  let created = 0;
  let adopted = 0;
  const failed = [];
  const opportunities = [];

  for (const [index, outcome] of settled.entries()) {
    const lineOfBusiness = payloads[index].line_of_business;
    if (outcome.status === "rejected") {
      const error = outcome.reason;
      failed.push({
        line_of_business: lineOfBusiness,
        status: error?.statusCode ?? "ERROR",
        // Surface Hermes' own `detail` (a 400 naming a bad vocabulary value is
        // actionable); never swallow it.
        detail: error?.message ?? String(error),
      });
      continue;
    }
    const value = outcome.value ?? {};
    if (value.ok === false) {
      failed.push({ line_of_business: lineOfBusiness, status: "REJECTED", detail: value.detail ?? value.message ?? "Hermes rejected the opportunity." });
      continue;
    }
    // created:false means the opportunity already existed and was returned.
    // That is an adoption, not a failure, and must never be retried as an error.
    if (value.created === false) adopted += 1;
    else created += 1;
    if (value.opportunity) opportunities.push({ line_of_business: lineOfBusiness, id: value.opportunity.id ?? null, created: value.created !== false });
  }

  return {
    status: CrmWriteStatus.COMPLETE,
    attempted: payloads.length,
    created,
    adopted,
    failed,
    skipped,
    opportunities,
  };
}
