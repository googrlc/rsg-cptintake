"""Deliverable generators — what leaves the building after approval.

Each lane lists deliverable kinds; these turn an approved SubmissionObject into
the actual artifacts (zipped on download, behind the review gate). Phase 1
produces text/markdown:

  - ``quote_worksheet``   — the rater-ready field sheet (real, from the spine)
  - ``carrier_shortlist`` — appetite-matched carriers (honest placeholder until
                            the live carrier_appetite lookup is wired)

Never fabricate: missing fields render as "—", not invented values.
"""
from __future__ import annotations

from typing import Any, Optional

from .submission import Lane, SubmissionObject


def _dash(v: Any) -> str:
    return "—" if v in (None, "") else str(v)


def _canonical(sub: SubmissionObject) -> dict[str, Any]:
    a = sub.applicant
    addr = a.mailing_address
    client_type = "Personal" if sub.lane is Lane.PERSONAL_NO_ACORD else (
        "Commercial" if sub.lane is Lane.COMMERCIAL_ACORD else None
    )
    return {
        "name": sub.client_name or a.legal_name,
        "email": a.email,
        "phone": a.phone,
        "street": addr.street,
        "city": addr.city,
        "state": addr.state,
        "zip": addr.zip,
        "fein": a.fein,
        "sic": a.sic,
        "entity_type": a.entity_type.value if a.entity_type else None,
        "client_type": client_type,
        "xdate": sub.current_policy_expiration.isoformat() if sub.current_policy_expiration else None,
    }


def quote_worksheet(sub: SubmissionObject) -> str:
    a = sub.applicant
    lines = [
        f"# Quote Worksheet — {_dash(sub.client_name or a.legal_name)}",
        "",
        f"- **Line of business:** {_dash(sub.lob.value if sub.lob else None)}",
        f"- **Target effective date:** {_dash(sub.target_effective_date)}",
        f"- **Current carrier:** {_dash(sub.current_carrier)}",
        f"- **Current premium:** {_dash(sub.current_premium)}",
        f"- **X-date (current expiration):** {_dash(sub.current_policy_expiration)}",
        f"- **Mailing address:** {_dash(a.mailing_address.street)}, "
        f"{_dash(a.mailing_address.city)} {_dash(a.mailing_address.state)} {_dash(a.mailing_address.zip)}",
        f"- **Email / phone:** {_dash(a.email)} / {_dash(a.phone)}",
    ]
    if sub.drivers:
        lines += ["", "## Drivers"] + [
            f"- {_dash(d.name)} — DOB {_dash(d.dob)}, lic {_dash(d.license_no)} ({_dash(d.license_state)})"
            for d in sub.drivers
        ]
    if sub.vehicles:
        lines += ["", "## Vehicles"] + [
            f"- {_dash(v.year)} {_dash(v.make)} {_dash(v.model)} — VIN {_dash(v.vin)}"
            for v in sub.vehicles
        ]
    return "\n".join(lines) + "\n"


def carrier_shortlist(sub: SubmissionObject) -> str:
    lob = sub.lob.value if sub.lob else "—"
    return (
        f"# Carrier Shortlist — {_dash(sub.client_name)}\n\n"
        f"Line of business: **{lob}**\n\n"
        "_Appetite match pending — wire to the live `carrier_appetite` table to "
        "rank carriers by LOB/state/class. No carriers are listed until that "
        "lookup runs (no fabrication)._\n"
    )


def acord_data(sub: SubmissionObject) -> str:
    a = sub.applicant
    addr = a.mailing_address
    lines = [
        f"# ACORD 125/126/140 data — {_dash(sub.client_name or a.legal_name)}", "",
        "## Applicant (ACORD 125)",
        f"- Legal name: {_dash(a.legal_name or sub.client_name)}",
        f"- FEIN: {_dash(a.fein)}   Entity: {_dash(a.entity_type.value if a.entity_type else None)}",
        f"- Address: {_dash(addr.street)}, {_dash(addr.city)} {_dash(addr.state)} {_dash(addr.zip)}",
        f"- NAICS / SIC: {_dash(a.naics)} / {_dash(a.sic)}",
        f"- Email / phone: {_dash(a.email)} / {_dash(a.phone)}", "",
        "## Incumbent / renewal",
        f"- Current carrier: {_dash(sub.current_carrier)}   Premium: {_dash(sub.current_premium)}",
        f"- X-date: {_dash(sub.current_policy_expiration)}   Target eff: {_dash(sub.target_effective_date)}",
    ]
    if sub.property_locations:
        lines += ["", "## Property (ACORD 140)"] + [
            f"- {_dash(p.address.street)}, {_dash(p.address.city)} — built {_dash(p.year_built)}, "
            f"{_dash(p.construction_type)}, {_dash(p.square_footage)} sqft"
            for p in sub.property_locations
        ]
    lines += [
        "",
        "_Combined field sheet across 125/126/140. Per-form drafts: the `acord_125` "
        "and `acord_126` deliverables (filled PDFs via `hermes_intake.acord.acord125` / "
        "`acord126` once the licensed templates are installed). 140 PDF fill is next._",
    ]
    return "\n".join(lines) + "\n"


