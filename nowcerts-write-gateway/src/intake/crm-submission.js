// Turn a finished intake bundle into a Hermes `POST /api/intake` submission.
//
// This is where the intake's details actually become CRM records. The gateway
// already holds a payload synthesized against Hermes' own `crm-intake-writer`
// contract, so the job here is not to invent a shape — it is to hand that payload
// back enriched with everything the gateway learned afterwards, and to say where
// each value came from.
//
// Three rules shape this module:
//
//  - THE AMS IS NOT THE DESTINATION. An intake is a prospect, and a prospect is
//    not a record of insurance. Nothing built here reaches NowCerts; the insured
//    and the policy are written when a deal is WON. Same rule the CRM's own lead
//    station follows.
//
//  - EVERY FACT CARRIES ITS SOURCE. `client_facts` has `source`/`source_ref`
//    columns, which is the first home the gateway's per-field citations have ever
//    had — until now they died on the PDF report. A fact without a citation is
//    not emitted.
//
//  - NOTHING IS INVENTED. Only values actually present in the payload are sent.
//    Absent stays absent; Hermes reads a missing key as "not supplied", and a
//    guess is worse than an omission because it looks sourced.
//
// The submission is idempotent on the intake id, so a retry after a timeout
// adopts the existing row rather than opening a second one.

import { canonicalLineOfBusiness, assignOwner, buildProvenance } from "./opportunity-payloads.js";

export const INTAKE_SOURCE = "intake_gate";

// Hermes routes an intake to a person, and only knows these two.
export const AGENT_LAMAR = "lamar";
export const AGENT_GRETCHEN = "gretchen";

// Hard rule 2 of the intake contract: EIN, DOB, DL, SSN, banking, health and
// beneficiary data are `restricted`, which is what keeps them out of the
// standard-sensitivity retrieval path. Keyed by the fact label we emit.
const RESTRICTED_LABELS = new Set([
  "EIN",
  "Date of Birth",
  "Driver's License Number",
  "Driver's License State",
]);

function present(value) {
  return value != null && value !== "" && !(Array.isArray(value) && value.length === 0);
}

function asList(value) {
  return Array.isArray(value) ? value.filter((item) => item != null && item !== "") : [];
}

// An underwriting flag arrives as either a string or a {flag, severity, why_needed}
// object. Flatten to one readable line — `client_facts.fact_value` is text, and a
// JSON blob in it is not something a human reads back later.
function flagText(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return String(value ?? "").trim();
  const label = value.flag ?? value.item ?? value.name;
  if (!label) return String(value.why_needed ?? "").trim();
  // Severity qualifies the flag, so it rides with it: "Prior pollution claim
  // (high) — Affects GL appetite", not three clauses of equal weight.
  const headline = value.severity ? `${label} (${value.severity})` : String(label);
  return [headline, value.why_needed].filter(Boolean).join(" — ").trim();
}

function contactName(contact) {
  const full = String(contact?.full_name ?? "").trim();
  if (full) return full;
  const joined = [contact?.first_name, contact?.last_name].filter(Boolean).join(" ").trim();
  return joined || null;
}

/**
 * Which of the two agents owns this intake.
 *
 * Reuses the pipeline's owner rule so an intake and its opportunities never
 * disagree about whose desk it is on: personal lines to Gretchen, commercial to
 * Lamar, anything unclear to Lamar.
 */
export function submissionAgent(payload = {}) {
  const account = payload.account ?? {};
  const lines = asList(payload.opportunities).map((item) => item?.line_of_business);
  // Every line personal => Gretchen. A mixed book is commercial work.
  const owners = lines
    .filter(Boolean)
    .map((lob) => assignOwner(lob, { accountType: account.account_type }).assigned_to);
  if (owners.length && owners.every((owner) => owner.includes("Gretchen"))) return AGENT_GRETCHEN;
  if (owners.length) return AGENT_LAMAR;
  return /personal/i.test(String(account.account_type ?? "")) ? AGENT_GRETCHEN : AGENT_LAMAR;
}

/**
 * Build the `facts[]` array — the cited, retrievable half of the intake.
 *
 * Every entry names the entity it belongs to by DISPLAY NAME, because that is how
 * Hermes resolves it: `_insert_retrieval_rows` builds its lookup from
 * `account.account_name` and each contact's full name. A fact naming anything else
 * is dropped on the floor at the far end, so the names here are taken from the
 * same payload the entities are created from rather than re-derived.
 *
 * @param {object} payload the enriched CRM payload
 * @param {object} options
 * @param {string} options.citation source string for every fact
 * @param {string|null} [options.sourceRef] primary source reference
 * @returns {object[]}
 */
