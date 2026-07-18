// Thin read-only client for the NAICS taxonomy API (search / details /
// drilldown / codes). This looks up the *classification tree* — it does not
// enrich a company from its name. Given business-activity text it returns
// candidate NAICS codes; given a code it validates/details it.
//
// Mirrors HermesPreviewClient's conventions: trailing-slash-trimmed base URL,
// AbortSignal timeout, tolerant JSON parse, and errors that carry a statusCode.
//
// Auth: the naics.com platform key, sent as the `x-api-key` header (confirmed
// against the live API — Bearer and query-param styles return 401). Base host is
// https://api.naics.com, so requests are e.g. https://api.naics.com/api/search.

export class NaicsClient {
  constructor({ url = "https://api.naics.com", apiKey = null, timeoutMs = 15_000, fetchImpl = fetch, searchParam = "q" }) {
    if (!url) throw new Error("NaicsClient requires a base url.");
    this.url = String(url).replace(/\/$/, "");
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.searchParam = searchParam;
  }

  #authHeaders() {
    return this.apiKey ? { "x-api-key": this.apiKey } : {};
  }

  async #get(path, query = {}) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v != null && v !== ""),
    ).toString();
    const target = `${this.url}${path}${qs ? `?${qs}` : ""}`;
    const response = await this.fetch(target, {
      method: "GET",
      headers: { accept: "application/json", ...this.#authHeaders() },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = value.detail ?? value.message ?? `NAICS API returned HTTP ${response.status}.`;
      throw Object.assign(new Error(String(message)), { statusCode: 502 });
    }
    return value;
  }

  // Fuzzy search by code, title, or description → normalized candidate list,
  // best match first. Tolerant of {results:[...]} | {data:[...]} | [...] shapes.
  async search(query, { limit = 5 } = {}) {
    const body = await this.#get("/api/search", { [this.searchParam]: query, limit });
    const rows = Array.isArray(body) ? body : body.results ?? body.data ?? body.items ?? [];
    return rows.map(normalizeCandidate).filter((c) => c.code);
  }

  // Validate / detail a single code. Returns null on 404-style "not found".
  async details(code) {
    try {
      const body = await this.#get(`/api/details/${encodeURIComponent(code)}`);
      return normalizeCandidate(body.data ?? body.result ?? body);
    } catch (err) {
      if (err.statusCode === 502 && /404|not found/i.test(err.message)) return null;
      throw err;
    }
  }

  async drilldown(code) {
    const body = await this.#get(`/api/drilldown/${encodeURIComponent(code)}`);
    const rows = Array.isArray(body) ? body : body.children ?? body.results ?? body.data ?? [];
    return rows.map(normalizeCandidate).filter((c) => c.code);
  }

  async codes({ depth } = {}) {
    const body = await this.#get("/api/codes", { depth });
    const rows = Array.isArray(body) ? body : body.results ?? body.data ?? [];
    return rows.map(normalizeCandidate).filter((c) => c.code);
  }
}

// The API's field names aren't contractually fixed; accept the common aliases so
// a schema tweak on their side doesn't silently null out the code/title.
function normalizeCandidate(row = {}) {
  const code = row.code ?? row.naics ?? row.naics_code ?? row.id ?? null;
  return {
    code: code == null ? null : String(code),
    title: row.title ?? row.name ?? row.description ?? null,
    description: row.description ?? row.long_description ?? null,
    // Fuzzy score if the API returns one (0..1 or 0..100); used as a confidence gate.
    score: numeric(row.score ?? row.relevance ?? row.match ?? row._score),
    depth: numeric(row.depth ?? (code != null ? String(code).length : null)),
  };
}

function numeric(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
