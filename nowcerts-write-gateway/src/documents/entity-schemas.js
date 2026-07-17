import { normalizeEntityType } from "../policy.js";

// Entity-specific field schemas for the writable NowCerts entities handled in
// Increment 1. Each schema names the fields a create may require, the fields an
// update/create may set, and the deterministic format each field must satisfy.
//
// These validators NEVER coerce or guess. A value that fails its format is
// reported as an error so the proposal builder can quarantine it as
// needs_review instead of writing a normalized-but-wrong value.

const US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL",
  "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT",
  "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
]);

// Deterministic format checkers. Each returns true when the value is acceptable.
export const formats = {
  nonEmpty: (v) => typeof v === "string" && v.trim().length > 0,
  isoDate: (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && isRealDate(v),
  state: (v) => typeof v === "string" && US_STATES.has(v.toUpperCase()),
  zip: (v) => typeof v === "string" && /^\d{5}(-\d{4})?$/.test(v),
  email: (v) => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  // NANP: 10 digits after stripping punctuation.
  phone: (v) => typeof v === "string" && v.replace(/[^\d]/g, "").length === 10,
  // VIN: 17 chars, no I/O/Q.
  vin: (v) => typeof v === "string" && /^[A-HJ-NPR-Z0-9]{17}$/.test(v.toUpperCase()),
  naic: (v) => typeof v === "string" && /^\d{5}$/.test(v),
  money: (v) => (typeof v === "number" && v >= 0) || (typeof v === "string" && /^\d+(\.\d{1,2})?$/.test(v)),
  year: (v) => /^\d{4}$/.test(String(v)) && Number(v) >= 1900 && Number(v) <= 2100,
};

function isRealDate(v) {
  const [y, m, d] = v.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function field(format, { required = false } = {}) {
  return { format, required };
}

// field name -> { format, required }. `required` means required for a create.
export const ENTITY_SCHEMAS = {
  insured: {
    commercial_name: field("nonEmpty"),
    first_name: field("nonEmpty"),
    last_name: field("nonEmpty"),
    email: field("email"),
    phone: field("phone"),
    address_line: field("nonEmpty"),
    city: field("nonEmpty"),
    state: field("state"),
    zip: field("zip"),
    // A create must identify the insured somehow; enforced by requireIdentity below.
  },
  contact: {
    first_name: field("nonEmpty", { required: true }),
    last_name: field("nonEmpty", { required: true }),
    business_email: field("email"),
    personal_email: field("email"),
    phone: field("phone"),
    title: field("nonEmpty"),
  },
  policy: {
    policy_number: field("nonEmpty", { required: true }),
    carrier_name: field("nonEmpty", { required: true }),
    line_of_business: field("nonEmpty", { required: true }),
    effective_date: field("isoDate", { required: true }),
    expiration_date: field("isoDate", { required: true }),
    premium: field("money"),
    status: field("nonEmpty"),
  },
  carrier: {
    legal_name: field("nonEmpty", { required: true }),
    naic: field("naic"),
    state: field("state"),
    active: field("nonEmpty"),
  },
  vehicle: {
    vin: field("vin", { required: true }),
    year: field("year"),
    make: field("nonEmpty"),
    model: field("nonEmpty"),
    garaging_zip: field("zip"),
  },
  driver: {
    first_name: field("nonEmpty", { required: true }),
    last_name: field("nonEmpty", { required: true }),
    license_number: field("nonEmpty", { required: true }),
    license_state: field("state", { required: true }),
    date_of_birth: field("isoDate"),
  },
  location: {
    address_line: field("nonEmpty", { required: true }),
    city: field("nonEmpty", { required: true }),
    state: field("state", { required: true }),
    zip: field("zip", { required: true }),
    description: field("nonEmpty"),
  },
};

// Entities where at least one of a set of "identity" fields must be present on a
// create even though none is individually required (e.g. an insured is either a
// person or a business).
const IDENTITY_REQUIREMENTS = {
  insured: [["commercial_name"], ["first_name", "last_name"]],
};

export function isKnownEntity(entityType) {
  return Object.prototype.hasOwnProperty.call(ENTITY_SCHEMAS, normalizeEntityType(entityType));
}

/**
 * Validate a flat map of normalized field -> value against an entity schema.
 * Returns per-field format errors, unknown fields, and (for creates) any
 * missing required fields. Does not mutate or coerce values.
 *
 * @param {string} entityType
 * @param {Record<string, unknown>} values
 * @param {object} [options]
 * @param {boolean} [options.forCreate] enforce required fields for a create
 */
export function validateEntityFields(entityType, values, { forCreate = false } = {}) {
  const normalized = normalizeEntityType(entityType);
  const schema = ENTITY_SCHEMAS[normalized];
  if (!schema) {
    return { ok: false, unknownEntity: true, fieldErrors: {}, unknownFields: [], missingRequired: [] };
  }

  const fieldErrors = {};
  const unknownFields = [];
  for (const [name, value] of Object.entries(values)) {
    const spec = schema[name];
    if (!spec) {
      unknownFields.push(name);
      continue;
    }
    // Blank/cleared values are validated by the generic proposal rules (clear
    // flag); only non-blank values are format-checked here.
    const blank = value === null || value === "" || value === undefined;
    if (!blank && !formats[spec.format](value)) {
      fieldErrors[name] = `Value does not satisfy required format: ${spec.format}.`;
    }
  }

  const missingRequired = [];
  if (forCreate) {
    for (const [name, spec] of Object.entries(schema)) {
      const present = values[name] !== undefined && values[name] !== null && values[name] !== "";
      if (spec.required && !present) missingRequired.push(name);
    }
    // Identity groups: at least one whole group must be fully present.
    const identityGroups = IDENTITY_REQUIREMENTS[normalized];
    if (identityGroups && !identityGroups.some((group) => group.every((name) => formats.nonEmpty(values[name])))) {
      missingRequired.push(identityGroups.map((g) => g.join("+")).join(" OR "));
    }
  }

  const ok = Object.keys(fieldErrors).length === 0 && unknownFields.length === 0 && missingRequired.length === 0;
  return { ok, unknownEntity: false, fieldErrors, unknownFields, missingRequired };
}
