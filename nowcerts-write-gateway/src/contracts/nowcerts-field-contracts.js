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
};

export function resolveFieldContract(field, operation) {
  const contract = contracts[field];
  const write = contract?.[operation];
  if (!write || !contract.read) return null;
  return {
    write_tool: write[0], write_field: write[1],
    read_tool: contract.read[0], read_field: contract.read[1],
    schema_status: "SCHEMA_ALIGNED",
  };
}

export function listFieldContracts() {
  return structuredClone(contracts);
}
