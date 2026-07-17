import { App } from "@modelcontextprotocol/ext-apps";

const root = document.querySelector("#app");
const brandLogo = "__RSG_LOGO_DATA_URL__";
const isStandalone = window.parent === window;
const sourceLabels = {
  pdf: "PDF",
  transcript: "Transcript",
  notes: "Notes",
  manual_facts: "Manual facts",
};
const state = {
  busy: false,
  connected: false,
  clientName: "",
  existingClientId: "",
  lookup: { status: "idle", query: "", matches: [], error: null, selected: null },
  sourceKind: "pdf",
  draftTitle: "",
  draftContent: "",
  sources: [],
  bundle: null,
  outputTab: "overview",
  proposal: null,
  proposalBusy: false,
  confirmInput: "",
  approvalResult: null,
  commitBusy: false,
  commitResult: null,
  message: "Add every source for one client, then prepare the combined intake.",
};
let lookupTimer = null;
let lookupRequest = 0;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sourceIcon(kind) {
  return { pdf: "PDF", transcript: "TX", notes: "NT", manual_facts: "MF" }[kind] ?? "•";
}

function statusLabel(value) {
  return String(value ?? "pending").replaceAll("_", " ");
}

function renderLookup() {
  const lookup = state.lookup;
  if (lookup.status === "idle") return `<div class="client-lookup idle">Type at least 2 characters to search live NowCerts.</div>`;
  if (lookup.status === "searching") return `<div class="client-lookup searching"><span></span>Searching live NowCerts for “${escapeHtml(lookup.query)}”…</div>`;
  if (lookup.status === "error") return `<div class="client-lookup error"><strong>NowCerts search unavailable.</strong> ${escapeHtml(lookup.error)}</div>`;
  if (lookup.status === "selected") return `<div class="client-lookup selected"><strong>Selected existing client:</strong> ${escapeHtml(lookup.selected.display_name)} <span>NowCerts ID ${escapeHtml(lookup.selected.database_id)}</span><button id="clear-client-match">Change</button></div>`;
  if (!lookup.matches.length) return `<div class="client-lookup no-match"><strong>No matching insured found.</strong> Check the spelling before treating this as a new prospect.</div>`;
  return `<div class="client-lookup results"><div><strong>${lookup.matches.length} possible match${lookup.matches.length === 1 ? "" : "es"} found.</strong> Select the correct client—name alone is never selected automatically.</div><div class="match-list">${lookup.matches.map((match, index) => `<button class="client-match" data-index="${index}"><strong>${escapeHtml(match.display_name)}</strong><span>${escapeHtml([match.email, match.phone, match.address].filter(Boolean).join(" · ") || "No contact details returned")}</span><small>NowCerts ID ${escapeHtml(match.database_id)}</small></button>`).join("")}</div></div>`;
}

function renderSourceComposer() {
  if (state.sourceKind === "pdf") {
    return `<button id="upload" class="drop" ${state.busy ? "disabled" : ""}>
      <span class="upload-icon">⇧</span>
      <strong>Add declaration pages or other PDFs</strong>
      <small>Choose one or several PDFs · 25 MB each</small>
    </button><input id="file" type="file" accept="application/pdf,.pdf" multiple hidden>`;
  }
  const labels = {
    transcript: ["Call or meeting transcript", "Paste the complete transcript, including timestamps when available."],
    notes: ["Apple Notes or working notes", "Paste the notes exactly as written. Facts will retain this source citation."],
    manual_facts: ["Additional client facts", "Add facts the client gave you that are not already in a document."],
  }[state.sourceKind];
  return `<div class="text-composer">
    <label>Source title<input id="source-title" value="${escapeHtml(state.draftTitle)}" placeholder="${escapeHtml(labels[0])}" maxlength="255"></label>
    <label>Source content<textarea id="source-content" placeholder="${escapeHtml(labels[1])}" maxlength="250000">${escapeHtml(state.draftContent)}</textarea></label>
    <div class="composer-foot"><span>${state.draftContent.length.toLocaleString()} characters</span><button id="add-text" class="secondary">Add to intake</button></div>
  </div>`;
}

