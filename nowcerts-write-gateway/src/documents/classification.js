import { isKnownEntity } from "./entity-schemas.js";

// Document classification maps an extraction result's declared class to a known
// document class and its candidate NowCerts entity. An unrecognized class or an
// unknown target entity STOPS the pipeline with NEEDS_CLASSIFICATION rather than
// forcing the document into a generic payload.

export const DOCUMENT_CLASSES = {
  declaration_page: { entity: "policy" },
  binder: { entity: "policy" },
  acord_application: { entity: "insured" },
  policy_change_form: { entity: "policy" },
  vehicle_schedule: { entity: "vehicle" },
  driver_schedule: { entity: "driver" },
  location_schedule: { entity: "location" },
  loss_run: { entity: "claim" },
  carrier_document: { entity: "carrier" },
  contact_document: { entity: "contact" },
  insured_document: { entity: "insured" },
};

/**
 * @param {{document_class: string, candidate_entity: string}} extraction
 * @returns {{ok: boolean, status: string, entity?: string, message?: string}}
 */
export function classifyDocument({ document_class: documentClass, candidate_entity: candidateEntity }) {
  const known = DOCUMENT_CLASSES[documentClass];
  if (!known) {
    return {
      ok: false,
      status: "NEEDS_CLASSIFICATION",
      message: `Unrecognized document class "${documentClass}". Classify before proposing a write.`,
    };
  }
  if (!isKnownEntity(candidateEntity)) {
    return {
      ok: false,
      status: "NEEDS_CLASSIFICATION",
      message: `Document class "${documentClass}" resolved to an unsupported entity "${candidateEntity}".`,
    };
  }
  return { ok: true, status: "CLASSIFIED", entity: candidateEntity };
}
