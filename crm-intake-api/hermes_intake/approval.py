"""Shared approval logic for agency intake drafts.

Both the Slack interactive button handler and the
`POST /agency-intake/approve` HTTP endpoint call `approve_draft()` here.

An approval token only moves the `intake_submissions` row; the intake worker
(`hermes/operations/intake_worker.py`) does the committing — opportunities and
the staged NowCerts insured via `commit_draft`, then the retrieval rows
(`client_entities` / `client_facts` / `client_notes`) via `_insert_retrieval_rows`
below.

Tokens:
  APPROVE ALL / CRM ONLY / SUPABASE ONLY / TASKS ONLY
                        — transition awaiting_approval -> approved; the worker
                          handles every path uniformly. The token is preserved
                          in status_history.
  REVISE                — mark revised, return early
  CANCEL                — mark canceled, return early
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from hermes_intake.agency_intake import ALLOWED_APPROVAL_TOKENS
from hermes_integrations import retrieval_client

if TYPE_CHECKING:
    from hermes_integrations.supabase_client import SupabaseClient

log = logging.getLogger(__name__)


@dataclass
class ApprovalResult:
    ok: bool
    draft_id: str
    token: str
    status: str
    enqueued_queue_ids: list[str] = field(default_factory=list)
    retrieval_row_ids: dict[str, list[str]] = field(default_factory=dict)
    summary: str = ""
    error: str | None = None


class ApprovalError(Exception):
    pass


def _load_draft(supa: "SupabaseClient", draft_id: str) -> dict[str, Any]:
    rows = supa.select(
        "agency_intake_drafts",
        params={"id": f"eq.{draft_id}"},
        limit=1,
    )
    if not rows:
        raise ApprovalError(f"Draft {draft_id} not found")
    return rows[0]


def _update_draft_status(
    supa: "SupabaseClient",
    draft_id: str,
    *,
    status: str,
    approval_token: str,
    approved_by: str | None,
    write_plan: dict[str, Any] | None = None,
    enqueued_queue_ids: list[str] | None = None,
    retrieval_row_ids: dict[str, list[str]] | None = None,
    error: str | None = None,
) -> None:
    payload: dict[str, Any] = {
        "status": status,
        "approval_token": approval_token,
        "approved_by": approved_by,
        "approved_at": "now()",
    }
    if write_plan is not None:
        payload["write_plan"] = write_plan
    if enqueued_queue_ids is not None:
        payload["enqueued_queue_ids"] = enqueued_queue_ids
    if retrieval_row_ids is not None:
        payload["retrieval_row_ids"] = retrieval_row_ids
    if error is not None:
        payload["error"] = error
    # PostgREST does not parse "now()" — drop it and let the table default / trigger handle it
    payload.pop("approved_at", None)
    supa.update("agency_intake_drafts", draft_id, payload)


def _insert_retrieval_rows(
    supa: "SupabaseClient",
    payload: dict[str, Any],
) -> dict[str, list[str]]:
    """Insert client_entities + client_facts + client_notes rows.

    CRM ids land later (the intake worker stamps them) — these rows are written
    eagerly so retrieval works even before the CRM write completes.
    """
    out: dict[str, list[str]] = {"client_entities": [], "client_facts": [], "client_notes": []}

    account = payload.get("account") or {}
    contacts = payload.get("contacts") or []
    note = payload.get("note") or {}
    facts = payload.get("facts") or []

    entity_id_lookup: dict[str, str] = {}

    if account.get("account_name"):
        entity_row = retrieval_client.upsert_entity(
            supa,
            entity_type="Account",
            entity_name=account["account_name"],
            canonical_aliases=[account["account_name"], account.get("legal_name"), account.get("dba")],
            tags=account.get("tags") or [],
        )
        entity_id = str(entity_row.get("id") or "")
        if entity_id:
            entity_id_lookup[account["account_name"]] = entity_id
            out["client_entities"].append(entity_id)
            primary_account_entity_id = entity_id
        else:
            primary_account_entity_id = None
    else:
        primary_account_entity_id = None

    for contact in contacts:
        name = contact.get("full_name") or f"{contact.get('first_name', '')} {contact.get('last_name', '')}".strip()
        if not name:
            continue
        entity_row = retrieval_client.upsert_entity(
            supa,
            entity_type="Contact",
            entity_name=name,
            canonical_aliases=[name],
            primary_account_entity_id=primary_account_entity_id,
        )
        entity_id = str(entity_row.get("id") or "")
        if entity_id:
            entity_id_lookup[name] = entity_id
            out["client_entities"].append(entity_id)

    fact_rows = retrieval_client.bulk_insert_facts(
        supa,
        facts=[f for f in facts if isinstance(f, dict)],
        entity_id_lookup=entity_id_lookup,
    )
    out["client_facts"] = [str(r.get("id")) for r in fact_rows if r.get("id")]

    if note.get("title") and note.get("body") and primary_account_entity_id:
        note_row = retrieval_client.insert_note(
            supa,
            entity_id=primary_account_entity_id,
            note_type=note.get("note_type") or "Underwriting Summary",
            title=note["title"],
            summary=(note["body"][:300] + "…") if len(note["body"]) > 300 else note["body"],
            full_text=note["body"],
            audience=note.get("audience") or "internal",
            sensitivity=note.get("sensitivity") or "standard",
            tags=note.get("tags") or [],
            author=(payload.get("source") or {}).get("submitted_by"),
            note_date=(payload.get("source") or {}).get("date"),
            source=(payload.get("source") or {}).get("type"),
            source_ref=(payload.get("source") or {}).get("source_ref"),
        )
        if note_row.get("id"):
            out["client_notes"].append(str(note_row["id"]))

    return out


def approve_draft(
    supa: "SupabaseClient",
    *,
    draft_id: str,
    token: str,
    approver: str | None,
) -> ApprovalResult:
    """Apply an approval token to an intake_submissions row.

    Phase 3 rewrite: the source of truth is now ``intake_submissions``
    (keyed by submission_id) rather than ``agency_intake_drafts`` (keyed
    by draft_id). The ``draft_id`` keyword is kept so existing callers in
    api.py and slack_socket.py don't need touching — but the value is
    now interpreted as a submission_id (UUID of intake_submissions.id).

    Behavior:
      APPROVE ALL                → transition awaiting_approval -> approved
                                   (worker picks up, enqueues CRM writes,
                                   walks writing -> written -> complete)
      APPROVE CRM ONLY           → approved; worker skips the Supabase
                                   retrieval/RAG rows and only creates the
                                   CRM opportunities (+ stages the AMS
                                   insured). Token persisted on the row.
      APPROVE SUPABASE ONLY      → approved; worker skips the CRM/AMS
                                   writes and only inserts retrieval rows.
      APPROVE TASKS ONLY         → approved; no task entity exists yet, so
                                   the worker completes the row with no
                                   writes (deliberate no-op).
      REVISE                     → transition to failed with note
                                   "marked revised by approver"
                                   (intake_submissions enum has no
                                   'revised' state)
      CANCEL                     → transition to failed with note
                                   "canceled by approver"
    """
    from datetime import datetime, timezone

    from hermes_intake.submissions import (
        IntakeError,
        fetch_by_id,
        transition,
    )

    submission_id = draft_id  # parameter is named draft_id for back-compat
    token = (token or "").strip().upper()
    if token not in ALLOWED_APPROVAL_TOKENS:
        raise ApprovalError(
            f"Token {token!r} is not allowed. Use one of: {sorted(ALLOWED_APPROVAL_TOKENS)}"
        )

    submission = fetch_by_id(supa, submission_id)
    if submission is None:
        raise ApprovalError(
            f"Submission {submission_id} not found in intake_submissions. "
            f"This Slack message may be stale from the pre-Phase-3 agency_intake_drafts path."
        )

    current_status = submission.get("status")
    if current_status != "awaiting_approval":
        raise ApprovalError(
            f"Submission {submission_id} is in status={current_status!r}, "
            f"not 'awaiting_approval' — cannot apply approval token."
        )

    approver_label = approver or "system"

    if token == "CANCEL":
        try:
            transition(
                supa, submission_id, "failed",
                note=f"canceled by {approver_label}",
                error={"reason": "canceled by approver", "token": token},
            )
        except IntakeError as exc:
            raise ApprovalError(f"Cancel transition failed: {exc}") from exc
        return ApprovalResult(
            ok=True, draft_id=submission_id, token=token, status="failed",
            summary=f"Submission {submission_id} canceled. Nothing was written.",
        )

    if token == "REVISE":
        try:
            transition(
                supa, submission_id, "failed",
                note=f"marked revised by {approver_label}",
                error={"reason": "marked revised by approver", "token": token},
            )
        except IntakeError as exc:
            raise ApprovalError(f"Revise transition failed: {exc}") from exc
        return ApprovalResult(
            ok=True, draft_id=submission_id, token=token, status="failed",
            summary=f"Submission {submission_id} marked failed (revise). Resubmit with corrections.",
        )

    # Any APPROVE* token → transition to 'approved'. The token is persisted
    # on the row (approval_token column) so the worker can branch on it:
    # CRM ONLY skips retrieval rows, SUPABASE ONLY skips CRM/AMS writes,
    # TASKS ONLY is a no-op until a task entity exists. APPROVE ALL does
    # everything. The token is also echoed in the status_history note for audit.
    approved_at_iso = datetime.now(timezone.utc).isoformat()
    try:
        transition(
            supa, submission_id, "approved",
            note=f"{token} by {approver_label}",
            extra_fields={
                "approved_by": approver_label,
                "approved_at": approved_at_iso,
                "approval_token": token,
            },
        )
    except IntakeError as exc:
        raise ApprovalError(f"Approve transition failed: {exc}") from exc

    return ApprovalResult(
        ok=True,
        draft_id=submission_id,
        token=token,
        status="approved",
        summary=(
            f"Submission {submission_id} approved via {token}. "
            f"Worker will enqueue CRM writes and walk through writing -> written -> complete."
        ),
    )