function renderSources() {
  if (!state.sources.length) return `<div class="source-empty">No sources added yet.</div>`;
  return state.sources.map((source, index) => `<div class="source-item">
    <span class="source-icon ${source.kind}">${sourceIcon(source.kind)}</span>
    <div><strong>${escapeHtml(source.title)}</strong><small>${escapeHtml(source.kind === "pdf" ? `${source.page_count ?? "?"} pages · ${formatBytes(source.byte_size)}` : `${source.content.length.toLocaleString()} characters`)}</small></div>
    <button class="remove-source" data-index="${index}" aria-label="Remove ${escapeHtml(source.title)}">×</button>
  </div>`).join("");
}

function renderPipeline() {
  const pipeline = state.bundle?.pipeline ?? {};
  const steps = [
    ["synthesis", "Synthesize evidence", "Combine facts and preserve citations"],
    ["reference_code_lookup", "Validate NAICS and codes", "Use RSG reference tables only"],
    ["risk_assessment", "Complete risk assessment", "Operations, coverages, flags, missing items"],
    ["nowcerts_preview", "Build AMS proposal", "Only supported AMS fields move forward"],
    ["retained_pdf", "Create retained PDF", "Assessment-only facts remain in the report"],
  ];
  return `<div class="pipeline">${steps.map(([key, title, description], index) => {
    const value = pipeline[key] ?? (index === 0 && state.sources.length ? "WAITING" : "PENDING");
    return `<div class="pipeline-step"><b>${index + 1}</b><div><strong>${title}</strong><span>${description}</span></div><em class="stage ${value === "READY" ? "ready" : ""}">${statusLabel(value)}</em></div>`;
  }).join("")}</div>`;
}

function renderProposalSection() {
  // Standalone (ChatGPT-free) prepare/approve. In the embedded ChatGPT surface,
  // proposals stay on the private Tailscale page, so only render this there.
  if (!isStandalone) return "";
  if (!(state.bundle?.routing?.ams_fields ?? []).length) return "";
  const p = state.proposal;
  const approval = state.approvalResult;
  const changeRows = (record) =>
    (record?.proposal?.changes ?? [])
      .map((c) => `<div><span>${escapeHtml(c.field)}</span><strong>${escapeHtml(String(c.proposed))}</strong><small>${escapeHtml(c.source?.reference ?? "")}</small></div>`)
      .join("");
  if (!p) {
    return `<div class="proposal-block">
      <div class="proposal-head"><h4>NowCerts write proposal</h4><button id="prepare-proposal" class="secondary" ${state.proposalBusy ? "disabled" : ""}>${state.proposalBusy ? "Preparing…" : "Prepare insured create proposal"}</button></div>
      <p class="proposal-hint">Builds a cited, confirmation-gated <strong>create</strong> proposal for the primary insured, then records a shadow approval. Nothing is written to NowCerts.</p>
    </div>`;
  }
  if (!p.id) {
    return `<div class="proposal-block">
      <div class="proposal-head"><h4>NowCerts write proposal</h4><button id="reset-proposal" class="secondary">Start over</button></div>
      <div class="proposal-issues">${escapeHtml(p.message ?? p.status ?? "A proposal could not be prepared from this intake.")}</div>
    </div>`;
  }
  const approved = Boolean(approval?.receipt);
  const ready = p.status === "READY_FOR_APPROVAL" && !approved;
  return `<div class="proposal-block">
    <div class="proposal-head"><h4>NowCerts write proposal</h4><button id="reset-proposal" class="secondary">Start over</button></div>
    <div class="proposal-status ${ready ? "ready" : ""}">${statusLabel(approved ? approval.status : p.status)}</div>
    <div class="data-list">${changeRows(p)}</div>
    ${p.validation?.errors?.length ? `<div class="proposal-issues"><strong>Blocked:</strong> ${p.validation.errors.map(escapeHtml).join("; ")}</div>` : ""}
    ${p.proposal?.missing_fields?.length ? `<div class="proposal-issues"><strong>Needs information:</strong> missing ${p.proposal.missing_fields.map(escapeHtml).join(", ")}</div>` : ""}
    ${approved ? `<div class="proposal-approved"><strong>${statusLabel(approval.status)}</strong><span>${escapeHtml(approval.message)}</span></div>${renderSendToAms()}` : ""}
    ${ready ? `<div class="proposal-approve">
      <label>Type to confirm — <code>${escapeHtml(p.expected_confirmation)}</code><input id="confirm-input" value="${escapeHtml(state.confirmInput)}" placeholder="${escapeHtml(p.expected_confirmation)}" autocomplete="off"></label>
      <button id="approve-proposal" class="primary" ${state.proposalBusy || state.confirmInput.trim() !== p.expected_confirmation ? "disabled" : ""}>Approve (shadow)</button>
    </div>` : ""}
    ${approval && !approval.ok && !approved ? `<div class="proposal-issues">${escapeHtml(approval.message ?? approval.status)}</div>` : ""}
  </div>`;
}

