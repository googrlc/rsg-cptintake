import { randomUUID } from "node:crypto";
import { z } from "zod";

export const MAX_TEXT_SOURCE_CHARS = 250_000;
export const MAX_TOTAL_TEXT_CHARS = 750_000;
export const MAX_SOURCES = 50;

const pdfSourceSchema = z
  .object({
    kind: z.literal("pdf"),
    document_id: z.string().uuid(),
    title: z.string().trim().min(1).max(255),
    filename: z.string().trim().min(1).max(255),
    byte_size: z.number().int().positive().max(25 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    page_count: z.number().int().positive().nullable(),
    captured_at: z.string().datetime({ offset: true }),
  })
  .strict();

const textSourceSchema = z
  .object({
    kind: z.enum(["transcript", "notes", "manual_facts"]),
    title: z.string().trim().min(1).max(255),
    content: z.string().trim().min(1).max(MAX_TEXT_SOURCE_CHARS),
    captured_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const intakeSourceSchema = z.discriminatedUnion("kind", [pdfSourceSchema, textSourceSchema]);

export const prepareSourceBundleSchema = z
  .object({
    client_name: z.string().trim().min(1).max(200),
    existing_client_id: z.string().trim().min(1).max(100).nullable(),
    sources: z.array(intakeSourceSchema).min(1).max(MAX_SOURCES),
  })
  .strict();

function summarizeSources(sources) {
  const counts = { pdf: 0, transcript: 0, notes: 0, manual_facts: 0 };
  for (const source of sources) counts[source.kind] += 1;
  return counts;
}

function sourceIndex(sources) {
  return sources.map((source, index) => ({
    source_id: `SRC-${String(index + 1).padStart(3, "0")}`,
    kind: source.kind,
    title: source.title,
    reference: source.kind === "pdf" ? source.filename : source.title,
    captured_at: source.captured_at,
    ...(source.kind === "pdf"
      ? {
          document_id: source.document_id,
          sha256: source.sha256,
          page_count: source.page_count,
          byte_size: source.byte_size,
        }
      : { character_count: source.content.length }),
  }));
}

export function prepareSourceBundle(input, { now = new Date().toISOString(), intakeId = randomUUID() } = {}) {
  const parsed = prepareSourceBundleSchema.parse(input);
  const textCharacters = parsed.sources
    .filter((source) => source.kind !== "pdf")
    .reduce((total, source) => total + source.content.length, 0);
  if (textCharacters > MAX_TOTAL_TEXT_CHARS) {
    throw new Error(`Combined transcript and notes exceed ${MAX_TOTAL_TEXT_CHARS} characters.`);
  }

  return {
    schema_version: "1.0.0",
    intake_id: intakeId,
    status: "READY_FOR_SYNTHESIS",
    created_at: now,
    client: {
      display_name: parsed.client_name,
      existing_client_id: parsed.existing_client_id,
      intended_operation: parsed.existing_client_id ? "update" : "create",
    },
    sources: parsed.sources,
    source_index: sourceIndex(parsed.sources),
    source_counts: summarizeSources(parsed.sources),
    routing: {
      ams_fields: [],
      assessment_only: [],
      conflicts: [],
      missing_items: [],
    },
    assessment: {
      status: "PENDING_SYNTHESIS",
      operations: [],
      naics: [],
      sic: [],
      gl_codes: [],
      wc_codes: [],
      coverage_requirements: [],
      endorsements: [],
      red_flags: [],
      favorable_factors: [],
      confidence: null,
    },
    pipeline: {
      synthesis: "NOT_CONFIGURED",
      reference_code_lookup: "NOT_CONFIGURED",
      risk_assessment: "NOT_CONFIGURED",
      nowcerts_preview: "NOT_CONFIGURED",
      retained_pdf: "NOT_CONFIGURED",
    },
    report_url: `/api/intakes/${intakeId}/report.pdf`,
    live_writes: false,
  };
}
