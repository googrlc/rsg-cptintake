"""Intake — lead capture and the intake desk.

Leads and their notes/conversion, the intake queue and its executor, pipeline
stages, and the agency-intake draft/approve pair.

This is NOT the same intake as rsg-cptintake. That repo is the NowCerts
submission gateway (rsg-intake-gate) — an MCP/AMS relay with its own operator
UI, owning /api/intakes/* and /api/intake/documents. This router is the
CRM-side desk: who came in, what they need, and where the deal sits.

The two are one character apart on the wire — /api/intakes (gateway) versus
/api/intake (here) — and the portal proxies them to different backends on that
distinction alone. Anyone consolidating the two should fix the naming before
the routing, not after.
"""

from __future__ import annotations

import hmac
import logging
import os
from datetime import date, datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator

from hermes_app import deps

log = logging.getLogger(__name__)

router = APIRouter()

IntakeSource = Literal["cowork", "voice_tool", "manual_curl", "n8n", "intake_gate"]
IntakeAgent = Literal["lamar", "gretchen"]
IntakeKind = Literal["full_intake", "task", "note", "update", "other"]


class IntakeDocument(BaseModel):
    model_config = ConfigDict(extra="allow")

    type: str | None = None
    extracted_data: dict[str, Any] | None = None
    raw_text: str | None = None
    source_file: str | None = None


class IntakeCoachingSnapshot(BaseModel):
    model_config = ConfigDict(extra="allow")

    covered_topics: list[str] = Field(default_factory=list)
    remaining_gaps: list[str] = Field(default_factory=list)
    flags_detected: list[dict[str, Any]] = Field(default_factory=list)


class IntakeSubmissionRequest(BaseModel):
    # Required
    idempotency_key: str = Field(..., min_length=1, max_length=512)
    source: IntakeSource
    agent: IntakeAgent
    captured_at: datetime

    # Optional with default
    intake_kind: IntakeKind = "full_intake"

    # Optional structured envelope fields
    client_identifier: str | None = None
    lob_code: str | None = None

    # Payload content — at least one of transcript/documents is required
    transcript: str | None = None
    documents: list[IntakeDocument] = Field(default_factory=list)
    coaching_snapshot: IntakeCoachingSnapshot | None = None
    notes: str | None = None

    # An already-synthesized `crm-intake-writer` payload (account, contacts,
    # opportunities, note, facts). Supply this when the CALLER has done the
    # extraction and its result is better than a second pass would be — the RSG
    # intake gate, for instance, synthesizes against the same contract and then
    # adds cited PDF text, reference-table NAICS/SIC/class codes and split
    # contact names. Re-extracting from raw text there would silently discard
    # all of it and produce a different answer from the one the operator
    # reviewed. When present the worker uses it verbatim and skips synthesis.
    synthesized_payload: dict[str, Any] | None = None

    # Who approved this intake BEFORE it was sent, when the caller owns the review.
    #
    # The intake gate does: an operator reads the synthesized bundle, resolves the
    # flagged items and presses Approve, and only then is anything sent here. That
    # review has already happened, so parking the row at `awaiting_approval` asks
    # the same person the same question twice — and with no Slack in the loop the
    # second question is never asked at all, leaving the intake stuck forever.
    #
    # Absent, nothing changes: the row waits for an approver exactly as before.
    approved_by: str | None = None
    approval_token: str | None = None   # defaults to APPROVE ALL when approved_by is set

    @model_validator(mode="after")
    def _validate_approval(self) -> "IntakeSubmissionRequest":
        """A token without an approver is an unsigned approval — refuse it."""
        if self.approval_token and not (self.approved_by or "").strip():
            raise ValueError("approval_token requires approved_by — an approval must name who gave it")
        if self.approved_by is not None and not self.approved_by.strip():
            raise ValueError("approved_by cannot be blank")
        from hermes_intake.agency_intake import ALLOWED_APPROVAL_TOKENS

        token = (self.approval_token or "").strip().upper()
        if token and token not in ALLOWED_APPROVAL_TOKENS:
            raise ValueError(
                f"approval_token {token!r} is not allowed; use one of {sorted(ALLOWED_APPROVAL_TOKENS)}"
            )
        return self

    @model_validator(mode="after")
    def _require_transcript_or_documents(self) -> "IntakeSubmissionRequest":
        has_transcript = bool(self.transcript and self.transcript.strip())
        has_documents = bool(self.documents)
        # A synthesized payload IS the content; requiring raw text alongside it
        # would force callers to send a transcript nothing will ever read.
        if self.synthesized_payload:
            return self
        if not (has_transcript or has_documents):
            raise ValueError(
                "at least one of `transcript`, `documents` or `synthesized_payload` is required"
            )
        return self


