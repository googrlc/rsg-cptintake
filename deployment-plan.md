# NowCerts Write Gateway — Historical Planning Notes

> **Superseded 2026-07-17:** This file preserves the Azure-to-Tailscale design history and is not the deployment authority. The current architecture uses **Tailscale only, with no Microsoft OAuth or application login**. The operator website is exposed through a private Tailscale Serve URL. ChatGPT access, if retained, uses OpenAI Secure MCP Tunnel for transport and remains preview-only; final approval occurs on the Tailscale page where device identity can be verified. See [`nowcerts-write-gateway/docs/CHATGPT-APP-ARCHITECTURE.md`](nowcerts-write-gateway/docs/CHATGPT-APP-ARCHITECTURE.md). Any conflicting Azure, public HTTPS, or Microsoft identity instruction below is historical.

> **Status:** Planning — offline document-intake layer under construction (Increment 1, shadow-only). Still blocked on Azure subscription, region, and Gretchen UPN confirmation before any deployment, live write, or production credential request.

Generated: 2026-07-17
Last updated: 2026-07-17 — added Increment 1 (offline PDF-to-proposal layer + failure-mode tests). See §11.

> **Note on plan locations.** Two identical copies of this plan exist: `deployment-plan.md` (repo root, tracked working copy) and `nowcerts-write-gateway/deployment-plan.md`. Per §9 the eventual source of truth is `.azure/deployment-plan.md`; `.azure/` currently holds no plan. Consolidate to one location before deployment approval.

---

## 1. Project Overview

**Goal:** Deploy the existing shadow-mode NowCerts MCP gateway as a private HTTPS ChatGPT app for Lamar and Gretchen, authenticated by Microsoft Entra ID. The app will accept insurance PDFs, extract a cited structured proposal, and route that proposal through the same duplicate checks, explicit approval, optimistic concurrency, least-privilege role enforcement, audit history, and post-write verification used for manually supplied data.

**Path:** Modernize Existing — the Node.js MCP gateway exists locally but has no Azure configuration.

**Specialized technology check:** No GitHub Copilot SDK, Azure Functions, cross-cloud migration, or other specialized routing marker detected.

---

## 2. Requirements

| Attribute | Value |
|-----------|-------|
| Classification | Production internal tool, introduced through shadow and controlled pilot stages |
| Scale | Small: two initial users, low request volume |
| Budget | Cost-optimized while retaining production identity, audit, and monitoring controls |
| Data | Insurance-client PII; exclude secrets and unnecessary PII from model/tool logs |
| Availability | Single US region initially; recovery from IaC and encrypted state backups |
| Subscription | Awaiting confirmation; Azure CLI is not installed and no subscription could be detected |
| Location | Proposed `eastus2`, pending user confirmation and service/quota validation |
| Access model | **Tailscale tailnet only — no login** (confirmed 2026-07-17). Microsoft Entra dropped. See §5 Access & Identity. |
| Identity for roles | Tailscale `whois` (Option A). No Microsoft UPN needed; Gretchen just needs a device on the tailnet. |

### Policy Constraints

Azure Policy assignments cannot be queried until a subscription is confirmed and Azure tooling or an Azure management connector is available. This plan is not ready for approval until policies are checked.

---

## 3. Components Detected

| Component | Type | Technology | Path |
|-----------|------|------------|------|
| Gateway | MCP/HTTP API | Node.js ESM, MCP TypeScript SDK, Zod | `nowcerts-write-gateway/src/` |
| Validation | Deterministic business rules | Node.js, strict schemas | `nowcerts-write-gateway/src/validator.js` |
| Role policy | Authorization policy | Node.js | `nowcerts-write-gateway/src/policy.js` |
| Proposal state | Local shadow store | Private JSON files and append-only audit JSONL | `nowcerts-write-gateway/src/store.js` |
| Tests | Safety and concurrency verification | Node test runner | `nowcerts-write-gateway/test/` |
| PDF intake | **Increment 1 (offline)** — file-signature/size/encryption/corruption checks, SHA-256 hashing, evidence-cited extraction model, entity schemas, duplicate search, proposal builder | Node.js ESM, Zod; extractor + NowCerts search behind stubbed interfaces | `nowcerts-write-gateway/src/documents/` |
| Live extractor | Planned — OpenAI Responses API file input and Structured Outputs (real key deferred) | Interface `Extractor` in `src/documents/extraction.js`; live impl not generated | Not generated until plan approval |

