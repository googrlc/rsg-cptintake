# AGENTS.md

## Cursor Cloud specific instructions

This is a monorepo of three services around the NowCerts/Momentum AMS and the
Hermes CRM. The startup update script already installs dependencies; this section
covers only non-obvious run/test/build caveats. Standard commands live in each
service's README/SETUP; prefer those.

### Services overview

| Dir | Runtime | Port | Run (dev) | Test | Lint/check |
|---|---|---|---|---|---|
| `nowcerts-write-gateway` | Node ≥20 | 8787 | `GATEWAY_MODE=shadow npm start` | `npm test` (`node --test`, 235 tests) | `npm run check` (build UI + `node --check` + tests) |
| `nowcerts-read-connector` | Python 3.11+ | 8082 | `./.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8082` | none in-repo | — |
| `crm-intake-api` | Python 3.11+ | 8803 | `rsg-crm-intake-api` (see below — install is blocked) | `pytest` (needs shared core) | — |

### nowcerts-write-gateway (RSG Intake Gate) — primary product

- Fully runnable offline. `GATEWAY_MODE` must be `shadow` (or `pilot`); the code
  refuses to start in `live` mode. Live AMS writes stay off unless `LIVE_AMS_WRITES=on`
  plus Momentum + read-connector are all configured.
- The PDF risk-report renderer (`scripts/render-intake-report.py`) is spawned as a
  subprocess using `PYTHON_BIN` (default `python3`) and imports `reportlab`. The
  update script installs `reportlab` into the system `python3` so `npm test` and the
  `/api/intakes/:id/report.pdf` route work out of the box. If you point `PYTHON_BIN`
  at a venv, that venv must have `reportlab`. Without it, 2 tests in
  `test/intake-report.test.js` fail.
- Operator UI is at `/app`; health JSON at `/`; MCP JSON-RPC at `/mcp`. The `/mcp`
  endpoint is stateless — call it directly with header
  `Accept: application/json, text/event-stream`.
- Offline (no external services) the following work: the guarded write-gate via MCP
  (`prepare_nowcerts_write` → `approve_nowcerts_write` → `SHADOW_APPROVED`),
  document intake (`POST /api/intake/documents`), reference lookups
  (`/api/reference/search|validate`), and collecting an evidence bundle in the UI.
- The UI's "Prepare combined intake" button (`POST /api/intakes`) and `synthesis_ready`
  require the Hermes preview/synthesis service. Offline it returns
  `SYNTHESIS_NOT_CONFIGURED` — this is expected, not a bug.
- `tesseract`/`clamav` are optional: absent, driver's-license barcode decode still
  works (bundled WASM), image OCR degrades gracefully, and uploads are admitted
  unless `REQUIRE_MALWARE_SCAN=on`.

### nowcerts-read-connector (NowCerts MCP Bridge)

- Runs from a venv at `nowcerts-read-connector/.venv` (created by the update script).
- `/healthz` and MCP `initialize`/`tools/list` work with no credentials. The actual
  read tools (`list_insureds`, etc.) need `NOWCERTS_USERNAME` + `NOWCERTS_PASSWORD`
  (NowCerts SaaS, password grant); without them a tool call returns a fail-closed
  error. Optional `API_SERVER_KEY` gates `/mcp` behind a bearer token.

### crm-intake-api (CRM Intake Desk) — install currently blocked

- Depends on the **private** git package `rsg-hermes-core @
  git+https://github.com/googrlc/rsg-hermes-core@<sha>` (pinned in `pyproject.toml`).
  The default Cursor GitHub token cannot access that repo (`Repository not found`),
  so `pip install -e '.[dev]'` fails. This is why the update script does NOT install
  this service.
- To enable it: grant the Cursor GitHub app access to `googrlc/rsg-hermes-core` (or
  provide a token with access), then in `crm-intake-api/`:
  `python3 -m venv .venv && ./.venv/bin/pip install -e '.[dev]'`.
- Running end-to-end additionally needs Supabase (`SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`). `pytest` (101 tests) needs the shared core installed.
- A configured-but-empty auth token (e.g. `HERMES_API_TOKEN`, `HERMES_INTAKE_KEY`)
  intentionally throws at startup rather than degrading to anonymous.
