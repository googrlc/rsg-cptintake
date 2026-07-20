// FEMA National Flood Hazard Layer (NFHL) client — the authoritative federal
// source for a property's FEMA flood zone, free and keyless. Given a lat/lon it
// queries the public ArcGIS flood-hazard layer and returns the zone that the
// point falls in. Used to fill property_profile.flood_zone after ATTOM supplies
// the coordinates.
//
// Layer 28 = S_FLD_HAZ_AR (flood hazard areas). FLD_ZONE is the FEMA zone code
// (X, A, AE, VE, …); SFHA_TF "T" means the point is in a Special Flood Hazard
// Area (the ~1% annual-chance floodplain where flood insurance is mandated).

const NFHL_QUERY_URL = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query";

export class FemaFloodClient {
  constructor({ url = NFHL_QUERY_URL, timeoutMs = 15_000, fetchImpl = fetch } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  // { latitude, longitude } → { zone, subtype, sfha, label } or null when the
  // point isn't in a mapped flood area (unmapped ≠ safe — reported as null, not X).
  async floodZone({ latitude, longitude } = {}) {
    if (latitude == null || longitude == null) return null;
    const params = new URLSearchParams({
      geometry: `${longitude},${latitude}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF",
      returnGeometry: "false",
      f: "json",
    });
    const response = await this.fetch(`${this.url}?${params}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(body?.error?.message ?? `FEMA NFHL returned HTTP ${response.status}.`), { statusCode: 502 });
    }
    const attrs = body?.features?.[0]?.attributes;
    if (!attrs || !attrs.FLD_ZONE) return null;
    const zone = String(attrs.FLD_ZONE);
    const sfha = attrs.SFHA_TF === "T";
    const subtype = attrs.ZONE_SUBTY ? String(attrs.ZONE_SUBTY) : null;
    return { zone, subtype, sfha, label: floodLabel(zone, sfha, subtype) };
  }
}

// Human-readable value for the report's flood_zone cell.
function floodLabel(zone, sfha, subtype) {
  if (sfha) return `Zone ${zone} — Special Flood Hazard Area (flood insurance required)`;
  if (subtype && /minimal/i.test(subtype)) return `Zone ${zone} — minimal flood hazard`;
  return `Zone ${zone}${subtype ? ` — ${subtype.toLowerCase()}` : ""}`;
}
