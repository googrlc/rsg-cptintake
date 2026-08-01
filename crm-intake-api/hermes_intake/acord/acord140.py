"""ACORD 140 — Property Section.

The property schedule for a commercial submission (building construction,
protection, and limit). Filled from the Command Center **SubmissionObject**'s
``property_locations``. Same design and hard rules as ``acord125.py``.

This is a separate template from the 125/126 (its own PDF). Field names below are
the **real** AcroForm names read from RSG's licensed ACORD 140 (its fields sit on
``F[0].P9[0].…`` in the supplied template). One ``Acord140`` covers the first
property location; a multi-building risk needs one draft per building until the
per-building schedule rows are mapped.

HARD RULE — never fabricate. Missing building data stays blank and surfaces in
``render_preview`` as "still needed". **Never auto-sent.**
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Optional

from hermes_intake.acord import acord_pdf

log = logging.getLogger(__name__)

FIELDMAP_ENV = "HERMES_ACORD140_FIELDMAP"
FORM_LABEL = "ACORD 140"

_P9 = "F[0].P9[0]."


@dataclass
class Acord140:
    named_insured: str = ""
    proposed_eff_date: str = ""
    premises_address: str = ""     # preview only (no single 1:1 field on this template)
    year_built: str = ""
    building_area: str = ""
    construction_code: str = ""
    roof_material: str = ""
    protection_class: str = ""
    hydrant_distance_ft: str = ""
    fire_station_distance_mi: str = ""
    building_limit: str = ""


FIELD_NAMES: dict[str, str] = {
    "named_insured": _P9 + "NamedInsured_FullName_A[0]",
    "proposed_eff_date": _P9 + "Policy_EffectiveDate_A[0]",
    "premises_address": _P9 + "CommercialStructure_PhysicalAddress_LineOne_A[0]",
    "year_built": _P9 + "CommercialStructure_BuiltYear_A[0]",
    "building_area": _P9 + "Construction_BuildingArea_A[0]",
    "construction_code": _P9 + "Construction_ConstructionCode_A[0]",
    "roof_material": _P9 + "Construction_RoofMaterialCode_A[0]",
    "protection_class": _P9 + "BuildingFireProtection_ProtectionClassCode_A[0]",
    "hydrant_distance_ft": _P9 + "BuildingFireProtection_HydrantDistanceFeetCount_A[0]",
    "fire_station_distance_mi": _P9 + "BuildingFireProtection_FireStationDistanceMileCount_A[0]",
    "building_limit": _P9 + "CommercialProperty_Premises_LimitAmount_A[0]",
}


def _s(v: Any) -> str:
    if v in (None, ""):
        return ""
    return str(v).strip()


def _fmt_address(addr: Any) -> str:
    if addr is None:
        return ""
    line = ", ".join(x for x in (_s(getattr(addr, "street", "")), _s(getattr(addr, "city", ""))) if x)
    tail = " ".join(x for x in (_s(getattr(addr, "state", "")), _s(getattr(addr, "zip", ""))) if x)
    return " ".join(x for x in (line, tail) if x).strip()


def from_submission(sub: Any, *, location_index: int = 0) -> Acord140:
    """Build an Acord140 for one property location. Missing data stays blank."""
    a = sub.applicant
    locs = sub.property_locations or []
    loc = locs[location_index] if location_index < len(locs) else None
    return Acord140(
        named_insured=_s(a.legal_name) or _s(sub.client_name),
        proposed_eff_date=_s(sub.target_effective_date),
        premises_address=_fmt_address(getattr(loc, "address", None)) if loc else "",
        year_built=_s(getattr(loc, "year_built", "")) if loc else "",
        building_area=_s(getattr(loc, "square_footage", "")) if loc else "",
        construction_code=_s(getattr(loc, "construction_type", "")) if loc else "",
        roof_material=_s(getattr(loc, "roof_type", "")) if loc else "",
        protection_class=_s(getattr(loc, "protection_class", "")) if loc else "",
        hydrant_distance_ft=_s(getattr(loc, "distance_to_hydrant_ft", "")) if loc else "",
        fire_station_distance_mi=_s(getattr(loc, "distance_to_fire_station_mi", "")) if loc else "",
        building_limit=_s(getattr(loc, "building_limit", "")) if loc else "",
    )


def build_field_map(a140: Acord140, field_names: Optional[dict[str, str]] = None) -> dict[str, str]:
    names = {**FIELD_NAMES, **(field_names or {})}
    out = {pdf: _s(getattr(a140, logical, "")) for logical, pdf in names.items()}
    return {k: v for k, v in out.items() if v}


_COMPLETENESS_FIELDS = [
    ("premises_address", "Premises address"),
    ("year_built", "Year built"),
    ("building_area", "Building area (sq ft)"),
    ("construction_code", "Construction type"),
    ("building_limit", "Building limit"),
]


def _dash(v: str) -> str:
    return v if v else "—"


def render_preview(a140: Acord140) -> str:
    lines = [
        f"# ACORD 140 (Property) — {_dash(a140.named_insured)}",
        "",
        "## Location",
        f"- **Premises address:** {_dash(a140.premises_address)}",
        f"- **Proposed effective date:** {_dash(a140.proposed_eff_date)}",
        "",
        "## Building",
        f"- **Year built:** {_dash(a140.year_built)}   **Area (sq ft):** {_dash(a140.building_area)}",
        f"- **Construction:** {_dash(a140.construction_code)}   **Roof:** {_dash(a140.roof_material)}",
        f"- **Protection class:** {_dash(a140.protection_class)}",
        f"- **Hydrant (ft):** {_dash(a140.hydrant_distance_ft)}   "
        f"**Fire station (mi):** {_dash(a140.fire_station_distance_mi)}",
        f"- **Building limit:** {_dash(a140.building_limit)}",
    ]
    missing = [label for attr, label in _COMPLETENESS_FIELDS if not getattr(a140, attr)]
    if missing:
        lines += ["", "## Still needed for a complete ACORD 140", *[f"- {m}" for m in missing]]
    lines += [
        "",
        "_Draft field data for the ACORD 140 (first location). Filled PDF via "
        "`draft_acord140` once the licensed template is installed; a multi-building "
        "risk needs one per building._",
    ]
    return "\n".join(lines) + "\n"


def pre_send_checklist(a140: Acord140) -> str:
    who = a140.named_insured or "this applicant"
    return (
        f"*Draft ACORD 140 (Property) for {who}* — please review before it goes to the underwriter:\n"
        f"1. *Premises address* and building match the risk?\n"
        f"2. *Construction, year built, and area* correct?\n"
        f"3. *Protection class* and distances to hydrant/fire station right?\n"
        f"4. *Building limit* and valuation basis as intended?\n"
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


def draft_acord140(
    a140: Acord140,
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
    values = build_field_map(a140, overrides)
    fill_result = acord_pdf.fill_pdf(template_path, values, output_path, form_label=FORM_LABEL)

    file_url = file_upload(output_path) if file_upload else None
    if slack_post:
        msg = pre_send_checklist(a140)
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
