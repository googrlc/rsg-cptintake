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
import { inspectImage, DEFAULT_MAX_IMAGE_BYTES, ACCEPTED_IMAGE_MIME_TYPES } from "./documents/image-intake.js";
import { ClamAvScanner, screenUpload } from "./documents/malware-scan.js";
import { readDriverLicense } from "./documents/license-intake.js";
import { ocrImage } from "./documents/ocr.js";
import { TempDocumentStore } from "./documents/temp-store.js";
import { prepareSourceBundle, prepareSourceBundleSchema } from "./intake/source-bundle.js";
import { FileIntakeSourceStore } from "./intake/source-store.js";
import { generateIntakeReport } from "./reports/intake-report.js";
import { NowCertsMcpClient, summarizeInsured } from "./connectors/nowcerts-mcp.js";
import { HermesPreviewClient, hermesTokenFromEnv, intakeKeyFromEnv } from "./connectors/hermes-preview.js";
import { extractPdfText } from "./documents/pdf-text.js";
import { applyHermesPreview, buildEvidenceText } from "./intake/live-pipeline.js";
import { buildInsuredProposal } from "./intake/intake-proposal.js";
import { MomentumWriteClient } from "./connectors/momentum-write.js";
import { commitApprovedInsured } from "./executor/insured-executor.js";
import { attomClientFromEnv } from "./connectors/attom-client.js";
import { FemaFloodClient } from "./connectors/fema-flood-client.js";
import { protectionClassClientFromEnv, replacementCostClientFromEnv } from "./connectors/property-risk-clients.js";
import { lookupPropertyProfile } from "./intake/property-lookup.js";
import { attachClassification, lookupCode, searchCodes, REFERENCE_TYPES } from "./intake/reference-classifier.js";
import { submitToCrm } from "./intake/crm-writer.js";
import { buildCrmSubmission } from "./intake/crm-submission.js";

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
// Optional bearer for the few token-gated Hermes routes. Throws at startup on a
// configured-but-empty token rather than degrading into silent anonymous calls.
const hermesToken = hermesTokenFromEnv();
// A separate credential from the bearer: Hermes gates `/api/intake` on
// X-RSG-API-Key. Same fail-loud rule — configured-but-empty throws at startup.
const hermesIntakeKey = intakeKeyFromEnv();
const hermesPreview = process.env.HERMES_PREVIEW_URL
  ? new HermesPreviewClient({
      url: process.env.HERMES_PREVIEW_URL,
      token: hermesToken,
      intakeKey: hermesIntakeKey,
    })
  : null;
// Optional, operator-triggered property enrichment (ATTOM). Null unless a key is
// configured — the "Get property details" button reports NOT_ENABLED then.
const attomClient = attomClientFromEnv();
// FEMA flood zone (free, keyless) — chained onto a property match via its coords.
// ATTOM_NO_FLOOD=on disables it if the NFHL service is ever a problem.
const floodClient = process.env.ATTOM_NO_FLOOD === "on" ? null : new FemaFloodClient();
// Deferred provider seams (Noop until a licensed source is wired): ISO fire
// protection class and replacement cost. They keep those two property_profile
// fields plumbed so they fill the moment a provider exists, and stay null now.
const protectionClassClient = protectionClassClientFromEnv();
const replacementCostClient = replacementCostClientFromEnv();
// Live AMS writes stay OFF unless ALL of: the explicit LIVE_AMS_WRITES=on flag,
// a configured Momentum write connector, AND a read connector (needed for the
// pre-write duplicate check and post-write read-back). Missing any one => no
// write is possible and the "Send to AMS" endpoint reports NOT_ENABLED.
const momentumWriter =
  process.env.LIVE_AMS_WRITES === "on" &&
  process.env.MOMENTUM_MCP_URL &&
  process.env.MOMENTUM_MCP_TOKEN_FILE &&
  nowcertsReader
    ? new MomentumWriteClient({
        url: process.env.MOMENTUM_MCP_URL,
        tokenFile: process.env.MOMENTUM_MCP_TOKEN_FILE,
      })
    : null;
