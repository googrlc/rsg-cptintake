import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { FileProposalStore } from "./store.js";
import { NowCertsGateway } from "./gateway.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const mode = process.env.GATEWAY_MODE ?? "shadow";
const dataDir = process.env.GATEWAY_DATA_DIR ?? "./data";
const store = new FileProposalStore(dataDir);
const gateway = new NowCertsGateway({ store, mode });

const sourceInput = z.object({
  kind: z.enum(["document", "user_message", "nowcerts", "trusted_system"]),
  reference: z.string().min(1),
  location: z.string().min(1).nullable(),
  excerpt: z.string().min(1).max(500).nullable(),
  captured_at: z.string().datetime({ offset: true }),
});

const changeInput = z.object({
  field: z.string().min(1),
  current: z.unknown(),
  proposed: z.unknown(),
  clear: z.boolean(),
  source: sourceInput,
});

const prepareInput = {
  actor: z.enum(["lamar", "gretchen"]),
  operation: z.enum(["create", "update", "import", "archive", "deactivate"]),
  entity_type: z.string().min(1),
  target: z.object({
    database_id: z.string().min(1).nullable(),
    display_name: z.string().min(1),
    match_status: z.enum(["EXACT", "LIKELY", "AMBIGUOUS", "NONE"]),
    match_reason: z.string().min(1),
    snapshot: z
      .object({
        observed_at: z.string().datetime({ offset: true }),
        version_token: z.string().min(1).nullable(),
        values: z.record(z.unknown()),
      })
      .nullable(),
  }),
  changes: z.array(changeInput).min(1),
  duplicate_risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
  missing_fields: z.array(z.string().min(1)),
  conflicts: z.array(
    z.object({ field: z.string().min(1), description: z.string().min(1) }),
  ),
  write_contract: z.object({
    method: z.enum(["api", "ui", "import"]),
    path: z.string().min(1),
    contract_source: z.string().min(1),
    checked_at: z.string().date(),
    supports_operation: z.enum(["create", "update", "import", "archive", "deactivate"]),
  }),
  read_back_path: z.string().min(1),
  read_back_fields: z.array(z.string().min(1)).min(1),
  master_data: z
    .object({
      is_master: z.boolean(),
      downstream_scope: z.string().min(1).nullable(),
      named_confirmation: z.string().min(1).nullable(),
    })
    .nullable(),
};

function asToolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function createMcpServer() {
  const server = new McpServer(
    { name: "rsg-nowcerts-write-gateway", version: "0.1.0" },
    {
      instructions:
        "Always prepare and show a proposal before approval. Never describe SHADOW_APPROVED as written to NowCerts. Missing information or conflicts must stop approval.",
    },
  );

  server.registerTool(
    "prepare_nowcerts_write",
    {
      title: "Prepare NowCerts write preview",
      description:
        "Validates and stores a cited NowCerts proposal with a current-record snapshot. It detects overlapping proposals and never writes to NowCerts. Show the complete returned preview and expected_confirmation to the user.",
      inputSchema: prepareInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => asToolResult(await gateway.prepare(args)),
  );

  server.registerTool(
    "get_nowcerts_proposal",
    {
      title: "Get NowCerts proposal",
      description: "Retrieves one previously prepared proposal and its status by ID.",
      inputSchema: { proposal_id: z.string().uuid() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ proposal_id: proposalId }) => {
      const record = await gateway.get(proposalId);
      return asToolResult(record ?? { status: "NOT_FOUND", proposal_id: proposalId });
    },
  );

  server.registerTool(
    "approve_nowcerts_write",
    {
      title: "Approve NowCerts proposal in shadow mode",
      description:
        "Checks confirmation and role permission, then records a shadow approval. This build cannot write to NowCerts and must never be represented as a live commit.",
      inputSchema: {
        proposal_id: z.string().uuid(),
        approver: z.enum(["lamar", "gretchen"]),
        confirmation: z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => asToolResult(await gateway.approve(args)),
  );

  return server;
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) return res.writeHead(400).end("Missing URL");
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ service: "rsg-nowcerts-write-gateway", mode, live_writes: false }));
    return;
  }

  if (req.method === "OPTIONS" && url.pathname === "/mcp") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (url.pathname === "/mcp" && ["POST", "GET", "DELETE"].includes(req.method ?? "")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP request failed", error);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, host, () => {
  console.log(`NowCerts gateway listening on http://${host}:${port}/mcp (${mode} mode)`);
});