### Existing Infrastructure

| Item | Status |
|------|--------|
| `azure.yaml` | Not present |
| Azure IaC | Not present |
| Dockerfile | Not present |
| Entra app registrations | Not created |
| Azure CLI / Azure Developer CLI | Not installed locally |

---

## 4. Recipe Selection

**Selected:** Azure Developer CLI with Bicep (`azd` + Bicep)

**Rationale:** Azure-first, single service, repeatable environments, managed deployment flow, auditable infrastructure, and the default supported recipe for a new Azure configuration.

No `azd init -t` template will be run inside the existing workspace. Configuration will be added to the existing project.

---

## 5. Architecture

**Stack:** Containers

### Service Mapping

| Component | Azure Service | Planned Tier |
|-----------|---------------|--------------|
| MCP gateway | Azure Container Apps | Consumption, min 0 during shadow; consider min 1 for production latency |
| Container image | Azure Container Registry | Basic |
| PDF intake, proposal, and audit state | Azure Storage account | Standard LRS, private Blob/Table services, Entra-only application access |
| Secrets | Azure Key Vault | Standard; managed identity access only |
| Logs | Log Analytics workspace | Pay-as-you-go with limited retention |
| APM | Application Insights | Workspace-based |
| Service identity | User-assigned managed identity | Key Vault and Storage access; no stored Azure credentials |

### Access & Identity — Tailscale (supersedes Microsoft Entra)

> **Decision (2026-07-17, Lamar):** No login. The gateway URL is reachable **only over the RSG Tailscale tailnet**; network membership is the access boundary. Microsoft Entra, OAuth 2.1, JWT/JWKS validation, and the ChatGPT OAuth client are **dropped** — not deferred.

- The gateway binds to the Tailscale interface (or is fronted by `tailscale serve` for in-tailnet HTTPS). It is never exposed publicly; do not enable Tailscale Funnel.
- Access control = tailnet membership. Only Lamar's and Gretchen's enrolled devices can reach the endpoint; everyone else gets no route.
- **Role identity for the least-privilege split** (`Admin` = Lamar: master data, bulk, archive/deactivate, overrides; `Operator` = Gretchen: routine create/update):
  - **Chosen — Option A (confirmed 2026-07-17, Lamar):** derive the actor from Tailscale — resolve the request's source IP via the local Tailscale `whois`/`LocalAPI` and map the tailnet user to `lamar`/`gretchen`. Identity is established by device ownership, not a declared field. Implementation: a small `src/auth/tailscale-identity.js` resolver (interface + offline stub now; live `LocalAPI` call wired when the gateway runs on the tailnet). Production tool schemas drop the caller-supplied `actor`/`approver` and use the resolved identity.
  - Rejected — Option B (declared `actor`/`approver`): honor-system only; any tailnet caller could claim to be Lamar. Kept solely as the offline-test seam.
- Whichever option, `policy.js` remains the authority for what each role may approve; only the *source* of the identity changes.
- Keep device-level MFA / posture under Tailscale ACLs and the users' own device security.

### PDF-to-Proposal Design

