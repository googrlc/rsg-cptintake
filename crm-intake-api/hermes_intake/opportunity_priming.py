"""Prime a freshly created opportunity from NowCerts — the fast AMS pull-back.

When an opportunity is created (intake commit, or the cockpit "+ New" button) we
don't want to wait for the ~5-min executor scheduler to tie it to the AMS. This
does the pull promptly so the pipeline row lands already linked and fleshed out:

  * If the opportunity is already linked (``insured_id`` set), nothing to do.
  * Else look up an existing NowCerts insured by name / FEIN. On a match, link its
    GUID and pull the segment fields (prospect_type, insured_type, lead_source)
    onto the pipeline row — only where the row doesn't already have a value.
  * Else (no existing insured) optionally kick the intake executor once, so a
    queued + approved ``create_insured`` job runs now instead of next cycle.

One AMS lookup serves a whole client's line-of-business rows. Best-effort by
design: every failure is swallowed and logged — priming must never break
opportunity creation. Disable with ``HERMES_OPPORTUNITY_PRIMING=0``.
"""
from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING, Any

from hermes_core import opportunities as opp

if TYPE_CHECKING:
    from hermes_integrations.supabase_client import SupabaseClient
    from hermes_integrations.nowcerts_client import NowCertsClient

log = logging.getLogger(__name__)

# opportunity column <- first non-empty of these NowCerts insured keys.
_SEGMENT_FIELDS: dict[str, tuple[str, ...]] = {
    "prospect_type": ("prospectType", "prospect_type"),
    "insured_type": ("insuredType", "insured_type"),
    "lead_source": ("leadSources", "leadSource", "referralSourceName"),
    # referral_source mirrors the NowCerts Referral Source (read-only in the CRM).
    "referral_source": ("referralSourceName", "referralSource"),
}


def enabled() -> bool:
    """Priming is on by default; HERMES_OPPORTUNITY_PRIMING=0 is the kill switch."""
    return os.environ.get("HERMES_OPPORTUNITY_PRIMING", "1").strip().lower() not in ("0", "false", "no", "off")


def _fein_from_identifier(client_identifier: str | None) -> str | None:
    """``make_client_identifier`` encodes a present FEIN as ``name:digits``."""
    if not client_identifier or ":" not in client_identifier:
        return None
    digits = client_identifier.rsplit(":", 1)[-1]
    return digits if digits.isdigit() else None


def _pick(row: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for k in keys:
        v = row.get(k)
        if v not in (None, ""):
            return v
    return None


def prime_new_opportunities(
    supa: "SupabaseClient",
    opportunities: list[dict[str, Any]],
    *,
    nc: "NowCertsClient | None" = None,
    kick_executor: bool = False,
    limit: int = 1,
) -> dict[str, Any]:
    """Promptly tie a client's new opportunities to NowCerts. Best-effort; never raises.

    ``opportunities`` are the just-created rows for ONE client (one AMS lookup is
    reused across all of them). ``kick_executor`` runs the intake executor once
    when no existing insured is found — use it on the intake path (which stages a
    ``create_insured`` job); leave it False for cockpit-created opportunities.
    """
    result: dict[str, Any] = {"matched": False, "linked": 0, "enriched": {}, "kicked": False}
    if not enabled():
        result["skipped"] = "disabled"
        return result

    rows = [o for o in opportunities if o.get("id")]
    unlinked = [o for o in rows if not o.get("insured_id")]
    if not unlinked:
        return result  # every row already linked, or nothing to do

    head = unlinked[0]
    try:
        if nc is None:
            from hermes_integrations.nowcerts_client import NowCertsClient

            nc = NowCertsClient()
        insured = nc.find_insured(
            commercial_name=head.get("insured_name"),
            fein=_fein_from_identifier(head.get("client_identifier")),
        )
    except Exception:
        log.exception("prime: NowCerts lookup failed for client %s", head.get("client_identifier"))
        insured = None

    if isinstance(insured, dict):
        guid = str(insured.get("id") or insured.get("databaseId") or "").strip()
        if guid:
            result["matched"] = True
            enriched = {
                col: str(val)
                for col, keys in _SEGMENT_FIELDS.items()
                if not head.get(col) and (val := _pick(insured, keys)) is not None
            }
            result["enriched"] = enriched
            for o in unlinked:
                try:
                    supa.update(opp.TABLE, o["id"], {"insured_id": guid, **enriched})
                    result["linked"] += 1
                except Exception:
                    log.exception("prime: failed to link opportunity %s to insured %s", o.get("id"), guid)
            return result

    # No existing insured — kick the queued create/link job now (intake path only).
    if kick_executor:
        try:
            from hermes_intake.executor import run_intake_executor

            result["kick_summary"] = run_intake_executor(supa=supa, nowcerts=nc, limit=limit)
            result["kicked"] = True
        except Exception:
            log.exception("prime: intake executor kick failed for client %s", head.get("client_identifier"))
    return result
