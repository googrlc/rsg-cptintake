import { normalizeEntityType } from "../policy.js";

// Duplicate/existing-record search performed BEFORE proposing a create. The
// live implementation (NowCerts MCP/API) is deferred; this module defines the
// NowCertsSearch interface and an offline in-memory stub so the search-before-
// create rule is exercised by tests without credentials.
//
// Matching uses entity-specific stable keys, per the data-gate skill:
//   carrier  -> NAIC, else normalized legal name
//   vehicle  -> VIN
//   driver   -> license_number + license_state
//   policy   -> policy_number
//   others   -> normalized identity (name/email/address)
// The result classifies EXACT / LIKELY / AMBIGUOUS / NONE. A name-only hit with
// competing candidates is never EXACT.

function norm(v) {
  return String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Returns an ordered list of key objects; the first satisfiable one is used.
function keyStrategies(entityType, values) {
  switch (normalizeEntityType(entityType)) {
    case "carrier":
      return [
        values.naic ? { kind: "naic", value: norm(values.naic) } : null,
        values.legal_name ? { kind: "legal_name", value: norm(values.legal_name) } : null,
      ];
    case "vehicle":
      return [values.vin ? { kind: "vin", value: norm(values.vin) } : null];
    case "driver":
      return [
        values.license_number && values.license_state
          ? { kind: "license", value: `${norm(values.license_number)}|${norm(values.license_state)}` }
          : null,
      ];
    case "policy":
      return [values.policy_number ? { kind: "policy_number", value: norm(values.policy_number) } : null];
    case "contact":
      return [
        values.business_email ? { kind: "email", value: norm(values.business_email) } : null,
        values.personal_email ? { kind: "email", value: norm(values.personal_email) } : null,
        values.first_name && values.last_name
          ? { kind: "name", value: `${norm(values.first_name)}|${norm(values.last_name)}` }
          : null,
      ];
    case "location":
      return [
        values.address_line && values.zip
          ? { kind: "address", value: `${norm(values.address_line)}|${norm(values.zip)}` }
          : null,
      ];
    case "insured":
    default:
      return [
        values.email ? { kind: "email", value: norm(values.email) } : null,
        values.commercial_name ? { kind: "commercial_name", value: norm(values.commercial_name) } : null,
        values.first_name && values.last_name
          ? { kind: "name", value: `${norm(values.first_name)}|${norm(values.last_name)}` }
          : null,
      ];
  }
}

// `kind` values considered stable/unique enough that a single hit is EXACT.
const STABLE_KINDS = new Set(["naic", "vin", "license", "policy_number", "email"]);

/**
 * @typedef {{ search(entityType: string, values: object): Promise<{match_status: string, reason: string, candidates: object[]}> }} NowCertsSearch
 */

export class InMemoryNowCertsSearch {
  constructor(records = []) {
    // record: { entity, database_id, values }
    this.records = records.map((r) => ({ ...r, entity: normalizeEntityType(r.entity) }));
  }

  add(record) {
    this.records.push({ ...record, entity: normalizeEntityType(record.entity) });
  }

  async search(entityType, values) {
    const entity = normalizeEntityType(entityType);
    const strategies = keyStrategies(entity, values).filter(Boolean);
    if (strategies.length === 0) {
      return {
        match_status: "NONE",
        reason: "No stable search key available from the extracted fields.",
        candidates: [],
      };
    }

    for (const strategy of strategies) {
      const matches = this.records.filter(
        (r) => r.entity === entity && matchesKey(strategy, r.values),
      );
      if (matches.length === 1) {
        return {
          match_status: STABLE_KINDS.has(strategy.kind) ? "EXACT" : "LIKELY",
          reason: `Matched existing record on ${strategy.kind}.`,
          candidates: matches,
          matched_on: strategy.kind,
        };
      }
      if (matches.length > 1) {
        return {
          match_status: "AMBIGUOUS",
          reason: `Multiple existing records match on ${strategy.kind}.`,
          candidates: matches,
          matched_on: strategy.kind,
        };
      }
    }

    return { match_status: "NONE", reason: "No existing record matched any stable key.", candidates: [] };
  }
}

function matchesKey(strategy, recordValues) {
  // Rebuild the same key from the stored record and compare exactly.
  const rebuilt = rebuildKey(strategy.kind, recordValues);
  return rebuilt !== null && rebuilt === strategy.value;
}

function rebuildKey(kind, values) {
  switch (kind) {
    case "naic":
      return values.naic ? norm(values.naic) : null;
    case "vin":
      return values.vin ? norm(values.vin) : null;
    case "license":
      return values.license_number && values.license_state
        ? `${norm(values.license_number)}|${norm(values.license_state)}`
        : null;
    case "policy_number":
      return values.policy_number ? norm(values.policy_number) : null;
    case "email":
      return values.business_email
        ? norm(values.business_email)
        : values.personal_email
          ? norm(values.personal_email)
          : values.email
            ? norm(values.email)
            : null;
    case "name":
      return values.first_name && values.last_name
        ? `${norm(values.first_name)}|${norm(values.last_name)}`
        : null;
    case "commercial_name":
      return values.commercial_name ? norm(values.commercial_name) : null;
    case "legal_name":
      return values.legal_name ? norm(values.legal_name) : null;
    case "address":
      return values.address_line && values.zip
        ? `${norm(values.address_line)}|${norm(values.zip)}`
        : null;
    default:
      return null;
  }
}

/**
 * Map a search result to the duplicate_risk and match_status the proposal
 * contract expects, given the intended operation.
 */
export function assessDuplicateRisk(operation, searchResult) {
  const isCreate = operation === "create" || operation === "import";
  if (!isCreate) return { duplicate_risk: "LOW", match_ok: true };

  switch (searchResult.match_status) {
    case "NONE":
      return { duplicate_risk: "LOW", match_ok: true };
    case "LIKELY":
      return { duplicate_risk: "MEDIUM", match_ok: false, reason: "A likely existing record was found." };
    case "EXACT":
      return { duplicate_risk: "HIGH", match_ok: false, reason: "An existing record already exists." };
    case "AMBIGUOUS":
    default:
      return { duplicate_risk: "HIGH", match_ok: false, reason: "Multiple existing records match." };
  }
}
