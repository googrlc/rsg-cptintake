import { resolveFieldContract } from "../contracts/nowcerts-field-contracts.js";

function asList(value) {
  return Array.isArray(value) ? value.filter((item) => item != null && item !== "") : [];
}

function labelFlag(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return String(value ?? "");
  return [value.flag ?? value.item ?? value.name, value.severity ? `(${value.severity})` : null, value.why_needed].filter(Boolean).join(" — ");
}

// "Jane Ukoh" -> first Jane / last Ukoh. Middle tokens join the first name so a
// surname is never invented, and anything that is not clearly two-or-more parts
// returns nulls so the caller can fall back to the uncontracted Name field.
export function splitContactName(value) {
  const parts = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { first: null, last: null };
  return { first: parts.slice(0, -1).join(" "), last: parts.at(-1) };
}

function sourceCitation(bundle, preferred = null) {
  if (preferred) return String(preferred);
  return bundle.source_index.map((source) => `${source.source_id} ${source.reference}`).join("; ") || "Source bundle";
}

function amsCandidates(payload, bundle) {
  const account = payload.account ?? {};
  const classifications = asList(payload.classification);
  const insuredType = classifications.some((item) => String(item).includes("Commercial")) || account.account_type === "Commercial Lines"
    ? "Commercial"
    : classifications.some((item) => String(item).includes("Personal")) || account.account_type === "Personal Lines"
      ? "Personal"
      : null;
  const fields = [
    ["Insured.Name", account.account_name], ["Insured.LegalName", account.legal_name],
    ["Insured.DBA", account.dba], ["Insured.FEIN", account.fein], ["Insured.EntityType", account.entity_type],
    ["Insured.Address", account.address], ["Insured.City", account.city], ["Insured.State", account.state],
    ["Insured.Zip", account.zip], ["Insured.Phone", account.phone], ["Insured.Email", account.email],
    ["Insured.Website", account.website], ["Insured.NAICS", account.naics], ["Insured.SIC", account.sic],
    ["Insured.Type", insuredType],
  ];
  for (const [index, contact] of asList(payload.contacts).entries()) {
    const prefix = `Contact[${index + 1}]`;
    // The AMS contact tool takes firstName/lastName separately, so a synthesized
    // full name is split rather than sent whole. An unsplittable single-token
    // name keeps its Name field, which has no contract and lands on the report
    // for a human to resolve — never guessed into a surname.
    const { first, last } = splitContactName(contact.full_name);
    fields.push(
      ...(first && last
        ? [[`${prefix}.FirstName`, first], [`${prefix}.LastName`, last]]
        : [[`${prefix}.Name`, contact.full_name]]),
      [`${prefix}.Phone`, contact.phone],
      [`${prefix}.Email`, contact.email],
      [`${prefix}.Role`, contact.role],
      [`${prefix}.DOB`, contact.date_of_birth ?? contact.dob],
      [`${prefix}.LicenseNumber`, contact.license_number ?? contact.dl_number],
      [`${prefix}.LicenseState`, contact.license_state ?? contact.dl_state],
    );
  }
  const amsFields = [];
  const unsupported = [];
  for (const [field, value] of fields.filter(([, candidate]) => candidate != null && candidate !== "")) {
    const contract = resolveFieldContract(field, bundle.client.intended_operation);
    if (!contract) {
      unsupported.push({ field, value, citation: sourceCitation(bundle), reason: `No ${bundle.client.intended_operation} + read-back contract is certified for this field.` });
      continue;
    }
    amsFields.push({ field, current: null, value, citation: sourceCitation(bundle), contract_status: contract.schema_status, contract });
  }
  return { amsFields, unsupported };
}

export function buildEvidenceText(bundle, pdfTexts = new Map()) {
  const parts = [`CLIENT: ${bundle.client.display_name}`, `INTENDED AMS OPERATION: ${bundle.client.intended_operation}`];
  for (const source of bundle.sources) {
    const indexed = bundle.source_index.find((item) => item.reference === (source.filename ?? source.title));
    const marker = `${indexed?.source_id ?? "SOURCE"} | ${source.title}`;
    if (source.kind === "pdf") {
      const extracted = pdfTexts.get(source.document_id);
      parts.push(`=== PDF ${marker} ===\n${extracted?.text || "[No machine-readable text found. Manual review/OCR required.]"}`);
    } else {
      const heading = source.kind === "manual_facts"
        ? `OPERATOR-PROVIDED FACTS (authoritative — treat as confirmed) ${marker}`
        : `${source.kind.toUpperCase()} ${marker}`;
      parts.push(`=== ${heading} ===\n${source.content}`);
    }
  }
  return parts.join("\n\n");
}

