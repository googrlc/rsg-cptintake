"""Intake drain executor — push approved routing intents to live systems (Phase 3).

The router (`router.py`) stages gated ``outbound_sync_queue`` rows: ``intake_crm``
(one opportunity per LOB → Supabase ``opportunities``) and ``intake_ams`` (the insured
bundle → NowCerts ``create_insured``). This executor claims those approved rows and
performs the writes.

Same guarantees as the casework/renewal executors: nothing writes synchronously,
guarded claim, dry-run previews, **opt-in** (no auto-cron until validated live).
NowCerts ``create_insured`` upserts on CommercialName / FirstName+LastName, so re-runs
don't duplicate insureds.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from hermes_intake.lane.router import OBJECT_TYPE_AMS, OBJECT_TYPE_CRM
from hermes_core.queue import (
    QUEUE_COMPLETED,
    QUEUE_FAILED,
    QUEUE_PROCESSING,
    QUEUE_QUEUED,
    QUEUE_TABLE,
    extract_created_id as _extract_created_id,
    utcnow as _utcnow,
)

if TYPE_CHECKING:
    from hermes_integrations.supabase_client import SupabaseClient
    from hermes_integrations.nowcerts_client import NowCertsClient

log = logging.getLogger(__name__)

OPPORTUNITIES_TABLE = "opportunities"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def map_opportunity_row(opp: dict[str, Any]) -> dict[str, Any]:
    """Router opportunity draft -> Supabase opportunities row."""
    name = opp.get("insured_name")
    return {
        "client_identifier": name,
        "insured_name": name,
        "line_of_business": opp.get("line_of_business"),
        "opportunity_type": opp.get("opportunity_type") or "New Business",
        "stage": opp.get("stage") or "new",
        "premium_estimate": opp.get("premium_estimate"),
        "carrier": opp.get("carrier"),
        "source": "intake",
        "sync_source": "intake",
    }


def map_insured_payload(insured: dict[str, Any]) -> dict[str, Any]:
    """Router insured bundle -> NowCerts /api/Insured/Insert (PascalCase) body."""
    body = {
        "CommercialName": insured.get("name"),
        "FEIN": insured.get("fein"),
        "AddressLine1": insured.get("address_line1"),
        "City": insured.get("city"),
        "State": insured.get("state"),
        "Zip": insured.get("zip"),
        "Email": insured.get("email"),
        "Phone": insured.get("phone"),
    }
    return {k: v for k, v in body.items() if v not in (None, "")}


def _eligible_jobs(supa, limit):
    # Local import: retry.py imports OBJECT_TYPE_CRM/AMS from router, and this
    # module imports those too — keep the dependency one-directional.
    from hermes_core.queue import due_filter

    return supa.select(
        QUEUE_TABLE, columns="*",
        params={
            "object_type": f"in.({OBJECT_TYPE_CRM},{OBJECT_TYPE_AMS})",
            "status": f"eq.{QUEUE_QUEUED}",
            **due_filter(),
            "order": "created_at.asc",
        },
        limit=limit,
    )


def run_intake_executor(
    *,
    supa: "SupabaseClient | None" = None,
    nowcerts: "NowCertsClient | None" = None,
    limit: int = 1,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Drain up to ``limit`` approved intake intents. ``dry_run`` is side-effect-free."""
    if supa is None:
        from hermes_integrations.supabase_client import SupabaseClient

        supa = SupabaseClient()
    summary: dict[str, Any] = {"claimed": 0, "crm": 0, "ams": 0, "failed": 0, "previews": []}

    for job in _eligible_jobs(supa, limit)[:limit]:
        payload = dict(job.get("payload") or {})
        object_type = job.get("object_type")

        if dry_run:
            summary["previews"].append({"queue_id": job.get("id"), "object_type": object_type,
                                        "kind": payload.get("kind")})
            continue

        claimed = supa.update_where(
            QUEUE_TABLE,
            {"status": QUEUE_PROCESSING, "updated_at": _utcnow().isoformat()},
            filters={"id": f"eq.{job.get('id')}", "status": f"eq.{QUEUE_QUEUED}"},
        )
        if not claimed:
            continue
        summary["claimed"] += 1

        try:
            if object_type == OBJECT_TYPE_CRM:
                opp = payload.get("opportunity") or {}
                supa.insert(OPPORTUNITIES_TABLE, map_opportunity_row(opp))
                summary["crm"] += 1
            elif object_type == OBJECT_TYPE_AMS:
                if nowcerts is None:
                    from hermes_integrations.nowcerts_client import NowCertsClient

                    nowcerts = NowCertsClient()
                insured = (payload.get("ams") or {}).get("insured") or {}
                if not insured:
                    raise ValueError("intake_ams job has no insured payload")
                resp = nowcerts.create_insured(map_insured_payload(insured))
                _extract_created_id(resp)  # tolerate no id in the response
                summary["ams"] += 1
            else:
                raise ValueError(f"unexpected object_type {object_type!r}")

            supa.update(QUEUE_TABLE, job.get("id"),
                        {"status": QUEUE_COMPLETED, "updated_at": _utcnow().isoformat()})
        except Exception as exc:  # noqa: BLE001
            log.exception("intake executor failed on queue_id=%s", job.get("id"))
            supa.update(QUEUE_TABLE, job.get("id"),
                        {"status": QUEUE_FAILED, "updated_at": _utcnow().isoformat(),
                         "last_error": str(exc)[:2000]})
            summary["failed"] += 1

    return summary
