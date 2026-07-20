// Deferred provider seams for the two property_profile fields that have no free
// authoritative source: ISO Public Protection Classification (PPC / fire class
// 1–10) and replacement cost (RCE). Both are licensed/paid (ISO/Verisk,
// CoreLogic, or a carrier feed), so the LIVE clients are deferred — mirroring the
// Enricher/NowCertsSearch pattern of "interface + offline stub now, live later."
//
// The point of these stubs: the property lookup stays fully wired. The field
// fills the instant a provider is supplied, and stays null (never guessed) until
// then. Each provider returns { <field>, source } on a hit, or null.

import { readFileSync } from "node:fs";

// --- ISO Public Protection Classification (fire protection class) ---------

// Default: contributes nothing. protection_class stays null.
export class NoopProtectionClassClient {
  async protectionClass() {
    return null;
  }
}

// Offline/manual provider seeded by normalized address → class. Lets a known
// fire-protection class be injected (e.g. from a manual RSG table) without a
// licensed API, and backs the tests.
export class StubProtectionClassClient {
  constructor(byAddress = {}) {
    this.byAddress = byAddress; // { "4529 WINONA CT, DENVER, CO 80212": "4" }
  }

  async protectionClass({ address } = {}) {
    const value = address ? this.byAddress[address] : null;
    return value ? { protection_class: String(value), source: "manual PPC table" } : null;
  }
}

// County-level ISO fire protection class from a structured table (e.g. the
// Georgia DCA GOMI "predominant county rating" dataset). This is an APPROXIMATION
// — true ISO PPC is per fire district/property — so the value is explicitly
// labeled "county estimate". The table must come from the structured source, not
// a hand-read map: an unknown county returns null, never a guessed class.
export class CountyProtectionClassClient {
  constructor(table = {}, { year = null, note = "county estimate" } = {}) {
    // table: { GA: { fulton: 3, ... } } — state code → lowercased county → 1..10
    this.table = {};
    for (const [state, counties] of Object.entries(table)) {
      this.table[String(state).toUpperCase()] = Object.fromEntries(
        Object.entries(counties).map(([c, r]) => [String(c).toLowerCase().trim(), r]),
      );
    }
    this.year = year;
    this.note = note;
  }

  async protectionClass({ state, county } = {}) {
    if (!state || !county) return null;
    const rating = this.table[String(state).toUpperCase()]?.[String(county).toLowerCase().trim()];
    if (rating == null) return null;
    const provenance = ["GOMI county fire ISO", this.year].filter(Boolean).join(" ");
    return {
      protection_class: `ISO ${rating} (${this.note}${this.year ? `, ${this.year}` : ""})`,
      source: provenance,
    };
  }
}

// Loads a structured county→ISO table from PROTECTION_CLASS_TABLE_FILE (JSON:
// {"year":2018,"table":{"GA":{"fulton":3,...}}}). Absent/unreadable → Noop, so
// the field simply stays null. No table is ever inferred from an image.
export function protectionClassClientFromEnv(env = process.env) {
  const file = env.PROTECTION_CLASS_TABLE_FILE;
  if (!file) return new NoopProtectionClassClient();
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return new CountyProtectionClassClient(data.table ?? data, { year: data.year ?? null });
  } catch {
    return new NoopProtectionClassClient();
  }
}

// --- Replacement cost estimate (RCE) --------------------------------------

// Default: contributes nothing. replacement_cost stays null.
export class NoopReplacementCostClient {
  async replacementCost() {
    return null;
  }
}

// Offline estimator: a simple $/sqft rule. NOT a real RCE (which weighs
// construction, quality, geography, fixtures) — it exists so the field and its
// wiring are exercised, and is only active when a rate is explicitly supplied.
export class StubReplacementCostClient {
  constructor({ perSqFt = null } = {}) {
    this.perSqFt = perSqFt;
  }

  async replacementCost({ square_feet } = {}) {
    const sqft = Number(square_feet);
    if (!this.perSqFt || !Number.isFinite(sqft) || sqft <= 0) return null;
    return { replacement_cost: Math.round(sqft * this.perSqFt), source: `estimate $${this.perSqFt}/sqft` };
  }
}

export function replacementCostClientFromEnv(env = process.env) {
  // A real RCE (CoreLogic/Verisk 360Value) is deferred. An explicit
  // RCE_STUB_PER_SQFT lets an interim $/sqft estimate be turned on deliberately;
  // absent it, contributes nothing.
  const rate = Number(env.RCE_STUB_PER_SQFT);
  return Number.isFinite(rate) && rate > 0
    ? new StubReplacementCostClient({ perSqFt: rate })
    : new NoopReplacementCostClient();
}
