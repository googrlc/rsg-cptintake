import { readFileSync } from "node:fs";
import { Provenance } from "./intake-schema.js";
import { NaicsClient } from "../connectors/naics-client.js";

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

// Words that carry no NAICS signal and, under the API's match=all keyword search,
// only shrink the result set to nothing. Stripped before searching.
const NAICS_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "with", "at", "by",
  "from", "as", "is", "are", "our", "we", "that", "this", "&",
  // generic business qualifiers that hurt match=all precision
  "residential", "commercial", "local", "various", "misc", "miscellaneous",
  "company", "business", "llc", "inc", "corp", "co",
]);

function naicsKeywords(text, max = 4) {
  const words = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !NAICS_STOPWORDS.has(w));
  return [...new Set(words)].slice(0, max);
}

// Live enricher that helps classify a commercial insured's industry via the
// NAICS keyword API. This API is a keyword lookup, not a semantic classifier: a
// full description sentence returns nothing under its match=all search, and a
// keyword can map to the wrong code (e.g. "replacement" → auto glass). So this
// enricher never asserts a code from free text — it SUGGESTS. It:
//   • validates a code already on the record (invalid → surfaced for review);
//   • otherwise reduces the business description to keywords, searches (phrase
//     first, then per-keyword), and returns the top candidates as a REVIEW item
//     for a human to confirm. Nothing is emitted as a ready-to-write value from
//     free text — "enrichment finds information, it does not invent it."
//
// Wire it in behind a flag in the reviewed rollout; the pipeline default stays
// NoopEnricher so shadow mode is unaffected.
export class NaicsEnricher {
  constructor(client, {
    entity = "insured",
    codeField = "naics",
    // Record fields, in priority order, whose value describes what the business
    // does. First present, non-empty one seeds the keyword search.
    descriptionFields = ["operations_summary", "business_description", "description", "operations", "commercial_name"],
    // How many candidate codes to carry into the review item.
    maxCandidates = 4,
  } = {}) {
    this.client = client;
    this.entity = entity;
    this.codeField = codeField;
    this.descriptionFields = descriptionFields;
    this.maxCandidates = maxCandidates;
  }

  #description(record) {
    for (const name of this.descriptionFields) {
      const hit = record.fields.find((f) => f.field === name && f.value != null && String(f.value).trim() !== "");
      if (hit) return String(hit.value).trim();
    }
    return null;
  }

  // Phrase search first (precise when the keywords co-occur in one entry); if
  // that finds nothing, union the per-keyword results in keyword order so the
  // most salient term's matches lead. Deduped, capped.
  async #findCandidates(keywords) {
    const phrase = await this.client.search(keywords.join(" "), { limit: this.maxCandidates }).catch(() => []);
    if (phrase.length) return phrase.slice(0, this.maxCandidates);
    const merged = [];
    const seen = new Set();
    for (const kw of keywords) {
      const rows = await this.client.search(kw, { limit: this.maxCandidates }).catch(() => []);
      for (const row of rows) {
        if (row.code && !seen.has(row.code)) {
          seen.add(row.code);
          merged.push(row);
          if (merged.length >= this.maxCandidates) return merged;
        }
      }
    }
    return merged;
  }

  async enrich(record) {
    if (record.entity !== this.entity) return [];
    const present = new Map(record.fields.map((f) => [f.field, f]));

    // A code already on the record: validate, don't overwrite. Valid → leave it;
    // invalid → surface for review rather than let a bad code reach the AMS.
    if (present.has(this.codeField)) {
      const existing = String(present.get(this.codeField).value ?? "").trim();
      if (!existing) return [];
      const detail = await this.client.details(existing).catch(() => null);
      if (detail && detail.code) return [];
      return [{
        field: this.codeField,
        value: existing,
        status: "review",
        citation: {
          provenance: Provenance.ENRICHMENT,
          reference: `NAICS API /api/details/${existing}`,
          excerpt: `Code ${existing} not found in the NAICS taxonomy — verify before writing.`,
        },
      }];
    }

    const description = this.#description(record);
    const keywords = description ? naicsKeywords(description) : [];
    if (!keywords.length) return [];

    const candidates = await this.#findCandidates(keywords);
    if (!candidates.length) return [];

    const top = candidates[0];
    const alternatives = candidates.slice(1).map((c) => `${c.code} ${c.title ?? ""}`.trim()).filter(Boolean);
    // Deliberately status "review": a keyword-API match on free text is a
    // suggestion for a human to confirm, never an auto-write.
    return [{
      field: this.codeField,
      value: top.code,
      status: "review",
      citation: {
        provenance: Provenance.ENRICHMENT,
        reference: `NAICS API /api/search [${keywords.join(", ")}] → suggested ${top.code}`,
        excerpt: [
          `Suggested: ${top.code} ${top.title ?? ""}`.trim(),
          alternatives.length ? `Alternatives: ${alternatives.join("; ")}` : null,
          "Confirm the correct NAICS before writing.",
        ].filter(Boolean).join(" | "),
      },
    }];
  }
}

// Factory mirroring server.js's "configured ? new Client : fallback" pattern.
// Returns a live NaicsEnricher when a key is configured (NAICS_API_KEY inline or
// NAICS_API_KEY_FILE, following the token-file convention), else NoopEnricher so
// shadow/offline runs are unaffected. Drop `naicsEnricherFromEnv()` in wherever
// runIntake() is invoked.
export function naicsEnricherFromEnv(env = process.env, { fetchImpl = fetch } = {}) {
  const key = env.NAICS_API_KEY
    ?? (env.NAICS_API_KEY_FILE ? readFileSync(env.NAICS_API_KEY_FILE, "utf8").trim() : null);
  if (!key) return new NoopEnricher();
  const client = new NaicsClient({
    url: env.NAICS_API_URL || "https://api.naics.com",
    apiKey: key,
    fetchImpl,
  });
  return new NaicsEnricher(client);
}
