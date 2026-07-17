import { EXTRACTION_SCHEMA_VERSION, FieldStatus } from "../src/documents/extraction.js";

// Synthetic, dependency-free PDF byte fixtures for intake tests. These are not
// real rendered PDFs; they carry exactly the structural markers the intake
// validator inspects, so each fixture exercises one accept/reject path.

const MINIMAL_BODY =
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R>>endobj\n";

export function validPdf() {
  return Buffer.from(`%PDF-1.4\n${MINIMAL_BODY}trailer<</Root 1 0 R>>\n%%EOF\n`, "latin1");
}

export function encryptedPdf() {
  return Buffer.from(
    `%PDF-1.4\n${MINIMAL_BODY}trailer<</Root 1 0 R/Encrypt 5 0 R>>\n%%EOF\n`,
    "latin1",
  );
}

// Valid signature and objects but no trailing %%EOF: truncated in transit.
export function truncatedPdf() {
  return Buffer.from(`%PDF-1.4\n${MINIMAL_BODY}`, "latin1");
}

// Signature only, no object structure.
export function structurelessPdf() {
  return Buffer.from("%PDF-1.4\nrandom bytes with no objects\n%%EOF\n", "latin1");
}

export function notPdf() {
  return Buffer.from("This is a plain text file, not a PDF.\n", "latin1");
}

export function emptyFile() {
  return Buffer.alloc(0);
}

// --- Extraction result fixtures -------------------------------------------

function evidence(filename, page, excerpt) {
  return { filename, page, excerpt };
}

/**
 * Build an extraction result. Each field entry is [name, value, status?,
 * evidenceExcerpt?, page?]. Defaults to a clean ok field with evidence.
 */
export function makeExtraction({
  document_id = "00000000-0000-4000-8000-000000000000",
  filename = "doc.pdf",
  sha256 = "a".repeat(64),
  document_class = "declaration_page",
  candidate_entity = "policy",
  candidate_operation = "create",
  fields = [],
  unreadable_pages = [],
} = {}) {
  return {
    schema_version: EXTRACTION_SCHEMA_VERSION,
    document_id,
    filename,
    sha256,
    document_class,
    candidate_entity,
    candidate_operation,
    unreadable_pages,
    fields: fields.map(([field, value, status = FieldStatus.OK, excerpt, page = 1]) => ({
      field,
      value,
      status,
      confidence: 0.9,
      evidence:
        status === FieldStatus.OK && excerpt !== null
          ? evidence(filename, page, excerpt ?? `${field}: ${value}`)
          : excerpt
            ? evidence(filename, page, excerpt)
            : null,
    })),
  };
}

// A clean, evidence-backed policy declaration page.
export function cleanPolicyExtraction(overrides = {}) {
  return makeExtraction({
    document_class: "declaration_page",
    candidate_entity: "policy",
    candidate_operation: "create",
    fields: [
      ["policy_number", "APV-100200", FieldStatus.OK, "Policy Number: APV-100200"],
      ["carrier_name", "Example Insurance Co", FieldStatus.OK, "Carrier: Example Insurance Co"],
      ["line_of_business", "Commercial Auto", FieldStatus.OK, "Line: Commercial Auto"],
      ["effective_date", "2026-08-01", FieldStatus.OK, "Effective 08/01/2026"],
      ["expiration_date", "2027-08-01", FieldStatus.OK, "Expires 08/01/2027"],
      ["premium", "4200.00", FieldStatus.OK, "Premium $4,200.00"],
    ],
    ...overrides,
  });
}
