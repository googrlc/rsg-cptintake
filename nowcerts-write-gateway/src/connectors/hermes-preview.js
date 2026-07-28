import { readFileSync } from "node:fs";

// Client for the Hermes API (the RSG CRM / Command Center backend).
//
// Most Hermes routes are unauthenticated on the internal Docker network, but a
// few are gated by a bearer token (`_require_hermes_token`): today
// /api/hermes/book-sync, /api/ams/search-insured, and /api/hermes/tts. The
// token is therefore OPTIONAL here — configure it and every request carries it,
// omit it and behaviour is exactly as before.
//
// Fail loudly on a half-configured token. The rsg-hermes MCP bridge outage on
// 2026-07-26 was caused by precisely this shape:
//
//     if HERMES_API_TOKEN:                      # empty string -> falsy
//         headers["Authorization"] = ...        # header silently omitted
//
// An empty token meant *no auth header at all*, so every protected route
// answered "invalid or missing bearer token" while the config looked present.
// A configured-but-empty token is a misconfiguration, not a request to disable
// auth, and it is refused at construction rather than degrading into anonymous
// calls that fail later and further away.

export class HermesTokenError extends Error {}

/**
 * Resolve the Hermes bearer token from the environment.
 *
 * HERMES_API_TOKEN_FILE (preferred, mounted like the other secrets) or
 * HERMES_API_TOKEN. Returns null when neither is set — that is a valid,
 * explicit "no token" configuration. Throws when one IS set but yields an
 * empty value, which is the silent-no-auth failure mode.
 */
export function hermesTokenFromEnv(env = process.env) {
  const file = env.HERMES_API_TOKEN_FILE;
  if (file) {
    let contents;
    try {
      contents = readFileSync(file, "utf8");
    } catch (error) {
      throw new HermesTokenError(`HERMES_API_TOKEN_FILE is set to ${file} but could not be read: ${error.message}`);
    }
    const token = contents.trim();
    if (!token) {
      throw new HermesTokenError(`HERMES_API_TOKEN_FILE (${file}) is empty. Remove the variable to run without a token, or write the token into the file.`);
    }
    return token;
  }
  if (env.HERMES_API_TOKEN !== undefined) {
    const token = String(env.HERMES_API_TOKEN).trim();
    if (!token) {
      throw new HermesTokenError("HERMES_API_TOKEN is set but empty. Remove the variable to run without a token, or give it a value — an empty token silently disables authentication.");
    }
    return token;
  }
  return null;
}

/**
 * Resolve the `/api/intake` key from the environment.
 *
 * A DIFFERENT credential from the bearer above: Hermes gates the intake
 * submission door on an `X-RSG-API-Key` header checked against its own
 * `RSG_INTAKE_API_KEY`, not on the bearer. Same fail-loud rule though — a
 * configured-but-empty key is a misconfiguration, and letting it through would
 * send every intake into a 401 that looks like the CRM being down.
 */
export function intakeKeyFromEnv(env = process.env) {
  const file = env.HERMES_INTAKE_KEY_FILE;
  if (file) {
    let contents;
    try {
      contents = readFileSync(file, "utf8");
    } catch (error) {
      throw new HermesTokenError(`HERMES_INTAKE_KEY_FILE is set to ${file} but could not be read: ${error.message}`);
    }
    const key = contents.trim();
    if (!key) {
      throw new HermesTokenError(`HERMES_INTAKE_KEY_FILE (${file}) is empty. Remove the variable to disable CRM intake submission, or write the key into the file.`);
    }
    return key;
  }
  if (env.HERMES_INTAKE_KEY !== undefined) {
    const key = String(env.HERMES_INTAKE_KEY).trim();
    if (!key) {
      throw new HermesTokenError("HERMES_INTAKE_KEY is set but empty. Remove the variable to disable CRM intake submission, or give it a value.");
    }
    return key;
  }
  return null;
}

export class HermesPreviewClient {
  constructor({ url, timeoutMs = 120_000, fetchImpl = fetch, token = null, intakeKey = null }) {
    this.url = String(url).replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    // Normalize here too, so a caller passing "" gets no header rather than a
    // malformed `Bearer ` one.
    this.token = token ? String(token).trim() || null : null;
    this.intakeKey = intakeKey ? String(intakeKey).trim() || null : null;
  }

  get authenticated() {
    return this.token !== null;
  }

  // Whether this client can submit intakes to the CRM. Separate from
  // `authenticated` — the two credentials are independent.
  get canSubmitIntake() {
    return this.intakeKey !== null;
  }

  async #post(path, body, { extraHeaders = {} } = {}) {
    const headers = { "content-type": "application/json", ...extraHeaders };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await this.fetch(`${this.url}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = value.detail ?? value.message ?? `Hermes returned HTTP ${response.status}.`;
      // 401 on a route that needs a token is the outage above. Say so plainly
      // instead of surfacing a bare "invalid or missing bearer token".
      const hint =
        response.status === 401 && !this.token
          ? " This route requires a bearer token; set HERMES_API_TOKEN_FILE on the gateway."
          : "";
      throw Object.assign(new Error(`${String(message)}${hint}`), { statusCode: response.status === 401 ? 401 : 502 });
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

  // Submit the whole intake to the CRM.
  //
  // This is the intake's real destination. Hermes queues the submission and its
  // worker commits the account, contacts, cited facts, underwriting facts, the
  // assessment note and the per-LOB opportunities — after a human approves it in
  // Slack. Nothing here reaches NowCerts: an intake is a prospect, and a prospect
  // is not a record of insurance. The insured reaches the AMS when a deal is won.
  //
  // Idempotent on `idempotency_key`. Re-submitting the same intake returns the
  // existing row with `idempotent_replay: true` — a SUCCESS, not a duplicate, and
  // the reason a retry after a timeout is always safe.
  async submitIntake(payload) {
    if (!this.intakeKey) {
      throw Object.assign(
        new Error("The CRM intake key is not configured; set HERMES_INTAKE_KEY_FILE on the gateway."),
        { statusCode: 401 },
      );
    }
    return this.#post("/api/intake", payload, { extraHeaders: { "x-rsg-api-key": this.intakeKey } });
  }

  async researchBusiness(query) {
    const result = await this.#post("/dispatch", { command: `research business ${query}`, confirm: false });
    if (!result.ok) throw Object.assign(new Error(result.message || "Business research failed."), { statusCode: 502 });
    return result.data?.research ?? null;
  }
}
