// Momentum (NowCerts) MCP WRITE connector — the only code path that can create
// a live AMS record, and only ever invoked by the guarded executor on a
// reviewed + approved, fingerprinted proposal. The Momentum server is a FastMCP
// Streamable-HTTP (SSE) endpoint, so we use the MCP SDK client which performs
// the initialize handshake, carries the session id, and parses SSE responses.
// Auth is Bearer <api_key>. Configured via MOMENTUM_MCP_URL + a token file;
// when unconfigured the server passes null and no write is possible.

import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export class MomentumWriteClient {
  constructor({ url, tokenFile, timeoutMs = 45_000, clientFactory } = {}) {
    this.url = url;
    this.tokenFile = tokenFile;
    this.timeoutMs = timeoutMs;
    // Injectable so the connector can be exercised without a live server.
    this.clientFactory = clientFactory ?? defaultClientFactory;
  }

  async #authorization() {
    const token = (await readFile(this.tokenFile, "utf8")).trim();
    if (!token) throw new Error("Momentum write token is empty.");
    return /^bearer\s/i.test(token) ? token : `Bearer ${token}`;
  }

  async callTool(name, args = {}) {
    if (!this.url || !this.tokenFile) throw new Error("Momentum write connector is not configured.");
    const authorization = await this.#authorization();
    const { client, close } = await this.clientFactory({ url: this.url, authorization, timeoutMs: this.timeoutMs });
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: this.timeoutMs });
      const text = resultText(result);
      if (result?.isError) throw new Error(text || "Momentum tool reported an error.");
      return text;
    } finally {
      await close();
    }
  }

  // Read-only connectivity check — proves URL + token + handshake without writing.
  async listTools() {
    if (!this.url || !this.tokenFile) throw new Error("Momentum write connector is not configured.");
    const authorization = await this.#authorization();
    const { client, close } = await this.clientFactory({ url: this.url, authorization, timeoutMs: this.timeoutMs });
    try {
      const result = await client.listTools();
      return (result?.tools ?? []).map((tool) => tool.name);
    } finally {
      await close();
    }
  }

  // Real auth check: a no-arg read tool that actually hits NowCerts, so it
  // validates the operating key (unlike tools/list, served from the catalog).
  async probeAuth() {
    await this.callTool("get_agent_list_tool", {});
    return true;
  }

  async insertInsuredProspect(fields) {
    return parseInsertResult(await this.callTool("insert_insured_prospect_tool", fields));
  }

  // Attach a note to an insured (the risk assessment). subject holds the note
  // text per the tool contract. Throws on error so the caller can record it.
  async insertNote({ insuredDatabaseId, subject }) {
    await this.callTool("insert_note_tool", { insured_database_id: insuredDatabaseId, subject });
    return { ok: true };
  }

  // Insert (or update) a primary contact under an existing insured.
  //
  // Per the tool contract this call is dedupe-aware: with no database_id it
  // matches firstName + lastName (+ email) against the insured's existing
  // contacts and returns duplicateFound with the existing databaseId instead of
  // creating a second record. The caller must surface that to a human and only
  // re-call with databaseId once the operator confirms an update — never
  // auto-confirm, which would silently overwrite a contact.
  async insertPrimaryContact(fields) {
    return parseContactResult(await this.callTool("insert_insured_prospect_primary_contact_in_ams_tool", fields));
  }

  // Read-back for contact writes.
  async getInsuredContacts(insuredDatabaseId) {
    const text = await this.callTool("get_insured_contact_details_tool", { insured_database_id: insuredDatabaseId });
    let parsed = null;
    try {
      parsed = typeof text === "string" ? JSON.parse(text) : text;
    } catch {
      parsed = null;
    }
    if (Array.isArray(parsed)) return parsed;
    return parsed?.value ?? parsed?.items ?? parsed?.results ?? parsed?.contacts ?? (parsed && typeof parsed === "object" ? [parsed] : []);
  }

  // Read-back by id — the audit-certified verification tool for insured create.
  async getInsuredById(insuredDatabaseId) {
    const text = await this.callTool("get_insured_detail_list_tool", { insured_database_id: insuredDatabaseId });
    let parsed = null;
    try {
      parsed = typeof text === "string" ? JSON.parse(text) : text;
    } catch {
      parsed = null;
    }
    const records = Array.isArray(parsed)
      ? parsed
      : parsed?.value ?? parsed?.items ?? parsed?.results ?? (parsed && typeof parsed === "object" ? [parsed] : []);
    const target = String(insuredDatabaseId);
    return records.find((r) => String(r?.databaseId ?? r?.DatabaseId ?? r?.id ?? r?.Id ?? "") === target) ?? records[0] ?? null;
  }
}

export function resultText(result) {
  const content = result?.content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join("").trim();
  if (typeof content === "string") return content.trim();
  return "";
}

// insert_insured_prospect_tool returns "a success response with insuredDatabaseId
// or an error message" — shape is not guaranteed, so parse defensively. The
// pre-go-live dry-run against the real MCP confirms the exact shape.
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
    parsed?.data?.insuredDatabaseId ??
    null;
  if (id) return { ok: true, insured_database_id: String(id), raw: parsed ?? text };
  if (typeof text === "string" && /^[0-9a-f-]{36}$/i.test(text.trim())) {
    return { ok: true, insured_database_id: text.trim(), raw: text };
  }
  const message = (typeof text === "string" ? text : JSON.stringify(parsed ?? "")).slice(0, 300);
  return { ok: false, insured_database_id: null, message: message || "No insuredDatabaseId returned.", raw: parsed ?? text };
}

// The contact tool returns either { insuredDatabaseId, primaryContactId } on a
// successful insert/update, or { duplicateFound: true, databaseId } when it
// matched an existing contact. A duplicate is NOT an error and NOT a success —
// it is a question for the operator, so it gets its own status.
export function parseContactResult(text) {
  let parsed = null;
  try {
    parsed = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    parsed = null;
  }
  const duplicate = parsed?.duplicateFound ?? parsed?.DuplicateFound ?? false;
  const existingId = parsed?.databaseId ?? parsed?.DatabaseId ?? parsed?.contactDatabaseId ?? null;
  if (duplicate) {
    return {
      ok: false,
      status: "DUPLICATE_CONTACT",
      contact_database_id: existingId ? String(existingId) : null,
      message: "A matching contact already exists on this insured. Confirm before updating it.",
      raw: parsed ?? text,
    };
  }
  const contactId = parsed?.primaryContactId ?? parsed?.PrimaryContactId ?? existingId ?? null;
  if (contactId) {
    return {
      ok: true,
      status: "WRITTEN",
      contact_database_id: String(contactId),
      insured_database_id: parsed?.insuredDatabaseId ? String(parsed.insuredDatabaseId) : null,
      raw: parsed ?? text,
    };
  }
  const message = (typeof text === "string" ? text : JSON.stringify(parsed ?? "")).slice(0, 300);
  return {
    ok: false,
    status: "WRITE_FAILED",
    contact_database_id: null,
    message: message || "No primaryContactId returned.",
    raw: parsed ?? text,
  };
}

async function defaultClientFactory({ url, authorization }) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: authorization } },
  });
  const client = new Client({ name: "rsg-intake-gate", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, close: () => transport.close().catch(() => {}) };
}
