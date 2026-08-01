"""Intake executor — drains approved NowCerts insured-create jobs (opt-in).

Mirrors the renewal executor: claims one approved ``intake`` job at a time,
calls ``create_insured`` (prospect), backfills the linked opportunities'
``insured_id``, and marks the queue row completed. ``dry_run`` previews the
insured payload without claiming or writing — use it to verify the NowCerts
insert field casing before the first live run.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from hermes_core import opportunities as opp
from hermes_intake.commit import OBJECT_TYPE_INTAKE
from hermes_core.queue import (
    DESTINATION_NOWCERTS,
    QUEUE_COMPLETED,
    QUEUE_FAILED,
    QUEUE_PROCESSING,
    QUEUE_QUEUED,
    QUEUE_TABLE,
    utcnow as _utcnow,
)

if TYPE_CHECKING:
    from hermes_integrations.supabase_client import SupabaseClient
    from hermes_integrations.nowcerts_client import NowCertsClient

log = logging.getLogger(__name__)


def _eligible_jobs(supa: "SupabaseClient", *, limit: int) -> list[dict[str, Any]]:
    return supa.select(
        QUEUE_TABLE,
        params={
            "object_type": f"eq.{OBJECT_TYPE_INTAKE}",
            "destination_system": f"eq.{DESTINATION_NOWCERTS}",
            "status": f"eq.{QUEUE_QUEUED}",
            "approved_by": "not.is.null",
            "approved_at": "not.is.null",
            # Honor backoff: skip jobs scheduled for the future.
            "or": f"(scheduled_for.is.null,scheduled_for.lte.{_utcnow().isoformat()})",
            "order": "created_at.asc",
        },
        limit=max(limit, 1),
    )


def _extract_insured_id(resp: Any) -> str | None:
    if isinstance(resp, dict):
        for k in ("databaseId", "DatabaseId", "id", "Id", "insuredDatabaseId"):
            if resp.get(k):
                return str(resp[k])
        nested = resp.get("data") or resp.get("result")
        if isinstance(nested, dict):
            for k in ("databaseId", "DatabaseId", "id", "Id"):
                if nested.get(k):
                    return str(nested[k])
    return None


def run_intake_executor(
    *,
    supa: "SupabaseClient | None" = None,
    nowcerts: "NowCertsClient | None" = None,
    limit: int = 1,
    dry_run: bool = False,
    now: Any = None,
) -> dict[str, Any]:
    """Process up to ``limit`` approved intake jobs. ``dry_run`` is side-effect-free."""
    if supa is None:
        from hermes_integrations.supabase_client import SupabaseClient

        supa = SupabaseClient()
    now = now or _utcnow()
    summary: dict[str, Any] = {"claimed": 0, "completed": 0, "failed": 0, "previews": []}

    jobs = _eligible_jobs(supa, limit=limit)
    if not jobs:
        return summary

    for job in jobs[:limit]:
        payload = dict(job.get("payload") or {})
        insured = payload.get("insured") or {}
        opportunity_ids = payload.get("opportunity_ids") or []

        if dry_run:
            summary["previews"].append(
                {"queue_id": job.get("id"), "insured": insured, "opportunity_ids": opportunity_ids}
            )
            continue

        # Guarded claim: queued -> processing.
        claimed = supa.update_where(
            QUEUE_TABLE,
            {"status": QUEUE_PROCESSING, "updated_at": now.isoformat()},
            filters={"id": f"eq.{job.get('id')}", "status": f"eq.{QUEUE_QUEUED}"},
        )
        if not claimed:
            continue  # another cycle grabbed it
        summary["claimed"] += 1

        if nowcerts is None:
            from hermes_integrations.nowcerts_client import NowCertsClient

            nowcerts = NowCertsClient()

        try:
            resp = nowcerts.create_insured(insured)
            insured_id = _extract_insured_id(resp)
            for oid in opportunity_ids:
                if insured_id and oid:
                    try:
                        opp.link_nowcerts(supa, oid, insured_id=insured_id)
                    except Exception:
                        log.exception("intake: failed to link opportunity %s to insured %s", oid, insured_id)
            supa.update(
                QUEUE_TABLE, job.get("id"),
                {"status": QUEUE_COMPLETED, "updated_at": _utcnow().isoformat()},
            )
            summary["completed"] += 1
        except Exception as exc:  # noqa: BLE001 — one bad job must not kill the run
            log.exception("intake executor failed on queue_id=%s", job.get("id"))
            supa.update(
                QUEUE_TABLE, job.get("id"),
                {"status": QUEUE_FAILED, "updated_at": _utcnow().isoformat(), "last_error": str(exc)[:2000]},
            )
            summary["failed"] += 1

    return summary
