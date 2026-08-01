"""intake_submissions table reader/writer + state transitions.

Phase 2: accept submission, idempotency-check on ``idempotency_key``, insert
with ``status='received'``.

Phase 3: state-machine helper. Every status change goes through
``transition()`` — it updates the ``status`` column AND appends to
``status_history``. On error, it also appends to ``error_log``. No direct
status writes anywhere else in the pipeline.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from hermes_integrations.supabase_client import SupabaseClient, SupabaseClientError

log = logging.getLogger(__name__)

TABLE = "intake_submissions"

_UNIQUE_VIOLATION_HINTS = ("23505", "duplicate key", "idempotency_key")


# State machine — mirrors PROJECT-CONTEXT.md and the DB CHECK constraint.
# Forward transitions are linear; ``failed`` is reachable from anywhere.
VALID_STATUSES: tuple[str, ...] = (
    "received",
    "synthesizing",
    "synthesized",
    "drafting",
    "awaiting_approval",
    "approved",
    "writing",
    "written",
    "complete",
    "failed",
)

_FORWARD: dict[str, set[str]] = {
    "received": {"synthesizing", "failed"},
    "synthesizing": {"synthesized", "failed"},
    "synthesized": {"drafting", "failed"},
    "drafting": {"awaiting_approval", "failed"},
    "awaiting_approval": {"approved", "failed"},
    "approved": {"writing", "failed"},
    "writing": {"written", "failed"},
    "written": {"complete", "failed"},
    "complete": set(),
    "failed": set(),
}

TERMINAL_STATUSES = frozenset({"complete", "failed"})


class IntakeError(Exception):
    """Raised when an intake submission cannot be persisted or transitioned."""


def _is_unique_violation(exc: SupabaseClientError) -> bool:
    text = str(exc).lower()
    return any(hint in text for hint in _UNIQUE_VIOLATION_HINTS)


def _isoformat(value: datetime) -> str:
    if value.tzinfo is None:
        raise IntakeError("captured_at must include a timezone offset")
    return value.isoformat()


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def fetch_by_idempotency_key(supa: SupabaseClient, idempotency_key: str) -> dict[str, Any] | None:
    rows = supa.select(
        TABLE,
        params={"idempotency_key": f"eq.{idempotency_key}"},
        limit=1,
    )
    return rows[0] if rows else None


def insert_submission(
    supa: SupabaseClient,
    *,
    idempotency_key: str,
    source: str,
    agent: str,
    intake_kind: str,
    client_identifier: str | None,
    lob_code: str | None,
    captured_at: datetime,
    payload: dict[str, Any],
) -> tuple[dict[str, Any], bool]:
    """Insert one submission row. Returns (row, is_new).

    ``is_new`` is False when an existing row with the same idempotency_key
    is returned instead of a fresh insert.
    """
    row_payload = {
        "idempotency_key": idempotency_key,
        "source": source,
        "agent": agent,
        "intake_kind": intake_kind,
        "client_identifier": client_identifier,
        "lob_code": lob_code,
        "captured_at": _isoformat(captured_at),
        "payload": payload,
    }
    try:
        row = supa.insert(TABLE, row_payload)
        return row, True
    except SupabaseClientError as exc:
        if not _is_unique_violation(exc):
            raise
        existing = fetch_by_idempotency_key(supa, idempotency_key)
        if existing is None:
            # Unique-violation but no row found — surface the original error.
            raise IntakeError(
                "idempotency_key conflict but no existing row could be located"
            ) from exc
        return existing, False


def fetch_by_id(supa: SupabaseClient, submission_id: str) -> dict[str, Any] | None:
    rows = supa.select(TABLE, params={"id": f"eq.{submission_id}"}, limit=1)
    return rows[0] if rows else None


def _assert_transition_allowed(from_status: str, to_status: str) -> None:
    if to_status not in VALID_STATUSES:
        raise IntakeError(f"unknown status {to_status!r}")
    if to_status == "failed":
        return  # failed is reachable from anywhere
    allowed = _FORWARD.get(from_status, set())
    if to_status not in allowed:
        raise IntakeError(
            f"invalid transition {from_status!r} -> {to_status!r} "
            f"(allowed from {from_status!r}: {sorted(allowed) or 'none — terminal'})"
        )


def transition(
    supa: SupabaseClient,
    submission_id: str,
    new_status: str,
    *,
    note: str | None = None,
    error: dict[str, Any] | str | None = None,
    extra_fields: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Move a submission to ``new_status``. The single allowed path for any
    status change on intake_submissions.

    Appends ``{status, at, note}`` to ``status_history``. On ``error`` (or
    when transitioning to ``failed``), also appends to ``error_log``.

    Sets ``completed_at`` automatically when transitioning to ``complete``.

    ``extra_fields`` lets callers piggyback non-status updates atomically
    (e.g. ``hermes_blocks``, ``draft_summary``, ``approved_by``,
    ``approved_at``, ``records_created``). Any key listed in
    ``_PROTECTED_FIELDS`` is rejected to keep the helper authoritative.
    """
    row = fetch_by_id(supa, submission_id)
    if row is None:
        raise IntakeError(f"submission {submission_id} not found")

    current = row.get("status") or ""
    if current == new_status:
        log.info("transition no-op: submission %s already %s", submission_id, new_status)
        return row

    _assert_transition_allowed(current, new_status)

    now_iso = _utcnow_iso()
    history = list(row.get("status_history") or [])
    history.append({"from": current, "to": new_status, "at": now_iso, "note": note})

    update: dict[str, Any] = {
        "status": new_status,
        "status_history": history,
    }

    if new_status == "complete":
        update["completed_at"] = now_iso

    if error is not None or new_status == "failed":
        err_entry = {
            "at": now_iso,
            "status_at_failure": current,
            "target_status": new_status,
        }
        if isinstance(error, str):
            err_entry["message"] = error
        elif isinstance(error, dict):
            err_entry.update(error)
        elif new_status == "failed" and note:
            err_entry["message"] = note
        existing_errors = list(row.get("error_log") or [])
        existing_errors.append(err_entry)
        update["error_log"] = existing_errors

    if extra_fields:
        protected = set(update) | _PROTECTED_FIELDS
        bad = [k for k in extra_fields if k in protected]
        if bad:
            raise IntakeError(f"extra_fields cannot override protected keys: {bad}")
        update.update(extra_fields)

    updated = supa.update(TABLE, submission_id, update)
    log.info(
        "transition %s: %s -> %s%s",
        submission_id, current, new_status,
        f" (note={note!r})" if note else "",
    )
    return updated


