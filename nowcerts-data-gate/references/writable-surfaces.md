# Writable surfaces

Use the current official NowCerts API catalog as the authority for API capability. The public API home reported version `2.1.5`, published `2026-07-15`, when this reference was prepared. Re-check it before relying on a contract because NowCerts states that endpoints are added frequently.

Official sources:

- API home and current collection link: `https://api.nowcerts.com/`
- API help catalog: `https://api.nowcerts.com/Help`

## Documented write families observed

The official catalog describes write operations for these families:

- insured/prospect and insured locations;
- policy/quote, partial policy updates, additional insureds, policy coverages, and policy files;
- drivers, vehicles and vehicle coverages, properties, equipment, group-health members, motor-truck cargo, and flood coverage;
- certificate holders, agency locations, agents, tasks/work groups, tags, notes/dispositions, claims, service requests, workflow checklists, pending cancellations, receipts/payments, custom fields/panels, files/folders, and data imports;
- rolodex records, rating data, opportunity tags, SMS/call logs, and selected operational records.

This is a routing aid, not permission to write. Open the exact endpoint documentation and capture its current request/response model in the proposal. Many `POST` paths under `Insured/*` and `Policy/*` are list/read operations.

## Contacts

The catalog's `POST api/Insured/InsuredContacts` is described as a list endpoint, not a contact write. Use a separately documented contact/principal write operation if its contract fits, or the live insured contact UI form. Do not send contact data to the list endpoint.

## Carriers and other shared master data

The catalog exposes `GET api/CarrierDetailList` for carrier details. No general carrier insert/update endpoint was identified in the official catalog when this reference was prepared. For carrier creation or editing:

1. Search `CarrierDetailList` and the UI to prevent duplicates, using normalized legal name and NAIC when available.
2. Use the authenticated carrier-management UI only if the user's account exposes a create/edit action.
3. Preview all master fields, including legal/display name, NAIC, active status, address, contact, producer/company codes, and parent/MGA relationships when present.
4. Explain agency-wide downstream scope and require a named confirmation.
5. Read the saved carrier back through the carrier detail view/list before reporting success.

Apply the same master-data treatment to MGAs, finance companies, agency locations, agents/CSRs, referral sources, and tag definitions.

## UI and imports

An authenticated UI form is a valid write surface only after inspecting the live form, confirming the user's permission, and recording the exact screen and required fields. A visible Save/Create action proves UI capability for that session; it does not prove an API endpoint exists.

Use data import only after verifying the exact import type, template version, required columns, duplicate behavior, and error-report format. Preview row counts and every validation error. After import, sample/read back all affected identifiers and reconcile successful, failed, and uncertain rows.
