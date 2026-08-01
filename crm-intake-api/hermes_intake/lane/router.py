"""Intake router — fan a synthesized submission out three ways (Phase 2).

Given a ``SubmissionObject`` (deterministic extract + top-model synthesis have run),
decide where each piece belongs:

- **CRM** ← sales only: one opportunity per line of business, so each can be worked.
- **AMS** (NowCerts) ← the structured rest: the insured/prospect identity + the
  incumbent policy. A *create* path, distinct from the case/task *relay*.
- **PDF** ← the remainder: schedules, loss history, coverage narrative — things that
  live on the source document as evidence, never force-fit into fields.

``plan_routing`` is pure (no writes) — it produces the approval artifact. ``stage_routing``
enqueues the plan as gated ``outbound_sync_queue`` intents (additive, human-approved,
nothing writes synchronously); a downstream executor drains them to CRM / NowCerts.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from hermes_intake.lane.submission import SubmissionObject
from hermes_core.queue import (
    DESTINATION_CRM,
    DESTINATION_NOWCERTS,
    OBJECT_TYPE_INTAKE_AMS as OBJECT_TYPE_AMS,
    OBJECT_TYPE_INTAKE_CRM as OBJECT_TYPE_CRM,
    QUEUE_TABLE,
)

log = logging.getLogger(__name__)




def _clean(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v not in (None, "", [], {})}


def _client_name(sub: SubmissionObject) -> str | None:
    if sub.client_name:
        return sub.client_name
    if sub.applicant and sub.applicant.legal_name:
        return sub.applicant.legal_name
    return None


def _lines_of_business(sub: SubmissionObject) -> list[str]:
    """The LOBs to open opportunities for — the submission's lob plus any coverage
    lines requested. De-duped, order-preserving."""
    lobs: list[str] = []
    if sub.lob is not None:
        lobs.append(getattr(sub.lob, "value", str(sub.lob)))
    for key in (sub.coverage_request or {}):
        lobs.append(str(key))
    seen: set[str] = set()
    return [x for x in lobs if x and not (x in seen or seen.add(x))]


def plan_routing(sub: SubmissionObject) -> dict[str, Any]:
    """Decide the three-way split. Pure — no writes. This is the approval artifact."""
    client = _client_name(sub)

    # CRM — one opportunity per line of business (sales only).
    crm = [
        {
            "insured_name": client,
            "line_of_business": lob,
            "opportunity_type": "New Business",
            "stage": "new",
            "premium_estimate": sub.current_premium,   # incumbent premium anchors the estimate
            "carrier": sub.current_carrier,            # incumbent, for remarket context
            "source": "intake",
            "submission_id": sub.submission_id,
        }
        for lob in _lines_of_business(sub)
    ]

    # AMS — the structured rest: insured identity + the incumbent policy.
    ap = sub.applicant
    addr = ap.mailing_address if ap else None
    insured = _clean({
        "name": client,
        "fein": ap.fein if ap else None,
        "naics": ap.naics if ap else None,
        "sic": ap.sic if ap else None,
        "phone": ap.phone if ap else None,
        "email": ap.email if ap else None,
        "website": ap.website if ap else None,
        "entity_type": getattr(ap.entity_type, "value", None) if ap and ap.entity_type else None,
        "address_line1": addr.street if addr else None,
        "city": addr.city if addr else None,
        "state": addr.state if addr else None,
        "zip": addr.zip if addr else None,
    })
    incumbent_policy = _clean({
        "carrier": sub.current_carrier,
        "premium": sub.current_premium,
        "expiration_date": sub.current_policy_expiration.isoformat() if sub.current_policy_expiration else None,
    })
    ams: dict[str, Any] = {}
    if insured:
        ams["insured"] = insured
    if incumbent_policy:
        ams["incumbent_policy"] = incumbent_policy

    # PDF — the remainder that stays on the source document as evidence.
    pdf: list[str] = []
    lh = sub.loss_history
    if lh and (lh.claims or lh.no_losses_attested):
        pdf.append("loss_history")
    if sub.prior_carriers:
        pdf.append("prior_carriers")
    if sub.drivers:
        pdf.append("driver_schedule")
    if sub.vehicles:
        pdf.append("vehicle_schedule")
    if sub.property_locations:
        pdf.append("property_schedule")
    if sub.coverage_request:
        pdf.append("coverage_detail")
    if sub.intake and sub.intake.note:
        pdf.append("intake_note")

    return {
        "submission_id": sub.submission_id,
        "client_name": client,
        "crm": crm,
        "ams": ams,
        "pdf_kept_on_document": pdf,
        "source_files": list(sub.intake.raw_files) if sub.intake else [],
    }


def routing_summary(plan: dict[str, Any]) -> str:
    """One-glance human summary of the plan, for the review gate."""
    crm_lines = ", ".join(o["line_of_business"] for o in plan.get("crm", [])) or "none"
    ams = plan.get("ams", {})
    ams_bits = []
    if ams.get("insured"):
        ams_bits.append("insured")
    if ams.get("incumbent_policy"):
        ams_bits.append("incumbent policy")
    ams_str = " + ".join(ams_bits) or "none"
    pdf = ", ".join(plan.get("pdf_kept_on_document", [])) or "none"
    return (
        f"{plan.get('client_name') or 'Unknown client'}\n"
        f"  CRM (sales): {len(plan.get('crm', []))} opportunity(ies) — {crm_lines}\n"
        f"  AMS: {ams_str}\n"
        f"  Stays on document: {pdf}"
    )


def stage_routing(supa, plan: dict[str, Any], *, approved_by: str) -> dict[str, Any]:
    """Enqueue the approved plan as gated ``outbound_sync_queue`` intents.

    Nothing writes to CRM/NowCerts here — a downstream executor drains these. The
    PDF remainder is informational (it already lives with the document).
    """
    now = datetime.now(timezone.utc).isoformat()
    staged = {"crm_queued": 0, "ams_queued": 0, "pdf_kept": len(plan.get("pdf_kept_on_document", []))}
    submission_id = plan.get("submission_id")

    for opp in plan.get("crm", []):
        supa.insert(QUEUE_TABLE, {
            "object_type": OBJECT_TYPE_CRM,
            "object_id": submission_id,
            "destination_system": DESTINATION_CRM,
            "action": "create",
            "payload": {"kind": "opportunity", "opportunity": opp},
            "status": "queued",
            "attempt_count": 0,
            "approved_by": approved_by,
            "approved_at": now,
        })
        staged["crm_queued"] += 1

    ams = plan.get("ams", {})
    if ams:
        supa.insert(QUEUE_TABLE, {
            "object_type": OBJECT_TYPE_AMS,
            "object_id": submission_id,
            "destination_system": DESTINATION_NOWCERTS,
            "action": "create",
            "payload": {"kind": "insured_bundle", "ams": ams},
            "status": "queued",
            "attempt_count": 0,
            "approved_by": approved_by,
            "approved_at": now,
        })
        staged["ams_queued"] += 1

    return staged


def stage_selection_opportunities(
    supa, sub: SubmissionObject, form_ids: list[str], *, approved_by: str,
    answers: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Stage one gated ``intake_crm`` opportunity per ACORD line the agent selected.

    The counterpart to ``stage_routing`` for the on-demand ACORD flow: the lines the
    agent *checked* (via ``acord_selection.plan_selection``) drive which opportunities
    are created — not the submission's inferred LOBs. Reuses ``stage_routing`` so the
    queue-row shape and the human-approved gate are identical; a supplemental (163)
    makes no opportunity, so nothing is staged for it.

    Enforces the ACORD Y/N question gate: ``answers`` (checkbox field → answer) must
    resolve every in-scope agent question for the selected lines, or this raises —
    nothing stages to the queue (and therefore not to CRM/AMS) while a required
    underwriting question is unanswered.
    """
    from hermes_intake.acord import acord_selection, acord_questions

    plan = acord_selection.plan_selection(sub, form_ids)

    unanswered = acord_questions.unanswered_required(plan.lines, answers or {})
    if unanswered:
        raise ValueError(
            f"{len(unanswered)} required ACORD question(s) unanswered — cannot stage. "
            f"First: {unanswered[0].question[:80]}"
        )
    crm = [
        {
            **opp,
            "premium_estimate": sub.current_premium,
            "carrier": sub.current_carrier,
            "submission_id": sub.submission_id,
        }
        for opp in plan.opportunities
    ]
    routing_plan = {
        "submission_id": sub.submission_id,
        "client_name": _client_name(sub),
        "crm": crm,
        "ams": {},                       # this bridge stages opportunities only
        "pdf_kept_on_document": [],
    }
    staged = stage_routing(supa, routing_plan, approved_by=approved_by)
    staged["lines"] = plan.lines
    return staged


def process_intake(supa, sub: SubmissionObject, text: str, *, doc_type: str = "dec_page",
                   approved_by: str | None = None, model: str | None = None) -> dict[str, Any]:
    """The whole intake router in one call: synthesize (top model) → route → stage.

    Without ``approved_by`` this is a dry run — it returns the plan + summary for the
    review gate. With ``approved_by`` it also stages the gated queue intents. Synthesis
    is safe/additive: if the LLM is unavailable it no-ops and routing proceeds on the
    fields already present.
    """
    from hermes_intake.lane.synthesis import enrich_submission

    sub = enrich_submission(sub, text, doc_type=doc_type, model=model)
    plan = plan_routing(sub)
    result: dict[str, Any] = {
        "submission_id": sub.submission_id,
        "plan": plan,
        "summary": routing_summary(plan),
    }
    if approved_by:
        result["staged"] = stage_routing(supa, plan, approved_by=approved_by)
    return result
