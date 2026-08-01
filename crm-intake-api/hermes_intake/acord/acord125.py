"""ACORD 125 — Commercial Insurance Application (Applicant Information).

The carrier-facing application section for a commercial submission. Filled from
the Command Center **SubmissionObject** (the intake candidate data), NOT from
bound-policy records — a 125 is new business going *to* the underwriter. At RSG
the 125 and 126 are one combined template (see ``acord_commercial_pack``); this
module owns the 125 (applicant) fields on it.

Design mirrors ``acord25.py`` (the testable core has no I/O):

  SubmissionObject  --from_submission-->  Acord125 (logical model)
  Acord125          --build_field_map-->  {pdf_text_field: value}
  Acord125          --build_checkbox_map-> {pdf_checkbox_field: on_state}
  Acord125          --render_preview--->  markdown preview (template-free)
  maps              --fill_pdf--------->  filled PDF (licensed template)
  filled PDF        --draft_acord125--->  Nextcloud + Slack + Supabase log

The ``FIELD_NAMES`` / checkbox names below are the **real** AcroForm names read
from RSG's licensed ACORD 125/126 template (the hierarchical ``F[0].P1[0].…``
names). ``fill_pdf`` skips any name not in the template and reports it, so a
different template revision degrades to a partial draft instead of nothing;
reconcile with ``acord_pdf.all_field_names(<template>)`` or the
``HERMES_ACORD125_FIELDMAP`` json override.

HARD RULE — never fabricate. A field the submission does not have stays blank and
surfaces in ``render_preview`` as "still needed". **Never auto-sent.**
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from hermes_intake.acord import acord_pdf

log = logging.getLogger(__name__)

FIELDMAP_ENV = "HERMES_ACORD125_FIELDMAP"
FORM_LABEL = "ACORD 125"
CHECKBOX_ON = "/1"


# ---------------------------------------------------------------------------
# Logical model — the 125 applicant section, PDF-independent.
# ---------------------------------------------------------------------------
@dataclass
class Acord125:
    producer_name: str = "Risk Solutions Group"
    named_insured: str = ""
    dba: str = ""
    mail_line_one: str = ""
    mail_city: str = ""
    mail_state: str = ""
    mail_postal: str = ""
    fein: str = ""
    phone: str = ""
    email: str = ""
    website: str = ""
    naics: str = ""
    sic: str = ""
    gl_class_code: str = ""
    proposed_eff_date: str = ""
    proposed_exp_date: str = ""
    prior_carrier: str = ""
    prior_policy_number: str = ""
    prior_premium: str = ""
    prior_expiration: str = ""
    # Enum-driven checkbox selections (raw keys; blank = no box checked).
    entity_key: str = ""     # EntityType value, e.g. "llc"
    lob_key: str = ""        # LineOfBusiness value, e.g. "commercial_gl"
    premises: list[str] = field(default_factory=list)  # preview only (no 1:1 field)


# ---------------------------------------------------------------------------
# Real AcroForm names — text fields. VERIFY against the licensed template.
# ---------------------------------------------------------------------------
_P1 = "F[0].P1[0]."
_P2 = "F[0].P2[0]."
_P3 = "F[0].P3[0]."

FIELD_NAMES: dict[str, str] = {
    "producer_name": _P1 + "Producer_FullName_A[0]",
    "named_insured": _P1 + "NamedInsured_FullName_A[0]",
    "mail_line_one": _P1 + "NamedInsured_MailingAddress_LineOne_A[0]",
    "mail_city": _P1 + "NamedInsured_MailingAddress_CityName_A[0]",
    "mail_state": _P1 + "NamedInsured_MailingAddress_StateOrProvinceCode_A[0]",
    "mail_postal": _P1 + "NamedInsured_MailingAddress_PostalCode_A[0]",
    "fein": _P1 + "NamedInsured_TaxIdentifier_A[0]",
    "phone": _P1 + "NamedInsured_Primary_PhoneNumber_A[0]",
    "website": _P1 + "NamedInsured_Primary_WebsiteAddress_A[0]",
    "naics": _P1 + "NamedInsured_NAICSCode_A[0]",
    "sic": _P1 + "NamedInsured_SICCode_A[0]",
    "gl_class_code": _P1 + "NamedInsured_GeneralLiabilityCode_A[0]",
    "proposed_eff_date": _P1 + "Policy_EffectiveDate_A[0]",
    "proposed_exp_date": _P1 + "Policy_ExpirationDate_A[0]",
    "email": _P2 + "NamedInsured_Contact_PrimaryEmailAddress_A[0]",
    # NOTE: prior_carrier/policy/premium/expiration are intentionally NOT mapped to
    # the ACORD 125 PriorCoverage_GeneralLiability_* fields. `prior_carriers` has no
    # per-carrier line of business, so writing the first entry under GL would put a
    # property/auto carrier's history on the GL prior-coverage row. Kept in the
    # preview as informational; fill only after an explicit line match.
}

# EntityType value -> the LegalEntity indicator checkbox on the form.
ENTITY_CHECKBOX: dict[str, str] = {
    "individual": _P1 + "NamedInsured_LegalEntity_IndividualIndicator_A[0]",
    "llc": _P1 + "NamedInsured_LegalEntity_LimitedLiabilityCorporationIndicator_A[0]",
    "corporation": _P1 + "NamedInsured_LegalEntity_CorporationIndicator_A[0]",
    "s_corp": _P1 + "NamedInsured_LegalEntity_SubchapterSCorporationIndicator_A[0]",
    "partnership": _P1 + "NamedInsured_LegalEntity_PartnershipIndicator_A[0]",
    "joint_venture": _P1 + "NamedInsured_LegalEntity_JointVentureIndicator_A[0]",
    "not_for_profit": _P1 + "NamedInsured_LegalEntity_NotForProfitIndicator_A[0]",
    "trust": _P1 + "NamedInsured_LegalEntity_TrustIndicator_A[0]",
}

# LineOfBusiness value -> the Policy line-of-business indicator checkbox.
LOB_CHECKBOX: dict[str, str] = {
    "commercial_gl": _P1 + "Policy_LineOfBusiness_CommercialGeneralLiability_A[0]",
    "commercial_property": _P1 + "Policy_LineOfBusiness_CommercialProperty_A[0]",
    "package_bop": _P1 + "Policy_LineOfBusiness_BusinessOwnersIndicator_A[0]",
    "commercial_auto": _P1 + "Policy_LineOfBusiness_BusinessAutoIndicator_A[0]",
    "commercial_umbrella": _P1 + "Policy_LineOfBusiness_UmbrellaIndicator_A[0]",
    # workers_comp has no box on the commercial 125 — WC is a standalone ACORD 130.
}

# A new submission is a quote request.
STATUS_QUOTE_CHECKBOX = _P1 + "Policy_Status_QuoteIndicator_A[0]"


# ---------------------------------------------------------------------------
# SubmissionObject -> Acord125  (pure)
# ---------------------------------------------------------------------------
def _s(v: Any) -> str:
    if v in (None, ""):
        return ""
    return str(v).strip()


def _enum_value(v: Any) -> str:
    """A raw enum value string ('llc'), tolerant of enum or plain str/None."""
    if v in (None, ""):
        return ""
    return str(getattr(v, "value", v)).strip()


def _fmt_address(addr: Any) -> str:
    if addr is None:
        return ""
    line = ", ".join(x for x in (_s(getattr(addr, "street", "")), _s(getattr(addr, "city", ""))) if x)
    tail = " ".join(x for x in (_s(getattr(addr, "state", "")), _s(getattr(addr, "zip", ""))) if x)
    return " ".join(x for x in (line, tail) if x).strip()


def from_submission(sub: Any) -> Acord125:
    """Build an Acord125 from a SubmissionObject. Missing data stays blank."""
    a = sub.applicant
    addr = a.mailing_address
    prior = (sub.prior_carriers or [None])[0]
    premises = [line for line in (_fmt_address(p.address) for p in (sub.property_locations or [])) if line]
    return Acord125(
        named_insured=_s(a.legal_name) or _s(sub.client_name),
        dba=", ".join(_s(d) for d in (a.dbas or []) if _s(d)),
        mail_line_one=_s(getattr(addr, "street", "")),
        mail_city=_s(getattr(addr, "city", "")),
        mail_state=_s(getattr(addr, "state", "")),
        mail_postal=_s(getattr(addr, "zip", "")),
        fein=_s(a.fein),
        phone=_s(a.phone),
        email=_s(a.email),
        website=_s(a.website),
        naics=_s(a.naics),
        sic=_s(a.sic),
        gl_class_code=_s(a.gl_class_code),
        proposed_eff_date=_s(sub.target_effective_date),
        prior_carrier=_s(getattr(prior, "carrier", "")) if prior else "",
        prior_policy_number=_s(getattr(prior, "policy_no", "")) if prior else "",
        prior_premium=_s(getattr(prior, "premium", "")) if prior else "",
        prior_expiration=_s(getattr(prior, "expiration", "")) if prior else "",
        entity_key=_enum_value(a.entity_type),
        lob_key=_enum_value(sub.lob),
        premises=premises,
    )


# ---------------------------------------------------------------------------
# Acord125 -> field maps  (pure)
# ---------------------------------------------------------------------------
def build_field_map(a125: Acord125, field_names: Optional[dict[str, str]] = None) -> dict[str, str]:
    """Text field values keyed by real AcroForm name. Empty/missing dropped."""
    names = {**FIELD_NAMES, **(field_names or {})}
    out = {pdf: _s(getattr(a125, logical, "")) for logical, pdf in names.items()}
    return {k: v for k, v in out.items() if v}


def build_checkbox_map(a125: Acord125, *, selected_lobs: Optional[list[str]] = None) -> dict[str, str]:
    """Checkbox fields -> on-state. Entity type, line(s) of business, quote status.

    ``selected_lobs`` checks every chosen line's box (the agent selecting multiple
    lines on the 125). When omitted, it falls back to the submission's single
    ``lob`` — the pre-selection default.
    """
    lobs = selected_lobs if selected_lobs is not None else ([a125.lob_key] if a125.lob_key else [])
    out: dict[str, str] = {STATUS_QUOTE_CHECKBOX: CHECKBOX_ON}
    if a125.entity_key in ENTITY_CHECKBOX:
        out[ENTITY_CHECKBOX[a125.entity_key]] = CHECKBOX_ON
    for lob in lobs:
        if lob in LOB_CHECKBOX:
            out[LOB_CHECKBOX[lob]] = CHECKBOX_ON
    return out


# ---------------------------------------------------------------------------
# Acord125 -> markdown preview (template-free; the Command Center deliverable)
# ---------------------------------------------------------------------------
_COMPLETENESS_FIELDS = [
    ("named_insured", "Named insured"),
    ("mail_line_one", "Mailing address"),
    ("fein", "FEIN"),
    ("entity_key", "Legal entity type"),
    ("naics", "NAICS"),
    ("proposed_eff_date", "Proposed effective date"),
]


def _dash(v: str) -> str:
    return v if v else "—"


def _mail_display(a125: Acord125) -> str:
    line = ", ".join(x for x in (a125.mail_line_one, a125.mail_city) if x)
    tail = " ".join(x for x in (a125.mail_state, a125.mail_postal) if x)
    return " ".join(x for x in (line, tail) if x) or ""


def render_preview(a125: Acord125) -> str:
    lines = [
        f"# ACORD 125 (Commercial Application) — {_dash(a125.named_insured)}",
        "",
        "## Applicant",
        f"- **Named insured:** {_dash(a125.named_insured)}",
        f"- **DBA:** {_dash(a125.dba)}",
        f"- **Mailing address:** {_dash(_mail_display(a125))}",
        f"- **Entity type:** {_dash(a125.entity_key.replace('_', ' ').upper())}",
        f"- **FEIN:** {_dash(a125.fein)}",
        f"- **NAICS / SIC:** {_dash(a125.naics)} / {_dash(a125.sic)}",
        f"- **GL class code:** {_dash(a125.gl_class_code)}",
        f"- **Phone / email:** {_dash(a125.phone)} / {_dash(a125.email)}",
        f"- **Website:** {_dash(a125.website)}",
        f"- **Proposed effective date:** {_dash(a125.proposed_eff_date)}",
        "",
        "## Premises",
        *([f"- {p}" for p in a125.premises] or ["- —"]),
        "",
        "## Prior carrier",
        f"- **Carrier:** {_dash(a125.prior_carrier)}   **Policy #:** {_dash(a125.prior_policy_number)}",
        f"- **Premium:** {_dash(a125.prior_premium)}   **Expiration:** {_dash(a125.prior_expiration)}",
    ]
    missing = [label for attr, label in _COMPLETENESS_FIELDS if not getattr(a125, attr)]
    if missing:
        lines += ["", "## Still needed for a complete ACORD 125", *[f"- {m}" for m in missing]]
    lines += [
        "",
        "_Draft field data for the ACORD 125. Filled PDF is generated from the same "
        "values via `draft_acord125` (or the combined 125/126 pack) once the licensed "
        "template is installed._",
    ]
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Review note + orchestration (live integrations injected).
# ---------------------------------------------------------------------------
def pre_send_checklist(a125: Acord125) -> str:
    who = a125.named_insured or "this applicant"
    return (
        f"*Draft ACORD 125 for {who}* — please review before it goes to the underwriter:\n"
        f"1. *Named insured & entity type* exactly as legally registered?\n"
        f"2. *FEIN, NAICS, and mailing address* correct?\n"
        f"3. *Premises* list every location to be covered?\n"
        f"4. *Proposed effective date* and prior-carrier info right?\n"
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


def draft_acord125(
    a125: Acord125,
    *,
    template_path: str,
    output_path: str,
    account_name: str,
    file_upload: Optional[Callable[[str], str]] = None,
    slack_post: Optional[Callable[[str], None]] = None,
    supa_log: Optional[Callable[[dict[str, Any]], None]] = None,
    field_names: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    """Fill → (Nextcloud) → (Slack) → (Supabase log). Never auto-sends.

    For the combined 125/126 template, prefer ``acord_commercial_pack.draft_pack``
    so both sections fill in one pass; this fills the 125 fields alone.
    """
    overrides = {**acord_pdf.load_fieldmap_override(FIELDMAP_ENV), **(field_names or {})}
    values = build_field_map(a125, overrides)
    checks = build_checkbox_map(a125)
    fill_result = acord_pdf.fill_pdf(template_path, values, output_path,
                                     checkboxes=checks, form_label=FORM_LABEL)

    file_url = file_upload(output_path) if file_upload else None
    if slack_post:
        msg = pre_send_checklist(a125)
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