class IntakeSubmissionResponse(BaseModel):
    submission_id: str
    status: str
    status_url: str
    created_at: str
    idempotent_replay: bool = False
    # Set when the submission was committed inline (already synthesized, already
    # approved). Carries what was actually created so the caller can say "it is in
    # the CRM" instead of "it was accepted" — those are different claims, and only
    # one of them is checkable.
    commit: dict[str, Any] | None = None


class AgencyIntakeRequest(BaseModel):
    raw_text: str
    submitted_by: str | None = None
    source_type: str = "manual"
    source_ref: str | None = None


class AgencyIntakeResponse(BaseModel):
    ok: bool
    draft_id: str
    approval_prompt: str
    validation_warnings: list[str] = []
    payload_preview: dict | None = None
    requires_confirmation: bool = True


class AgencyIntakeApprovalRequest(BaseModel):
    draft_id: str
    token: str
    approver: str | None = None


class AgencyIntakeApprovalResponse(BaseModel):
    ok: bool
    draft_id: str
    token: str
    status: str
    summary: str
    enqueued_queue_ids: list[str] = []
    retrieval_row_ids: dict[str, list[str]] = {}
    error: str | None = None


@router.get("/api/leads")
def list_leads_endpoint(limit: int = 200, status: str | None = None, include_ams: bool = True):
    """The lead station — the agency's own leads, plus live NowCerts prospects.

    A lead lives in the CRM (``crm_leads``) and never goes to the AMS; it reaches
    NowCerts only by being converted to an opportunity and that opportunity being
    won. Prospects created directly in NowCerts appear here too, read-only, marked
    ``source='nowcerts'`` — and a prospect already held as a CRM lead is shown once.

    The AMS half is best-effort: it is the slowest read the backend does, and our
    own leads must not disappear because it was slow. When it fails the response
    carries ``ams_error`` rather than 502-ing the whole screen."""
    from hermes import leads as L

    try:
        return L.combined_leads(
            deps.get_supa(),
            deps.get_nowcerts() if include_ams else None,
            status=status,
            limit=limit,
        )
    except Exception as exc:
        log.exception("leads list failed")
        raise HTTPException(status_code=502, detail=str(exc))


class LeadWriteRequest(BaseModel):
    """A lead. Only a name is required — a lead is often just a name and a number,
    and demanding a full record is how leads stay on a napkin."""
    name: str | None = None
    company: str | None = None
    email: str | None = None
    phone: str | None = None
    city: str | None = None
    state: str | None = None
    lead_type: str | None = None            # Personal | Commercial
    lines_of_business: str | None = None
    premium_estimate: float | None = None
    x_date: str | None = None               # when their current cover expires
    status: str | None = None
    lead_source: str | None = None
    owner_email: str | None = None
    next_action: str | None = None
    next_action_date: str | None = None
    nowcerts_insured_guid: str | None = None
    lost_reason: str | None = None
    created_by_email: str | None = None


@router.post("/api/leads")
def create_lead_endpoint(req: LeadWriteRequest):
    """Add a lead. Written to the CRM only — nothing reaches NowCerts here."""
    from hermes import leads as L

    supa = deps.get_supa()
    fields = req.model_dump(exclude_unset=True)
    creator = fields.pop("created_by_email", None)
    if fields.get("owner_email"):
        deps.require_users(supa, [("owner_email", fields["owner_email"])])
    try:
        lead = L.create_lead(supa, fields, created_by=creator)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        log.exception("create lead failed: %s", fields.get("name"))
        raise HTTPException(status_code=502, detail=str(exc))
    return {"ok": True, "lead": lead}


@router.get("/api/leads/{lead_id}")
def get_lead_endpoint(lead_id: str):
    """One lead and everything said to them so far."""
    from hermes import leads as L

    supa = deps.get_supa()
    try:
        lead = L.get_lead(supa, lead_id)
    except Exception:
        lead = None                 # malformed uuid → not found, not a 502
    if not lead:
        raise HTTPException(status_code=404, detail="lead not found")
    try:
        notes = L.list_notes(supa, lead_id)
    except Exception:  # noqa: BLE001 — a lead without its notes still opens
        log.exception("lead notes read failed: %s", lead_id)
        notes = []
    return {"lead": lead, "notes": notes, "statuses": list(L.LEAD_STATUSES)}