function renderSendToAms() {
  const c = state.commitResult;
  if (c) {
    const tone = c.status === "VERIFIED" ? "verified" : c.status === "DUPLICATE_STOP" || c.status === "ALREADY_COMMITTED" ? "warn" : "error";
    const settled = c.status === "VERIFIED" || c.status === "ALREADY_COMMITTED";
    return `<div class="ams-send-result ${tone}">
      <strong>${statusLabel(c.status)}</strong>
      <span>${escapeHtml(c.message ?? "")}</span>
      ${c.receipt?.insured_database_id ? `<small>NowCerts insured ID ${escapeHtml(c.receipt.insured_database_id)}</small>` : ""}
    </div>${settled ? "" : `<button id="retry-commit" class="secondary" ${state.commitBusy ? "disabled" : ""}>${state.commitBusy ? "Sending…" : "Try send again"}</button>`}`;
  }
  return `<div class="ams-send">
    <p>Reviewed and approved. Sending writes the insured to NowCerts, re-checks for duplicates first, then reads the saved record back and verifies every field.</p>
    <button id="send-ams" class="primary danger" ${state.commitBusy ? "disabled" : ""}>${state.commitBusy ? "Sending to AMS…" : "Send to AMS →"}</button>
  </div>`;
}

function renderOutput() {
  const assessment = state.bundle?.assessment;
  if (state.outputTab === "ams") {
    const fields = state.bundle?.routing?.ams_fields ?? [];
    return `<div class="output-block"><h3>AMS candidate preview</h3><p>Hermes extracted these candidate fields. They remain locked until each destination is mapped to a verified NowCerts contract and the current record is reread.</p>
      ${fields.length ? `<div class="contract-summary"><strong>${fields.length} field contract${fields.length === 1 ? "" : "s"} lined up</strong><span>Exact write property + read-back property found. Executor certification is still required.</span></div><div class="data-list">${fields.map((item) => `<div><span>${escapeHtml(item.field)}</span><strong>${escapeHtml(item.value)}</strong><small>${escapeHtml(item.citation)} · ${escapeHtml(statusLabel(item.contract_status))}${item.contract ? ` · ${escapeHtml(item.contract.write_tool)}.${escapeHtml(item.contract.write_field)} → ${escapeHtml(item.contract.read_tool)}.${escapeHtml(item.contract.read_field)}` : ""}</small></div>`).join("")}</div>` : `<div class="blank-state">${state.bundle ? "No operation-specific field contracts line up yet; extracted facts remain in the PDF." : "Prepare the intake to begin routing fields."}</div>`}
      ${state.bundle?.approval ? `<div class="approval-lock"><strong>Live submission locked</strong><span>${escapeHtml(state.bundle.approval.reason)}</span></div>` : ""}${renderProposalSection()}</div>`;
  }
  if (state.outputTab === "risk") {
    return `<div class="output-block"><h3>Risk assessment</h3><p>Each business operation will be assessed separately. NAICS, SIC, GL, and WC codes must be found in the RSG reference tables—never guessed.</p>
      <div class="metric-grid">
        <div><span>Operations</span><strong>${assessment?.operations?.length ?? "—"}</strong></div>
        <div><span>NAICS</span><strong>${assessment?.naics?.length ?? "—"}</strong></div>
        <div><span>Red flags</span><strong>${assessment?.red_flags?.length ?? "—"}</strong></div>
        <div><span>Confidence</span><strong>${assessment?.confidence == null ? "—" : `${assessment.confidence}%`}</strong></div>
      </div>${assessment ? `<div class="assessment-summary">${escapeHtml(assessment.summary)}</div>
        <div class="risk-columns"><div><h4>Coverage needs</h4>${(assessment.coverage_requirements ?? []).map((item) => `<span>${escapeHtml(item)}</span>`).join("") || "<span>None extracted</span>"}</div><div><h4>Red flags</h4>${(assessment.red_flags ?? []).map((item) => `<span>${escapeHtml(item)}</span>`).join("") || "<span>None extracted</span>"}</div><div><h4>Missing / verify</h4>${(assessment.missing_items ?? []).map((item) => `<span>${escapeHtml(item)}</span>`).join("") || "<span>None identified</span>"}</div></div>` : `<div class="blank-state">No assessment prepared yet.</div>`}</div>`;
  }
  if (state.outputTab === "report") {
    const ready = state.bundle?.assessment?.status === "COMPLETE" && state.bundle?.report_url;
    return `<div class="output-block report-block"><h3>Retained client PDF</h3><p>The final downloadable report will contain the source inventory, underwriting summary, evidence map, validated classifications, coverage requirements, red flags, missing items, AMS routing, and all assessment-only facts.</p>
      <div class="report-card"><div class="report-page"><span>RSG</span><strong>${escapeHtml(state.clientName || "Client risk assessment")}</strong><small>Evidence-backed intake report</small></div><div><strong>${ready ? "Report ready" : "Waiting for completed assessment"}</strong><span>PDF · retained with the client intake</span></div></div>
      ${ready ? `<a class="download" href="${escapeHtml(state.bundle.report_url)}" download>Download completed PDF</a>` : `<button class="download" disabled>Download completed PDF</button>`}
    </div>`;
  }
  return `<div class="output-block"><div class="overview-head"><div><h3>Combined intake</h3><p>One evidence bundle for this client, separated into AMS and assessment-only destinations.</p></div><span class="bundle-status">${statusLabel(state.bundle?.status ?? "not prepared")}</span></div>${renderPipeline()}</div>`;
}

