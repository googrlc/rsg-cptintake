// NowCerts-aligned picklist option IDs (stable seeds matching Hermes migration).
import { createHash } from "node:crypto";

function stableId(listKey, label) {
  const h = createHash("sha1").update(`${listKey}:${label}`).digest("hex").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const LISTS = {
  pipeline_new_business: [
    "Not Assigned", "Preparing Application", "Sent For Quoting", "Quotes Received",
    "Sent Proposal", "Request to Bind", "Bound / Won", "Lost",
  ],
  pipeline_renewal: [
    "Renewal in 90 days", "Renewal in 60 days", "Renewal in 30 days", "Requote Renewal",
    "Annual Policy Review", "Complete/Auto-Renewal", "Bound / Won", "Not Renewed",
  ],
  lead_status: ["new", "working", "quoted", "converted", "lost"],
  renewal_status: ["Up for Renewal", "Renewing", "Renewed", "Non-Renewed", "Cancelled"],
  endorsement_type: [
    "Add Driver", "Remove Driver", "Replace Driver", "Add Vehicle", "Replace Vehicle",
    "Address Change", "Coverage Change", "Policy Change", "Certificate of Insurance", "Other",
  ],
};

export const PICKLIST_TYPES = Object.keys(LISTS);

export function listPicklist(listKey) {
  const labels = LISTS[listKey];
  if (!labels) return null;
  return labels.map((label, sort_order) => ({
    list_key: listKey,
    option_id: stableId(listKey, label),
    label,
    sort_order,
    active: true,
  }));
}