const liveWritesEnabled = Boolean(momentumWriter);
// Malware scanning for uploads. Configured => every upload is scanned and a
// scanner outage rejects uploads rather than admitting them unscanned.
// REQUIRE_MALWARE_SCAN=on additionally refuses to accept uploads at all when no
// scanner is configured — set it in any deployment that accepts images.
// Hermes CRM opportunity writes. Ships dark: verify against one real intake,
// then enable. Opportunities are additive and never block the intake.
const hermesCrmWrites = process.env.HERMES_CRM_WRITES === "1";
const malwareScanner = ClamAvScanner.fromEnv();
const requireMalwareScan = process.env.REQUIRE_MALWARE_SCAN === "on";
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
        hermes_authenticated: Boolean(hermesPreview?.authenticated),
        live_writes: liveWritesEnabled,
        uploads: {
          accepted: ["application/pdf", ...ACCEPTED_IMAGE_MIME_TYPES],
          malware_scanning: malwareScanner.configured,
          scanner_required: requireMalwareScan,
        },
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
      const declaredType = req.headers["content-type"]?.split(";")[0]?.trim() ?? "";
      const isPdf = declaredType === "application/pdf";
      const isImage = ACCEPTED_IMAGE_MIME_TYPES.includes(declaredType);
      if (!isPdf && !isImage) {
        sendJson(res, 415, {
          status: "REJECTED",
          message: `Accepted uploads: application/pdf, ${ACCEPTED_IMAGE_MIME_TYPES.join(", ")}.`,
        });
        return;
      }
      const rawName = String(req.headers["x-file-name"] ?? (isPdf ? "upload.pdf" : "upload"));
      const filename = decodeURIComponent(rawName).replace(/[\\/]/g, "_").slice(0, 255) || "upload";
      const bytes = await readBody(req, isPdf ? DEFAULT_MAX_BYTES : DEFAULT_MAX_IMAGE_BYTES);

      // Malware scan BEFORE anything parses the bytes. Fail closed: a configured
      // scanner that cannot be reached rejects the upload rather than letting it
      // through unscanned. Images especially — an image decoder is a far larger
      // attack surface than pdftotext.
      const screened = await screenUpload(bytes, malwareScanner, { required: requireMalwareScan });
      if (!screened.ok) {
        sendJson(res, screened.statusCode, {
          status: "REJECTED",
          reason: screened.reason,
          message: screened.message,
        });
        return;
      }

      // The declared Content-Type is attacker-controlled, so the real type is
      // confirmed from the magic bytes here, not from the header.
      const inspected = isPdf ? inspectPdf(bytes, { filename }) : inspectImage(bytes, { filename });
      if (!inspected.ok) {
        sendJson(res, 422, { status: "REJECTED", ...inspected });
        return;
      }
      await documentStore.put(bytes, inspected.document);

      // Images get an automatic licence read: if the photo is the back of a
      // driver's licence its PDF417 barcode decodes to exact AAMVA fields. A
      // non-licence image simply reports NO_BARCODE and falls through to OCR.
      let license = null;
      let ocr = null;
      if (isImage) {
        license = await readDriverLicense(bytes);
        if (!license.ok) {
          const text = await ocrImage(bytes);
          ocr = text.ok
            ? { status: "OK", text: text.text, confidence: text.confidence, low_confidence: text.low_confidence }
            : { status: text.reason, message: text.message };
        }
      }

      sendJson(res, 201, {
        status: "DOCUMENT_ACCEPTED",
        document: inspected.document,
        ...(license ? { license } : {}),
        ...(ocr ? { ocr } : {}),
        live_writes: false,
      });
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
      // Deterministic classification against the RSG reference tables — attaches
      // NAICS/SIC/GL/WC candidates for review; validates any existing NAICS.
      attachClassification(bundle);

      // Nothing is sent to the CRM here. Synthesis produces a bundle for an
      // operator to READ — flagged items, missing evidence, suggested class codes
      // — and sending it before they have read it would make the review theatre.
      // The operator presses Approve and POSTs /api/intakes/:id/crm; that is the
      // one moment this intake becomes CRM records.
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

  // Read-only reference-table lookups (NAICS/SIC/GL/WC) — deterministic, no auth
  // concern. search?type=&q=&limit= ranks candidates; validate?type=&code= checks
  // a single code. Lets the operator/UI find codes in the tables, never guess.
  if (req.method === "GET" && url.pathname === "/api/reference/search") {
    const type = url.searchParams.get("type");
    const q = url.searchParams.get("q") ?? "";
    const limit = Math.min(Number(url.searchParams.get("limit")) || 5, 25);
    if (!REFERENCE_TYPES.includes(type)) {
      sendJson(res, 400, { status: "INVALID", message: `type must be one of: ${REFERENCE_TYPES.join(", ")}.` });
      return;
    }
    sendJson(res, 200, searchCodes(type, q, { limit }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/reference/validate") {
    const type = url.searchParams.get("type");
    const code = url.searchParams.get("code") ?? "";
    if (!REFERENCE_TYPES.includes(type)) {
      sendJson(res, 400, { status: "INVALID", message: `type must be one of: ${REFERENCE_TYPES.join(", ")}.` });
      return;
    }
    const result = lookupCode(type, code);
    sendJson(res, 200, { ...result, valid: Boolean(result.entry) });
    return;
  }

  // What the approval button is actually approving. Built by the SAME function
  // that builds the send, so the screen cannot drift from the payload — an
  // approval screen that shows its own arithmetic is an approval of nothing.
  const crmPreview = req.method === "GET" && url.pathname.match(/^\/api\/intakes\/([a-f0-9-]{36})\/crm$/);
  if (crmPreview) {
    const bundle = await intakeStore.get(crmPreview[1]);
    if (!bundle) {
      sendJson(res, 404, { status: "NOT_FOUND" });
      return;
    }
    const submission = buildCrmSubmission(bundle, { submittedBy: requestActor(req) });
    const payload = submission.synthesized_payload ?? {};
    sendJson(res, 200, {
      enabled: hermesCrmWrites,
      configured: Boolean(hermesPreview?.canSubmitIntake),
      already_submitted: bundle.crm?.status === "SUBMITTED",
      crm: bundle.crm ?? null,
      account_name: payload.account?.account_name ?? null,
      lines_of_business: (payload.opportunities ?? []).map((item) => item.line_of_business).filter(Boolean),
      contact_names: (payload.contacts ?? []).map((item) => item.full_name).filter(Boolean),
      fact_count: (payload.facts ?? []).length,
      restricted_fact_count: (payload.facts ?? []).filter((item) => item.sensitivity === "restricted").length,
      note_title: payload.note?.title ?? null,
      // The operator should see what is still unresolved before approving.
      missing_items: bundle.routing?.missing_items ?? [],
    });
    return;
  }

  // "Approve & send to CRM" — the reviewed write. This is the only path by which
  // an intake becomes CRM records, and it exists so that a person has read the
  // bundle first: the approver is the tailnet identity, recorded on the
  // submission, and Hermes commits on that approval rather than asking a second
  // time. Nothing here touches NowCerts.
  const crmSubmit = req.method === "POST" && url.pathname.match(/^\/api\/intakes\/([a-f0-9-]{36})\/crm$/);
  if (crmSubmit) {
    try {
      const bundle = await intakeStore.get(crmSubmit[1]);
      if (!bundle) {
        sendJson(res, 404, { status: "NOT_FOUND", message: "Intake bundle not found." });
        return;
      }
      // Re-sending is safe — the submission is idempotent on the intake id, so a
      // double-click adopts the existing row rather than filing a second intake.
      // Reported as a replay rather than pretended to be a fresh approval.
      if (bundle.crm?.status === "SUBMITTED") {
        sendJson(res, 200, { ...bundle.crm, already_submitted: true });
        return;
      }
      const approver = requestActor(req);
      const result = await submitToCrm(bundle, {
        client: hermesPreview,
        enabled: hermesCrmWrites,
        submittedBy: approver,
        approvedBy: approver,
      });
      bundle.crm = result;
      bundle.crm_write = result.status;
      await intakeStore.save(bundle);
      // A refused or unconfigured submission is not a server error — it is an
      // answer about configuration, and the operator needs to read it.
      sendJson(res, result.status === "SUBMITTED" ? 201 : 200, result);
    } catch (error) {
      sendJson(res, error.statusCode ?? 502, { status: "ERROR", message: error.message });
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

  const clientReportMatch = req.method === "GET" && url.pathname.match(/^\/api\/intakes\/([a-f0-9-]{36})\/client-report\.pdf$/);
  if (clientReportMatch) {
    try {
      const bundle = await intakeStore.get(clientReportMatch[1]);
      if (!bundle) {
        sendJson(res, 404, { status: "NOT_FOUND" });
        return;
      }
      const report = await generateIntakeReport(bundle, path.join(dataDir, "reports"), { audience: "client" });
      const filename = `${bundle.client.display_name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "client"}-insurance-review.pdf`;
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

  // Operator-triggered property lookup ("Get property details" button). Optional
  // and off the automatic path — an auto-only quote never calls this. Reads the
  // insured address off the saved bundle, asks ATTOM, and attaches a SUGGESTED
  // property_profile[] to the bundle so it flows into the risk report. Read-only;
  // no AMS write.
  const propertyMatch = req.method === "POST" && url.pathname.match(/^\/api\/intakes\/([a-f0-9-]{36})\/property$/);
  if (propertyMatch) {
    try {
      if (!attomClient) {
        sendJson(res, 503, { ok: false, status: "NOT_ENABLED", message: "Property lookup is not configured (ATTOM_API_KEY not set)." });
        return;
      }
      const bundle = await intakeStore.get(propertyMatch[1]);
      if (!bundle) {
        sendJson(res, 404, { ok: false, status: "NOT_FOUND", message: "Intake bundle not found." });
        return;
      }
      const result = await lookupPropertyProfile(bundle, attomClient, { floodClient, protectionClassClient, replacementCostClient });
      if (result.status === "NO_ADDRESS") {
        sendJson(res, 422, { ok: false, status: "NO_ADDRESS", message: "No property street address is on this intake to look up." });
        return;
      }
      // Persist the suggestion onto the bundle so the retained report includes it.
      bundle.property_profile = result.property_profile;
      await intakeStore.save(bundle);
      sendJson(res, 200, {
        ok: result.status === "OK",
        status: result.status,
        address: result.address,
        property_profile: result.property_profile,
        message: result.status === "OK"
          ? "Property details retrieved and attached to the report (suggested — confirm before relying on them)."
          : "No ATTOM property record matched this address.",
      });
    } catch (error) {
      sendJson(res, error.statusCode ?? 502, { ok: false, status: "LOOKUP_FAILED", message: error.message });
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
      // Remember the source intake so the guarded commit can attach its note.
      record.intake_id = String(intakeId);
      await store.save(record);
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

  // Connectivity dry-run for the Momentum write MCP: proves URL + token +
  // handshake work by listing tools. Read-only — nothing is written.
  if (req.method === "GET" && url.pathname === "/api/ams/check") {
    if (!momentumWriter) {
      sendJson(res, 503, { status: "NOT_ENABLED", live_writes: false, message: "Live AMS writes are not configured." });
      return;
    }
    try {
      const tools = await momentumWriter.listTools();
      // tools/list only proves connectivity; probe a real read tool to confirm
      // the key is actually accepted for NowCerts operations.
      let authOk = false;
      let authError = null;
      try {
        await momentumWriter.probeAuth();
        authOk = true;
      } catch (error) {
        authError = error.message;
      }
      sendJson(res, authOk ? 200 : 502, {
        status: authOk ? "CONNECTED" : "AUTH_FAILED",
        live_writes: true,
        auth_ok: authOk,
        tool_count: tools.length,
        has_insert_insured: tools.includes("insert_insured_prospect_tool"),
        ...(authError ? { auth_error: authError } : {}),
      });
    } catch (error) {
      sendJson(res, 502, { status: "UNAVAILABLE", live_writes: true, message: error.message });
    }
    return;
  }

  // "Send to AMS" — the guarded live write. Runs only on a reviewed + approved
  // proposal, and only when live writes are enabled; otherwise NOT_ENABLED.
  const proposalCommit = req.method === "POST" && url.pathname.match(/^\/api\/proposals\/([0-9a-f-]{36})\/commit$/);
  if (proposalCommit) {
    try {
      const record = await gateway.get(proposalCommit[1]);
      if (!record) {
        sendJson(res, 404, { ok: false, status: "NOT_FOUND", message: "Proposal not found." });
        return;
      }
      let override = false;
      try {
        const raw = await readBody(req, 8 * 1024);
        override = Boolean(JSON.parse(raw.toString("utf8") || "{}").override_duplicate);
      } catch {
        override = false;
      }
      const sourceBundle = record.intake_id ? await intakeStore.get(record.intake_id) : null;
      const intakeNote = sourceBundle?.synthesis?.payload?.note ?? null;
      const result = await commitApprovedInsured({
        record,
        store,
        writeClient: momentumWriter,
        readClient: nowcertsReader,
        override,
        intakeNote,
        hermesClient: hermesPreview,
      });
      // Stamp the NowCerts GUID onto the intake bundle so CRM writes key on it.
      if (result?.receipt?.insured_database_id && record.intake_id) {
        try {
          const bundle = await intakeStore.get(record.intake_id);
          if (bundle) {
            bundle.client = {
              ...(bundle.client ?? {}),
              nowcerts_insured_guid: result.receipt.insured_database_id,
              intended_operation: result.status === "ADOPTED" ? "update" : (bundle.client?.intended_operation ?? "create"),
            };
            await intakeStore.save(bundle);
          }
        } catch (error) {
          console.warn("failed to stamp NowCerts GUID on intake bundle", error?.message ?? error);
        }
      }
      const code = result.ok
        ? 200
        : result.status === "NOT_FOUND"
          ? 404
          : result.status === "NOT_ENABLED"
            ? 503
            : result.status === "DUPLICATE_REVIEW" || result.status === "ALREADY_COMMITTED"
              ? 409
              : 422;
      sendJson(res, code, result);
    } catch (error) {
      sendJson(res, error.statusCode ?? 500, { ok: false, status: "ERROR", message: error.message });
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
