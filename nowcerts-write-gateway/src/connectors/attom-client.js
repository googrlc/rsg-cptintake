// Read-only client for the ATTOM property data API. Given a street address it
// returns a normalized property profile matching the report renderer's
// property_profile[] shape (year_built / square_feet / construction / roof /
// stories). ATTOM's /property/detail does NOT carry protection_class, flood_zone,
// or replacement_cost — those come from other sources and stay null here.
//
// Mirrors HermesPreviewClient conventions: trimmed base URL, AbortSignal timeout,
// tolerant JSON parse, errors carrying a statusCode. Auth is the `APIKey` header.
//
// ATTOM's JSON nests deeply with inconsistent key casing (yearbuilt, roofcover,
// universalsize are lowercase; countrySubd, bathstotal are camel). The normalizer
// below walks candidate paths case-insensitively so a casing quirk doesn't null a
// field — but confirm against a live response before trusting a new field.

import { readFileSync } from "node:fs";

export class AttomClient {
  constructor({ url = "https://api.gateway.attomdata.com/propertyapi/v1.0.0", apiKey = null, timeoutMs = 15_000, fetchImpl = fetch }) {
    if (!apiKey) throw new Error("AttomClient requires an APIKey.");
    this.url = String(url).replace(/\/$/, "");
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async #get(path, query = {}) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v != null && v !== ""),
    ).toString();
    const target = `${this.url}${path}${qs ? `?${qs}` : ""}`;
    const response = await this.fetch(target, {
      method: "GET",
      headers: { accept: "application/json", apikey: this.apiKey },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      // ATTOM signals "address valid but no data" as a non-2xx carrying a normal
      // status envelope (msg "SuccessWithoutResult"). That's an empty result, not
      // an error — hand the body back so the caller resolves it to null.
      const msg = body?.status?.msg;
      if (msg && /without\s*result|no\s*(property\s*)?result/i.test(msg)) return body;
      const message = msg ?? body?.message ?? `ATTOM API returned HTTP ${response.status}.`;
      throw Object.assign(new Error(String(message)), { statusCode: 502 });
    }
    return body;
  }

  // Raw /property/detail for an address. `address2` = "city, ST zip". Accepts a
  // single-line `address` alternatively. Returns the first matched property node
  // or null when ATTOM finds none (status.code !== 0 / empty property array).
  async propertyDetail({ address1, address2, address } = {}) {
    const query = address ? { address } : { address1, address2 };
    const body = await this.#get("/property/detail", query);
    const code = body?.status?.code;
    if (code != null && code !== 0) return null; // ATTOM: 0 = success, non-zero = no match
    const rows = Array.isArray(body?.property) ? body.property : [];
    return rows[0] ?? null;
  }

  // Address → normalized property_profile[] entry (renderer keys), or null.
  async propertyProfile(addressParts) {
    const node = await this.propertyDetail(addressParts);
    return node ? toPropertyProfile(node) : null;
  }
}

// Walk the first candidate path that resolves to a non-empty value. Each path is
// a dot list; each segment match is case-insensitive so ATTOM's mixed casing
// (yearbuilt vs yearBuilt) resolves either way.
function pick(root, paths) {
  for (const path of paths) {
    let node = root;
    for (const seg of path.split(".")) {
      node = getCI(node, seg);
      if (node == null) break;
    }
    if (node != null && node !== "") return node;
  }
  return null;
}

function getCI(obj, key) {
  if (obj == null || typeof obj !== "object") return undefined;
  if (key in obj) return obj[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === lower) return obj[k];
  return undefined;
}

// Maps an ATTOM property node to the report's property_profile row. Fields ATTOM
// doesn't provide in /property/detail are left null (not guessed).
export function toPropertyProfile(node) {
  const line1 = pick(node, ["address.line1"]);
  const line2 = pick(node, ["address.line2"]);
  return {
    address: [line1, line2].filter(Boolean).join(", ") || null,
    year_built: pick(node, ["summary.yearbuilt", "summary.yearBuilt", "building.summary.yearbuilt"]),
    square_feet: pick(node, ["building.size.universalsize", "building.size.livingsize", "building.size.bldgsize"]),
    // ATTOM's /property/detail rarely returns constructiontype; wallType (e.g.
    // "BRICK") is the reliable construction signal and is what underwriting cares
    // about (masonry vs frame). Fall through in that order.
    construction: pick(node, ["building.construction.constructiontype", "building.construction.wallType", "building.construction.frameType"]),
    roof: pick(node, ["building.construction.roofcover", "building.construction.roofShape"]), // often absent → null, never guessed
    condition: pick(node, ["building.construction.condition"]),
    stories: pick(node, ["building.summary.levels", "building.summary.storycount", "building.summary.storyDesc"]),
    // Coordinates carry forward so the flood-zone step can query FEMA's NFHL.
    latitude: pick(node, ["location.latitude"]),
    longitude: pick(node, ["location.longitude"]),
    // Not available from /property/detail — sourced elsewhere, never guessed.
    // flood_zone is filled by the FEMA NFHL step in the property lookup.
    protection_class: null,
    flood_zone: null,
    replacement_cost: null,
    // Provenance for the report's evidence appendix.
    _source: {
      provider: "ATTOM /property/detail",
      attom_id: pick(node, ["identifier.attomId", "identifier.Id", "identifier.attomid"]),
    },
  };
}

// Factory mirroring server.js's "configured ? new Client : null" pattern.
// Returns an AttomClient when a key is configured (ATTOM_API_KEY inline or
// ATTOM_API_KEY_FILE), else null so unconfigured runs simply skip property lookup.
export function attomClientFromEnv(env = process.env, { fetchImpl = fetch } = {}) {
  const apiKey = env.ATTOM_API_KEY
    ?? (env.ATTOM_API_KEY_FILE ? readFileSync(env.ATTOM_API_KEY_FILE, "utf8").trim() : null);
  if (!apiKey) return null;
  return new AttomClient({ url: env.ATTOM_API_URL || undefined, apiKey, fetchImpl });
}