@router.patch("/api/leads/{lead_id}")
def update_lead_endpoint(lead_id: str, req: LeadWriteRequest):
    """Work a lead: status, owner, next action, the x-date you just found out."""
    from hermes import leads as L

    supa = deps.get_supa()
    fields = req.model_dump(exclude_unset=True)
    fields.pop("created_by_email", None)
    if fields.get("owner_email"):
        deps.require_users(supa, [("owner_email", fields["owner_email"])])
    try:
        lead = L.update_lead(supa, lead_id, fields)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        log.exception("update lead failed: %s", lead_id)
        raise HTTPException(status_code=502, detail=str(exc))
    return {"ok": True, "lead": lead}


@router.delete("/api/leads/{lead_id}")
def delete_lead_endpoint(lead_id: str):
    """Delete a lead. Its notes go with it (FK cascade). Prefer status='lost',
    which keeps the x-date — a lead that went elsewhere this year is a call to
    make next year."""
    from hermes import leads as L

    try:
        deps.get_supa().delete(L.TABLE, lead_id)
    except Exception as exc:
        log.exception("delete lead failed: %s", lead_id)
        raise HTTPException(status_code=502, detail=str(exc))
    return {"ok": True, "deleted": lead_id}


class LeadNoteRequest(BaseModel):
    body: str
    author_email: str | None = None


@router.post("/api/leads/{lead_id}/notes")
def add_lead_note_endpoint(lead_id: str, req: LeadNoteRequest):
    """Write down what was said. Append-only — the history is why the next call
    is not the same call again."""
    from hermes import leads as L

    supa = deps.get_supa()
    if not L.get_lead(supa, lead_id):
        raise HTTPException(status_code=404, detail="lead not found")
    try:
        note = L.add_note(supa, lead_id, req.body, author_email=req.author_email)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        log.exception("add lead note failed: %s", lead_id)
        raise HTTPException(status_code=502, detail=str(exc))
    return {"ok": True, "note": note}


class LeadConvertRequest(BaseModel):
    line_of_business: str
    opportunity_type: str | None = None
    premium_estimate: float | None = None
    assigned_to_email: str | None = None
    created_by: str | None = None