function render() {
  const prepared = Boolean(state.bundle);
  root.innerHTML = `<section class="shell">
    <header><div class="brand"><img src="${brandLogo}" alt="Risk Solutions Group"><div class="product-name"><h1>Client Intake Gate</h1><p>Evidence in · assessed, routed, and verified out</p></div></div><div class="mode"><i></i> LIVE DATA PILOT · WRITES LOCKED</div></header>
    <section class="client-bar">
      <label>Client or prospect name<input id="client-name" value="${escapeHtml(state.clientName)}" placeholder="Example Contracting LLC"></label>
      <label>Existing NowCerts ID <span>optional</span><input id="client-id" value="${escapeHtml(state.existingClientId)}" placeholder="Leave blank for a new prospect"></label>
      <div class="privacy"><b>Private Tailscale workspace</b><span>Nothing writes without a reviewed proposal and confirmation.</span></div>
    </section>
    ${renderLookup()}
    <div class="workspace">
      <aside class="sources-panel">
        <div class="section-heading"><div><span class="eyebrow">1 · COLLECT</span><h2>Add client evidence</h2></div><span class="count">${state.sources.length}</span></div>
        <div class="source-tabs">${Object.entries(sourceLabels).map(([kind, label]) => `<button class="source-tab ${state.sourceKind === kind ? "active" : ""}" data-kind="${kind}">${label}</button>`).join("")}</div>
        ${renderSourceComposer()}
        <div class="source-list"><div class="list-title"><strong>Evidence bundle</strong><span>${state.sources.length} source${state.sources.length === 1 ? "" : "s"}</span></div>${renderSources()}</div>
        <button id="prepare" class="primary" ${state.busy || !state.sources.length || !state.clientName.trim() ? "disabled" : ""}>${state.busy ? "Preparing…" : prepared ? "Rebuild combined intake" : "Prepare combined intake"}</button>
      </aside>
      <main class="results-panel">
        <div class="section-heading"><div><span class="eyebrow">2 · SYNTHESIZE & ROUTE</span><h2>Client assessment workspace</h2></div><span class="safe">No AMS write</span></div>
        <nav class="output-tabs" aria-label="Intake outputs">${[
          ["overview", "Workflow"], ["ams", "AMS data"], ["risk", "Risk assessment"], ["report", "PDF report"],
        ].map(([key, label]) => `<button class="output-tab ${state.outputTab === key ? "active" : ""}" data-output="${key}">${label}</button>`).join("")}</nav>
        ${renderOutput()}
        <div class="routing-note"><div><b>AMS destination</b><span>Verified client, contact, policy, vehicle, driver, location, and supported fields</span></div><div><b>Retained PDF</b><span>Operations narrative, assessment detail, evidence map, research, flags, and unsupported fields</span></div></div>
      </main>
    </div>
    <footer><div><span class="pulse"></span><p>${escapeHtml(state.message)}</p></div><button disabled>${state.bundle?.approval?.status === "LOCKED" ? "Live AMS submission locked pending certification" : "Final approval occurs after the full preview"}</button></footer>
  </section>`;
  bindEvents();
}