1. Lamar or Gretchen uploads a PDF through the private authenticated app. The gateway accepts PDF only, verifies the file signature and size, assigns a document ID, and stores the original in a private short-retention Blob container.
2. The gateway sends the PDF to the OpenAI Responses API as an `input_file`. Use `gpt-5.6` with PDF `detail: high` for small print, schedules, tables, scanned pages, and dense insurance forms. PDF processing includes both extracted text and page images.
3. Structured Outputs must conform to a versioned Zod/JSON schema. The extraction result contains:
   - document type and candidate NowCerts entity/action;
   - normalized fields and values;
   - filename, page number, and a short supporting excerpt for every proposed value;
   - missing required fields, ambiguities, conflicts, warnings, and unreadable pages;
   - informational confidence, which is never sufficient by itself to authorize a write.
4. Deterministic validators check dates, state/ZIP formats, phone/email formats, policy identifiers, entity-specific required fields, and allowed enums. Values without direct page evidence, ambiguous handwriting, conflicting pages, or failed validation are marked `needs_review`; the system does not guess.
5. The extraction service cannot call a live NowCerts writer. It can only submit the cited result to `prepare_nowcerts_write`, which performs current-record lookup, duplicate detection, authorization, risk classification, and preview generation.
6. The user sees the source PDF beside a field-by-field proposal. Changed values, missing values, and conflicts are highlighted. Approval binds the exact normalized payload, evidence set, source document hash, actor identity, and observed NowCerts snapshot.
7. Immediately before commit, the gateway repeats duplicate/concurrency checks. After the write, it reads the record back and compares every intended field before reporting success.

Initial document classes: declaration pages, binders, ACORD applications, policy change forms, vehicle/driver/location/equipment schedules, loss runs, carrier documents, and contact/insured documents. Each class receives a separate extraction schema and evaluation set; unrecognized documents stop for classification rather than being forced into a generic payload.

### PDF Security and Retention

- Do not expose Blob URLs publicly; use narrowly scoped, short-lived upload/download access issued only after Entra authorization.
- Encrypt stored files with Azure Storage defaults and use managed identity for service access.
- Do not place raw PDF content, SSNs, driver's-license numbers, payment data, or full extracted payloads in application logs.
- Store a SHA-256 document hash for deduplication and approval binding.
- Make raw-document retention configurable; proposed default is 30 days after a verified write and 7 days for abandoned uploads, pending the agency's record-retention requirements.
- Reject encrypted, corrupt, non-PDF, oversized, or malware-flagged uploads. A malware scanning option must be selected during the Azure security review.

### Concurrency and Write Safety

- Re-search before create to detect records added after preview.
- Capture record ID, observed time, version/change token, and field snapshot.
- Re-read immediately before commit.
- Block same-field changes as conflicts.
- Preserve unrelated changes, regenerate the preview, and require confirmation again.
- Submit once with an idempotency record, then read back every intended field.
- Never report success from an HTTP response or UI toast alone.

### PDF Accuracy Test Gate

Before live enablement, test representative redacted documents across digitally generated, scanned, rotated, low-resolution, multi-policy, multi-page table, and handwritten/annotated cases. Include conflicting pages, missing required fields, corrupt/encrypted PDFs, duplicate clients, and a client record changed after the preview. Track field-level precision/recall by document class and require zero unreviewed writes from unsupported, ambiguous, or uncited fields. Thresholds will be approved from the evaluation results rather than inferred from model confidence.

### Rollout

1. Local shadow validation — complete.
2. Authenticated Azure shadow environment — no NowCerts live writer.
3. PDF extraction evaluation using representative redacted documents; extraction only, no writes.
4. Lamar-only pilot with anonymized/approved cases.
5. Entity-by-entity connector enablement and verification.
6. Gretchen operator access for approved low-risk entities.
7. Master data, bulk, archive, and deactivate remain Lamar-only.

---

## 6. Provisioning Limit Checklist

### Phase 1: Resource Inventory

