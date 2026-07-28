// Send the intake to the CRM.
//
// The whole intake goes through ONE door — Hermes' `POST /api/intake` — rather
// than the gateway fanning individual records out itself. That choice matters:
//
//  - Hermes queues the submission and a human approves it in Slack before
//    anything is committed. Posting opportunities directly (the previous
//    behaviour) wrote pipeline rows the moment an intake was parsed, ahead of any
//    review, and left the account, contacts and cited facts with nowhere to go.
//  - One writer means one place where sync_source is decided. The inbound AMS
//    sync stops updating an opportunity permanently once the CRM has PATCHed it,
//    so a second path that touches the same rows is a quiet way to break renewals.
//
// Nothing here reaches NowCerts. An intake is a prospect, and a prospect is not a
// record of insurance — the insured and the policy are written when the deal is
// WON, by the CRM's own won-push. That is the agency's rule, not this module's
// preference.
//
// Two contract rules shape the error handling, unchanged from the fan-out it
// replaces:
//
//  - Never block the intake on the CRM. If Hermes is down, the insured proposal
//    and the retained report must still complete.
//  - A replay is a SUCCESS. Re-submitting the same intake adopts the existing
//    submission rather than opening a second one, which is why a hand-retry after
//    a timeout is always safe.

import { buildCrmSubmission } from "./crm-submission.js";

export const CrmWriteStatus = {
  DISABLED: "DISABLED",
  NOT_CONFIGURED: "NOT_CONFIGURED",
  NOTHING_TO_WRITE: "NOTHING_TO_WRITE",
  SUBMITTED: "SUBMITTED",
  ERROR: "ERROR",
};

function emptyResult(status, extra = {}) {
  return {
    status,
    destination: "hermes",
    submission_id: null,
    awaiting_approval: false,
    opportunity_count: 0,
    fact_count: 0,
    contact_count: 0,
    ...extra,
  };
}

/**
 * Submit a finished intake bundle to the CRM.
 *
 * @param {object} bundle the intake bundle, post-synthesis
 * @param {object} options
 * @param {object|null} options.client HermesPreviewClient (or null)
 * @param {boolean} options.enabled HERMES_CRM_WRITES flag
 * @param {string|null} [options.submittedBy] the operator
 * @param {string|null} [options.approvedBy] the operator who approved the send
 * @returns {Promise<object>} the `crm` report block
 */
export async function submitToCrm(bundle, { client, enabled, submittedBy = null, approvedBy = null } = {}) {
  if (!enabled) return emptyResult(CrmWriteStatus.DISABLED);
  if (!client) return emptyResult(CrmWriteStatus.NOT_CONFIGURED);
  if (!client.canSubmitIntake) {
    return emptyResult(CrmWriteStatus.NOT_CONFIGURED, {
      detail: "The CRM intake key is not configured; set HERMES_INTAKE_KEY_FILE on the gateway.",
    });
  }

  const submission = buildCrmSubmission(bundle, { submittedBy, approvedBy });
  const payload = submission.synthesized_payload ?? {};
  const counts = {
    opportunity_count: (payload.opportunities ?? []).length,
    fact_count: (payload.facts ?? []).length,
    contact_count: (payload.contacts ?? []).length,
  };

  // An intake with no account name and no line of business has nothing for the
  // CRM to open a record against. Reported rather than submitted, so it lands on
  // the report as a review item instead of failing at the far end.
  if (!payload.account?.account_name && counts.opportunity_count === 0) {
    return emptyResult(CrmWriteStatus.NOTHING_TO_WRITE, {
      ...counts,
      detail: "No account name and no line of business — nothing to open a CRM record against.",
    });
  }

  let response;
  try {
    response = await client.submitIntake(submission);
  } catch (error) {
    return emptyResult(CrmWriteStatus.ERROR, {
      ...counts,
      detail: error?.message ?? String(error),
      status_code: error?.statusCode ?? null,
    });
  }

  // Hermes commits an approved, already-synthesized intake inline and returns
  // what it created. When it does, THAT is the truth about this intake — report
  // the rows that exist, not the rows we hoped to send. Absent, the submission is
  // queued and the counts are still a description of the payload.
  const commit = response?.commit ?? null;
  return {
    status: CrmWriteStatus.SUBMITTED,
    destination: "hermes",
    submission_id: response?.submission_id ?? null,
    status_url: response?.status_url ?? null,
    // A replay means this intake was already submitted. Surfaced plainly so a
    // second run reads as "already there", never as a new record.
    idempotent_replay: Boolean(response?.idempotent_replay),
    approved_by: approvedBy,
    // "In the CRM" and "accepted for the CRM" are different claims. Only say the
    // first when Hermes reported the rows it wrote.
    committed: Boolean(commit?.ok),
    awaiting_approval: !approvedBy && !commit?.ok,
    submission_status: commit?.status ?? response?.status ?? null,
    client_identifier: commit?.client_identifier ?? null,
    ...counts,
    ...(commit?.ok
      ? {
          opportunity_count: commit.opportunity_count ?? counts.opportunity_count,
          fact_count: commit.fact_count ?? counts.fact_count,
          contact_count: commit.entity_count != null
            ? Math.max(commit.entity_count - 1, 0)   // entities = the account + its contacts
            : counts.contact_count,
          note_count: commit.note_count ?? 0,
          opportunity_ids: commit.opportunity_ids ?? [],
          nextcloud_folder: commit.nextcloud_folder ?? null,
          warnings: commit.warnings ?? [],
        }
      : {}),
  };
}