function bindEvents() {
  document.querySelector("#client-name")?.addEventListener("input", (event) => {
    state.clientName = event.target.value;
    state.existingClientId = "";
    state.lookup.selected = null;
    updatePrepareButton();
    scheduleClientLookup();
  });
  document.querySelector("#client-name")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); runClientLookup(); }
  });
  document.querySelector("#client-id")?.addEventListener("input", (event) => { state.existingClientId = event.target.value; });
  document.querySelectorAll(".source-tab").forEach((button) => button.addEventListener("click", () => { state.sourceKind = button.dataset.kind; state.draftTitle = ""; state.draftContent = ""; render(); }));
  document.querySelectorAll(".output-tab").forEach((button) => button.addEventListener("click", () => { state.outputTab = button.dataset.output; render(); }));
  document.querySelector("#upload")?.addEventListener("click", choosePdfs);
  document.querySelector("#file")?.addEventListener("change", (event) => uploadPdfs([...event.target.files]));
  document.querySelector("#source-title")?.addEventListener("input", (event) => { state.draftTitle = event.target.value; });
  document.querySelector("#source-content")?.addEventListener("input", (event) => { state.draftContent = event.target.value; });
  document.querySelector("#add-text")?.addEventListener("click", addTextSource);
  document.querySelectorAll(".remove-source").forEach((button) => button.addEventListener("click", () => { state.sources.splice(Number(button.dataset.index), 1); state.bundle = null; render(); }));
  document.querySelector("#prepare")?.addEventListener("click", prepareIntake);
  document.querySelectorAll(".client-match").forEach((button) => button.addEventListener("click", () => selectClientMatch(Number(button.dataset.index))));
  document.querySelector("#clear-client-match")?.addEventListener("click", clearClientMatch);
  document.querySelector("#prepare-proposal")?.addEventListener("click", prepareProposal);
  document.querySelector("#approve-proposal")?.addEventListener("click", approveProposal);
  document.querySelector("#reset-proposal")?.addEventListener("click", () => {
    state.proposal = null;
    state.approvalResult = null;
    state.confirmInput = "";
    state.commitResult = null;
    state.commitBusy = false;
    render();
  });
  document.querySelector("#confirm-input")?.addEventListener("input", (event) => {
    state.confirmInput = event.target.value;
    const button = document.querySelector("#approve-proposal");
    if (button) button.disabled = state.proposalBusy || state.confirmInput.trim() !== (state.proposal?.expected_confirmation ?? " ");
  });
  document.querySelector("#send-ams")?.addEventListener("click", sendToAms);
  document.querySelector("#retry-commit")?.addEventListener("click", sendToAms);
}

