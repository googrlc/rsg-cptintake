"""ACORD 137 — Commercial Auto Section.

Its own template (attaches to the 125). Filled from the ``SubmissionObject``
applicant/identity block. The vehicle schedule (per-vehicle rows, coverage symbols,
per-vehicle limits) and the driver schedule are **row-based** — those rows map to
``sub.vehicles`` / ``sub.drivers`` but the row ordering must be verified visually
against the licensed template before it can be trusted, so they are NOT auto-filled
yet; they surface in ``render_preview`` as "still needed" (attach the 163 driver
schedule + the vehicle schedule).

Field names are the real AcroForm names from the licensed ACORD 137. Never
fabricate; never auto-send.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Optional

from hermes_intake.acord import acord_pdf

log = logging.getLogger(__name__)

FIELDMAP_ENV = "HERMES_ACORD137_FIELDMAP"
FORM_LABEL = "ACORD 137"
_P1 = "F[0].P1[0]."


@dataclass
class Acord137:
    named_insured: str = ""
    proposed_eff_date: str = ""


FIELD_NAMES: dict[str, str] = {
    "named_insured": _P1 + "NamedInsured_FullName_A[0]",
    "proposed_eff_date": _P1 + "Policy_EffectiveDate_A[0]",
}


def _s(v: Any) -> str:
    return "" if v in (None, "") else str(v).strip()


def from_submission(sub: Any) -> Acord137:
    return Acord137(
        named_insured=_s(sub.applicant.legal_name) or _s(sub.client_name),
        proposed_eff_date=_s(sub.target_effective_date),
    )


def build_field_map(a137: Acord137, field_names: Optional[dict[str, str]] = None) -> dict[str, str]:
    names = {**FIELD_NAMES, **(field_names or {})}
    out = {pdf: _s(getattr(a137, logical, "")) for logical, pdf in names.items()}
    return {k: v for k, v in out.items() if v}


def build_checkbox_map(a137: Acord137) -> dict[str, str]:
    """No checkbox mapping wired (auto symbols / coverage boxes are review items)."""
    return {}


def _dash(v: str) -> str:
    return v if v else "—"


def render_preview(a137: Acord137, *, vehicle_count: int = 0, driver_count: int = 0) -> str:
    lines = [
        f"# ACORD 137 (Commercial Auto) — {_dash(a137.named_insured)}",
        "",
        "## Applicant",
        f"- **Named insured:** {_dash(a137.named_insured)}",
        f"- **Proposed effective date:** {_dash(a137.proposed_eff_date)}",
        "",
        "## Still needed for a complete ACORD 137",
        f"- Vehicle schedule ({vehicle_count} vehicle(s) on file) — **upload as CSV**",
        f"- Driver schedule ({driver_count} driver(s) on file) — **upload as CSV**",
        "- Liability limits (CSL or split BI/PD), physical damage deductibles",
        "",
        "_Applicant block filled from intake. The vehicle/driver schedules ride along as an "
        "uploaded CSV attachment (cleaner than the ACORD's out-of-order row fields). "
        "Filled PDF via `draft_acord137` once the template is installed._",
    ]
    return "\n".join(lines) + "\n"


def pre_send_checklist(a137: Acord137) -> str:
    who = a137.named_insured or "this applicant"
    return (
        f"*Draft ACORD 137 (Commercial Auto) for {who}* — review before it goes to the underwriter:\n"
        f"1. *Vehicle schedule* complete (year/make/model/VIN, garaging)?\n"
        f"2. *Driver schedule* attached (ACORD 163) with license info?\n"
        f"3. *Coverage symbols and limits* (CSL / BI-PD, comp/collision) correct?\n"
        f"_Nothing is submitted automatically — you send it once it looks right._"
    )


def supabase_logger(supa) -> Callable[[dict[str, Any]], None]:
    from hermes_core.identity import agent_id

    def _log(summary: dict[str, Any]) -> None:
        supa.insert("acord_drafts", {
            "agent_id": agent_id(), "form": FORM_LABEL,
            "account": summary.get("account", ""), "output_path": summary.get("output_path"),
            "file_url": summary.get("file_url"), "placed_fields": summary.get("placed_fields", []),
            "skipped_fields": summary.get("skipped_fields", []), "auto_sent": False,
        })

    return _log


def draft_acord137(
    a137: Acord137, *, template_path: str, output_path: str, account_name: str,
    file_upload: Optional[Callable[[str], str]] = None,
    slack_post: Optional[Callable[[str], None]] = None,
    supa_log: Optional[Callable[[dict[str, Any]], None]] = None,
    field_names: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    """Fill → (Nextcloud) → (Slack) → (Supabase log). Never auto-sends."""
    overrides = {**acord_pdf.load_fieldmap_override(FIELDMAP_ENV), **(field_names or {})}
    fill = acord_pdf.fill_pdf(template_path, build_field_map(a137, overrides), output_path,
                             form_label=FORM_LABEL)
    file_url = file_upload(output_path) if file_upload else None
    if slack_post:
        msg = pre_send_checklist(a137)
        if file_url:
            msg += f"\nDraft: {file_url}"
        slack_post(msg)
    summary = {"account": account_name, "output_path": output_path, "file_url": file_url,
               "placed_fields": fill["placed"], "skipped_fields": fill["skipped"], "auto_sent": False}
    if supa_log:
        supa_log(summary)
    return summary
