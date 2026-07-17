import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { FileProposalStore } from "./store.js";
import { NowCertsGateway } from "./gateway.js";
import { inspectPdf, DEFAULT_MAX_BYTES } from "./documents/pdf-intake.js";
import { TempDocumentStore } from "./documents/temp-store.js";
import { prepareSourceBundle, prepareSourceBundleSchema } from "./intake/source-bundle.js";
import { FileIntakeSourceStore } from "./intake/source-store.js";
import { generateIntakeReport } from "./reports/intake-report.js";
import { NowCertsMcpClient, summarizeInsured } from "./connectors/nowcerts-mcp.js";
import { HermesPreviewClient } from "./connectors/hermes-preview.js";
import { extractPdfText } from "./documents/pdf-text.js";
import { applyHermesPreview, buildEvidenceText } from "./intake/live-pipeline.js";
import { buildInsuredProposal } from "./intake/intake-proposal.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const mode = process.env.GATEWAY_MODE ?? "shadow";
const dataDir = process.env.GATEWAY_DATA_DIR ?? "./data";
const allowedOrigin = process.env.MCP_ALLOWED_ORIGIN ?? null;
const store = new FileProposalStore(dataDir);
const gateway = new NowCertsGateway({ store, mode });
const nowcertsReader = process.env.NOWCERTS_MCP_URL && process.env.NOWCERTS_MCP_TOKEN_FILE
  ? new NowCertsMcpClient({
      url: process.env.NOWCERTS_MCP_URL,
      tokenFile: process.env.NOWCERTS_MCP_TOKEN_FILE,
    })
  : null;
const hermesPreview = process.env.HERMES_PREVIEW_URL
  ? new HermesPreviewClient({ url: process.env.HERMES_PREVIEW_URL })
  : null;
const documentStore = new TempDocumentStore(path.join(dataDir, "documents"));
const intakeStore = new FileIntakeSourceStore(path.join(dataDir, "intakes"));
const intakeAppUri = "ui://rsg/intake-gate.html";
const intakeAppHtml = readFileSync(
  path.resolve(import.meta.dirname, "../dist/intake-app.html"),
  "utf8",
);

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

async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Minimal access log to identify which tailnet device consumes this gateway.
// PII-safe: logs the pathname only (never the query string, which can carry a
// client name via ?q=), the source tailnet IP that Tailscale Serve forwards,
// and the identity header Serve injects. No request bodies, no headers dump.
function logAccess(req, url) {
  const xff = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  const src = xff || req.socket?.remoteAddress || "-";
  const tsUser = req.headers["tailscale-user-login"] ?? "-";
  console.log(
    `[access] ${new Date().toISOString()} src=${src} ts=${tsUser} ${req.method} ${url.pathname}`,
  );
}

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

function requestActor(req) {
  const identity = String(req.headers["tailscale-user-login"] ?? "").toLowerCase();
  return identity.includes("gretchen") ? "gretchen" : "lamar";
}

