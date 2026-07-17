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
  sourceKind: "pdf",
  draftTitle: "",
  draftContent: "",
  sources: [],
  bundle: null,
  outputTab: "overview",
  message: "Add every source for one client, then prepare the combined intake.",
};

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

function renderOutput() {
  const assessment = state.bundle?.assessment;
  if (state.outputTab === "ams") {
    return `<div class="output-block"><h3>AMS write preview</h3><p>Only fields supported by a verified NowCerts write contract appear here. Every field will show its current value, proposed value, and source citation before approval.</p><div class="blank-state">${state.bundle ? "Synthesis and NowCerts matching are not connected yet." : "Prepare the intake to begin routing fields."}</div></div>`;
  }
  if (state.outputTab === "risk") {
    return `<div class="output-block"><h3>Risk assessment</h3><p>Each business operation will be assessed separately. NAICS, SIC, GL, and WC codes must be found in the RSG reference tables—never guessed.</p>
      <div class="metric-grid">
        <div><span>Operations</span><strong>${assessment?.operations?.length ?? "—"}</strong></div>
        <div><span>NAICS</span><strong>${assessment?.naics?.length ?? "—"}</strong></div>
        <div><span>Red flags</span><strong>${assessment?.red_flags?.length ?? "—"}</strong></div>
        <div><span>Confidence</span><strong>${assessment?.confidence == null ? "—" : `${assessment.confidence}%`}</strong></div>
      </div><div class="blank-state">${assessment ? statusLabel(assessment.status) : "No assessment prepared yet."}</div></div>`;
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
    <header><div class="brand"><img src="${brandLogo}" alt="Risk Solutions Group"><div class="product-name"><h1>Client Intake Gate</h1><p>Evidence in · assessed, routed, and verified out</p></div></div><div class="mode"><i></i> SHADOW MODE</div></header>
    <section class="client-bar">
      <label>Client or prospect name<input id="client-name" value="${escapeHtml(state.clientName)}" placeholder="Example Contracting LLC"></label>
      <label>Existing NowCerts ID <span>optional</span><input id="client-id" value="${escapeHtml(state.existingClientId)}" placeholder="Leave blank for a new prospect"></label>
      <div class="privacy"><b>Private Tailscale workspace</b><span>Nothing writes without a reviewed proposal and confirmation.</span></div>
    </section>
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
    <footer><div><span class="pulse"></span><p>${escapeHtml(state.message)}</p></div><button disabled>Final approval occurs after the full preview</button></footer>
  </section>`;
  bindEvents();
}

function bindEvents() {
  document.querySelector("#client-name")?.addEventListener("input", (event) => { state.clientName = event.target.value; updatePrepareButton(); });
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
  state.message = "Combining source inventory and preparing the client pipeline…";
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
    state.outputTab = "overview";
    state.message = "Sources accepted and retained. Live synthesis, code lookup, and risk assessment are the next connector stage; nothing was written to NowCerts.";
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
