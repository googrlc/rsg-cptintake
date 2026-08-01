"""ACORD 126 — Commercial General Liability Section.

The GL coverage section of the combined commercial application (the 125/126
template). Filled from the Command Center **SubmissionObject**. Same design and
hard rules as ``acord125.py``. On RSG's combined template the 125 and 126 fill
the one PDF together — see ``acord_commercial_pack``.

Field names below are the **real** AcroForm names from the licensed template (the
GL section lives on page 5, ``F[0].P5[0].GeneralLiability_…``). Limits come from
the submission's free-form ``coverage_request`` when present; nothing is assumed.

HARD RULE — never fabricate. GL limits the submission does not carry stay blank
and surface in ``render_preview`` as "still needed". **Never auto-sent.**
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Optional

from hermes_intake.acord import acord_pdf

log = logging.getLogger(__name__)

FIELDMAP_ENV = "HERMES_ACORD126_FIELDMAP"
FORM_LABEL = "ACORD 126"
CHECKBOX_ON = "/1"

_P1 = "F[0].P1[0]."
_P5 = "F[0].P5[0]."


@dataclass
class Acord126:
    named_insured: str = ""
    proposed_eff_date: str = ""
    gl_class_code: str = ""
    naics: str = ""
    coverage_basis: str = ""          # "Occurrence" | "Claims-Made" (only if given)
    each_occurrence: str = ""
    general_aggregate: str = ""
    products_completed_ops_aggregate: str = ""
    personal_advertising_injury: str = ""
    damage_to_premises: str = ""
    medical_expense: str = ""


FIELD_NAMES: dict[str, str] = {
    # The 126 GL SECTION header lives on page 5 — not the page-1 ACORD 125 header
    # (filling P1 here would just rewrite the 125's already-filled values and leave
    # the GL section header blank in the combined pack).
    "named_insured": _P5 + "NamedInsured_FullName_A[0]",
    "proposed_eff_date": _P5 + "Policy_EffectiveDate_A[0]",
    "gl_class_code": _P1 + "NamedInsured_GeneralLiabilityCode_A[0]",
    "naics": _P1 + "NamedInsured_NAICSCode_A[0]",
    "each_occurrence": _P5 + "GeneralLiability_EachOccurrence_LimitAmount_A[0]",
    "general_aggregate": _P5 + "GeneralLiability_GeneralAggregate_LimitAmount_A[0]",
    "products_completed_ops_aggregate":
        _P5 + "GeneralLiability_ProductsAndCompletedOperations_AggregateLimitAmount_A[0]",
    "personal_advertising_injury": _P5 + "GeneralLiability_PersonalAndAdvertisingInjury_LimitAmount_A[0]",
    "damage_to_premises": _P5 + "GeneralLiability_FireDamageRentedPremises_EachOccurrenceLimitAmount_A[0]",
    "medical_expense": _P5 + "GeneralLiability_MedicalExpense_EachPersonLimitAmount_A[0]",
}

# Coverage-basis checkboxes on the GL section.
OCCURRENCE_CHECKBOX = _P5 + "GeneralLiability_OccurrenceIndicator_A[0]"
CLAIMS_MADE_CHECKBOX = _P5 + "GeneralLiability_ClaimsMadeIndicator_A[0]"

_LIMIT_KEYS: dict[str, tuple[str, ...]] = {
    "each_occurrence": ("each_occurrence", "eachOccurrence", "occurrence", "per_occurrence"),
    "general_aggregate": ("general_aggregate", "generalAggregate", "aggregate"),
    "products_completed_ops_aggregate": (
        "products_completed_ops_aggregate", "products_aggregate", "products_completed_ops",
    ),
    "personal_advertising_injury": (
        "personal_advertising_injury", "personal_and_advertising_injury", "pai",
    ),
    "damage_to_premises": ("damage_to_premises", "fire_damage", "damage_to_rented_premises"),
    "medical_expense": ("medical_expense", "med_pay", "medical_payments"),
}
_BASIS_KEYS = ("gl_basis", "coverage_basis", "basis")


# ---------------------------------------------------------------------------
# SubmissionObject -> Acord126  (pure)
# ---------------------------------------------------------------------------
def _s(v: Any) -> str:
    if v in (None, ""):
        return ""
    return str(v).strip()


def _gl_request(sub: Any) -> dict[str, Any]:
    """The GL slice of coverage_request — top-level or nested under gl/general_liability."""
    cr = getattr(sub, "coverage_request", None) or {}
    if not isinstance(cr, dict):
        return {}
    merged: dict[str, Any] = {}
    for nested_key in ("general_liability", "gl"):
        nested = cr.get(nested_key)
        if isinstance(nested, dict):
            merged.update(nested)
    merged.update({k: v for k, v in cr.items() if not isinstance(v, dict)})
    return merged


def _first(d: dict[str, Any], keys: tuple[str, ...]) -> str:
    for k in keys:
        if d.get(k) not in (None, ""):
            return _s(d[k])
    return ""


def from_submission(sub: Any) -> Acord126:
    a = sub.applicant
    gl = _gl_request(sub)
    return Acord126(
        named_insured=_s(a.legal_name) or _s(sub.client_name),
        proposed_eff_date=_s(sub.target_effective_date),
        gl_class_code=_s(a.gl_class_code),
        naics=_s(a.naics),
        coverage_basis=_first(gl, _BASIS_KEYS),
        each_occurrence=_first(gl, _LIMIT_KEYS["each_occurrence"]),
        general_aggregate=_first(gl, _LIMIT_KEYS["general_aggregate"]),
        products_completed_ops_aggregate=_first(gl, _LIMIT_KEYS["products_completed_ops_aggregate"]),
        personal_advertising_injury=_first(gl, _LIMIT_KEYS["personal_advertising_injury"]),
        damage_to_premises=_first(gl, _LIMIT_KEYS["damage_to_premises"]),
        medical_expense=_first(gl, _LIMIT_KEYS["medical_expense"]),
    )


# ---------------------------------------------------------------------------
# Acord126 -> field maps  (pure)
# ---------------------------------------------------------------------------
def build_field_map(a126: Acord126, field_names: Optional[dict[str, str]] = None) -> dict[str, str]:
    names = {**FIELD_NAMES, **(field_names or {})}
    out = {pdf: _s(getattr(a126, logical, "")) for logical, pdf in names.items()}
    return {k: v for k, v in out.items() if v}


def build_checkbox_map(a126: Acord126) -> dict[str, str]:
    """Coverage-basis checkbox: occurrence OR claims-made, per the submission."""
    basis = (a126.coverage_basis or "").lower()
    if "claims" in basis:
        return {CLAIMS_MADE_CHECKBOX: CHECKBOX_ON}
    if "occurrence" in basis:
        return {OCCURRENCE_CHECKBOX: CHECKBOX_ON}
    return {}


# ---------------------------------------------------------------------------
# Acord126 -> markdown preview (template-free)
# ---------------------------------------------------------------------------
_COMPLETENESS_FIELDS = [
    ("named_insured", "Named insured"),
    ("proposed_eff_date", "Proposed effective date"),
    ("gl_class_code", "GL class code"),
    ("each_occurrence", "Each-occurrence limit"),
    ("general_aggregate", "General aggregate limit"),
]


def _dash(v: str) -> str:
    return v if v else "—"


def render_preview(a126: Acord126) -> str:
    lines = [
        f"# ACORD 126 (General Liability) — {_dash(a126.named_insured)}",
        "",
        "## Coverage",
        f"- **Proposed effective date:** {_dash(a126.proposed_eff_date)}",
        f"- **Coverage basis:** {_dash(a126.coverage_basis)}",
        f"- **GL class code:** {_dash(a126.gl_class_code)}   **NAICS:** {_dash(a126.naics)}",
        "",
        "## Limits",
        f"- **Each occurrence:** {_dash(a126.each_occurrence)}",
        f"- **General aggregate:** {_dash(a126.general_aggregate)}",
        f"- **Products / completed-ops aggregate:** {_dash(a126.products_completed_ops_aggregate)}",
        f"- **Personal & advertising injury:** {_dash(a126.personal_advertising_injury)}",
        f"- **Damage to rented premises:** {_dash(a126.damage_to_premises)}",
        f"- **Medical expense:** {_dash(a126.medical_expense)}",
    ]
    missing = [label for attr, label in _COMPLETENESS_FIELDS if not getattr(a126, attr)]
    if missing:
        lines += ["", "## Still needed for a complete ACORD 126", *[f"- {m}" for m in missing]]
    lines += [
        "",
        "_Draft field data for the ACORD 126. Filled PDF is generated from the same "
        "values via `draft_acord126` (or the combined 125/126 pack) once the licensed "
        "template is installed._",
    ]
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Review note + orchestration (live integrations injected).
# ---------------------------------------------------------------------------
def pre_send_checklist(a126: Acord126) -> str:
    who = a126.named_insured or "this applicant"
    return (
        f"*Draft ACORD 126 (GL) for {who}* — please review before it goes to the underwriter:\n"
        f"1. *GL class code* and NAICS match the operation?\n"
        f"2. *Coverage basis* (occurrence vs claims-made) correct?\n"
        f"3. *Limits* (each-occurrence, aggregate, products/completed-ops) as quoted?\n"
        f"4. Any *exposure detail* (sales, payroll, area) the underwriter needs attached?\n"
        f"_Nothing is submitted automatically — you send it once it looks right._"
    )


def supabase_logger(supa) -> Callable[[dict[str, Any]], None]:
    from hermes_core.identity import agent_id

    def _log(summary: dict[str, Any]) -> None:
        supa.insert("acord_drafts", {
            "agent_id": agent_id(),
            "form": FORM_LABEL,
            "account": summary.get("account", ""),
            "output_path": summary.get("output_path"),
            "file_url": summary.get("file_url"),
            "placed_fields": summary.get("placed_fields", []),
            "skipped_fields": summary.get("skipped_fields", []),
            "auto_sent": False,
        })

    return _log


def draft_acord126(
    a126: Acord126,
    *,
    template_path: str,
    output_path: str,
    account_name: str,
    file_upload: Optional[Callable[[str], str]] = None,
    slack_post: Optional[Callable[[str], None]] = None,
    supa_log: Optional[Callable[[dict[str, Any]], None]] = None,
    field_names: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    """Fill → (Nextcloud) → (Slack) → (Supabase log). Never auto-sends."""
    overrides = {**acord_pdf.load_fieldmap_override(FIELDMAP_ENV), **(field_names or {})}
    values = build_field_map(a126, overrides)
    checks = build_checkbox_map(a126)
    fill_result = acord_pdf.fill_pdf(template_path, values, output_path,
                                     checkboxes=checks, form_label=FORM_LABEL)

    file_url = file_upload(output_path) if file_upload else None
    if slack_post:
        msg = pre_send_checklist(a126)
        if file_url:
            msg += f"\nDraft: {file_url}"
        slack_post(msg)

    summary = {
        "account": account_name,
        "output_path": output_path,
        "file_url": file_url,
        "placed_fields": fill_result["placed"],
        "skipped_fields": fill_result["skipped"],
        "auto_sent": False,
    }
    if supa_log:
        supa_log(summary)
    return summary