function createMcpServer() {
  const server = new McpServer(
    { name: "rsg-nowcerts-write-gateway", version: "0.1.0" },
    {
      instructions:
        "Always prepare and show a proposal before approval. Never describe SHADOW_APPROVED as written to NowCerts. Missing information or conflicts must stop approval.",
    },
  );

  registerAppResource(
    server,
    "RSG Intake Gate",
    intakeAppUri,
    { description: "Private multi-source client intake, risk assessment, and cited NowCerts proposal workspace." },
    async () => ({
      contents: [
        {
          uri: intakeAppUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: intakeAppHtml,
          _meta: {
            ui: {
              prefersBorder: false,
              csp: { connectDomains: [], resourceDomains: [] },
            },
          },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "open_intake_workspace",
    {
      title: "Open RSG intake workspace",
      description:
        "Opens the private client workspace for PDFs, transcripts, notes, risk assessment, retained PDF, and NowCerts proposal review.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: intakeAppUri } },
    },
    async () =>
      asToolResult({
        status: "WAITING_FOR_INPUT",
        mode,
        live_writes: false,
        extraction_ready: false,
        message:
          "The intake workspace is ready. Add PDFs, transcripts, notes, or manual facts for one client. No data has been written to NowCerts.",
      }),
  );

  registerAppTool(
    server,
    "prepare_client_intake",
    {
      title: "Prepare multi-source client intake",
      description:
        "Combines cited PDFs, transcripts, notes, and manual facts into one shadow intake bundle. It prepares the synthesis pipeline but cannot write to NowCerts.",
      inputSchema: prepareSourceBundleSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: intakeAppUri } },
    },
    async (args) => {
      const bundle = prepareSourceBundle(args);
      await intakeStore.save(bundle);
      return asToolResult(bundle);
    },
  );

  registerAppTool(
    server,
    "register_intake_document",
    {
      title: "Register PDF for intake",
      description:
        "Registers a ChatGPT file reference for the intake workspace. This does not extract content or write to NowCerts.",
      inputSchema: {
        file_id: z.string().min(1),
        file_name: z.string().min(1).max(255),
        mime_type: z.literal("application/pdf"),
        byte_size: z.number().int().positive().max(25 * 1024 * 1024).nullable(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: intakeAppUri, visibility: ["app"] } },
    },
    async (args) =>
      asToolResult({
        status: "DOCUMENT_REGISTERED",
        ...args,
        live_writes: false,
        extraction_ready: false,
        message:
          "Document registered. The live PDF extractor is not configured yet; no data has been written to NowCerts.",
      }),
  );

  registerAppTool(
    server,
    "prepare_nowcerts_write",
    {
      title: "Prepare NowCerts write preview",
      description:
        "Validates and stores a cited NowCerts proposal with a current-record snapshot. It detects overlapping proposals and never writes to NowCerts. Show the complete returned preview and expected_confirmation to the user.",
      inputSchema: prepareInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: intakeAppUri, visibility: ["model"] } },
    },
    async (args) => asToolResult(await gateway.prepare(args)),
  );

  registerAppTool(
    server,
    "get_nowcerts_proposal",
    {
      title: "Get NowCerts proposal",
      description: "Retrieves one previously prepared proposal and its status by ID.",
      inputSchema: { proposal_id: z.string().uuid() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: intakeAppUri, visibility: ["model"] } },
    },
    async ({ proposal_id: proposalId }) => {
      const record = await gateway.get(proposalId);
      return asToolResult(record ?? { status: "NOT_FOUND", proposal_id: proposalId });
    },
  );

  registerAppTool(
    server,
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
      _meta: { ui: { resourceUri: intakeAppUri, visibility: ["model"] } },
    },
    async (args) => asToolResult(await gateway.approve(args)),
  );

  return server;
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) return res.writeHead(400).end("Missing URL");
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  logAccess(req, url);

  if (req.method === "GET" && url.pathname === "/") {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        service: "rsg-nowcerts-write-gateway",
        mode,
        live_data: mode === "pilot" && Boolean(nowcertsReader),
        synthesis_ready: Boolean(hermesPreview),
        live_writes: false,
        operator_page: "/app",
      }));
    return;
  }

  if (req.method === "GET" && ["/app", "/app/"].includes(url.pathname)) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'",
    });
    res.end(intakeAppHtml);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/nowcerts/status") {
    if (mode !== "pilot" || !nowcertsReader) {
      sendJson(res, 503, { status: "NOT_CONFIGURED", live_data: false, live_writes: false });
      return;
    }
    try {
      await nowcertsReader.ping();
      sendJson(res, 200, { status: "CONNECTED", live_data: true, live_writes: false });
    } catch (error) {
      sendJson(res, 502, { status: "UNAVAILABLE", live_data: false, live_writes: false, message: error.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/nowcerts/insureds/search") {
    const query = (url.searchParams.get("q") ?? "").trim();
    if (mode !== "pilot" || !nowcertsReader) {
      sendJson(res, 503, { status: "NOT_CONFIGURED", matches: [] });
      return;
    }
    if (query.length < 2 || query.length > 120) {
      sendJson(res, 400, { status: "INVALID_QUERY", message: "Enter 2–120 characters.", matches: [] });
      return;
    }
    try {
      const matches = (await nowcertsReader.searchInsureds(query, 10))
        .map(summarizeInsured)
        .filter((match) => match.database_id);
      sendJson(res, 200, { status: "CONNECTED", query, matches, live_writes: false });
    } catch (error) {
      sendJson(res, 502, { status: "UNAVAILABLE", message: error.message, matches: [] });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/intake/documents") {
    try {
      if (req.headers["content-type"]?.split(";")[0] !== "application/pdf") {
        sendJson(res, 415, { status: "REJECTED", message: "Only application/pdf uploads are accepted." });
        return;
      }
      const rawName = String(req.headers["x-file-name"] ?? "upload.pdf");
      const filename = decodeURIComponent(rawName).replace(/[\\/]/g, "_").slice(0, 255) || "upload.pdf";
      const bytes = await readBody(req, DEFAULT_MAX_BYTES);
      const inspected = inspectPdf(bytes, { filename });
      if (!inspected.ok) {
        sendJson(res, 422, { status: "REJECTED", ...inspected });
        return;
      }
      await documentStore.put(bytes, inspected.document);
      sendJson(res, 201, { status: "DOCUMENT_ACCEPTED", document: inspected.document, live_writes: false });
    } catch (error) {
      sendJson(res, error.statusCode ?? 400, { status: "REJECTED", message: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/intakes") {
    try {
      const bytes = await readBody(req, 1024 * 1024);
      const input = JSON.parse(bytes.toString("utf8"));
      let bundle = prepareSourceBundle(input);
      if (!hermesPreview) {
        await intakeStore.save(bundle);
        sendJson(res, 503, { ...bundle, status: "SYNTHESIS_NOT_CONFIGURED", message: "Hermes preview service is not connected." });
        return;
      }

      const pdfTexts = new Map();
      const pdfWarnings = [];
      for (const source of bundle.sources.filter((item) => item.kind === "pdf")) {
        const pdfBytes = await documentStore.getBytes(source.document_id);
        if (!pdfBytes) {
          pdfWarnings.push(`${source.title}: uploaded PDF bytes are no longer available.`);
          continue;
        }
        try {
          const extracted = await extractPdfText(pdfBytes);
          pdfTexts.set(source.document_id, extracted);
          if (!extracted.text) pdfWarnings.push(`${source.title}: no machine-readable text found; OCR or manual review is required.`);
          if (extracted.truncated) pdfWarnings.push(`${source.title}: extracted text was truncated at the safety limit.`);
        } catch (error) {
          pdfWarnings.push(`${source.title}: ${error.message}`);
        }
      }

      const rawText = buildEvidenceText(bundle, pdfTexts);
      const draft = await hermesPreview.stageDraft({
        rawText,
        submittedBy: requestActor(req),
        sourceRef: `rsg-intake-gate:${bundle.intake_id}`,
      });
      const operations = draft.payload_preview?.account?.operations_summary;
      let research = null;
      try {
        research = await hermesPreview.researchBusiness([bundle.client.display_name, operations].filter(Boolean).join(" — "));
      } catch (error) {
        pdfWarnings.push(`Business enrichment unavailable: ${error.message}`);
      }
      bundle = applyHermesPreview(bundle, draft, research, pdfWarnings);
      await intakeStore.save(bundle);
      sendJson(res, 201, bundle);
    } catch (error) {
      sendJson(res, error.statusCode ?? 400, {
        status: "REJECTED",
        message: error?.issues?.map((issue) => issue.message).join("; ") ?? error.message,
      });
    }
    return;
  }

  const intakeMatch = req.method === "GET" && url.pathname.match(/^\/api\/intakes\/([a-f0-9-]{36})$/);
  if (intakeMatch) {
    const bundle = await intakeStore.get(intakeMatch[1]);
    sendJson(res, bundle ? 200 : 404, bundle ?? { status: "NOT_FOUND" });
    return;
  }

  const reportMatch = req.method === "GET" && url.pathname.match(/^\/api\/intakes\/([a-f0-9-]{36})\/report\.pdf$/);
  if (reportMatch) {
    try {
      const bundle = await intakeStore.get(reportMatch[1]);
      if (!bundle) {
        sendJson(res, 404, { status: "NOT_FOUND" });
        return;
      }
      const report = await generateIntakeReport(bundle, path.join(dataDir, "reports"));
      const filename = `${bundle.client.display_name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "client"}-risk-assessment.pdf`;
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": report.bytes.length,
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(report.bytes);
    } catch (error) {
      sendJson(res, error.statusCode ?? 500, { status: "REPORT_NOT_READY", message: error.message });
    }
    return;
  }

  // Standalone (ChatGPT-free) write-proposal + approval over REST. Mirrors the
  // MCP prepare/approve tools: same gateway.prepare()/approve() guardrails, with
  // actor/approver derived from the tailnet identity rather than caller-supplied.
  if (req.method === "POST" && url.pathname === "/api/proposals") {
    try {
      const bytes = await readBody(req, 64 * 1024);
      const { intake_id: intakeId } = JSON.parse(bytes.toString("utf8"));
      if (!intakeId || !/^[a-f0-9-]{36}$/.test(String(intakeId))) {
        sendJson(res, 400, { status: "INVALID", message: "A valid intake_id is required." });
        return;
      }
      const bundle = await intakeStore.get(String(intakeId));
      if (!bundle) {
        sendJson(res, 404, { status: "NOT_FOUND", message: "Intake bundle not found." });
        return;
      }
      const built = buildInsuredProposal(bundle, requestActor(req));
      if (!built.ok) {
        sendJson(res, 422, built);
        return;
      }
      const record = await gateway.prepare(built.proposal);
      sendJson(res, 201, record);
    } catch (error) {
      sendJson(res, error.statusCode ?? 400, { status: "REJECTED", message: error.message });
    }
    return;
  }

  const proposalGet = req.method === "GET" && url.pathname.match(/^\/api\/proposals\/([0-9a-f-]{36})$/);
  if (proposalGet) {
    const record = await gateway.get(proposalGet[1]);
    sendJson(res, record ? 200 : 404, record ?? { status: "NOT_FOUND" });
    return;
  }

  const proposalApprove = req.method === "POST" && url.pathname.match(/^\/api\/proposals\/([0-9a-f-]{36})\/approve$/);
  if (proposalApprove) {
    try {
      const bytes = await readBody(req, 8 * 1024);
      const { confirmation } = JSON.parse(bytes.toString("utf8"));
      const result = await gateway.approve({
        proposal_id: proposalApprove[1],
        approver: requestActor(req),
        confirmation: String(confirmation ?? ""),
      });
      const code = result.ok ? 200 : result.status === "NOT_FOUND" ? 404 : 409;
      sendJson(res, code, result);
    } catch (error) {
      sendJson(res, error.statusCode ?? 400, { status: "REJECTED", message: error.message });
    }
    return;
  }

  if (req.method === "OPTIONS" && url.pathname === "/mcp") {
    const origin = req.headers.origin;
    if (!allowedOrigin || origin !== allowedOrigin) {
      res.writeHead(403).end("Origin not allowed");
      return;
    }
    res.writeHead(204, {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (url.pathname === "/mcp" && ["POST", "GET", "DELETE"].includes(req.method ?? "")) {
    const origin = req.headers.origin;
    if (origin && origin !== allowedOrigin) {
      res.writeHead(403).end("Origin not allowed");
      return;
    }
    if (origin && allowedOrigin) res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
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
