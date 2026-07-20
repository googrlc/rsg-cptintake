// On-demand property lookup for a prepared intake. This is OPERATOR-TRIGGERED
// (a "Get property details" button), not part of the automatic pipeline — many
// assessments (e.g. an auto-only quote) never need property data. It reads the
// insured's address off the synthesized bundle, asks ATTOM, and returns a
// SUGGESTED property_profile[] for the risk report. Suggestions are marked and
// cited; nothing is written to the AMS.

// Pull the primary property address from the synthesized bundle (insured
// account). Returns ATTOM's split-address parts, or null when no street address
// was captured (never guessed).
export function propertyAddress(bundle) {
  const account = bundle?.synthesis?.payload?.account ?? {};
  const address1 = account.address ? String(account.address).trim() : null;
  if (!address1) return null;
  const cityStateZip = [account.city, [account.state, account.zip].filter(Boolean).join(" ").trim()]
    .filter(Boolean)
    .join(", ");
  return { address1, address2: cityStateZip || null };
}

// Look the address up in ATTOM and return a review-tagged property_profile entry.
// When a FEMA flood client is supplied and ATTOM returned coordinates, the FEMA
// NFHL flood zone is chained in to fill flood_zone. Statuses: OK (matched),
// NO_ADDRESS (nothing to look up), NO_MATCH (address had no ATTOM record). Never
// throws for the no-data cases — only a real ATTOM failure propagates. A FEMA
// failure is swallowed (flood_zone stays null) so it can't sink a good property
// match.
export async function lookupPropertyProfile(bundle, client, {
  floodClient = null,
  protectionClassClient = null,
  replacementCostClient = null,
} = {}) {
  const address = propertyAddress(bundle);
  if (!address) return { status: "NO_ADDRESS", property_profile: [] };
  const profile = await client.propertyProfile(address);
  if (!profile) return { status: "NO_MATCH", property_profile: [], address };

  if (floodClient && profile.latitude != null && profile.longitude != null) {
    try {
      const flood = await floodClient.floodZone({ latitude: profile.latitude, longitude: profile.longitude });
      if (flood) profile.flood_zone = flood.label;
    } catch {
      // FEMA unreachable — leave flood_zone null rather than block the property match.
    }
  }

  // ISO fire protection class — deferred provider seam; fills only when supplied.
  if (protectionClassClient) {
    try {
      const pc = await protectionClassClient.protectionClass({ state: profile.state, county: profile.county, address: profile.address, latitude: profile.latitude, longitude: profile.longitude });
      if (pc?.protection_class) profile.protection_class = pc.protection_class;
    } catch { /* provider optional — never block the match */ }
  }

  // Replacement cost — deferred provider seam; fills only when supplied.
  if (replacementCostClient) {
    try {
      const rc = await replacementCostClient.replacementCost(profile);
      if (rc?.replacement_cost != null) profile.replacement_cost = rc.replacement_cost;
    } catch { /* provider optional — never block the match */ }
  }

  // status "suggested": operator-confirmed data only — this is a lookup result,
  // not a verified field.
  return { status: "OK", property_profile: [{ ...profile, status: "suggested" }], address };
}