@router.post("/api/leads/{lead_id}/convert")
def convert_lead_endpoint(lead_id: str, req: LeadConvertRequest):
    """Turn a lead into a pipeline opportunity.

    Still nothing written to NowCerts: the deal is worked in the CRM and reaches
    the AMS when it is won. Idempotent — converting twice returns the same deal."""
    from hermes import leads as L

    supa = deps.get_supa()
    if req.assigned_to_email:
        deps.require_users(supa, [("assigned_to_email", req.assigned_to_email)])
    try:
        lead, opportunity = L.convert_to_opportunity(
            supa, lead_id,
            line_of_business=req.line_of_business,
            opportunity_type=req.opportunity_type,
            premium_estimate=req.premium_estimate,
            assigned_to_email=req.assigned_to_email,
            created_by=req.created_by,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        log.exception("lead conversion failed: %s", lead_id)
        raise HTTPException(status_code=502, detail=str(exc))
    return {"ok": True, "lead": lead, "opportunity": opportunity}


@router.get("/api/intake/queue")
def intake_queue_endpoint(limit: int = 50):
    """Intake submissions waiting on a human, oldest first.

    Oldest first on purpose: the useful signal is what has been sitting, not what
    just arrived. ``oldest_age_days`` is surfaced because a queue that stopped
    moving looks identical to a busy one if you only report the count.
    """
    supa = deps.get_supa()
    rows = supa.select(
        "intake_submissions",
        columns="id,source,agent,intake_kind,client_identifier,lob_code,status,"
                "approval_token,retry_count,created_at,updated_at",
        params={"status": "eq.awaiting_approval", "order": "created_at.asc"},
        limit=limit,
    )
    failed = supa.select(
        "intake_submissions", columns="id,client_identifier,status,error_log,updated_at",
        params={"status": "eq.failed", "order": "updated_at.desc"}, limit=20,
    )
    oldest_age = None
    if rows:
        try:
            oldest = datetime.fromisoformat(str(rows[0].get("created_at")).replace("Z", "+00:00"))
            oldest_age = (datetime.now(oldest.tzinfo) - oldest).days
        except (ValueError, TypeError):
            oldest_age = None
    return {
        "awaiting_approval": rows,
        "awaiting_count": len(rows),
        "oldest_age_days": oldest_age,
        "failed_recent": failed,
        "failed_count": len(failed),
    }


@router.post("/api/intake/run")
def run_intake_writebacks(req: deps.ExecutorRunRequest):
    """Drain approved intake routing intents to CRM (opportunities) + NowCerts (insured)
    on command (opt-in, no cron). ``dry_run`` previews without writing."""
    from hermes_intake.lane.intake_executor import run_intake_executor

    summary = run_intake_executor(supa=deps.get_supa(), limit=req.limit, dry_run=req.dry_run)
    return {"ok": True, **summary}


@router.get("/api/pipeline/stages")
def pipeline_stages_endpoint():
    """The stage vocabulary, in order, per pipeline.

    A kanban has to know its columns and their order before it can draw them, and
    hardcoding the list in the browser is how the board drifts from what the
    backend will accept on a stage move. Same source both sides.
    """
    from hermes_core.opportunities import (
        LOST_STAGES,
        NEW_BUSINESS_STAGES,
        OPPORTUNITY_TYPES,
        RENEWAL_STAGES,
        RENEWAL_TYPES,
        WON_STAGES,
    )

    return {
        "new_business": list(NEW_BUSINESS_STAGES),
        "renewal": list(RENEWAL_STAGES),
        "won": sorted(WON_STAGES),
        "lost": sorted(LOST_STAGES),
        # Which types are worked on the renewal ladder, and the full vocabulary.
        # Shipped rather than re-derived in the browser: "is this a renewal" has
        # to mean the same thing on the board as it does when a stage move is
        # validated, and a substring test on the type name would quietly sweep in
        # "Remarket" — a different pipeline with a different ladder.
        "renewal_types": sorted(RENEWAL_TYPES),
        "types": list(OPPORTUNITY_TYPES),
    }


@router.post("/agency-intake", response_model=AgencyIntakeResponse)
def agency_intake(req: AgencyIntakeRequest):
    """Stage an agency intake draft. Returns draft_id + approval prompt.

    Nothing is written to CRM yet — caller must POST /agency-intake/approve
    with an approval token (APPROVE ALL, APPROVE CRM ONLY, etc.).
    """
    from hermes_intake.agency_intake import AgencyIntakeError, stage_draft

    if not req.raw_text or not req.raw_text.strip():
        raise HTTPException(status_code=400, detail="raw_text is required")
    try:
        draft = stage_draft(
            deps.get_supa(),
            raw_text=req.raw_text,
            submitted_by=req.submitted_by,
            source_type=req.source_type,
            source_ref=req.source_ref,
        )
    except AgencyIntakeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        log.exception("agency_intake staging failed")
        raise HTTPException(status_code=500, detail=str(exc))
    return AgencyIntakeResponse(
        ok=True,
        draft_id=draft.draft_id,
        approval_prompt=draft.approval_prompt,
        validation_warnings=draft.validation_warnings,
        payload_preview=draft.payload,
    )


@router.post("/agency-intake/approve", response_model=AgencyIntakeApprovalResponse)
def agency_intake_approve(req: AgencyIntakeApprovalRequest):
    """Apply an approval token to a staged agency intake draft.

    Same shared logic the interactive approval button calls.
    """
    from hermes_intake.approval import ApprovalError, approve_draft

    try:
        result = approve_draft(
            deps.get_supa(),
            draft_id=req.draft_id,
            token=req.token,
            approver=req.approver,
        )
    except ApprovalError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        log.exception("agency_intake_approve failed for draft=%s", req.draft_id)
        raise HTTPException(status_code=500, detail=str(exc))
    return AgencyIntakeApprovalResponse(
        ok=result.ok,
        draft_id=result.draft_id,
        token=result.token,
        status=result.status,
        summary=result.summary,
        enqueued_queue_ids=result.enqueued_queue_ids,
        retrieval_row_ids=result.retrieval_row_ids,
        error=result.error,
    )


def _require_intake_api_key(request: Request) -> None:
    """Validate ``X-RSG-API-Key`` header against ``RSG_INTAKE_API_KEY`` env."""
    expected = os.environ.get("RSG_INTAKE_API_KEY", "").strip()
    if not expected:
        # Misconfiguration: never silently accept; refuse with 503.
        log.error("RSG_INTAKE_API_KEY is unset — refusing /api/intake")
        raise HTTPException(status_code=503, detail="intake endpoint not configured")
    provided = request.headers.get("x-rsg-api-key", "")
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="invalid or missing X-RSG-API-Key")


