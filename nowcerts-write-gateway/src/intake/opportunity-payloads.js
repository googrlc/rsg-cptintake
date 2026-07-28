// The pipeline vocabulary the intake speaks: line-of-business names, who owns a
// line, and how a source becomes one readable sentence on a card.
//
// Contract owner is rsg-hermes (build spec 2026-07-26). Rules that matter and are
// enforced here rather than left to the caller:
//
//  - One opportunity per line of business. Never a bundled "Commercial Package".
//  - Send only what we have. Hermes derives stage/probability/likelihood from
//    opportunity_type, and a guess is worse than an omission.
//  - Never send `stage`, `probability`, `likelihood` or `referral_source`
//    (read-only, owned by the AMS sync), and never `client_identifier` (derived
//    server-side; computing it here risks a near-miss slug that defeats the
//    uniqueness constraint).
//  - assigned_to is a JSON array encoded as a STRING, mirroring NowCerts' shape.
//    An unowned opportunity is how a renewal goes dark, so it is always set.
//
// These used to feed a direct POST /api/opportunities fan-out from the gateway.
// They no longer do: the intake goes through Hermes' one intake door, which
// creates the opportunities itself on approval. The vocabulary stayed, because
// the payload still has to speak it — see crm-submission.js.
//
// This module is pure so the mapping is testable without a network.

export const OWNER_LAMAR = '["Lamar Coates"]';
export const OWNER_GRETCHEN = '["Gretchen Coates"]';

// OPPORTUNITY_SOURCE and OPPORTUNITY_TYPES lived here for the direct
// POST /api/opportunities fan-out. That fan-out is gone — the CRM opens the
// opportunities itself from the submitted intake — and the constants went with
// it rather than being left as vocabulary nothing speaks.

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
