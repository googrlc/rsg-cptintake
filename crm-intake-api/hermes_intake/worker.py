"""intake_submissions worker — drives the rsg-intake state machine.

Pipeline per row (PROJECT-CONTEXT.md):

  received → synthesizing → synthesized → drafting → awaiting_approval
                                                              ↓ (Slack APPROVE)
                                                            approved
                                                              ↓
                                                            writing → written → complete

  Any state → failed (with error_log entry + Slack alert)

This file lands incrementally across Phase 3:

  Step 2 (here): worker scaffold + ``received -> awaiting_approval`` arc.
                 Synthesizer + Slack draft post are stubbed; the arc
                 transitions states so the claim pattern is exercised
                 end-to-end. Stubs raise NotImplementedError which the
                 worker catches and routes to ``failed`` + Slack alert.
  Step 3:        actual synthesizer fill-in (commands/agency_intake.py).
  Step 4:        Slack draft post replaces the stubbed _post_draft.
  Step 5:        ``approved -> writing -> written -> complete`` arc +
                 retrieval inserts + completion post.

Single-worker assumption is fine today; the claim pattern in
``claim_next_received`` makes scale-out safe later.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

from hermes_intake.submissions import (
    IntakeError,
    TABLE,
    claim_next_received,
    transition,
)
from hermes_integrations.slack_notifier import SlackNotifier, SlackNotifierError
from hermes_integrations.supabase_client import SupabaseClient, SupabaseClientError

log = logging.getLogger(__name__)


DEFAULT_POLL_SECONDS = 5.0


def _intake_alert_channel() -> str:
    """Slack channel for failure alerts (#systems-check by default)."""
    return os.environ.get(
        "HERMES_INTAKE_ALERT_CHANNEL", os.environ.get("HERMES_SYSTEMS_CHECK_CHANNEL", "C0ANSEP6SSD")
    ).strip()


def _intake_draft_channel() -> str:
    """Slack channel for draft + completion posts."""
    return os.environ.get(
        "HERMES_INTAKE_DRAFT_CHANNEL",
        os.environ.get("HERMES_SENTINEL_SLACK_CHANNEL", "D0B2PJYLGQG"),
    ).strip()


def _post_alert(text: str, *, channel: str | None = None) -> None:
    """Post to Slack, swallowing errors so the worker doesn't crash on Slack failures."""
    try:
        notifier = SlackNotifier(channel=channel or _intake_alert_channel())
        notifier.post_message(text=text)
    except SlackNotifierError:
        log.exception("Slack post failed (channel=%s)", channel)
    except Exception:
        log.exception("Unexpected Slack post failure (channel=%s)", channel)


def _safe_transition_to_failed(
    supa: SupabaseClient, submission_id: str, *, exc: Exception, stage: str
) -> None:
    """Move the submission to ``failed`` and alert Slack. Swallows transition errors."""
    err = {"stage": stage, "message": str(exc), "exception_type": type(exc).__name__}
    try:
        transition(supa, submission_id, "failed", note=f"{stage} failed", error=err)
    except Exception:
        log.exception("Failed to mark submission %s as failed", submission_id)
    _post_alert(
        f":rotating_light: Hermes intake submission failed\n"
        f"- submission_id: {submission_id}\n"
        f"- stage: {stage}\n"
        f"- error: {exc}"
    )


# ---------------------------------------------------------------------------
# Pluggable hooks (filled across Steps 3-4).
# Steps 3+4 swap real implementations in via module-level assignment so the
# worker's claim/transition flow stays stable.
# ---------------------------------------------------------------------------


from hermes_intake.agency_intake import (  # noqa: E402
    build_approval_blocks,
    render_hermes_blocks,
    synthesize_from_payload,
    validate_payload,
)


def _format_submission_approval_prompt(
    submission_id: str, draft_summary: dict[str, Any]
) -> str:
    """One-liner Slack-friendly summary keyed on submission_id (not draft_id).

    Lamar reviews this in #crm-entry / the draft channel before clicking
    APPROVE ALL. The submission_id is embedded so the audit trail
    matches the intake_submissions row even if the buttons are clipped.
    """
    account = draft_summary.get("account") or {}
    contacts = draft_summary.get("contacts") or []
    opps = draft_summary.get("opportunities") or []
    facts = draft_summary.get("facts") or []
    note = draft_summary.get("note") or {}

    contact_names = ", ".join(
        c.get("full_name", "") or f"{c.get('first_name', '')} {c.get('last_name', '')}".strip()
        for c in contacts
    ) or "(none)"
    lob_lines = [
        f"  - {o.get('line_of_business', '?')}  ({o.get('stage', '?')})"
        + (f"  quote {o.get('quote_number')}" if o.get("quote_number") else "")
        for o in opps
    ]
    restricted = sum(1 for f in facts if isinstance(f, dict) and f.get("sensitivity") == "restricted")

    return (
        f"*Intake draft ready — NOTHING WRITTEN YET.*  "
        f"(submission_id: `{submission_id}`)\n\n"
        f"*Account:*       {account.get('account_name', '?')}  "
        f"({account.get('entity_type', '?')}, {account.get('industry', '?')})\n"
        f"*Contacts:*      {contact_names}\n"
        f"*Opportunities:* {len(opps)}\n"
        + ("\n".join(lob_lines) + "\n" if lob_lines else "")
        + f"*Note:*          {note.get('title', '(none)')}  ({note.get('note_type', '?')})\n"
        f"*Facts staged:*  {len(facts)} ({restricted} restricted)\n\n"
        "Click a button below — or reply with the token verbatim."
    )


def post_draft_to_slack(submission_id: str, draft_summary: dict[str, Any]) -> None:
    """Real Step-4 implementation of ``post_draft``.

    Posts the synthesized intake draft to the draft channel with the same
    interactive Block Kit buttons used by the agency-intake Slack flow —
    the existing ``^agency_intake_`` action handler in slack_socket.py
    will route button clicks to the (Step-5-rewritten) approve_draft.

    The button value is ``submission_id`` (NOT draft_id) and the
    ``block_id`` carries it too so the handler can recover it from either
    field.

    Slack failures are caught + logged so the worker doesn't fail the
    transition. The row will still settle at awaiting_approval; an
    operator can manually post or click the approval token reply.
    """
    prompt_text = _format_submission_approval_prompt(submission_id, draft_summary)
    blocks = build_approval_blocks(submission_id, prompt_text)
    try:
        notifier = SlackNotifier(channel=_intake_draft_channel())
        notifier.post_message(text=prompt_text, blocks=blocks)
        log.info("Posted intake draft to Slack for submission %s", submission_id)
    except SlackNotifierError as exc:
        log.exception("Slack draft post failed for submission %s", submission_id)
        # Surface to the alert channel so it doesn't get lost.
        _post_alert(
            f":warning: Intake draft synthesized but Slack post failed\n"
            f"- submission_id: {submission_id}\n"
            f"- error: {exc}\n"
            f"Row will settle at awaiting_approval; approve via reply token "
            f"or POST /agency-intake/approve."
        )


synthesize_payload = synthesize_from_payload
render_blocks = render_hermes_blocks
post_draft = post_draft_to_slack


# ---------------------------------------------------------------------------
# Arc 1: received -> synthesizing -> synthesized -> drafting -> awaiting_approval
# ---------------------------------------------------------------------------


def process_one_received(supa: SupabaseClient) -> bool:
    """Pull one received row through to awaiting_approval.

    Returns True if a row was processed (success OR failed), False if the
    queue was empty / lost the claim race.
    """
    claimed = claim_next_received(supa)
    if claimed is None:
        return False

    submission_id = str(claimed["id"])
    log.info("Claimed intake submission %s (synthesizing)", submission_id)

    payload = claimed.get("payload") or {}

    # Stage A: synthesize -> 'synthesized' (writes hermes_blocks + draft_summary)
    #
    # A caller may supply the synthesized payload itself. The RSG intake gate
    # does: it runs the same `crm-intake-writer` contract, then enriches the
    # result with extracted PDF text, reference-table NAICS/SIC/class codes and
    # contact names split against the AMS field contracts. Re-extracting from
    # its raw text here would throw all of that away and — because the second
    # LLM pass is not the first one — commit something other than what the
    # operator reviewed and approved. So a supplied payload is used verbatim.
    supplied = payload.get("synthesized_payload")
    try:
        if supplied:
            draft_summary, warnings = supplied, validate_payload(supplied)
            log.info("Submission %s carries a synthesized payload; skipping extraction", submission_id)
        else:
            draft_summary, warnings = synthesize_payload(payload)
        hermes_blocks = render_blocks(draft_summary)
    except Exception as exc:
        _safe_transition_to_failed(supa, submission_id, exc=exc, stage="synthesize")
        return True

    if warnings:
        log.warning("Submission %s synthesis warnings: %s", submission_id, warnings)

    try:
        transition(
            supa, submission_id, "synthesized",
            note="synthesis complete",
            extra_fields={"hermes_blocks": hermes_blocks, "draft_summary": draft_summary},
        )
    except (IntakeError, SupabaseClientError) as exc:
        _safe_transition_to_failed(supa, submission_id, exc=exc, stage="synthesized-transition")
        return True

    # Stage B: drafting — pass-through. Dedup probes deferred per Phase 3
    # decision (post-Phase-5 work).
    try:
        transition(
            supa, submission_id, "drafting",
            note="dedup probes deferred — pass-through",
        )
    except (IntakeError, SupabaseClientError) as exc:
        _safe_transition_to_failed(supa, submission_id, exc=exc, stage="drafting-transition")
        return True

    # Stage C: settle at awaiting_approval — or walk straight past it when the
    # submitter already carried an approval.
    #
    # A pre-approved submission was reviewed by a person before it was ever sent
    # (the intake gate's Approve button). Asking for a second approval here would
    # be asking the same person the same question twice, and with no Slack in the
    # loop nobody would ever be asked — the row would simply stop. It still passes
    # THROUGH awaiting_approval rather than skipping the state, so status_history
    # records who approved it and when, exactly like a Slack approval would.
    approval = (payload.get("approval") or {}) if isinstance(payload, dict) else {}
    approver = str(approval.get("approved_by") or "").strip()
    try:
        if not approver:
            post_draft(submission_id, draft_summary)
        transition(
            supa, submission_id, "awaiting_approval",
            note=f"approved on submission by {approver}" if approver else "draft posted to Slack",
        )
    except (IntakeError, SupabaseClientError) as exc:
        _safe_transition_to_failed(
            supa, submission_id, exc=exc, stage="awaiting_approval-transition"
        )
        return True
    except Exception as exc:
        # Slack post failures are non-fatal; record and continue to
        # awaiting_approval. But if the post + transition both crash here,
        # surface as failed.
        _safe_transition_to_failed(supa, submission_id, exc=exc, stage="slack-draft-post")
        return True

    if not approver:
        log.info("Submission %s now awaiting_approval", submission_id)
        return True

    token = str(approval.get("token") or "APPROVE ALL").strip().upper()
    try:
        transition(
            supa, submission_id, "approved",
            note=f"{token} by {approver} (approved before submission)",
            extra_fields={
                "approved_by": approver,
                "approved_at": _utcnow_iso(),
                "approval_token": token,
            },
        )
    except (IntakeError, SupabaseClientError) as exc:
        _safe_transition_to_failed(supa, submission_id, exc=exc, stage="pre-approved-transition")
        return True

    log.info("Submission %s approved on submission by %s (%s)", submission_id, approver, token)
    return True


# ---------------------------------------------------------------------------
# Arc 2: approved -> committed to NowCerts + Supabase
# ---------------------------------------------------------------------------


def _utcnow_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _claim_next_approved(supa: SupabaseClient) -> dict[str, Any] | None:
    """Atomically claim one ``status='approved'`` row -> 'writing'.

    Same race-safe pattern as ``claim_next_received``: SELECT then
    conditional UPDATE WHERE status='approved'. Losing workers get [].
    """
    candidates = supa.select(
        TABLE,
        columns="id,status_history,draft_summary,approved_by,approval_token,source",
        params={"status": "eq.approved", "order": "created_at.asc"},
        limit=1,
    )
    if not candidates:
        return None
    candidate = candidates[0]
    candidate_id = candidate["id"]

    history = list(candidate.get("status_history") or [])
    history.append({
        "from": "approved",
        "to": "writing",
        "at": _utcnow_iso(),
        "note": "claimed by intake worker",
    })
    claimed = supa.update_where(
        TABLE,
        {"status": "writing", "status_history": history},
        filters={"id": f"eq.{candidate_id}", "status": "eq.approved"},
    )
    if not claimed:
        return None
    row = claimed[0]
    # update_where doesn't return joined columns; keep the draft_summary
    # we already SELECTed on candidate.
    row.setdefault("draft_summary", candidate.get("draft_summary"))
    row.setdefault("approved_by", candidate.get("approved_by"))
    row.setdefault("approval_token", candidate.get("approval_token"))
    row.setdefault("source", candidate.get("source"))
    return row


def process_one_approved(supa: SupabaseClient) -> bool:
    """Commit one approved submission to NowCerts + Supabase.

    Walks the row approved -> writing -> written -> complete in a single pass,
    branching on the approver's token (persisted on the row by ``approve_draft``):

    * APPROVE ALL          → ``commit_draft`` (CRM opportunities + gated AMS
                             insured) **and** retrieval rows. The historical path.
    * APPROVE CRM ONLY     → ``commit_draft`` only; skip the Supabase
                             retrieval/RAG rows.
    * APPROVE SUPABASE ONLY → retrieval rows only; skip the CRM/AMS writes.
    * APPROVE TASKS ONLY   → no task entity exists yet, so a deliberate no-op:
                             the row still walks through to ``complete`` with
                             zero writes so it is not left stuck at ``writing``.

    A missing/NULL token (old rows, or any path that did not set it) defaults to
    APPROVE ALL so the worker keeps doing what it always did.
    """
    from hermes_intake.submissions import transition
    from hermes_intake.commit import commit_draft
    from hermes_intake.approval import _insert_retrieval_rows
    from hermes_core.write_gate import APPROVE_ALL, parse_approval_token

    claimed = _claim_next_approved(supa)
    if claimed is None:
        return False

    submission_id = str(claimed["id"])
    log.info("Claimed approved submission %s -> writing", submission_id)

    draft_summary = claimed.get("draft_summary") or {}
    approver = claimed.get("approved_by") or "system"
    token = (claimed.get("approval_token") or APPROVE_ALL).strip().upper()
    decision = parse_approval_token(token)
    if decision is None:  # defensive: unknown token → historical APPROVE ALL behaviour
        decision = parse_approval_token(APPROVE_ALL)
    log.info("Submission %s approval scope: %s (crm=%s supabase=%s tasks=%s)",
             submission_id, token, decision.approve_crm,
             decision.approve_supabase, decision.approve_tasks)

    # --- CRM side: opportunities + gated NowCerts insured staging ---
    # commit_draft creates the Supabase opportunities (the sales pipeline) and
    # stages the approval-gated NowCerts create_insured job. SUPABASE ONLY and
    # TASKS ONLY skip it.
    result: dict[str, Any] = {
        "opportunities": [],
        "opportunity_count": 0,
        "intake_job_id": None,
        "nextcloud_folder": None,
    }
    if decision.approve_crm:
        try:
            # Carry the submitting system onto every opportunity it opens. Without
            # it every intake row reads `source='agency_intake'` regardless of
            # where it came from, and "which channel is actually producing deals"
            # stops being an answerable question.
            result = commit_draft(
                supa,
                draft_summary,
                approved_by=approver,
                source=claimed.get("source"),
            )
        except Exception as exc:
            _safe_transition_to_failed(supa, submission_id, exc=exc, stage="commit-nowcerts-intake")
            return True
    else:
        log.info("Submission %s: skipping CRM/AMS writes (token=%s)", submission_id, token)

    records_created: dict[str, Any] = {
        "target": "nowcerts",
        "approval_token": token,
        "opportunities": [r.get("id") for r in result.get("opportunities", [])],
        "intake_job_id": result.get("intake_job_id"),
        "nextcloud_folder": result.get("nextcloud_folder"),
    }
    try:
        supa.update(TABLE, submission_id, {"records_created": records_created})
        # writing -> written (opportunities created now, or skipped by scope;
        # the NowCerts insured create is a separate approval-gated executor job).
        transition(supa, submission_id, "written",
                   note="intake opportunities created; NowCerts insured staged")
    except Exception as exc:
        _safe_transition_to_failed(supa, submission_id, exc=exc, stage="written-transition")
        return True

    # --- Supabase side: retrieval/RAG rows (client_entities / facts / notes) ---
    # CRM ONLY and TASKS ONLY skip it. The rows are written eagerly so retrieval
    # answers from this submission the moment it lands.
    retrieval_ids: dict[str, list[str]] = {}
    if decision.approve_supabase:
        try:
            retrieval_ids = _insert_retrieval_rows(supa, draft_summary)
            records_created["retrieval_row_ids"] = retrieval_ids
        except Exception as exc:
            log.exception("Retrieval insert failed for submission %s", submission_id)
            _safe_transition_to_failed(supa, submission_id, exc=exc, stage="retrieval-inserts")
            return True
    else:
        log.info("Submission %s: skipping retrieval/RAG rows (token=%s)", submission_id, token)

    # --- Tasks side: no task entity exists yet, so APPROVE TASKS ONLY is a
    # deliberate no-op. We still walk the row through to complete so it is not
    # left stuck at 'writing'; the records_created stash above records the scope. ---

    try:
        transition(supa, submission_id, "complete",
                   note=f"intake committed to NowCerts+Supabase by {approver} ({token})",
                   extra_fields={"records_created": records_created})
    except Exception as exc:
        _safe_transition_to_failed(supa, submission_id, exc=exc, stage="complete-nowcerts-intake")
        return True  # #112: do NOT fall through to the success log after a failed transition

    log.info(
        "Submission %s committed to NowCerts+Supabase (%d opportunities, intake_job=%s)",
        submission_id, result.get("opportunity_count", 0), result.get("intake_job_id"),
    )

    # Completion post to the draft channel for Gretchen's visibility.
    retrieval_summary = ", ".join(
        f"{k}={len(v)}" for k, v in retrieval_ids.items() if v
    ) or "(none)"
    _post_alert(
        f":white_check_mark: Hermes intake complete ({token})\n"
        f"- submission_id: {submission_id}\n"
        f"- opportunities: {result.get('opportunity_count', 0)}\n"
        f"- Retrieval rows: {retrieval_summary}",
        channel=_intake_draft_channel(),
    )
    return True



# ---------------------------------------------------------------------------
# Synchronous commit — the reviewed-at-the-source path
# ---------------------------------------------------------------------------


def commit_submission_now(supa: SupabaseClient, submission_id: str) -> dict[str, Any]:
    """Walk ONE submission from ``received`` to ``complete`` in a single call.

    The asynchronous worker exists to buy time for things this path does not do:
    an LLM extraction, a Slack round trip, and a wait for a human to approve.
    When a submission arrives already synthesized AND already approved, none of
    those are pending — there is nothing left to wait for, so making the caller
    wait means their intake sits in a queue looking like it worked.

    That is not hypothetical here. Nothing in this deployment runs the worker
    loop: the scheduler drives ``run_intake_executor`` (the outbound queue), not
    ``tick``. A row left for the worker is a row that never moves.

    Every state is still walked in order rather than jumped, so ``status_history``
    reads the same as an asynchronous commit and the DB's status CHECK is never
    violated. Returns a summary; raises nothing — a failure is reported in the
    return value with the row transitioned to ``failed``, because the caller is a
    person looking at a screen who needs to be told.
    """
    from hermes_intake.submissions import fetch_by_id, transition
    from hermes_intake.commit import commit_draft
    from hermes_intake.approval import _insert_retrieval_rows
    from hermes_core.write_gate import APPROVE_ALL, parse_approval_token

    row = fetch_by_id(supa, submission_id)
    if row is None:
        return {"ok": False, "status": "failed", "error": f"submission {submission_id} not found"}

    payload = row.get("payload") or {}
    draft_summary = payload.get("synthesized_payload")
    approval = payload.get("approval") or {}
    approver = str(approval.get("approved_by") or "").strip()
    token = str(approval.get("token") or APPROVE_ALL).strip().upper()

    if not draft_summary or not approver:
        return {
            "ok": False,
            "status": row.get("status"),
            "error": "a synchronous commit needs both a synthesized payload and an approver",
        }

    decision = parse_approval_token(token) or parse_approval_token(APPROVE_ALL)

    def _fail(exc: Exception, stage: str) -> dict[str, Any]:
        _safe_transition_to_failed(supa, submission_id, exc=exc, stage=stage)
        return {"ok": False, "status": "failed", "error": f"{stage}: {exc}"}

    # Walk to 'approved'. No synthesis (supplied), no Slack post, no wait.
    try:
        warnings = validate_payload(draft_summary)
        blocks = render_blocks(draft_summary)
        transition(supa, submission_id, "synthesizing", note="synchronous commit")
        transition(supa, submission_id, "synthesized",
                   note="payload supplied by submitter; extraction skipped",
                   extra_fields={"hermes_blocks": blocks, "draft_summary": draft_summary})
        transition(supa, submission_id, "drafting", note="dedup probes deferred — pass-through")
        transition(supa, submission_id, "awaiting_approval",
                   note=f"approved on submission by {approver}")
        transition(supa, submission_id, "approved",
                   note=f"{token} by {approver} (approved before submission)",
                   extra_fields={"approved_by": approver, "approved_at": _utcnow_iso(),
                                 "approval_token": token})
        transition(supa, submission_id, "writing", note="synchronous commit")
    except Exception as exc:  # noqa: BLE001 — reported, not raised; see the docstring
        return _fail(exc, "approve-transitions")

    result: dict[str, Any] = {"opportunities": [], "opportunity_count": 0,
                              "intake_job_id": None, "nextcloud_folder": None}
    if decision.approve_crm:
        try:
            result = commit_draft(supa, draft_summary, approved_by=approver,
                                  source=row.get("source"))
        except Exception as exc:  # noqa: BLE001
            return _fail(exc, "commit-opportunities")

    records_created: dict[str, Any] = {
        "target": "crm",
        "approval_token": token,
        "opportunities": [r.get("id") for r in result.get("opportunities", [])],
        "intake_job_id": result.get("intake_job_id"),
        "nextcloud_folder": result.get("nextcloud_folder"),
    }
    try:
        supa.update(TABLE, submission_id, {"records_created": records_created})
        transition(supa, submission_id, "written", note="opportunities created")
    except Exception as exc:  # noqa: BLE001
        return _fail(exc, "written-transition")

    retrieval_ids: dict[str, list[str]] = {}
    if decision.approve_supabase:
        try:
            retrieval_ids = _insert_retrieval_rows(supa, draft_summary)
            records_created["retrieval_row_ids"] = retrieval_ids
        except Exception as exc:  # noqa: BLE001
            return _fail(exc, "retrieval-inserts")

    try:
        transition(supa, submission_id, "complete",
                   note=f"intake committed by {approver} ({token})",
                   extra_fields={"records_created": records_created})
    except Exception as exc:  # noqa: BLE001
        return _fail(exc, "complete-transition")

    log.info("Submission %s committed synchronously by %s (%d opportunities)",
             submission_id, approver, result.get("opportunity_count", 0))
    return {
        "ok": True,
        "status": "complete",
        "approved_by": approver,
        "approval_token": token,
        "client_identifier": result.get("client_identifier"),
        "opportunity_count": result.get("opportunity_count", 0),
        "opportunity_ids": records_created["opportunities"],
        "entity_count": len(retrieval_ids.get("client_entities", [])),
        "fact_count": len(retrieval_ids.get("client_facts", [])),
        "note_count": len(retrieval_ids.get("client_notes", [])),
        "nextcloud_folder": result.get("nextcloud_folder"),
        # False on this path by design — an intake is a prospect. Reported so the
        # caller never has to assume.
        "ams_insured_staged": bool(result.get("ams_insured_staged")),
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Worker loop
# ---------------------------------------------------------------------------


def tick(supa: SupabaseClient) -> dict[str, int]:
    """One worker iteration. Drives both arcs once each."""
    received = 1 if process_one_received(supa) else 0
    approved = 1 if process_one_approved(supa) else 0
    return {
        "received_processed": received,
        "approved_processed": approved,
    }


def run_intake_worker_loop(
    supa: SupabaseClient,
    *,
    poll_seconds: float = DEFAULT_POLL_SECONDS,
) -> None:
    """Continuously drive the intake state machine. Designed for
    ``hermes --run-intake-worker`` and a docker-compose service."""
    interval = poll_seconds if poll_seconds > 0 else DEFAULT_POLL_SECONDS
    log.info("Starting intake worker loop: interval=%ss", interval)
    while True:
        try:
            result = tick(supa)
            if any(result.values()):
                log.info("intake tick: %s", result)
        except Exception:
            log.exception("intake worker tick crashed; continuing")
        time.sleep(interval)
