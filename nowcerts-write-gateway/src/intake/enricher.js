import { Provenance } from "./intake-schema.js";

// Enrichment fills gaps the intake didn't cover ("it will also go out and find
// any additional information missing on that intake"). This is NOT a licence to
// guess: every enriched field must carry a real source citation
// (provenance: enrichment). A value that cannot be sourced is never emitted —
// the gap simply stays open for review.
//
// The live enricher (external lookups: Secretary of State, carrier data, address
// validation, etc.) is deferred because it needs network access and credentials
// and belongs in the reviewed rollout. The interface and an offline no-op stub
// are provided so the pipeline is exercised without live calls.
//
// @typedef {{ enrich(record: object, context: object): Promise<Array<{field:string,value:unknown,status:string,citation:object}>> }} Enricher

// Adds nothing. Correct default for shadow/offline: the pipeline proceeds with
// exactly the intake-provided fields and never fabricates.
export class NoopEnricher {
  async enrich() {
    return [];
  }
}

// Test/offline enricher seeded with sourced facts per (entity, field). It only
// returns a value when a citation is supplied, and only for fields the record is
// actually missing — mirroring the never-fabricate rule.
export class StubEnricher {
  constructor(facts = []) {
    // fact: { entity, field, value, reference, excerpt }
    this.facts = facts;
  }

  async enrich(record) {
    const present = new Set(record.fields.map((f) => f.field));
    return this.facts
      .filter((f) => f.entity === record.entity && !present.has(f.field) && f.reference && f.excerpt)
      .map((f) => ({
        field: f.field,
        value: f.value,
        status: "ok",
        citation: { provenance: Provenance.ENRICHMENT, reference: f.reference, excerpt: f.excerpt },
      }));
  }
}