def _intake_status_url(request: Request, submission_id: str) -> str:
    base = os.environ.get("HERMES_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if not base:
        base = str(request.base_url).rstrip("/")
    return f"{base}/api/intake/{submission_id}/status"


@router.post("/api/intake")
def intake_submit(req: IntakeSubmissionRequest, request: Request):
    """Accept an intake submission and insert one row in ``intake_submissions``.

    On a fresh insert: returns 202 with ``submission_id``, ``status_url``, etc.
    On idempotent replay (same ``idempotency_key``): returns 200 with the
    existing row's state. The Phase 3 worker picks up ``status='received'``
    rows asynchronously; this endpoint never blocks on downstream processing.
    """
    from hermes_intake.submissions import (
        IntakeError,
        insert_submission,
    )
    from hermes_integrations.supabase_client import SupabaseClientError

    _require_intake_api_key(request)

    payload = {
        "transcript": req.transcript,
        "documents": [deps.model_dict(d) for d in req.documents],
        "coaching_snapshot": deps.model_dict(req.coaching_snapshot) if req.coaching_snapshot else None,
        "notes": req.notes,
    }
    # Only carried when supplied — an absent key is what tells the worker to
    # synthesize, and storing an explicit null would be indistinguishable from
    # a caller who sent an empty one.
    if req.synthesized_payload:
        payload["synthesized_payload"] = req.synthesized_payload
    # Likewise for the approval: absent means "wait for an approver".
    if req.approved_by:
        payload["approval"] = {
            "approved_by": req.approved_by.strip(),
            "token": (req.approval_token or "APPROVE ALL").strip().upper(),
        }

    try:
        row, is_new = insert_submission(
            deps.get_supa(),
            idempotency_key=req.idempotency_key,
            source=req.source,
            agent=req.agent,
            intake_kind=req.intake_kind,
            client_identifier=req.client_identifier,
            lob_code=req.lob_code,
            captured_at=req.captured_at,
            payload=payload,
        )
    except IntakeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except SupabaseClientError as exc:
        log.exception("intake_submissions insert failed key=%s", req.idempotency_key)
        raise HTTPException(status_code=502, detail=f"supabase write failed: {exc}")

    submission_id = str(row.get("id"))
    status = str(row.get("status", "received"))

    # Commit inline when there is genuinely nothing left to wait for: the payload
    # is already synthesized and a human already approved it. The asynchronous
    # worker buys time for an LLM extraction, a Slack round trip and an approval
    # wait — none of which apply here. Queueing anyway would leave the operator
    # looking at "accepted" while the intake had not moved, and in this deployment
    # it would never move: nothing runs the worker loop.
    #
    # Only on a fresh insert. A replay must not re-commit — the first submission
    # already did, and the row is past 'received'.
    commit: dict[str, Any] | None = None
    if is_new and req.approved_by and req.synthesized_payload:
        from hermes_intake.worker import commit_submission_now

        try:
            commit = commit_submission_now(deps.get_supa(), submission_id)
        except Exception as exc:  # noqa: BLE001 — the row's own state is the record
            log.exception("synchronous intake commit failed id=%s", submission_id)
            commit = {"ok": False, "status": "failed", "error": str(exc)}
        status = str(commit.get("status") or status)

    body = deps.model_dict(
        IntakeSubmissionResponse(
            submission_id=submission_id,
            status=status,
            status_url=_intake_status_url(request, submission_id),
            created_at=str(row.get("created_at", "")),
            idempotent_replay=not is_new,
            commit=commit,
        )
    )
    # 201 when it is actually in the CRM; 202 still means "accepted, not yet done".
    if commit is not None:
        if commit.get("ok"):
            return JSONResponse(status_code=201, content=body)
        # `detail` is where every other error on this API puts its reason, and it
        # is what clients read. Without it a failed commit reads as a bare 502 and
        # the actual cause — which the row already knows — is lost to the operator.
        body["detail"] = str(commit.get("error") or "intake commit failed")
        return JSONResponse(status_code=502, content=body)
    return JSONResponse(status_code=202 if is_new else 200, content=body)
