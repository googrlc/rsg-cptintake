// Momentum (NowCerts) MCP WRITE connector — the only code path that can create
// a live AMS record, and only ever invoked by the guarded executor on a
// reviewed + approved, fingerprinted proposal. Modeled on the read connector's
// JSON-RPC-over-HTTP shape. Configured via MOMENTUM_MCP_URL + a token file; when
// unconfigured it does not exist (server passes null) and no write is possible.

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export class MomentumWriteClient {
  constructor({ url, tokenFile, fetchImpl = fetch, timeoutMs = 45_000 }) {
    this.url = url;
    this.tokenFile = tokenFile;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async #authorization() {
    const token = (await readFile(this.tokenFile, "utf8")).trim();
    if (!token) throw new Error("Momentum write token is empty.");
    return /^bearer\s/i.test(token) ? token : `Bearer ${token}`;
  }

  async call(name, args = {}) {
    if (!this.url || !this.tokenFile) throw new Error("Momentum write connector is not configured.");
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        authorization: await this.#authorization(),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Momentum MCP returned HTTP ${response.status}.`);
    const body = await response.json();
    if (body.error) throw new Error(body.error.message ?? "Momentum MCP error.");
    const result = body.result;
    const text = result?.content?.[0]?.text ?? "";
    if (result?.isError) throw new Error(text || "Momentum tool reported an error.");
    return text;
  }

  async insertInsuredProspect(fields) {
    return parseInsertResult(await this.call("insert_insured_prospect_tool", fields));
  }
}

// insert_insured_prospect_tool returns "a success response with insuredDatabaseId
// or an error message" — shape is not guaranteed, so parse defensively. This is
// exactly what the pre-go-live dry-run against the real MCP must confirm.
export function parseInsertResult(text) {
  let parsed = null;
  try {
    parsed = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    parsed = null;
  }
  const id =
    parsed?.insuredDatabaseId ??
    parsed?.InsuredDatabaseId ??
    parsed?.databaseId ??
    parsed?.DatabaseId ??
    parsed?.id ??
    null;
  if (id) return { ok: true, insured_database_id: String(id), raw: parsed ?? text };
  if (typeof text === "string" && /^[0-9a-f-]{36}$/i.test(text.trim())) {
    return { ok: true, insured_database_id: text.trim(), raw: text };
  }
  const message = (typeof text === "string" ? text : JSON.stringify(parsed ?? "")).slice(0, 300);
  return { ok: false, insured_database_id: null, message: message || "No insuredDatabaseId returned.", raw: parsed ?? text };
}
