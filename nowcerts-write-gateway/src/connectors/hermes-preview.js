export class HermesPreviewClient {
  constructor({ url, timeoutMs = 120_000, fetchImpl = fetch }) {
    this.url = String(url).replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async #post(path, body) {
    const response = await this.fetch(`${this.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = value.detail ?? value.message ?? `Hermes returned HTTP ${response.status}.`;
      throw Object.assign(new Error(String(message)), { statusCode: 502 });
    }
    return value;
  }

  async stageDraft({ rawText, submittedBy, sourceRef }) {
    return this.#post("/agency-intake", {
      raw_text: rawText,
      submitted_by: submittedBy,
      source_type: "intake_gate",
      source_ref: sourceRef,
    });
  }

  // Create (or adopt) a pipeline opportunity in the RSG CRM.
  //
  // Hermes enforces UNIQUE (client_identifier, line_of_business,
  // opportunity_type) and derives client_identifier server-side, so re-POSTing
  // is safe: a repeat returns the existing row with created:false. That is a
  // SUCCESS -- the opportunity is adopted, not duplicated. Never PATCH an
  // adopted row to "fix" it; any PATCH or /stage call flips sync_source to
  // 'crm', after which the inbound AMS sync permanently stops updating it.
  async createOpportunity(payload) {
    return this.#post("/api/opportunities", payload);
  }

  async researchBusiness(query) {
    const result = await this.#post("/dispatch", { command: `research business ${query}`, confirm: false });
    if (!result.ok) throw Object.assign(new Error(result.message || "Business research failed."), { statusCode: 502 });
    return result.data?.research ?? null;
  }
}
