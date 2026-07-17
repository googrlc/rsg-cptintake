---
name: nowcerts-data-gate
description: Safely create, update, import, archive, or deactivate any entity that the user's NowCerts/Momentum account exposes as writable, including insureds, prospects, contacts, policies, quotes, carriers, drivers, vehicles, properties, coverages, claims, tasks, notes, locations, certificate holders, receipts, tags, files, and custom fields. Enforce mandatory capability verification, search/match, normalization, validation, preview, explicit confirmation, write, and read-back. Use whenever the user asks to enter, import, correct, update, clean, or sync data into NowCerts, Momentum, or "NowSearch" when they mean the NowCerts system.
---

# NowCerts Data Gate

Treat NowCerts/Momentum as the system of record. Never write on the first request.

## Scope: all supported writable entities

Support every entity the deployed NowCerts account exposes through a documented API, an authenticated UI form, or a documented import type. This includes, but is not limited to:

- insureds, prospects, contacts/principals, locations, custom fields, and tags;
- policies, quotes, lines of business, coverages, additional insureds/interests, pending cancellations, and rating data;
- carriers, MGAs, finance companies, certificate holders, referral sources, and rolodex records;
- drivers, vehicles, properties/buildings, equipment, group-health members, and motor-truck/flood details;
- claims, tasks, notes, SMS/call logs, service requests, workflow checklists, opportunities, receipts, and files;
- agency locations, agents, CSRs, tags, and other account configuration that the user's permissions allow.

Read [writable-surfaces.md](references/writable-surfaces.md) before choosing a write path. Treat the list as examples, not a frozen allowlist. Re-check the current official API catalog or inspect the live UI because NowCerts adds endpoints and account permissions vary.

Do not confuse HTTP method with behavior: several NowCerts `POST` endpoints are read/list operations. Only classify a path as writable when its official description says insert, update, upload, apply, archive, remove, or equivalent, or when the live UI exposes a save action.

## Hard rules

- Separate every run into `PREVIEW` and `COMMIT` phases.
- Treat the user's original request as authorization to prepare a preview, not to write.
- Require a fresh, explicit confirmation after showing the final preview.
- Reject ambiguous matches, duplicate risks, missing required fields, unsupported fields, and unexplained destructive changes.
- Never invent identifiers, policy numbers, dates, carrier names, premiums, coverage values, or contact details.
- Never use an undocumented or guessed write endpoint.
- Never convert a read/list endpoint into an assumed write endpoint.
- Never expose credentials, tokens, or unnecessary PII in output or logs.
- For bulk work, preview the complete batch and require one confirmation that names the batch size. Stop the entire batch if any row is ambiguous unless the user explicitly approves partial processing.

## Phase 1: PREVIEW

1. **Identify the target.** Resolve the entity type and intended operation (`create`, `update`, `import`, `archive`, or `deactivate`). If “NowSearch” could mean a different system, clarify before any write.
2. **Verify capability.** Prove that the user's account exposes this exact operation through a documented API, live UI form, or documented import type. Record the source, version/observation date, exact path/form, supported operation, and read-back path in `write_contract`. For UI writes, inspect the current form and its required fields before building the preview. For API writes, use the current official NowCerts request model. For imports, verify the exact import type and template columns.
3. **Capture provenance.** Record where each proposed value came from (user message, attached document, trusted system, or existing NowCerts record).
4. **Search before create.** Use the existing `nowcerts-skill` lookup rules. Match by stable identifiers first, then policy number, then exact normalized identity. Never select a record from name alone when multiple candidates exist. Use entity-specific keys: NAIC/name for carriers, VIN for vehicles, driver license plus jurisdiction for drivers, address for properties, and stable NowCerts IDs whenever available.
5. **Classify the match.** Set exactly one status:
   - `EXACT`: one record matches stable identifiers and corroborating fields.
   - `LIKELY`: one strong candidate exists but needs the user to choose or confirm it.
   - `AMBIGUOUS`: multiple plausible candidates exist; stop and ask the user to choose.
   - `NONE`: no candidate exists; a create may be proposed.
6. **Normalize without changing meaning.** Trim whitespace, normalize phone/email casing and formatting, use ISO dates internally, preserve identifiers as strings, and distinguish blank from “remove this value.” Do not silently expand abbreviations or infer legal names.
7. **Validate deterministically.** Build a JSON proposal matching [proposal-schema.md](references/proposal-schema.md) and run:
   `python3 scripts/validate_proposal.py proposal.json`
8. **Compare updates.** Read the current record and show field-level `current → proposed` changes. Flag replacements, clears, active-status changes, premium changes, effective/expiration changes, and any field whose source conflicts with the current record.
9. **Escalate master-data changes.** For carriers, MGAs, finance companies, agency settings, agents, CSRs, tag definitions, and other shared reference data, show the likely downstream scope and require an exact confirmation that names the entity. Never merge or replace master records without a separate preview.
10. **Present the gate summary** using this compact structure:

   ```text
   NOWCERTS WRITE PREVIEW — NOT YET WRITTEN
   Operation: CREATE|UPDATE <entity>
   Target: <display name> (<stable identifier or NEW>)
   Match: EXACT|LIKELY|AMBIGUOUS|NONE — <reason>
   Changes: <field-by-field current → proposed list>
   Source: <provenance summary>
   Validation: PASS|FAIL — <issues/warnings>
   Duplicate risk: LOW|MEDIUM|HIGH — <reason>
   Write path: <documented API operation or named UI form>
   After-write check: <fields that will be read back>
   ```

11. If validation passes and the match is `EXACT` for update or `NONE` for create, ask: **“Confirm this NowCerts write?”** Do not perform the write in the same turn as the preview. For master data, ask the user to confirm the named record, for example: **“Confirm create carrier: Acme Insurance Company?”**

## Phase 2: COMMIT

Proceed only when the immediately preceding preview is unchanged and the user explicitly confirms it. If any data, target, or write path changes, regenerate the preview and reconfirm.

1. Re-read the target immediately before an update. Stop if relevant values changed since preview.
2. Write through a verified NowCerts-supported mechanism:
   - Prefer a documented API operation whose request and response contract has been confirmed.
   - Otherwise use the authenticated NowCerts UI and the exact named form shown in the preview.
   - If neither is available, stop and report that the proposal is ready but cannot safely be committed.
3. Submit once. On timeout or uncertain response, search/read back before retrying to avoid duplicates.
4. Read back the saved record using its returned or existing stable identifier.
5. Compare every intended field with the stored values. Never report success based only on a submit response or toast.
6. Return a receipt:

   ```text
   NOWCERTS WRITE RECEIPT
   Result: VERIFIED|PARTIAL|FAILED|UNKNOWN
   Record: <display name> (<stable identifier>)
   Written: <verified fields>
   Not written/mismatched: <fields or none>
   Verification: <read-back time and method>
   Next action: <none or exact remediation>
   ```

## Stop conditions

Stop without writing when credentials fail, the record match is not unique, the user has not confirmed the final preview, the write contract is undocumented, the page/API response is uncertain, validation fails, or read-back cannot identify the saved record. Preserve the proposal and explain the smallest next step needed.
