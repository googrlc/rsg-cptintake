// Map intake CRM records onto Hermes POST /api/opportunities payloads.
//
// Contract owner is rsg-hermes (build spec 2026-07-26). Rules that matter and
// are enforced here rather than left to the caller:
//
//  - One opportunity per line of business. Never a bundled "Commercial Package".
//  - Send only what we have. Every field except line_of_business and the client
//    identity is optional, and Hermes derives stage/probability/likelihood from
//    opportunity_type. A guess is worse than an omission.
//  - Never send `stage`, `probability`, `likelihood`, or `referral_source`
//    (read-only, owned by the AMS sync), and never `client_identifier` (derived
//    server-side; computing it here risks a near-miss slug that defeats the
//    uniqueness constraint).
//  - assigned_to is a JSON array encoded as a STRING, mirroring NowCerts' shape.
//    An unowned opportunity is how a renewal goes dark, so it is always set.
//
// This module is pure so the mapping is testable without a network.

export const OPPORTUNITY_SOURCE = "intake-gate";

export const OWNER_LAMAR = '["Lamar Coates"]';
export const OWNER_GRETCHEN = '["Gretchen Coates"]';

export const OPPORTUNITY_TYPES = [
  "New Business", "Renewals", "Cross-selling", "Upselling", "Remarket",
  "Bundling", "Competitive Replacements (BOR)", "Life Events", "Seasonal / Event",
];

// The book's existing line-of-business vocabulary. Matching it keeps the
// pipeline from fragmenting into near-duplicate lines. Note the apostrophe in
// "Worker's Compensation" -- it is the spelling already in use.
const LOB_CANONICAL = [
  "Personal Auto", "Commercial Auto", "Homeowners", "General Liability",
  "Worker's Compensation", "Professional Liability", "Commercial Property", "Motorcycle",
];

const LOB_ALIASES = new Map([
  ["workers compensation", "Worker's Compensation"],
  ["workers comp", "Worker's Compensation"],
  ["workers' compensation", "Worker's Compensation"],
  ["work comp", "Worker's Compensation"],
  ["wc", "Worker's Compensation"],
  ["gl", "General Liability"],
  ["general liability", "General Liability"],
  ["commercial general liability", "General Liability"],
  ["cgl", "General Liability"],
  ["professional liability", "Professional Liability"],
  ["e&o", "Professional Liability"],
  ["errors and omissions", "Professional Liability"],
  ["commercial property", "Commercial Property"],
  ["property", "Commercial Property"],
  ["business personal property", "Commercial Property"],
  ["commercial auto", "Commercial Auto"],
  ["personal auto", "Personal Auto"],
  ["auto", "Commercial Auto"],
  ["homeowners", "Homeowners"],
  ["home", "Homeowners"],
  ["motorcycle", "Motorcycle"],
]);

const PERSONAL_LINES = new Set(["Personal Auto", "Homeowners", "Motorcycle"]);

/**
 * Normalize a line of business onto the book's vocabulary. Unrecognized values
 * pass through trimmed rather than being dropped or forced onto a near match --
 * Hermes accepts free text, and silently rewriting an unknown line would hide a
 * real new product from whoever reads the pipeline.
 */
