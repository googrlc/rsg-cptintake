"""ACORD 130 — Workers Compensation Application.

Its own standalone template (not on the 125). Filled from the ``SubmissionObject``
applicant block; the WC rating detail (per-state payroll, class codes, experience
mod, officers) is not carried on the intake record, so it stays blank and surfaces
in ``render_preview`` as "still needed". Same design/rules as the other fillers.

Field names are the real AcroForm names read from the licensed ACORD 130 (its
applicant block uses the same ``NamedInsured_*`` names as the 125). Never
fabricate; never auto-send.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Optional

from hermes_intake.acord import acord_pdf

log = logging.getLogger(__name__)

FIELDMAP_ENV = "HERMES_ACORD130_FIELDMAP"
FORM_LABEL = "ACORD 130"
_P1 = "F[0].P1[0]."


@dataclass
class Acord130:
    producer_name: str = "Risk Solutions Group"
    named_insured: str = ""
    mail_line_one: str = ""
    mail_city: str = ""
    mail_state: str = ""
    mail_postal: str = ""
    fein: str = ""
    naics: str = ""
    sic: str = ""
    proposed_eff_date: str = ""


FIELD_NAMES: dict[str, str] = {
    "producer_name": _P1 + "Producer_FullName_A[0]",
    "named_insured": _P1 + "NamedInsured_FullName_A[0]",
    "mail_line_one": _P1 + "NamedInsured_MailingAddress_LineOne_A[0]",
    "mail_city": _P1 + "NamedInsured_MailingAddress_CityName_A[0]",
    "mail_state": _P1 + "NamedInsured_MailingAddress_StateOrProvinceCode_A[0]",
    "mail_postal": _P1 + "NamedInsured_MailingAddress_PostalCode_A[0]",
    "fein": _P1 + "NamedInsured_TaxIdentifier_A[0]",
    "naics": _P1 + "NamedInsured_NAICSCode_A[0]",
    "sic": _P1 + "NamedInsured_SICCode_A[0]",
    "proposed_eff_date": _P1 + "Policy_EffectiveDate_A[0]",
}


def _s(v: Any) -> str:
    return "" if v in (None, "") else str(v).strip()


def from_submission(sub: Any) -> Acord130:
    a = sub.applicant
    addr = a.mailing_address
    return Acord130(
        named_insured=_s(a.legal_name) or _s(sub.client_name),
        mail_line_one=_s(getattr(addr, "street", "")),
        mail_city=_s(getattr(addr, "city", "")),
        mail_state=_s(getattr(addr, "state", "")),
        mail_postal=_s(getattr(addr, "zip", "")),
        fein=_s(a.fein),
        naics=_s(a.naics),
        sic=_s(a.sic),
        proposed_eff_date=_s(sub.target_effective_date),
    )


def build_field_map(a130: Acord130, field_names: Optional[dict[str, str]] = None) -> dict[str, str]:
    names = {**FIELD_NAMES, **(field_names or {})}
    out = {pdf: _s(getattr(a130, logical, "")) for logical, pdf in names.items()}
    return {k: v for k, v in out.items() if v}


def build_checkbox_map(a130: Acord130) -> dict[str, str]:
    """No checkbox mapping wired yet (WC status/rating boxes are review items)."""
    return {}


def _dash(v: str) -> str:
    return v if v else "—"


def render_preview(a130: Acord130) -> str:
    lines = [
        f"# ACORD 130 (Workers Compensation) — {_dash(a130.named_insured)}",
        "",
        "## Applicant",
        f"- **Named insured:** {_dash(a130.named_insured)}",
        f"- **Mailing address:** {_dash(', '.join(x for x in (a130.mail_line_one, a130.mail_city) if x))}"
        f" {_dash(' '.join(x for x in (a130.mail_state, a130.mail_postal) if x))}",
        f"- **FEIN:** {_dash(a130.fein)}   **NAICS / SIC:** {_dash(a130.naics)} / {_dash(a130.sic)}",
        f"- **Proposed effective date:** {_dash(a130.proposed_eff_date)}",
        "",
        "## Still needed for a complete ACORD 130",
        "- Rating states",
        "- Class codes + payroll per class",
        "- Number of employees (FT/PT)",
        "- Experience modification factor",
        "- Owners / officers (included/excluded)",
        "",
        "_Applicant block filled from intake; WC rating detail is not on the intake "
        "record and must be added. Filled PDF via `draft_acord130` once the licensed "
        "template is installed._",
    ]
    return "\n".join(lines) + "\n"


def pre_send_checklist(a130: Acord130) -> str:
    who = a130.named_insured or "this applicant"
    return (
        f"*Draft ACORD 130 (Workers Comp) for {who}* — review before it goes to the underwriter:\n"
        f"1. *Named insured, FEIN, address* correct?\n"
        f"2. *Rating states* and *class codes + payroll* added?\n"
        f"3. *Owners/officers* included or excluded as intended?\n"
        f"4. *Experience mod* current?\n"
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


def draft_acord130(
    a130: Acord130, *, template_path: str, output_path: str, account_name: str,
    file_upload: Optional[Callable[[str], str]] = None,
    slack_post: Optional[Callable[[str], None]] = None,
    supa_log: Optional[Callable[[dict[str, Any]], None]] = None,
    field_names: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    """Fill → (Nextcloud) → (Slack) → (Supabase log). Never auto-sends."""
    overrides = {**acord_pdf.load_fieldmap_override(FIELDMAP_ENV), **(field_names or {})}
    fill = acord_pdf.fill_pdf(template_path, build_field_map(a130, overrides), output_path,
                             form_label=FORM_LABEL)
    file_url = file_upload(output_path) if file_upload else None
    if slack_post:
        msg = pre_send_checklist(a130)
        if file_url:
            msg += f"\nDraft: {file_url}"
        slack_post(msg)
    summary = {"account": account_name, "output_path": output_path, "file_url": file_url,
               "placed_fields": fill["placed"], "skipped_fields": fill["skipped"], "auto_sent": False}
    if supa_log:
        supa_log(summary)
    return summary
