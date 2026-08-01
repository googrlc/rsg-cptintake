"""ACORD 131 — Commercial Excess / Umbrella Section.

Filled from the ``SubmissionObject``: applicant identity + the umbrella limit and
self-insured retention, plus the underlying GL limits (read from
``coverage_request``). Its own template. Same design/rules as the other fillers.

Field names are the real AcroForm names read from the licensed ACORD 131.
Never fabricate; never auto-send.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Optional

from hermes_intake.acord import acord_pdf

log = logging.getLogger(__name__)

FIELDMAP_ENV = "HERMES_ACORD131_FIELDMAP"
FORM_LABEL = "ACORD 131"
_P1 = "F[0].P1[0]."


@dataclass
class Acord131:
    producer_name: str = "Risk Solutions Group"
    named_insured: str = ""
    proposed_eff_date: str = ""
    umbrella_each_occurrence: str = ""
    self_insured_retention: str = ""
    underlying_gl_each_occurrence: str = ""
    underlying_gl_aggregate: str = ""


FIELD_NAMES: dict[str, str] = {
    "producer_name": _P1 + "Producer_FullName_A[0]",
    "named_insured": _P1 + "NamedInsured_FullName_A[0]",
    "proposed_eff_date": _P1 + "Policy_EffectiveDate_A[0]",
    "umbrella_each_occurrence": _P1 + "ExcessUmbrella_Umbrella_EachOccurrenceAmount_A[0]",
    "self_insured_retention": _P1 + "ExcessUmbrella_Umbrella_DeductibleOrRetentionAmount_A[0]",
    "underlying_gl_each_occurrence": _P1 + "GeneralLiability_EachOccurrence_LimitAmount_A[0]",
    "underlying_gl_aggregate": _P1 + "GeneralLiability_GeneralAggregate_LimitAmount_A[0]",
}

_UMBRELLA_KEYS = ("umbrella_each_occurrence", "umbrella_limit", "umbrella_occurrence", "umbrella")
_SIR_KEYS = ("self_insured_retention", "sir", "retention", "self_insured_retention_amount")


def _s(v: Any) -> str:
    return "" if v in (None, "") else str(v).strip()


def _cov(sub: Any) -> dict[str, Any]:
    cr = getattr(sub, "coverage_request", None) or {}
    if not isinstance(cr, dict):
        return {}
    merged: dict[str, Any] = {}
    for nested in ("umbrella", "excess_umbrella", "gl", "general_liability"):
        v = cr.get(nested)
        if isinstance(v, dict):
            merged.update(v)
    merged.update({k: v for k, v in cr.items() if not isinstance(v, dict)})
    return merged


def _first(d: dict[str, Any], keys: tuple[str, ...]) -> str:
    for k in keys:
        if d.get(k) not in (None, ""):
            return _s(d[k])
    return ""


def from_submission(sub: Any) -> Acord131:
    cov = _cov(sub)
    return Acord131(
        named_insured=_s(sub.applicant.legal_name) or _s(sub.client_name),
        proposed_eff_date=_s(sub.target_effective_date),
        umbrella_each_occurrence=_first(cov, _UMBRELLA_KEYS),
        self_insured_retention=_first(cov, _SIR_KEYS),
        underlying_gl_each_occurrence=_first(cov, ("each_occurrence", "eachOccurrence", "occurrence")),
        underlying_gl_aggregate=_first(cov, ("general_aggregate", "aggregate")),
    )


def build_field_map(a131: Acord131, field_names: Optional[dict[str, str]] = None) -> dict[str, str]:
    names = {**FIELD_NAMES, **(field_names or {})}
    out = {pdf: _s(getattr(a131, logical, "")) for logical, pdf in names.items()}
    return {k: v for k, v in out.items() if v}


def build_checkbox_map(a131: Acord131) -> dict[str, str]:
    """No checkbox mapping wired yet (coverage-basis boxes are review items)."""
    return {}


def _dash(v: str) -> str:
    return v if v else "—"


def render_preview(a131: Acord131) -> str:
    lines = [
        f"# ACORD 131 (Umbrella / Excess) — {_dash(a131.named_insured)}",
        "",
        "## Coverage",
        f"- **Proposed effective date:** {_dash(a131.proposed_eff_date)}",
        f"- **Umbrella each occurrence:** {_dash(a131.umbrella_each_occurrence)}",
        f"- **Self-insured retention:** {_dash(a131.self_insured_retention)}",
        "",
        "## Underlying (general liability)",
        f"- **Each occurrence:** {_dash(a131.underlying_gl_each_occurrence)}",
        f"- **General aggregate:** {_dash(a131.underlying_gl_aggregate)}",
    ]
    missing = []
    if not a131.umbrella_each_occurrence:
        missing.append("Umbrella limit")
    if not a131.self_insured_retention:
        missing.append("Self-insured retention")
    if not a131.underlying_gl_each_occurrence:
        missing.append("Underlying GL each-occurrence (and other underlying schedules)")
    if missing:
        lines += ["", "## Still needed for a complete ACORD 131", *[f"- {m}" for m in missing]]
    lines += [
        "",
        "_Filled from intake coverage request. Full underlying schedule (auto, WC, "
        "employers liability) is added in review. Filled PDF via `draft_acord131` "
        "once the licensed template is installed._",
    ]
    return "\n".join(lines) + "\n"


def pre_send_checklist(a131: Acord131) -> str:
    who = a131.named_insured or "this applicant"
    return (
        f"*Draft ACORD 131 (Umbrella/Excess) for {who}* — review before it goes to the underwriter:\n"
        f"1. *Umbrella limit* and *self-insured retention* correct?\n"
        f"2. *Underlying schedule* (GL, auto, employers liability) complete?\n"
        f"3. Coverage basis (occurrence / claims-made) right?\n"
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


def draft_acord131(
    a131: Acord131, *, template_path: str, output_path: str, account_name: str,
    file_upload: Optional[Callable[[str], str]] = None,
    slack_post: Optional[Callable[[str], None]] = None,
    supa_log: Optional[Callable[[dict[str, Any]], None]] = None,
    field_names: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    """Fill → (Nextcloud) → (Slack) → (Supabase log). Never auto-sends."""
    overrides = {**acord_pdf.load_fieldmap_override(FIELDMAP_ENV), **(field_names or {})}
    fill = acord_pdf.fill_pdf(template_path, build_field_map(a131, overrides), output_path,
                             form_label=FORM_LABEL)
    file_url = file_upload(output_path) if file_upload else None
    if slack_post:
        msg = pre_send_checklist(a131)
        if file_url:
            msg += f"\nDraft: {file_url}"
        slack_post(msg)
    summary = {"account": account_name, "output_path": output_path, "file_url": file_url,
               "placed_fields": fill["placed"], "skipped_fields": fill["skipped"], "auto_sent": False}
    if supa_log:
        supa_log(summary)
    return summary