export function canonicalLineOfBusiness(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const exact = LOB_CANONICAL.find((lob) => lob.toLowerCase() === text.toLowerCase());
  if (exact) return exact;
  return LOB_ALIASES.get(text.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ")) ?? text;
}

/**
 * Owner selection. Personal lines go to Gretchen, commercial to Lamar, and an
 * unclear case goes to Lamar and says so in the description.
 */
export function assignOwner(lineOfBusiness, { accountType = null } = {}) {
  const lob = canonicalLineOfBusiness(lineOfBusiness);
  if (lob && PERSONAL_LINES.has(lob)) return { assigned_to: OWNER_GRETCHEN, unclear: false };
  if (lob && LOB_CANONICAL.includes(lob)) return { assigned_to: OWNER_LAMAR, unclear: false };
  // Unrecognized line: fall back to the account type, then to Lamar.
  if (/personal/i.test(String(accountType ?? ""))) return { assigned_to: OWNER_GRETCHEN, unclear: true };
  return { assigned_to: OWNER_LAMAR, unclear: true };
}

// Hermes has no per-field citation column, so the gateway's structured source
// object is flattened into one sentence a human can read. Deliberately not
// JSON-stuffed.
export function buildProvenance({ source = null, needsReview = [], unclearOwner = false, extra = [] } = {}) {
  const parts = [];
  if (source?.reference) {
    const kind = String(source.kind ?? "source").replace(/_/g, " ");
    const captured = source.captured_at ? ` captured ${source.captured_at}` : "";
    parts.push(`Source: ${kind} "${source.reference}"${captured}.`);
  } else {
    parts.push("Source: RSG intake gate.");
  }
  if (needsReview.length) {
    const fields = needsReview.map((item) => item.field ?? item).filter(Boolean);
    parts.push(`${fields.length} field(s) needed review: ${fields.join(", ")}.`);
  }
  if (unclearOwner) parts.push("Owner could not be determined from the line of business; assigned to Lamar Coates.");
  parts.push(...extra.filter(Boolean));
  return parts.join(" ");
}

function firstPresent(records, fieldName) {
  for (const record of records) {
    const hit = (record.fields ?? []).find((f) => f.field === fieldName && f.value != null && f.value !== "");
    if (hit) return hit.value;
  }
  return null;
}

/**
 * Build one Hermes opportunity payload per line of business.
 *
 * @param {object} bundle an intake bundle carrying crm_records
 * @param {object} [options]
 * @param {string|null} [options.insuredId] NowCerts insured GUID, when known
 * @returns {{payloads: object[], skipped: object[]}}
 */
export function toOpportunityPayloads(bundle, { insuredId = null } = {}) {
  const records = Array.isArray(bundle?.crm_records) ? bundle.crm_records : [];
  const opportunities = records.filter((r) => r.entity === "opportunity");
  const accountRecords = records.filter((r) => r.entity === "account");

  const insuredName = bundle?.client?.display_name ?? firstPresent(accountRecords, "account_name");
  const accountType = firstPresent(accountRecords, "account_type");
  const fein = firstPresent([...opportunities, ...accountRecords], "fein");
  // An intake against an existing client is a cross-sell; a brand new prospect
  // is new business.
  const opportunityType = bundle?.client?.existing_client_id ? "Cross-selling" : "New Business";
  const primarySource = bundle?.source_index?.[0] ?? null;

  const payloads = [];
  const skipped = [];

  for (const record of opportunities) {
    const rawLob = (record.fields ?? []).find((f) => f.field === "line_of_business")?.value ?? null;
    const lineOfBusiness = canonicalLineOfBusiness(rawLob);
    // Hermes requires a line of business, and the client identity. Without
    // either there is nothing to open a pipeline record against.
    if (!lineOfBusiness || !insuredName) {
      skipped.push({
        line_of_business: lineOfBusiness,
        reason: !lineOfBusiness ? "NO_LINE_OF_BUSINESS" : "NO_INSURED_NAME",
        needs_review: record.needs_review ?? [],
      });
      continue;
    }

    const { assigned_to: assignedTo, unclear } = assignOwner(lineOfBusiness, { accountType });
    const get = (name) => (record.fields ?? []).find((f) => f.field === name)?.value ?? null;
    const premium = get("current_premium") ?? get("premium_estimate");
    const carrier = get("current_carrier");

    // Only defined keys are added: Hermes treats an absent field as "not
    // supplied", and sending null would look like a deliberate blank.
    const payload = {
      line_of_business: lineOfBusiness,
      insured_name: insuredName,
      opportunity_type: opportunityType,
      assigned_to: assignedTo,
      description: buildProvenance({
        source: primarySource,
        needsReview: record.needs_review ?? [],
        unclearOwner: unclear,
      }),
      source: OPPORTUNITY_SOURCE,
    };
    if (fein) payload.fein = fein;
    if (insuredId) payload.insured_id = insuredId;
    if (premium != null && premium !== "") payload.premium_estimate = premium;
    if (carrier) payload.carrier = carrier;

    payloads.push(payload);
  }

  return { payloads, skipped };
}
