import { z } from "zod";
import { validateEntityFields } from "./entity-schemas.js";

// Versioned, evidence-cited extraction contract. Every candidate field must
// carry the filename, page number, and a short supporting excerpt. A field the
// model could not read cleanly is reported with a non-ok status and is NEVER
// promoted to a proposed change: the system quarantines it as needs_review
// rather than guessing.
//
// `confidence` is captured for triage only. It is explicitly not a gate: a
// high-confidence field with a failed format or a missing excerpt is still
// quarantined, and a low-confidence field never authorizes anything on its own.

export const EXTRACTION_SCHEMA_VERSION = "1.0.0";

export const FieldStatus = {
  OK: "ok", // read cleanly with direct evidence
  MISSING: "missing", // required field not present in the document
  UNREADABLE: "unreadable", // present but not legible (scan quality, handwriting)
  AMBIGUOUS: "ambiguous", // more than one plausible reading
  CONFLICT: "conflict", // sources within the document disagree
};

export const ReviewReason = {
  NO_EVIDENCE: "no_evidence",
  UNREADABLE: "unreadable",
  MISSING: "missing",
  AMBIGUOUS: "ambiguous",
  CONFLICT: "conflict",
  BAD_FORMAT: "bad_format",
  UNKNOWN_FIELD: "unknown_field",
  DUPLICATE_FIELD: "duplicate_field",
};

const evidenceSchema = z
  .object({
    filename: z.string().trim().min(1),
    page: z.number().int().positive(),
    excerpt: z.string().trim().min(1).max(500),
  })
  .strict();

const extractedFieldSchema = z
  .object({
    field: z.string().trim().min(1),
    value: z.unknown(),
    status: z.enum([
      FieldStatus.OK,
      FieldStatus.MISSING,
      FieldStatus.UNREADABLE,
      FieldStatus.AMBIGUOUS,
      FieldStatus.CONFLICT,
    ]),
    // Evidence is required for ok fields; nullable for the non-ok statuses,
    // where the point is precisely that clean evidence was unavailable.
    evidence: evidenceSchema.nullable(),
    confidence: z.number().min(0).max(1).nullable(),
  })
  .strict();

export const extractionResultSchema = z
  .object({
    schema_version: z.literal(EXTRACTION_SCHEMA_VERSION),
    document_id: z.string().trim().min(1),
    filename: z.string().trim().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    document_class: z.string().trim().min(1),
    candidate_entity: z.string().trim().min(1),
    candidate_operation: z.enum(["create", "update", "import", "archive", "deactivate"]),
    fields: z.array(extractedFieldSchema),
    unreadable_pages: z.array(z.number().int().positive()),
  })
  .strict();

/**
 * Contract every extractor (offline stub or live OpenAI implementation) must
 * satisfy. The live implementation is deferred; this keeps the pipeline testable
 * and prevents extraction from ever calling a writer.
 * @typedef {{ extract(input: {document_id: string, filename: string, sha256: string, buffer?: Buffer}): Promise<object> }} Extractor
 */

// Deterministic offline extractor. Returns a pre-seeded extraction result keyed
// by sha256 (preferred) or filename. Used by tests and shadow runs so no model
// call or API key is involved.
export class StubExtractor {
  constructor(fixtures = {}) {
    this.byKey = new Map();
    for (const [key, result] of Object.entries(fixtures)) this.byKey.set(key, result);
  }

  register(key, result) {
    this.byKey.set(key, result);
  }

  async extract({ document_id: documentId, filename, sha256 }) {
    const seed = this.byKey.get(sha256) ?? this.byKey.get(filename);
    if (!seed) {
      throw new Error(`No stub extraction registered for ${filename} (${sha256}).`);
    }
    // The actual document's identity always wins over any placeholder in the seed.
    return { ...seed, schema_version: EXTRACTION_SCHEMA_VERSION, document_id: documentId, filename, sha256 };
  }
}

/**
 * Partition a validated extraction result into evidence-backed proposed fields
 * and quarantined needs_review fields. This is the never-guess boundary: only a
 * field that is (a) status ok, (b) carries filename+page+excerpt evidence, (c)
 * appears exactly once, and (d) passes its entity format check becomes a
 * proposed change. Everything else is needs_review with a reason.
 *
 * @param {object} rawResult extraction result to validate and reconcile
 * @returns {{ok: boolean, error?: string, document_class?: string, candidate_entity?: string,
 *   candidate_operation?: string, proposed?: Array, needs_review?: Array, unreadable_pages?: number[]}}
 */