| Resource Type | Number to Deploy |
|---------------|------------------|
| `Microsoft.App/managedEnvironments` | 1 |
| `Microsoft.App/containerApps` | 1 |
| `Microsoft.ContainerRegistry/registries` | 1 |
| `Microsoft.Storage/storageAccounts` | 1 |
| `Microsoft.KeyVault/vaults` | 1 |
| `Microsoft.OperationalInsights/workspaces` | 1 |
| `Microsoft.Insights/components` | 1 |
| `Microsoft.ManagedIdentity/userAssignedIdentities` | 1 |

### Phase 2: Quota and Capacity

Not started. Subscription and region must be confirmed first. Azure Policy, provider registration, current usage, limits, and regional service availability must then be queried through the Azure quota workflow one resource type at a time.

**Status:** Blocking — this plan must not be presented for deployment approval until actual values replace this section.

---

## 7. Execution Checklist

### Phase 1: Planning

- [x] Analyze workspace
- [x] Gather initial requirements and classify the workload
- [x] Scan codebase
- [x] Select deployment recipe
- [x] Plan architecture
- [x] ~~Confirm Gretchen's Microsoft UPN~~ — not needed; Tailscale access, no login
- [x] ~~Confirm Azure subscription / location / policy / quota~~ — Azure not required at this scale (Tailscale host); revisit only if going full managed Azure
- [ ] Confirm the tailnet host for the gateway (which always-on device)
- [ ] Choose whether the Intake app + gateway share one host on the tailnet
- [ ] User approves completed plan

### Phase 2: Execution

- [ ] Install/use approved Azure tooling
- [ ] Add Tailscale `whois` identity resolver (`src/auth/tailscale-identity.js`) and derive `actor`/`approver` from it *(Entra dropped; interface + offline stub, live LocalAPI wired on the tailnet host)*
- [ ] Replace local state with Azure Storage using optimistic concurrency *(deferred; offline temp store + fingerprint concurrency in place)*
- [~] Add private PDF upload, retention, hashing, and malware/file validation *(offline: signature/size/encryption/corruption checks, SHA-256, TTL temp store — malware scan + Azure Blob deferred)*
- [~] Add PDF classification and versioned cited extraction schemas *(offline classification + entity schemas + cited extraction model with `needs_review`; live extractor deferred)*
- [x] Route extraction output only through `prepare_nowcerts_write` *(proposal-builder routes solely through `gateway.prepare()`)*
- [~] Add field-evidence review UI and PDF evaluation suite *(evidence model + failure-mode test suite added; review UI deferred)*
- [ ] Add Dockerfile, `azure.yaml`, and Bicep
- [ ] Configure managed identity, Key Vault, Storage RBAC, logging, and health probes
- [~] Verify locally and in the authenticated shadow environment *(local shadow tests pass; authenticated environment deferred)*
- [ ] Set plan status to `Ready for Validation`

### Phase 3: Validation

- [ ] Invoke `azure-validate`
- [ ] Record validation proof
- [ ] Set status to `Validated`

### Phase 4: Deployment

- [ ] Invoke `azure-deploy`
- [ ] Verify HTTPS MCP endpoint and OAuth metadata
- [ ] Connect private ChatGPT app
- [ ] Keep live NowCerts writes disabled pending shadow evaluation approval

---

## 8. Validation Proof

No Azure validation has been run; the plan remains in Planning.

---

## 9. Files to Generate After Approval

| File | Purpose | Status |
|------|---------|--------|
| `.azure/deployment-plan.md` | Source of truth | Planning |
| `nowcerts-write-gateway/azure.yaml` | Azure Developer CLI configuration | Not generated |
| `nowcerts-write-gateway/infra/main.bicep` | Azure infrastructure | Not generated |
| `nowcerts-write-gateway/infra/main.parameters.json` | Environment parameters | Not generated |
| `nowcerts-write-gateway/Dockerfile` | Gateway container | Not generated |
| `nowcerts-write-gateway/src/auth/tailscale-identity.js` | Tailscale `whois` → `lamar`/`gretchen` role identity (Entra dropped) | **Built: interface + `StaticIdentityResolver` stub + `TailscaleIdentityResolver` (injectable whois). Live LocalAPI call + server wiring deferred to tailnet host.** |
| `nowcerts-write-gateway/src/documents/` | PDF intake, classification, extraction schemas, evidence, and retention | **Increment 1 generated (offline; live extractor deferred)** |
| `nowcerts-write-gateway/test/fixtures/documents/` | Synthetic PDF fixtures for failure-mode tests (scanned, rotated, incomplete, conflicting, duplicate, corrupt, concurrent-edit) | **Increment 1 generated (synthetic)**; redacted real samples still awaited |

