// Certified NowCerts/Momentum field contracts. A field routes to the AMS only
// if it appears here with BOTH a write path for the requested operation and a
// read-back path — no read-back, no write. Everything else stays on the report.
//
// Contact.* fields map to insert_insured_prospect_primary_contact_in_ams_tool,
// which the tool catalog documents as insert-or-update: it dedupes on
// firstName + lastName (+ email) against get_insured_contact_details and returns
// duplicateFound with the existing databaseId rather than silently creating a
// second contact. That is why the same contract serves create and update.
//
// Contact.DOB / LicenseNumber / LicenseState are regulated PII. They are
// contracted here so the routing layer stops discarding them, but the executor
// refuses to send them unless the store is encrypted — see insured-executor.

const CONTACT_TOOL = "insert_insured_prospect_primary_contact_in_ams_tool";
const CONTACT_READ = "get_insured_contact_details_tool";

const contracts = {
  "Insured.Name": { create: ["insert_insured_prospect_tool", "commercialName"], read: ["get_insured_details_tool", "commercialName"] },
  "Insured.Address": { create: ["insert_insured_prospect_tool", "addressLine1"], read: ["get_insured_details_tool", "addressLine1"] },
  "Insured.City": { create: ["insert_insured_prospect_tool", "city"], read: ["get_insured_details_tool", "city"] },
  "Insured.State": { create: ["insert_insured_prospect_tool", "state"], read: ["get_insured_details_tool", "state"] },
  "Insured.Zip": { create: ["insert_insured_prospect_tool", "zipCode"], read: ["get_insured_details_tool", "zipCode"] },
  "Insured.Phone": { create: ["insert_insured_prospect_tool", "phone"], read: ["get_insured_details_tool", "phone"] },
  "Insured.Email": { create: ["insert_insured_prospect_tool", "eMail"], read: ["get_insured_details_tool", "eMail"] },
  "Insured.Type": { create: ["insert_insured_prospect_tool", "insuredType"], read: ["get_insured_details_tool", "insuredType"] },
  "Insured.NAICS": { update: ["update_cl_rating_data_tool", "naic"], read: ["get_insured_detail_list_tool", "naics"] },
  "Insured.SIC": { update: ["update_cl_rating_data_tool", "sic"], read: ["get_insured_detail_list_tool", "sicCode"] },

  "Contact.FirstName": { create: [CONTACT_TOOL, "firstName"], update: [CONTACT_TOOL, "firstName"], read: [CONTACT_READ, "firstName"] },
  "Contact.LastName": { create: [CONTACT_TOOL, "lastName"], update: [CONTACT_TOOL, "lastName"], read: [CONTACT_READ, "lastName"] },
  "Contact.MiddleName": { create: [CONTACT_TOOL, "middle_name"], update: [CONTACT_TOOL, "middle_name"], read: [CONTACT_READ, "middleName"] },
  "Contact.Email": { create: [CONTACT_TOOL, "personal_email"], update: [CONTACT_TOOL, "personal_email"], read: [CONTACT_READ, "personalEmail"] },
  "Contact.BusinessEmail": { create: [CONTACT_TOOL, "business_email"], update: [CONTACT_TOOL, "business_email"], read: [CONTACT_READ, "businessEmail"] },
  "Contact.Phone": { create: [CONTACT_TOOL, "cell_phone"], update: [CONTACT_TOOL, "cell_phone"], read: [CONTACT_READ, "cellPhone"] },
  "Contact.OfficePhone": { create: [CONTACT_TOOL, "office_phone"], update: [CONTACT_TOOL, "office_phone"], read: [CONTACT_READ, "officePhone"] },
  "Contact.Role": { create: [CONTACT_TOOL, "contact_type"], update: [CONTACT_TOOL, "contact_type"], read: [CONTACT_READ, "contactType"] },
  "Contact.DOB": { create: [CONTACT_TOOL, "birthday"], update: [CONTACT_TOOL, "birthday"], read: [CONTACT_READ, "birthday"], sensitive: true },
  "Contact.LicenseNumber": { create: [CONTACT_TOOL, "dl_number"], update: [CONTACT_TOOL, "dl_number"], read: [CONTACT_READ, "dlNumber"], sensitive: true },
  "Contact.LicenseState": { create: [CONTACT_TOOL, "dl_state"], update: [CONTACT_TOOL, "dl_state"], read: [CONTACT_READ, "dlState"], sensitive: true },
};

// Fields that carry regulated PII (DOB, driver's licence, SSN-adjacent). The
// routing layer surfaces them; the executor gates them on encryption.
export const SENSITIVE_FIELDS = Object.keys(contracts).filter((field) => contracts[field].sensitive);

// live-pipeline emits indexed contact fields (Contact[2].Phone) because an
// account can have several contacts. Contracts are declared once per field, so
// the index is stripped before lookup and returned alongside the contract.
const INDEXED = /^Contact\[(\d+)\]\.(.+)$/;

export function normalizeFieldKey(field) {
  const match = INDEXED.exec(String(field ?? ""));
  if (!match) return { key: String(field ?? ""), index: null };
  return { key: `Contact.${match[2]}`, index: Number(match[1]) };
}

export function resolveFieldContract(field, operation) {
  const { key, index } = normalizeFieldKey(field);
  const contract = contracts[key];
  const write = contract?.[operation];
  if (!write || !contract.read) return null;
  return {
    write_tool: write[0], write_field: write[1],
    read_tool: contract.read[0], read_field: contract.read[1],
    entity: key.startsWith("Contact.") ? "contact" : "insured",
    contact_index: index,
    sensitive: Boolean(contract.sensitive),
    schema_status: "SCHEMA_ALIGNED",
  };
}

export function listFieldContracts() {
  return structuredClone(contracts);
}
