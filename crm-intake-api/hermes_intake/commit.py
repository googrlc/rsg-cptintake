"""Commit an approved new-business intake — Supabase pipeline, CRM-only by default.

On approval this:
  1. Creates the Supabase ``opportunities`` rows (the pipeline — immediate, no AMS write).
  2. Creates the client's Nextcloud folder tree (if configured).
  3. Only when ``HERMES_INTAKE_STAGES_AMS_INSURED=1``: stages a NowCerts
     ``create_insured`` (prospect) job on ``outbound_sync_queue``.

Step 3 is OFF by default, and that default is the agency's rule rather than a
matter of caution:

    The CRM is the working copy; NowCerts is the record of what is REAL.

An intake is a prospect. A prospect is not a record of insurance, and a book
filled with prospects who never bought is a book that means nothing — the same
reasoning that put the lead station in ``crm_leads`` instead of the AMS. The
insured reaches NowCerts when a deal on it is WON, which is what the won-push
executor does with ``opportunities.policy_number``.

The staging path is kept, not deleted, because there are real cases for it (a
migration, a backfill, an account that genuinely exists already). It just has to
be asked for. Nothing here has ever written to NowCerts synchronously.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from hermes_intake import nowcerts_map
from hermes_core import opportunities as opp
from hermes_core.queue import (
    DESTINATION_NOWCERTS,
    OBJECT_TYPE_INTAKE,
    QUEUE_QUEUED,
    QUEUE_TABLE,
)

if TYPE_CHECKING:
    from hermes_integrations.nextcloud_client import NextcloudClient
    from hermes_integrations.supabase_client import SupabaseClient

log = logging.getLogger(__name__)

INTAKE_ACTION_CREATE_INSURED = "create_insured"
DEFAULT_ASSIGNEE = "gretchen"

# Opt-in: stage the NowCerts prospect create on intake commit. See the module
# docstring — the default is off because an intake is not yet a record of
# insurance.
ENV_STAGE_AMS_INSURED = "HERMES_INTAKE_STAGES_AMS_INSURED"


def stages_ams_insured(env: "dict[str, str] | None" = None) -> bool:
    """Whether an intake commit stages a NowCerts insured create.

    Only an explicit "1"/"true"/"yes" turns it on. Anything else — unset, empty,
    a typo — reads as off, because the failure mode of guessing wrong here is
    prospects silently landing in the system of record.
    """
    raw = (env if env is not None else os.environ).get(ENV_STAGE_AMS_INSURED, "")
    return str(raw).strip().lower() in ("1", "true", "yes")


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stage_insured_job(
    supa: "SupabaseClient",
    *,
    insured_payload: dict[str, Any],
    client_identifier: str,
    opportunity_ids: list[str],
    approved_by: str,
) -> dict[str, Any]:
    return supa.insert(
        QUEUE_TABLE,
        {
            "object_type": OBJECT_TYPE_INTAKE,
            "object_id": client_identifier,
            "destination_system": DESTINATION_NOWCERTS,
            "action": "create",
            "payload": {
                "action": INTAKE_ACTION_CREATE_INSURED,
                "insured": insured_payload,
                "client_identifier": client_identifier,
                "opportunity_ids": opportunity_ids,
            },
            "status": QUEUE_QUEUED,
            "attempt_count": 0,
            "approved_by": approved_by,       # human approved the intake token
            "approved_at": _utcnow_iso(),
        },
    )


def commit_intake(
    supa: "SupabaseClient",
    *,
    account: dict[str, Any],
    opportunities_spec: list[dict[str, Any]],
    approved_by: str,
    prospect_type: str = "Prospect",
    insured_type: str | None = None,
    nextcloud: "NextcloudClient | None" = None,
    source: str | None = None,
    created_by: str = "hermes-intake",
    assigned_to: str = DEFAULT_ASSIGNEE,
) -> dict[str, Any]:
    """Commit an approved intake. Returns a summary. No synchronous NowCerts write."""
    if not opportunities_spec:
        raise ValueError("opportunities_spec must have at least one line of business")

    name = account.get("account_name") or account.get("commercial_name") or account.get("name")
    fein = account.get("fein") or account.get("ein")
    cid = opp.make_client_identifier(name, fein)
    itype = nowcerts_map.normalize_insured_type(
        insured_type or account.get("insured_type") or account.get("segment")
    )
    ptype = nowcerts_map.normalize_prospect_type(prospect_type)

    # 1. Supabase pipeline rows (one per LOB).
    opp_rows: list[dict[str, Any]] = []
    for spec in opportunities_spec:
        lob = spec.get("line_of_business")
        if not lob:
            continue
        # Per-line owner and description win over the intake-wide default. An
        # intake that says who works a line and what the deal actually is knows
        # more than the fallback does; dropping that is how every intake
        # opportunity lands on one person's desk with a blank card.
        #
        # `stage` is deliberately NOT carried across. The intake contract's stage
        # vocabulary ("Discovery", "Quoting", ...) is not the pipeline's ("Not
        # Assigned", "Preparing Application", ...), and create_opportunity raises
        # on an unknown stage — so passing it through would fail the whole commit
        # over a word. The type's first stage is correct for a new intake anyway.
        row, _created = opp.create_opportunity(
            supa,
            client_identifier=cid,
            line_of_business=lob,
            insured_name=name,
            prospect_type=ptype,
            insured_type=itype,
            premium_estimate=spec.get("premium_estimate"),
            carrier=spec.get("carrier"),
            lead_source=account.get("lead_source"),
            assigned_to=spec.get("assigned_to") or assigned_to,
            description=spec.get("description"),
            source=source,
            created_by=created_by,
        )
        opp_rows.append(row)

    # 2. NowCerts insured-create job — opt-in only (see the module docstring).
    # ptype (Hot/Cold/Prospect) stays on the opportunities row; the NowCerts
    # insured write uses the connector's numeric type code (prospect=1).
    #
    # The payload is still BUILT when staging is off. It costs nothing, it goes
    # back in the summary as `insured_preview`, and it is what lets an operator
    # see exactly what would reach the AMS without anything being queued.
    insured_payload = nowcerts_map.map_to_insured(account, insured_type=itype, is_prospect=True)
    job: dict[str, Any] = {}
    staged_ams = stages_ams_insured()
    if staged_ams:
        job = _stage_insured_job(
            supa,
            insured_payload=insured_payload,
            client_identifier=cid,
            opportunity_ids=[r.get("id") for r in opp_rows],
            approved_by=approved_by,
        )

    # 2b. Prompt AMS pull-back: link an existing insured now (and pull its segment
    # fields onto the row), or kick the just-staged create/link job immediately —
    # so the pipeline row is tied to NowCerts within seconds, not next scheduler
    # cycle. Best-effort: never fails the commit.
    #
    # The LOOKUP always runs: an intake for a client who already exists in the AMS
    # should be linked to them, and that is a read plus a CRM-side update. Only the
    # executor kick is conditional — with nothing staged there is no job to run, and
    # kicking anyway would drain unrelated queued work as a side effect of an intake.
    prime: dict[str, Any] = {}
    try:
        from hermes_intake.opportunity_priming import prime_new_opportunities

        prime = prime_new_opportunities(supa, opp_rows, kick_executor=staged_ams)
    except Exception:
        log.exception("intake commit: opportunity priming failed for %s", cid)

    # 3. Nextcloud client folder tree (best-effort).
    folder = None
    nc = nextcloud
    if nc is None:
        from hermes_integrations.nextcloud_client import NextcloudClient

        nc = NextcloudClient()
    try:
        if nc.is_configured() and name:
            folder = nc.ensure_client_folders(str(name))
    except Exception:
        folder = None

    return {
        "client_identifier": cid,
        "opportunities": opp_rows,
        "opportunity_count": len(opp_rows),
        # None when nothing was staged. `ams_insured_staged` says which of the two
        # reasons that is, so "no job id" is never read as a silent failure.
        "intake_job_id": job.get("id"),
        "ams_insured_staged": staged_ams,
        "insured_preview": insured_payload,
        "nextcloud_folder": folder,
        "prospect_type": ptype,
        "insured_type": itype,
        "prime": prime,
    }


_PERSONAL_LOBS = {
    "personal auto", "homeowners", "renters", "condo", "dwelling fire",
    "motorcycle", "boat", "rv", "umbrella (personal)",
}


def _derive_insured_type(account: dict[str, Any], opportunities_spec: list[dict[str, Any]]) -> str | None:
    explicit = nowcerts_map.normalize_insured_type(
        account.get("account_type") or account.get("insured_type") or account.get("segment") or account.get("type")
    )
    if explicit:
        return explicit
    lobs = {(s.get("line_of_business") or "").strip().lower() for s in opportunities_spec}
    if lobs & _PERSONAL_LOBS:
        return "Personal"
    return "Commercial" if any(lobs) else None


def commit_draft(
    supa: "SupabaseClient",
    payload: dict[str, Any],
    *,
    approved_by: str,
    nextcloud: "NextcloudClient | None" = None,
    source: str | None = None,
) -> dict[str, Any]:
    """Adapt an intake draft/submission payload (account + opportunities) → commit_intake.

    This is the bridge the intake worker calls once a submission is approved.
    Raises ValueError if the draft carries no line of business to open a pipeline on.
    """
    account = payload.get("account") or {}
    opps = payload.get("opportunities") or []
    spec = [
        {
            "line_of_business": o.get("line_of_business"),
            "premium_estimate": o.get("premium") or o.get("target_premium"),
            "carrier": o.get("carrier"),
            # A submitter that already decided the owner (the intake gate applies
            # the agency's personal/commercial split per line) keeps it. Absent,
            # commit_intake's default applies.
            "assigned_to": o.get("assigned_to"),
            # Where the deal came from and what still needs checking. Without it
            # the pipeline card is a line of business and nothing else.
            "description": o.get("description"),
        }
        for o in opps
        if o.get("line_of_business")
    ]
    if not spec:
        raise ValueError("intake draft has no line_of_business to open an opportunity on")

    prospect_type = "Prospect"
    if str(account.get("account_type") or "").strip().lower() in ("hot", "hot prospect", "hot_prospect"):
        prospect_type = "Hot_Prospect"

    return commit_intake(
        supa,
        account=account,
        opportunities_spec=spec,
        approved_by=approved_by,
        prospect_type=prospect_type,
        insured_type=_derive_insured_type(account, spec),
        nextcloud=nextcloud,
        source=source or "agency_intake",
    )