async function sendToAms() {
  if (!state.proposal?.id) return;
  state.commitBusy = true;
  render();
  try {
    const response = await fetch(`/api/proposals/${state.proposal.id}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const result = await response.json();
    state.commitResult = result;
    state.message = result.ok
      ? `Written to NowCerts and verified (insured ${result.receipt?.insured_database_id}).`
      : `Send stopped (${statusLabel(result.status)}): ${result.message ?? ""}`;
  } catch (error) {
    state.message = `Send failed: ${error.message}`;
  } finally {
    state.commitBusy = false;
    render();
  }
}

async function prepareProposal() {
  if (!state.bundle?.intake_id) return;
  state.proposalBusy = true;
  state.approvalResult = null;
  render();
  try {
    const response = await fetch("/api/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intake_id: state.bundle.intake_id }),
    });
    const result = await response.json();
    state.proposal = result;
    state.confirmInput = "";
    state.commitResult = null;
    state.message = result.id
      ? `Proposal ${statusLabel(result.status)}. Review each field, then type the confirmation to shadow-approve.`
      : `No proposal prepared: ${result.message ?? result.status}`;
  } catch (error) {
    state.message = `Proposal request failed: ${error.message}`;
  } finally {
    state.proposalBusy = false;
    render();
  }
}

async function approveProposal() {
  if (!state.proposal?.id) return;
  state.proposalBusy = true;
  render();
  try {
    const response = await fetch(`/api/proposals/${state.proposal.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: state.confirmInput.trim() }),
    });
    const result = await response.json();
    state.approvalResult = result;
    state.message = result.ok
      ? "Shadow-approved. Nothing was written to NowCerts."
      : `Approval blocked: ${result.message ?? result.status}`;
  } catch (error) {
    state.message = `Approval request failed: ${error.message}`;
  } finally {
    state.proposalBusy = false;
    render();
  }
}

function scheduleClientLookup() {
  if (lookupTimer) clearTimeout(lookupTimer);
  const query = state.clientName.trim();
  if (query.length < 2) {
    state.lookup = { status: "idle", query, matches: [], error: null, selected: null };
    return;
  }
  lookupTimer = setTimeout(runClientLookup, 650);
}

