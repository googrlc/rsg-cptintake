import { z } from "zod";
import { FieldStatus } from "../documents/extraction.js";

// Structured contract for a parsed new-business intake ("first initial
// assessment"). The free-text blob from the Intake screen is parsed and
// synthesized into one or more candidate records (an insured, its contacts, and
// the opportunity/coverage context). Every field is cited: it carries where the
// value came from (the intake text or an enrichment source) and a supporting
// excerpt. Fields the parser could not read cleanly get a non-ok status and are
// never promoted to a write — they are surfaced for review, never guessed.

export const INTAKE_SCHEMA_VERSION = "1.0.0";

// Where a value came from. intake_text = the submitted assessment; enrichment =
// a lookup that FOUND missing information (must still be cited, never invented).
export const Provenance = {
  INTAKE_TEXT: "intake_text",
  ENRICHMENT: "enrichment",
};

const citationSchema = z
  .object({
    // Maps onto the gateway's source contract: intake_text -> user_message,
    // enrichment -> trusted_system.
    provenance: z.enum([Provenance.INTAKE_TEXT, Provenance.ENRICHMENT]),
    reference: z.string().trim().min(1), // e.g. "new-business intake" or "Secretary of State — GA"
    excerpt: z.string().trim().min(1).max(500),
  })
  .strict();

const intakeFieldSchema = z
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
    citation: citationSchema.nullable(),
  })
  .strict();

// A candidate record synthesized from the intake. `role` links contacts to the
// insured; `write_target` says where this record is meant to land.
const intakeRecordSchema = z
  .object({
    entity: z.string().trim().min(1),
    operation: z.enum(["create", "update"]),
    role: z.enum(["primary_insured", "contact", "opportunity"]),
    write_target: z.enum(["nowcerts", "hermes", "pdf_only"]),
    fields: z.array(intakeFieldSchema),
  })
  .strict();

export const parsedIntakeSchema = z
  .object({
    schema_version: z.literal(INTAKE_SCHEMA_VERSION),
    submitted_by: z.enum(["lamar", "gretchen"]),
    raw_text: z.string().trim().min(1),
    records: z.array(intakeRecordSchema).min(1),
    // Free-form context that belongs on the intake PDF but not necessarily in a
    // structured AMS field (requested lines of coverage, notes, etc.).
    coverage_lines: z.array(z.string().trim().min(1)),
  })
  .strict();

// Translate an intake citation into the gateway's source object. captured_at is
// supplied by the builder at assembly time.
export function citationToSource(citation, capturedAt) {
  return {
    kind: citation.provenance === Provenance.ENRICHMENT ? "trusted_system" : "user_message",
    reference: citation.reference,
    location: citation.provenance === Provenance.ENRICHMENT ? "enrichment lookup" : "new-business intake",
    excerpt: citation.excerpt,
    captured_at: capturedAt,
  };
}
