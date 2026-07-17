# NowCerts Write Gateway setup

This is the local shadow-mode foundation for the private Lamar/Gretchen ChatGPT app. It validates, stores, previews, and approves proposals without writing to NowCerts.

## Local run

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` if local overrides are needed.
3. Start: `npm start`
4. Health check: `curl http://localhost:8787/`
5. MCP endpoint: `http://localhost:8787/mcp`

`GATEWAY_MODE=shadow` is mandatory. The server refuses to start in live mode.

## Production work still required

- Deploy behind HTTPS.
- Add OAuth 2.1 with an established identity provider and map verified identities to Lamar/Gretchen roles. Never accept the `actor` or `approver` field as identity in production.
- Replace the file store with the production audit database and encrypt sensitive proposal data.
- Implement exact NowCerts API/UI connectors entity by entity.
- Wire the existing target-snapshot concurrency check to a real pre-write NowCerts reread. Same-field changes must stop; unrelated changes must be preserved and re-previewed.
- Add connector-level idempotency keys, post-write read-back, and field comparison.
- Keep master-data, bulk, archive, and deactivate approval limited to Lamar.
- Run the anonymized shadow-mode evaluation set before enabling any live tool.

## ChatGPT connection after deployment

Deploy the MCP server to a reachable HTTPS URL, enable ChatGPT developer mode, create a private developer-mode app, and enter the deployed URL ending in `/mcp`. Refresh the app whenever tool metadata changes.