export function reconcileExtraction(rawResult) {
  const parsed = extractionResultSchema.safeParse(rawResult);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  const result = parsed.data;
  const reconciled = reconcileFields(result.candidate_entity, result.candidate_operation, result.fields);
  return {
    ok: true,
    document_class: result.document_class,
    candidate_entity: result.candidate_entity,
    candidate_operation: result.candidate_operation,
    unreadable_pages: result.unreadable_pages,
    ...reconciled,
  };
}

/**
 * The never-guess partitioning shared by the PDF document path and the text
 * intake path. Given cited candidate fields, it splits them into:
 *   - proposed:     status ok, evidence present, unique, valid entity format
 *   - needs_review: missing / unreadable / ambiguous / conflict / no-evidence /
 *                   duplicate / bad-format (never guessed)
 *   - pdf_only:     cited fields that are not part of the AMS entity schema,
 *                   when the caller routes unknowns to the PDF instead of
 *                   quarantining them ("what belongs in the AMS goes to the AMS;
 *                   everything else lives on the PDF")
 *
 * Each field is `{ field, value, status, evidence }`; evidence is any truthy
 * citation object (the document path uses filename+page+excerpt, the intake
 * path uses kind+reference+excerpt). A missing/falsy evidence for an ok field
 * is itself a quarantine reason.
 *
 * @param {string} candidateEntity
 * @param {string} candidateOperation
 * @param {Array<{field:string,value:unknown,status:string,evidence:unknown}>} fields
 * @param {{unknownDisposition?: "review"|"pdf_only"}} [options]
 */
export function reconcileFields(candidateEntity, candidateOperation, fields, { unknownDisposition = "review" } = {}) {
  const proposed = [];
  const needsReview = [];
  const pdfOnly = [];
  const seen = new Map();

  for (const item of fields) {
    seen.set(item.field, (seen.get(item.field) ?? 0) + 1);
    if (item.status !== FieldStatus.OK) {
      needsReview.push({ field: item.field, reason: reasonForStatus(item.status), evidence: item.evidence });
      continue;
    }
    if (!item.evidence) {
      needsReview.push({ field: item.field, reason: ReviewReason.NO_EVIDENCE, evidence: null });
      continue;
    }
    proposed.push(item);
  }

  // A field appearing more than once is two readings for one field — ambiguous.
  const duplicated = new Set([...seen.entries()].filter(([, n]) => n > 1).map(([f]) => f));
  const dedupedProposed = [];
  for (const item of proposed) {
    if (duplicated.has(item.field)) {
      needsReview.push({ field: item.field, reason: ReviewReason.DUPLICATE_FIELD, evidence: item.evidence });
      continue;
    }
    dedupedProposed.push(item);
  }

  const valueMap = Object.fromEntries(dedupedProposed.map((i) => [i.field, i.value]));
  const entityCheck = validateEntityFields(candidateEntity, valueMap, {
    forCreate: candidateOperation === "create" || candidateOperation === "import",
  });

  const finalProposed = [];
  for (const item of dedupedProposed) {
    if (entityCheck.unknownFields.includes(item.field)) {
      if (unknownDisposition === "pdf_only") {
        pdfOnly.push(item);
      } else {
        needsReview.push({ field: item.field, reason: ReviewReason.UNKNOWN_FIELD, evidence: item.evidence });
      }
      continue;
    }
    if (entityCheck.fieldErrors[item.field]) {
      needsReview.push({
        field: item.field,
        reason: ReviewReason.BAD_FORMAT,
        detail: entityCheck.fieldErrors[item.field],
        evidence: item.evidence,
      });
      continue;
    }
    finalProposed.push(item);
  }

  return {
    proposed: finalProposed,
    needs_review: needsReview,
    pdf_only: pdfOnly,
    missing_required: entityCheck.missingRequired,
    unknown_entity: entityCheck.unknownEntity,
  };
}

function reasonForStatus(status) {
  switch (status) {
    case FieldStatus.MISSING:
      return ReviewReason.MISSING;
    case FieldStatus.UNREADABLE:
      return ReviewReason.UNREADABLE;
    case FieldStatus.AMBIGUOUS:
      return ReviewReason.AMBIGUOUS;
    case FieldStatus.CONFLICT:
      return ReviewReason.CONFLICT;
    default:
      return ReviewReason.UNREADABLE;
  }
}
