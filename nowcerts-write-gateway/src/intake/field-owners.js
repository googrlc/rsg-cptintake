// Classify intake fields by write owner for the write-routing spine.
//
// AMS-owned facts (insured / policy / endorsement) go to NowCerts FIRST via the
// gateway commit path. CRM-owned facts (leads, pipeline, cases, notes) go to
// Hermes keyed by the NowCerts GUID. Assessment-only stays on the retained PDF.

export const OWNER_AMS = "ams";
export const OWNER_CRM = "crm";
export const OWNER_ASSESSMENT = "assessment";

const AMS_PREFIXES = [
  "Insured.",
  "Policy.",
  "Endorsement.",
  "PolicyChange.",
  "Coverage.",
];

const CRM_FIELDS = new Set([
  "Lead.Status",
  "Lead.Source",
  "Lead.Notes",
  "Opportunity.Stage",
  "Opportunity.LineOfBusiness",
  "Opportunity.Notes",
  "Case.Type",
  "Case.Notes",
  "Pipeline.Stage",
  "Note.Body",
]);

export function classifyFieldOwner(field) {
  const name = String(field ?? "");
  if (!name) return OWNER_ASSESSMENT;
  if (CRM_FIELDS.has(name) || name.startsWith("Lead.") || name.startsWith("Opportunity.")
      || name.startsWith("Case.") || name.startsWith("Note.") || name.startsWith("Pipeline.")) {
    return OWNER_CRM;
  }
  if (AMS_PREFIXES.some((prefix) => name.startsWith(prefix))) return OWNER_AMS;
  // Contact rows on the insured are AMS when certified; otherwise assessment.
  if (name.startsWith("Contact[")) return OWNER_AMS;
  return OWNER_ASSESSMENT;
}

export function partitionByOwner(fields = []) {
  const ams = [];
  const crm = [];
  const assessment = [];
  for (const item of fields) {
    const owner = item.owner ?? classifyFieldOwner(item.field);
    const row = { ...item, owner };
    if (owner === OWNER_AMS) ams.push(row);
    else if (owner === OWNER_CRM) crm.push(row);
    else assessment.push(row);
  }
  return { ams_fields: ams, crm_fields: crm, assessment_only: assessment };
}
