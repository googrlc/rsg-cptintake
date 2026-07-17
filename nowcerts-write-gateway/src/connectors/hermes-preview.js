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

  async researchBusiness(query) {
    const result = await this.#post("/dispatch", { command: `research business ${query}`, confirm: false });
    if (!result.ok) throw Object.assign(new Error(result.message || "Business research failed."), { statusCode: 502 });
    return result.data?.research ?? null;
  }
}