export function applyHermesPreview(bundle, draft, research = null, pdfWarnings = []) {
  const payload = draft.payload_preview ?? {};
  const account = payload.account ?? {};
  const opportunities = asList(payload.opportunities);
  const flags = asList(payload.underwriting_flags).map(labelFlag);
  const missing = [
    ...asList(payload.missing_information).map(labelFlag),
    ...asList(draft.validation_warnings),
    ...pdfWarnings,
  ];
  const researchNaics = research?.naics ?? null;
  const source = sourceCitation(bundle);
  const operationSummary = account.operations_summary ?? research?.short_summary ?? null;
  const operation = operationSummary ? [{
    name: operationSummary,
    naics: account.naics ?? researchNaics,
    gl_codes: [], wc_codes: [], evidence: source,
  }] : [];
  const enrichedPayload = { ...payload, account: { ...account, naics: account.naics ?? researchNaics, sic: account.sic ?? research?.sic } };
  const { amsFields, unsupported } = amsCandidates(enrichedPayload, bundle);
  if (bundle.client.intended_operation === "create") {
    const requiredFields = ["Insured.Name", "Insured.Address", "Insured.City", "Insured.State", "Insured.Zip", "Insured.Type"];
    for (const field of requiredFields) {
      if (!amsFields.some((item) => item.field === field)) missing.push(`AMS create requires a sourced ${field} value.`);
    }
  }
  const assessmentOnly = [
    ["Operations summary", operationSummary], ["Annual revenue", account.annual_revenue],
    ["Estimated payroll", account.estimated_payroll], ["Employee count", account.employee_count],
    ["Underwriting flags", flags.join("; ")], ["Research summary", research?.short_summary],
  ].filter(([, value]) => value != null && value !== "").map(([field, value]) => ({ field, value, citation: source }));
  assessmentOnly.push(...unsupported);

  return {
    ...bundle,
    status: missing.length ? "READY_FOR_REVIEW" : "PREVIEW_READY",
    synthesis: { status: "COMPLETE", draft_id: draft.draft_id, payload, warnings: asList(draft.validation_warnings) },
    research: research ? { status: "COMPLETE", ...research } : { status: "UNAVAILABLE" },
    routing: { ...bundle.routing, ams_fields: amsFields, assessment_only: assessmentOnly, missing_items: missing },
    assessment: {
      ...bundle.assessment,
      status: "COMPLETE",
      review_status: missing.length ? "Needs Review" : "Ready for Review",
      summary: payload.note?.body ?? operationSummary ?? "INSUFFICIENT EVIDENCE",
      operations: operation,
      naics: [account.naics ?? researchNaics].filter(Boolean),
      sic: [account.sic ?? research?.sic].filter(Boolean),
      coverage_requirements: asList(payload.coverage_needs).length ? asList(payload.coverage_needs) : opportunities.map((item) => item.line_of_business).filter(Boolean),
      red_flags: flags,
      missing_items: missing,
      evidence_map: bundle.source_index.map((item) => ({ source: item.source_id, reference: item.reference, fact: "Included in Hermes synthesis input" })),
      confidence: research?.confidence === "high" ? 85 : research?.confidence === "medium" ? 70 : null,
    },
    pipeline: {
      synthesis: "READY", reference_code_lookup: research ? "READY" : "NEEDS_REVIEW",
      risk_assessment: "READY", nowcerts_preview: amsFields.length ? "SCHEMA_ALIGNED" : "NEEDS_REVIEW", retained_pdf: "READY",
    },
    approval: {
      status: "LOCKED", reason: "Live NowCerts field mappings, pre-write reread, idempotency, and post-write read-back are not yet certified.",
    },
  };
}