_PROTECTED_FIELDS = frozenset({
    "id",
    "idempotency_key",
    "created_at",
    "captured_at",
    "payload",  # raw payload is immutable after insert
    "status_history",  # owned by transition()
})


def claim_next_received(supa: SupabaseClient) -> dict[str, Any] | None:
    """Atomically claim one ``status='received'`` row, transitioning it to
    ``synthesizing``. Returns the claimed row or None if the queue is empty
    or another worker won the race.

    Two-step but safe:
      1. SELECT one received row (id + current status_history)
      2. UPDATE ... SET status='synthesizing', status_history=... WHERE id=?
         AND status='received' — conditional on status, so PostgREST returns
         an empty list if another worker claimed it between (1) and (2).

    Future-proofs against multi-worker even though single-worker is the
    current deploy.
    """
    candidates = supa.select(
        TABLE,
        columns="id,status_history",
        params={"status": "eq.received", "order": "created_at.asc"},
        limit=1,
    )
    if not candidates:
        return None
    candidate = candidates[0]
    candidate_id = candidate["id"]

    history = list(candidate.get("status_history") or [])
    history.append({
        "from": "received",
        "to": "synthesizing",
        "at": _utcnow_iso(),
        "note": "claimed by worker",
    })

    claimed = supa.update_where(
        TABLE,
        {"status": "synthesizing", "status_history": history},
        filters={"id": f"eq.{candidate_id}", "status": "eq.received"},
    )
    return claimed[0] if claimed else None