async function runClientLookup() {
  if (!isStandalone) return;
  if (lookupTimer) clearTimeout(lookupTimer);
  const query = state.clientName.trim();
  if (query.length < 2) return;
  const request = ++lookupRequest;
  state.lookup = { status: "searching", query, matches: [], error: null, selected: null };
  render();
  try {
    const response = await fetch(`/api/nowcerts/insureds/search?q=${encodeURIComponent(query)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || result.status || "Search failed.");
    if (request !== lookupRequest || query !== state.clientName.trim()) return;
    state.lookup = { status: "results", query, matches: result.matches ?? [], error: null, selected: null };
  } catch (error) {
    if (request !== lookupRequest) return;
    state.lookup = { status: "error", query, matches: [], error: error.message, selected: null };
  }
  render();
}

function selectClientMatch(index) {
  const match = state.lookup.matches[index];
  if (!match) return;
  state.clientName = match.display_name;
  state.existingClientId = match.database_id;
  state.lookup = { status: "selected", query: match.display_name, matches: [], error: null, selected: match };
  state.message = `Existing NowCerts client selected: ${match.display_name}. No data has been changed.`;
  render();
}

function clearClientMatch() {
  state.existingClientId = "";
  state.lookup = { status: "idle", query: state.clientName, matches: [], error: null, selected: null };
  render();
  scheduleClientLookup();
}

function updatePrepareButton() {
  const button = document.querySelector("#prepare");
  if (button) button.disabled = state.busy || !state.sources.length || !state.clientName.trim();
}

function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function addTextSource() {
  const title = state.draftTitle.trim() || sourceLabels[state.sourceKind];
  const content = state.draftContent.trim();
  if (!content) {
    state.message = "Paste the transcript or notes before adding the source.";
    render();
    return;
  }
  state.sources.push({ kind: state.sourceKind, title, content, captured_at: new Date().toISOString() });
  state.bundle = null;
  state.draftTitle = "";
  state.draftContent = "";
  state.message = `${sourceLabels[state.sourceKind]} added to this client's evidence bundle.`;
  render();
}

async function choosePdfs() {
  if (!isStandalone) {
    state.message = "Open the private Tailscale page to transfer PDF bytes. ChatGPT can still prepare text-only intake previews.";
    render();
    return;
  }
  document.querySelector("#file")?.click();
}

async function uploadPdfs(files) {
  if (!files.length) return;
  state.busy = true;
  state.message = `Inspecting ${files.length} PDF${files.length === 1 ? "" : "s"}…`;
  render();
  try {
    for (const file of files) {
      if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) throw new Error(`${file.name} is not a PDF.`);
      const response = await fetch("/api/intake/documents", {
        method: "POST",
        headers: { "content-type": "application/pdf", "x-file-name": encodeURIComponent(file.name) },
        body: file,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(`${file.name}: ${result.message}`);
      state.sources.push({
        kind: "pdf",
        document_id: result.document.document_id,
        title: result.document.filename,
        filename: result.document.filename,
        byte_size: result.document.byte_size,
        sha256: result.document.sha256,
        page_count: result.document.page_count,
        captured_at: result.document.accepted_at,
      });
    }
    state.bundle = null;
    state.message = `${files.length} PDF${files.length === 1 ? "" : "s"} added. Add transcripts or notes, then prepare the intake.`;
  } catch (error) {
    state.message = `PDF intake stopped: ${error.message}`;
  } finally {
    state.busy = false;
    render();
  }
}

async function prepareIntake() {
  state.busy = true;
  state.message = "Extracting PDFs, synthesizing evidence, enriching the business, and building the review package…";
  render();
  const input = {
    client_name: state.clientName.trim(),
    existing_client_id: state.existingClientId.trim() || null,
    sources: state.sources,
  };
  try {
    let result;
    if (isStandalone) {
      const response = await fetch("/api/intakes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      result = await response.json();
      if (!response.ok) throw new Error(result.message);
    } else if (app) {
      result = await app.callServerTool({ name: "prepare_client_intake", arguments: input });
      result = result.structuredContent ?? result;
    } else throw new Error("The intake service is not connected.");
    state.bundle = result;
    state.proposal = null;
    state.approvalResult = null;
    state.confirmInput = "";
    state.commitResult = null;
    state.commitBusy = false;
    state.outputTab = "overview";
    const gaps = result.assessment?.missing_items?.length ?? 0;
    state.message = `Intake synthesized and retained${gaps ? ` with ${gaps} item${gaps === 1 ? "" : "s"} to verify` : ""}. The PDF is ready; nothing was written to NowCerts.`;
  } catch (error) {
    state.message = `The combined intake could not be prepared: ${error.message}`;
  } finally {
    state.busy = false;
    render();
  }
}

let app = null;
render();
async function connectChatGptApp() {
  if (isStandalone) return;
  try {
    app = new App({ name: "RSG Client Intake Gate", version: "0.3.0" });
    app.ontoolresult = (result) => {
      const value = result?.structuredContent ?? result;
      if (value?.intake_id) { state.bundle = value; state.message = "Combined intake loaded. No data has been written to NowCerts."; render(); }
    };
    await app.connect();
    state.connected = true;
    state.message = "ChatGPT preview connected. Final approval stays on the private Tailscale page.";
    render();
  } catch {
    app = null;
    state.message = "ChatGPT preview could not connect. Use the private Tailscale page for the full intake.";
    render();
  }
}

connectChatGptApp();