---

## 10. Next Step

Review Increment 1 (§11) and its test suite. Provide representative redacted PDFs for the initial document classes, confirm Gretchen's exact Microsoft login, and confirm whether an Azure subscription already exists. Then install or connect approved Azure management tooling, confirm subscription/location, inspect policy and quota, finalize the PDF malware/retention choices, complete this plan, and request deployment approval. **No Azure resource, live NowCerts write, or production credential is requested until this plan and the tests are reviewed.**

---

## 11. Increment 1 — Offline Document-Intake Layer (shadow-only)

This increment extends the existing shadow gateway. It changes none of the existing safety controls (validation, fingerprint/stale detection, concurrency checks, role policy, append-only audit, hard-coded shadow-mode refusal). It adds only offline, credential-free modules and tests so the pipeline can be reviewed before any Azure, Entra, OpenAI, or NowCerts credential is introduced.

### What is built now (no credentials, runs offline)

| Module | File | Responsibility |
|--------|------|----------------|
| PDF intake | `src/documents/pdf-intake.js` | Reject non-PDF (magic bytes `%PDF-`), oversized, empty, truncated/corrupt, and encrypted PDFs; compute SHA-256; assign a document ID; count pages best-effort. Never logs raw bytes. |
| Temp storage | `src/documents/temp-store.js` | Private (`0700`/`0600`) short-retention scratch store for accepted uploads, keyed by document ID + hash, with configurable TTL and sweep. Purely local; the Azure Blob equivalent is deferred. |
| Entity schemas | `src/documents/entity-schemas.js` | Per-entity required/optional fields, formats (date, state, ZIP, phone, email, VIN, NAIC), and enums for insured, contact, policy, carrier, vehicle, driver, and location. |
| Extraction model | `src/documents/extraction.js` | Versioned, evidence-cited extraction shape. Every proposed field carries filename + page + excerpt. Missing/unreadable/ambiguous/conflicting/failed-format values become `needs_review` and are never emitted as proposed changes. Defines the `Extractor` interface; ships a deterministic offline stub, not a live model call. |
| Classification | `src/documents/classification.js` | Maps a document to a known class or stops with `NEEDS_CLASSIFICATION`; never forces an unknown document into a generic payload. |
| Duplicate search | `src/documents/duplicate-search.js` | `NowCertsSearch` interface + offline in-memory stub. Searches by entity-specific keys before proposing a create; classifies EXACT/LIKELY/AMBIGUOUS/NONE. Real MCP/API search deferred. |
| Proposal builder | `src/documents/proposal-builder.js` | Turns a cited extraction result + search result into the exact proposal contract and routes it through the existing `gateway.prepare()`. Stops (never guesses) when any field is `needs_review` or the match is not clean. |

### What is deferred (needs review / credentials / Azure)

- Real Entra JWT verification keys and tenant/audience config, and identity-derived `actor`/`approver` (interface boundary noted; not wired to a live JWKS this increment).
- Live OpenAI Responses API extractor implementation and API key.
- Live NowCerts search/read-back/write connector.
- Azure Blob temp storage, `Dockerfile`, `azure.yaml`, Bicep, managed identity, Key Vault.

### Invariants preserved

