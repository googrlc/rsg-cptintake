import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export class NowCertsMcpClient {
  constructor({ url, tokenFile, fetchImpl = fetch }) {
    this.url = url;
    this.tokenFile = tokenFile;
    this.fetchImpl = fetchImpl;
  }

  async call(name, args = {}) {
    if (!this.url || !this.tokenFile) throw new Error("Live NowCerts read connector is not configured.");
    const token = (await readFile(this.tokenFile, "utf8")).trim();
    if (!token) throw new Error("Live NowCerts connector token is empty.");
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(40_000),
    });
    if (!response.ok) throw new Error(`NowCerts read connector returned HTTP ${response.status}.`);
    const body = await response.json();
    if (body.error) throw new Error(body.error.message ?? "NowCerts connector error.");
    const result = body.result;
    if (result?.isError) throw new Error(result.content?.[0]?.text ?? "NowCerts tool error.");
    return result?.content?.[0]?.text ?? "";
  }

  async ping() {
    return this.call("ping");
  }

  async searchInsureds(query, top = 10) {
    const parsed = JSON.parse(await this.call("search_insureds", { query, top }));
    if (Array.isArray(parsed)) return parsed;
    for (const key of ["value", "items", "results"]) {
      if (Array.isArray(parsed?.[key])) return parsed[key];
    }
    return [];
  }
}