def acord_125(sub: SubmissionObject) -> str:
    """ACORD 125 (Commercial Application) preview — the exact values that fill
    the PDF via ``hermes_intake.acord.acord125``."""
    from hermes_intake.acord import acord125

    return acord125.render_preview(acord125.from_submission(sub))


def acord_126(sub: SubmissionObject) -> str:
    """ACORD 126 (General Liability) preview — same values that fill the PDF via
    ``hermes_intake.acord.acord126``."""
    from hermes_intake.acord import acord126

    return acord126.render_preview(acord126.from_submission(sub))


def acord_140(sub: SubmissionObject) -> str:
    """ACORD 140 (Property) preview for the first location — same values that fill
    the PDF via ``hermes_intake.acord.acord140``."""
    from hermes_intake.acord import acord140

    return acord140.render_preview(acord140.from_submission(sub))


def benefits_worksheet(sub: SubmissionObject) -> str:
    a = sub.applicant
    return (
        f"# Group Benefits Worksheet — {_dash(sub.client_name)}\n\n"
        f"- Employer: {_dash(sub.client_name or a.legal_name)}\n"
        f"- FEIN: {_dash(a.fein)}\n"
        f"- Current carrier: {_dash(sub.current_carrier)}   Premium: {_dash(sub.current_premium)}\n"
        f"- Renewal X-date: {_dash(sub.current_policy_expiration)}   Target effective: {_dash(sub.target_effective_date)}\n\n"
        "_Employee census + current-plan SBCs required before marketing (not auto-extracted)._\n"
    )


def medicare_checklist(sub: SubmissionObject) -> str:
    a = sub.applicant
    addr = a.mailing_address
    return (
        f"# Medicare Intake Checklist — {_dash(sub.client_name)}\n\n"
        f"- Beneficiary: {_dash(sub.client_name)}\n"
        f"- Phone: {_dash(a.phone)}   Email: {_dash(a.email)}\n"
        f"- Address: {_dash(addr.street)}, {_dash(addr.city)} {_dash(addr.state)} {_dash(addr.zip)}\n"
        f"- Current plan / carrier: {_dash(sub.current_carrier)}   Plan X-date: {_dash(sub.current_policy_expiration)}\n\n"
        "Required before enrollment:\n"
        "- [ ] Scope of Appointment (SOA) on file\n"
        "- [ ] Date of birth / MBI\n"
        "- [ ] Part A / B effective dates\n"
        "- [ ] Doctors + Rx list\n"
    )


def peo_worksheet(sub: SubmissionObject) -> str:
    a = sub.applicant
    return (
        f"# PEO Submission Worksheet — {_dash(sub.client_name)}\n\n"
        f"- Employer: {_dash(sub.client_name or a.legal_name)}\n"
        f"- FEIN: {_dash(a.fein)}   Entity: {_dash(a.entity_type.value if a.entity_type else None)}\n"
        f"- Current carrier: {_dash(sub.current_carrier)}   Premium: {_dash(sub.current_premium)}\n"
        f"- X-date: {_dash(sub.current_policy_expiration)}\n\n"
        "_Payroll register + employee census + current WC loss runs required (not auto-extracted)._\n"
    )


GENERATORS = {
    "quote_worksheet": quote_worksheet,
    "carrier_shortlist": carrier_shortlist,
    "acord_data": acord_data,
    "acord_125": acord_125,
    "acord_126": acord_126,
    "acord_140": acord_140,
    "benefits_worksheet": benefits_worksheet,
    "medicare_checklist": medicare_checklist,
    "peo_worksheet": peo_worksheet,
}


def build_deliverable(kind: str, title: str, sub: SubmissionObject) -> Optional[dict[str, Any]]:
    gen = GENERATORS.get(kind)
    if gen is None:
        return None
    return {
        "kind": kind,
        "title": title,
        "content": gen(sub),
        "content_type": "text/markdown",
        "file_ext": "md",
    }


def build_all(lane, sub: SubmissionObject) -> list[dict[str, Any]]:
    """Build every deliverable a lane declares (skipping unknown kinds)."""
    out: list[dict[str, Any]] = []
    for d in lane.deliverables:
        built = build_deliverable(d.kind, d.title, sub)
        if built is not None:
            out.append(built)
    return out
