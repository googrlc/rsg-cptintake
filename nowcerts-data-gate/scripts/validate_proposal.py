#!/usr/bin/env python3
"""Validate a NowCerts write proposal without making network calls."""

import json
import re
import sys
from pathlib import Path


ALLOWED_OPERATIONS = {"create", "update", "import", "archive", "deactivate"}
ALLOWED_MATCHES = {"EXACT", "LIKELY", "AMBIGUOUS", "NONE"}
ALLOWED_RISKS = {"LOW", "MEDIUM", "HIGH"}
ALLOWED_METHODS = {"api", "ui", "import"}
PLACEHOLDER_WRITE_PATHS = {"", "tbd", "unknown", "api", "ui", "nowcerts"}


def nonempty_string(value):
    return isinstance(value, str) and bool(value.strip())


def validate(data):
    errors = []
    warnings = []

    operation = data.get("operation")
    if operation not in ALLOWED_OPERATIONS:
        errors.append("operation must be create, update, import, archive, or deactivate")

    if not nonempty_string(data.get("entity_type")):
        errors.append("entity_type is required")

    target = data.get("target")
    if not isinstance(target, dict):
        errors.append("target must be an object")
        target = {}

    database_id = target.get("database_id")
    match_status = target.get("match_status")
    if match_status not in ALLOWED_MATCHES:
        errors.append("target.match_status is invalid")
    if not nonempty_string(target.get("display_name")):
        errors.append("target.display_name is required")
    if not nonempty_string(target.get("match_reason")):
        errors.append("target.match_reason is required")
    if operation in {"update", "archive", "deactivate"}:
        if not nonempty_string(database_id):
            errors.append(f"{operation} requires target.database_id as a string")
        if match_status != "EXACT":
            errors.append(f"{operation} requires an EXACT match")
    if operation in {"create", "import"}:
        if database_id not in (None, ""):
            errors.append(f"{operation} must not specify target.database_id")
        if match_status != "NONE":
            errors.append(f"{operation} requires match_status NONE")

    changes = data.get("changes")
    if not isinstance(changes, list) or not changes:
        errors.append("changes must be a non-empty list")
        changes = []

    changed_fields = []
    seen_fields = set()
    for index, change in enumerate(changes):
        prefix = f"changes[{index}]"
        if not isinstance(change, dict):
            errors.append(f"{prefix} must be an object")
            continue
        field = change.get("field")
        if not nonempty_string(field):
            errors.append(f"{prefix}.field is required")
        elif field in seen_fields:
            errors.append(f"{prefix}.field duplicates {field!r}")
        else:
            seen_fields.add(field)
            changed_fields.append(field)
        if not nonempty_string(change.get("source")):
            errors.append(f"{prefix}.source is required")
        proposed = change.get("proposed")
        is_clear = proposed is None or proposed == ""
        if is_clear and change.get("clear") is not True:
            errors.append(f"{prefix}.clear must be true for a blank proposed value")
        if not is_clear and change.get("clear") is True:
            errors.append(f"{prefix}.clear cannot be true for a non-blank value")
        if isinstance(proposed, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", proposed):
            year, month, day = map(int, proposed.split("-"))
            if not (1 <= month <= 12 and 1 <= day <= 31 and year >= 1900):
                errors.append(f"{prefix}.proposed is not a plausible ISO date")

    risk = data.get("duplicate_risk")
    if risk not in ALLOWED_RISKS:
        errors.append("duplicate_risk must be LOW, MEDIUM, or HIGH")
    elif risk != "LOW":
        errors.append("duplicate_risk must be LOW before commit")

    contract = data.get("write_contract")
    if not isinstance(contract, dict):
        errors.append("write_contract must be an object")
        contract = {}
    method = contract.get("method")
    if method not in ALLOWED_METHODS:
        errors.append("write_contract.method must be api, ui, or import")
    write_path = contract.get("path")
    if not nonempty_string(write_path) or write_path.strip().lower() in PLACEHOLDER_WRITE_PATHS:
        errors.append("write_contract.path must name a verified endpoint, exact UI form, or import type")
    if not nonempty_string(contract.get("contract_source")):
        errors.append("write_contract.contract_source is required")
    checked_at = contract.get("checked_at")
    if not nonempty_string(checked_at) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", checked_at):
        errors.append("write_contract.checked_at must be YYYY-MM-DD")
    if contract.get("supports_operation") != operation:
        errors.append("write_contract.supports_operation must equal operation")
    if not nonempty_string(data.get("read_back_path")):
        errors.append("read_back_path is required")

    master = data.get("master_data")
    if isinstance(master, dict) and master.get("is_master") is True:
        if not nonempty_string(master.get("downstream_scope")):
            errors.append("master_data.downstream_scope is required")
        if not nonempty_string(master.get("named_confirmation")):
            errors.append("master_data.named_confirmation is required")

    read_back = data.get("read_back_fields")
    if not isinstance(read_back, list) or not all(nonempty_string(v) for v in read_back):
        errors.append("read_back_fields must be a non-empty list of strings")
        read_back = []
    missing_read_back = sorted(set(changed_fields) - set(read_back))
    if missing_read_back:
        errors.append("read_back_fields missing: " + ", ".join(missing_read_back))

    if any(change.get("current") == change.get("proposed") for change in changes if isinstance(change, dict)):
        warnings.append("proposal contains at least one no-op change")

    return errors, warnings


def main():
    if len(sys.argv) != 2:
        print("Usage: validate_proposal.py PROPOSAL.json", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"FAIL: cannot read proposal: {exc}")
        return 2
    if not isinstance(data, dict):
        print("FAIL: proposal root must be an object")
        return 1
    errors, warnings = validate(data)
    for warning in warnings:
        print(f"WARNING: {warning}")
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        print(f"FAIL: {len(errors)} error(s)")
        return 1
    print("PASS: proposal is structurally safe to preview")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