- `GATEWAY_MODE=shadow` still hard-fails any non-shadow start. No module can write to NowCerts.
- Extraction output can only reach `prepare_nowcerts_write`; it cannot call any writer.
- Any missing, unreadable, ambiguous, conflicting, or format-invalid value is quarantined as `needs_review` and blocks approval rather than being guessed.
- Filename + page + excerpt evidence is mandatory on every proposed field.

---

## 12. Increment 2 — New-Business Intake Layer (shadow-only)

Backs the "Intake" screen's **Parse intake →** action. The free-text "first initial assessment" is parsed/synthesized into structured, cited records; enrichment fills gaps *only with sourced values*; fields are routed **AMS-vs-PDF** ("what belongs in the AMS goes to the AMS; everything else lives on the PDF"); the primary insured is queued to NowCerts through the unchanged shadow gateway. Reuses Increment 1's never-guess reconcile.

| Module | File | Responsibility |
|--------|------|----------------|
| Intake schema | `src/intake/intake-schema.js` | Versioned parsed-intake contract; per-field citation (`intake_text` → `user_message`, `enrichment` → `trusted_system`). |
| Parser | `src/intake/parser.js` | `IntakeParser` interface + deterministic `StubIntakeParser`. Live LLM parser deferred. |
| Enricher | `src/intake/enricher.js` | `Enricher` interface + `NoopEnricher`/`StubEnricher`. Finds missing info but **never fabricates** — a value with no source citation is dropped, not emitted. Live lookups (SoS, carrier, address) deferred (need network + creds). |
| Intake builder | `src/intake/intake-builder.js` | Reconcile each record → route AMS fields to a NowCerts proposal via `gateway.prepare()`; keep non-AMS cited fields as `pdf_only`; assemble the full `pdf_record` for PDF generation. Search-before-create + duplicate block on the insured. |
| Shared reconcile | `src/documents/extraction.js` (`reconcileFields`) | Extracted from the PDF path; adds an `unknownDisposition: "pdf_only"` routing option so intake keeps non-AMS fields instead of quarantining them. |

**Tests (7):** clean intake queues an approvable insured with non-AMS fields on the PDF; AMS-vs-PDF routing; missing identity → needs information; duplicate insured blocked; ambiguous field → conflict; enrichment fills a gap only with a real citation; enricher never fabricates.

**Deferred downstream stages of the vision** (all need review / creds and are NOT built): generate the client-intake **PDF** from `pdf_record`; **archive** the PDF + attachments to Nextcloud/client folder; write the EspoCRM account/contacts/**opportunity**; live NowCerts insured write; capability reporting. These have interface seams (`pdf_generation`/`archive` markers on the intake result) but no implementation.

---

## 13. Hosting — Tailscale node (decided)

> **Decision (2026-07-17, Lamar):** No Azure, no login, no public endpoint. The gateway runs on **one always-on device on the RSG Tailscale tailnet**. The §5 Azure architecture is retained only as a "if we ever outgrow this" reference and is **not** the plan of record.

- **Host:** a single always-on machine on the tailnet (e.g. a Mac mini or a small VM). Node ≥ 20; run the gateway as a service.
- **Reachability:** bind to the Tailscale interface, or front with `tailscale serve` for in-tailnet HTTPS with a stable MagicDNS name. **Never** enable Tailscale Funnel — the endpoint stays private.
- **Access control:** tailnet membership (Tailscale ACLs). Only Lamar's and Gretchen's devices can route to it.
- **Identity:** Tailscale `whois` → `lamar`/`gretchen` (Option A, §5).
- **Storage/audit/secrets:** local encrypted file store + append-only audit (already built) + 1Password. No Key Vault/Blob/Table required.
- **Not required anymore:** Microsoft Entra, OAuth/JWT, ChatGPT OAuth client, Container Apps, ACR, Key Vault, Log Analytics, App Insights, managed identity, public HTTPS / Cloudflare Tunnel.
- **Open item:** confirm *which* device is the always-on host, and whether the Intake app front-end shares that host.
