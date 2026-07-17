# NowCerts Write Gateway setup

This is the shadow-mode foundation for the shared Lamar/Gretchen intake gate. It collects multiple PDFs, pasted transcripts, notes, and manual facts for one client; retains the cited source bundle; and prepares the downstream risk-assessment, PDF, and NowCerts proposal stages without writing to NowCerts.

## Local run

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` if local overrides are needed.
3. Build and start: `npm start` (the UI is built automatically)
4. Health check: `curl http://localhost:8787/`
5. MCP endpoint: `http://localhost:8787/mcp`

The local operator page is available at `http://127.0.0.1:8787/app`. Browser CORS is disabled by default. Set `MCP_ALLOWED_ORIGIN` only for an explicitly trusted origin during local testing; wildcard CORS is not supported.

`GATEWAY_MODE=shadow` is mandatory. The server refuses to start in live mode.

## Single-write-door policy

All automated NowCerts/Momentum mutations must originate in this Intake Gate. Hermes is the guarded execution engine, not an independent approval or write surface. Slack, scheduled jobs, scripts, n8n, MCP, ChatGPT, and other tools may prepare data but may not bypass the gate. The only exception is a human logging directly into the AMS and making a manual change; the gate's mandatory pre-write reread protects that concurrent work.

## Current ChatGPT App tools

- `open_intake_workspace` renders the RSG Intake Gate UI.
- `register_intake_document` records ChatGPT PDF file metadata only; byte transfer and extraction remain intentionally disabled.
- `prepare_client_intake` creates and privately stores one cited multi-source bundle.
- `prepare_nowcerts_write` renders a cited field-by-field proposal.
- `get_nowcerts_proposal` reloads a proposal.
- `approve_nowcerts_write` records a shadow approval only.

The ChatGPT copy of the interface is preview-only. Final approval belongs on the private Tailscale operator page after the live Tailscale `whois` resolver replaces caller-supplied actor/approver fields.

## Production work still required

- Run the gateway on the private Tailscale host and publish `/app` through a Tailscale Serve URL. Do not enable Tailscale Funnel.
- Wire Tailscale LocalAPI `whois` and map Lamar's and Gretchen's tailnet identities to their roles. Never accept the `actor` or `approver` field as identity in production.
- If the ChatGPT App is retained, connect the MCP endpoint through OpenAI Secure MCP Tunnel because ChatGPT cannot directly route to a private tailnet URL. Keep that surface preview-only.
- Complete ChatGPT file transfer, malware scanning, OCR/model extraction, and citation validation.
- Connect the synthesis engine, RSG reference-table lookups, and full evidence-backed risk assessment.
- The retained PDF renderer and download route are built; the download remains locked until an assessment is marked complete.
- Replace the file store with the production audit database and encrypt sensitive proposal data.
- Implement exact NowCerts API/UI connectors entity by entity.
- Wire the existing target-snapshot concurrency check to a real pre-write NowCerts reread. Same-field changes must stop; unrelated changes must be preserved and re-previewed.
- Add connector-level idempotency keys, post-write read-back, and field comparison.
- Keep master-data, bulk, archive, and deactivate approval limited to Lamar.
- Run the anonymized shadow-mode evaluation set before enabling any live tool.

## Tailscale connection

On the always-on tailnet host, run the gateway on loopback and configure Tailscale Serve to proxy `localhost:8787`. Lamar and Gretchen then open the resulting private `https://<device>.<tailnet>.ts.net/app` URL. Follow [`docs/CHATGPT-APP-ARCHITECTURE.md`](docs/CHATGPT-APP-ARCHITECTURE.md).

## Active VPS deployment

The shadow gateway is deployed on `hermes-gretch` with `compose.vps.yml`:

- Private URL: `https://hermes-gretch.tail1cbc83.ts.net/app`
- Container: `rsg-intake-gate`, with Docker restart policy `unless-stopped`
- VPS loopback binding: `127.0.0.1:8790` (not an internet-facing port)
- Persistent data: `/var/lib/rsg-intake-gate`
- Application files: `/opt/rsg-intake-gate`
- Tailscale Serve: private HTTPS only; Funnel is not enabled

Operational checks:

```sh
docker inspect --format '{{.State.Status}} {{.State.Health.Status}} {{.HostConfig.RestartPolicy.Name}}' rsg-intake-gate
curl -fsS http://127.0.0.1:8790/
tailscale serve status
```

This deployment intentionally remains `GATEWAY_MODE=shadow`: it retains intake bundles and completed PDFs but cannot write to NowCerts until the live identity, synthesis, connector, concurrency reread, and post-write verification work is complete.
