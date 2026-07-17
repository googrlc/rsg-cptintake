# Proposal contract

Create a UTF-8 JSON object with these fields before presenting a write preview:

```json
{
  "operation": "update",
  "entity_type": "insured",
  "target": {
    "database_id": "12345",
    "display_name": "Example LLC",
    "match_status": "EXACT",
    "match_reason": "databaseId and email match"
  },
  "changes": [
    {
      "field": "email",
      "current": "old@example.com",
      "proposed": "new@example.com",
      "source": "user-provided signed application",
      "clear": false
    }
  ],
  "duplicate_risk": "LOW",
  "write_contract": {
    "method": "ui",
    "path": "Insured > Edit > Contact Information",
    "contract_source": "live authenticated form inspection",
    "checked_at": "2026-07-17",
    "supports_operation": "update"
  },
  "read_back_path": "Insured detail > Contact Information",
  "read_back_fields": ["email"]
}
```

Rules:

- `operation`: `create`, `update`, `import`, `archive`, or `deactivate`.
- `entity_type`: any explicit NowCerts entity name exposed as writable to the user's account.
- `target.database_id`: required for update; omit or set `null` for create.
- `target.match_status`: `EXACT`, `LIKELY`, `AMBIGUOUS`, or `NONE`.
- Update requires `EXACT`; create requires `NONE`.
- `changes`: non-empty list of explicit fields. Every item needs a non-empty provenance `source`.
- `clear`: must be `true` when the proposed value is null or an empty string; otherwise it must be `false` or omitted.
- `duplicate_risk`: `LOW`, `MEDIUM`, or `HIGH`. Commit only at `LOW` unless the user resolves the risk and a new preview is produced.
- `write_contract.method`: `api`, `ui`, or `import`.
- `write_contract.path`: exact verified endpoint, named UI form, or import type. Placeholder values such as `TBD` fail validation.
- `write_contract.contract_source`: official current API documentation/collection or a live authenticated UI inspection.
- `write_contract.checked_at`: `YYYY-MM-DD` date the contract was verified.
- `write_contract.supports_operation`: must equal `operation`.
- `read_back_path`: exact endpoint or UI detail view used to verify persisted values.
- `read_back_fields`: include every changed field.

Keep identifiers and policy numbers as strings so leading zeros are preserved. Use `YYYY-MM-DD` for dates in the proposal while showing dates in a user-friendly format in the preview.

For master data (`carrier`, `mga`, `finance_company`, `agency_location`, `agent`, `csr`, `tag_definition`, and comparable shared configuration), include:

```json
"master_data": {
  "is_master": true,
  "downstream_scope": "Available on policy carrier selections agency-wide",
  "named_confirmation": "Confirm create carrier: Example Insurance Company"
}
```

For other entities, set `master_data.is_master` to `false` or omit `master_data`.
