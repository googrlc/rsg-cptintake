// Deferred provider seams for the two property_profile fields that have no free
// authoritative source: ISO Public Protection Classification (PPC / fire class
// 1–10) and replacement cost (RCE). Both are licensed/paid (ISO/Verisk,
// CoreLogic, or a carrier feed), so the LIVE clients are deferred — mirroring the
// Enricher/NowCertsSearch pattern of "interface + offline stub now, live later."
//
// The point of these stubs: the property lookup stays fully wired. The field
// fills the instant a provider is supplied, and stays null (never guessed) until
// then. Each provider returns { <field>, source } on a hit, or null.

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

export function protectionClassClientFromEnv(/* env = process.env */) {
  // No licensed ISO/Verisk provider is wired yet → Noop. When one is available,
  // build and return the live client here; the property lookup already consumes it.
  return new NoopProtectionClassClient();
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