export function buildFacts(payload = {}, { citation, sourceRef = null } = {}) {
  const account = payload.account ?? {};
  const accountName = account.account_name;
  const facts = [];

  const push = (entity, entityType, label, value) => {
    if (!present(entity) || !present(value)) return;
    facts.push({
      entity,
      entity_type: entityType,
      fact_label: label,
      fact_value: String(value),
      sensitivity: RESTRICTED_LABELS.has(label) ? "restricted" : "standard",
      source: citation,
      ...(sourceRef ? { source_ref: sourceRef } : {}),
    });
  };

  // Account identity and the pipeline context that has no AMS contract. Both go
  // to the same place now, which is the point of the change: revenue, payroll and
  // headcount used to be stranded on the report as "assessment only".
  for (const [label, value] of [
    ["EIN", account.fein],
    ["Legal Name", account.legal_name],
    ["DBA", account.dba],
    ["Entity Type", account.entity_type],
    ["Industry", account.industry],
    ["Address", account.address],
    ["City", account.city],
    ["State", account.state],
    ["Zip", account.zip],
    ["Phone", account.phone],
    ["Email", account.email],
    ["Website", account.website],
    ["NAICS", account.naics],
    ["SIC", account.sic],
    ["Operations Summary", account.operations_summary],
    ["Annual Revenue", account.annual_revenue],
    ["Estimated Payroll", account.estimated_payroll],
    ["Employee Count", account.employee_count],
  ]) {
    push(accountName, "Account", label, value);
  }

  // Underwriting flags. `underwriting_facts` would be the natural home, but the
  // approval path only writes entities/facts/notes — so they land as cited
  // account facts, where they are at least retrievable. Dropping them was the
  // alternative, and a surfaced pollution exposure is not a detail to lose.
  for (const flag of asList(payload.underwriting_flags)) {
    push(accountName, "Account", "Underwriting Flag", flagText(flag));
  }

  for (const contact of asList(payload.contacts)) {
    const name = contactName(contact);
    for (const [label, value] of [
      ["Phone", contact.phone],
      ["Email", contact.email],
      ["Role", contact.role],
      ["Relationship to Account", contact.relationship_to_account],
      ["Date of Birth", contact.date_of_birth ?? contact.dob],
      ["Driver's License Number", contact.license_number ?? contact.dl_number],
      ["Driver's License State", contact.license_state ?? contact.dl_state],
    ]) {
      push(name, "Contact", label, value);
    }
  }

  return facts;
}

/**
 * Enrich the synthesized payload with what the gateway learned after synthesis.
 *
 * Business research fills a missing NAICS/SIC; lines of business are normalized
 * onto the book's vocabulary so the pipeline does not fragment into near-duplicate
 * lines. Existing values always win — research is a fallback for a blank field,
 * never a correction of a sourced one.
 */
export function enrichPayload(bundle, payload = {}) {
  const account = payload.account ?? {};
  const research = bundle?.research ?? null;
  const primarySource = bundle?.source_index?.[0] ?? null;
  const opportunities = asList(payload.opportunities).map((opportunity) => {
    const lob = canonicalLineOfBusiness(opportunity.line_of_business ?? opportunity.lob);
    if (!lob) return { ...opportunity };
    // Owner and provenance travel WITH the line, because the agency's split is
    // per line of business: personal lines are Gretchen's desk, commercial is
    // Lamar's. Left to the CRM's intake default every line of every intake lands
    // on one person, and an unowned renewal is how a deal goes dark.
    const { assigned_to: assignedTo, unclear } = assignOwner(lob, { accountType: account.account_type });
    return {
      ...opportunity,
      line_of_business: lob,
      assigned_to: opportunity.assigned_to ?? assignedTo,
      // Hermes has no per-field citation column on an opportunity, so the source
      // is flattened into one sentence on the card — enough for whoever picks it
      // up to know where it came from without opening the retained report.
      description:
        opportunity.description ??
        buildProvenance({ source: primarySource, unclearOwner: unclear }),
    };
  });

  return {
    ...payload,
    // validate_payload checks these three; a payload_preview that lost one on the
    // way through would otherwise fail far from here for no visible reason.
    action: payload.action ?? "crm_intake_upsert",
    approval_required: payload.approval_required ?? true,
    duplicate_search: payload.duplicate_search ?? {},
    account: {
      ...account,
      account_name: account.account_name ?? bundle?.client?.display_name ?? null,
      naics: account.naics ?? research?.naics ?? null,
      sic: account.sic ?? research?.sic ?? null,
    },
    opportunities,
  };
}

/**
 * Build the complete `POST /api/intake` body for a finished intake bundle.
 *
 * @param {object} bundle the intake bundle, post-synthesis
 * @param {object} [options]
 * @param {string} [options.submittedBy] the operator, for the note author
 * @param {string} [options.approvedBy] the operator who approved the send
 * @returns {object} the submission body
 */
export function buildCrmSubmission(bundle, { submittedBy = null, approvedBy = null } = {}) {
  const payload = enrichPayload(bundle, bundle?.synthesis?.payload ?? {});
  const primarySource = bundle?.source_index?.[0] ?? null;
  const citation =
    (bundle?.source_index ?? []).map((source) => `${source.source_id} ${source.reference}`).join("; ") ||
    "RSG intake gate";

  const facts = buildFacts(payload, { citation, sourceRef: primarySource?.reference ?? null });

  // The note carries the assessment narrative. `source.submitted_by` becomes the
  // note author at the far end, and `source.date`/`source_ref` its provenance.
  const source = {
    type: "document",
    submitted_by: submittedBy ?? "rsg-intake-gate",
    date: String(bundle?.created_at ?? "").slice(0, 10) || null,
    source_ref: `rsg-intake-gate:${bundle?.intake_id ?? ""}`,
  };

  return {
    // Stable per intake: a retry after a timeout adopts the existing submission
    // instead of opening a second one. This is the whole reason a failed CRM
    // write is safe to retry by hand.
    idempotency_key: `rsg-intake-gate:${bundle?.intake_id ?? ""}`,
    source: INTAKE_SOURCE,
    agent: submissionAgent(payload),
    intake_kind: "full_intake",
    captured_at: bundle?.created_at ?? null,
    // Metadata only — the source text itself stays in the gateway's own encrypted
    // store. This records WHAT the intake was built from without copying it.
    documents: (bundle?.source_index ?? []).map((item) => ({
      type: item.kind,
      source_file: item.reference,
    })),
    notes: bundle?.assessment?.summary ?? null,
    // The review already happened, here, in front of a person. Naming the
    // approver lets Hermes commit on it instead of queueing for an approval that
    // — with no Slack in the loop — nobody would ever be asked to give.
    ...(approvedBy ? { approved_by: approvedBy, approval_token: "APPROVE ALL" } : {}),
    synthesized_payload: { ...payload, facts, source },
  };
}
