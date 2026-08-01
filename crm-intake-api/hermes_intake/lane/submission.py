"""THE SPINE — the Command Center Submission Object.

Ported from the freshhermes submissions builder and extended for the lane engine.
There is exactly one SubmissionObject per submission; every stage reads/writes it.
Commercial field names map 1:1 to ACORD 125/126/140 so the form-filler can map
directly.

Hard rule: NEVER fabricate. A field we don't have stays ``None``. Provenance is
tracked (``enrichment.sources``) so a human can see where every value came from,
and ``enrichment.needs_verification`` flags estimate-sourced fields a person must
confirm before quote/bind.

Extensions over the freshhermes spine (for personal-lines renewal lanes):
  - ``current_policy_expiration`` — the **XDATE** (expiring policy's expiration).
    The whole Gretchen lane revolves around it, so it's first-class, not buried
    inside ``prior_carriers``.
  - ``current_carrier`` / ``current_premium`` — the incumbent being remarketed.
  - ``FIELD_ALIASES`` — lane configs reference human-readable field names
    ("xdate", "property_details") that resolve to real spine paths. The lane
    loader validates every ``extraction_fields`` entry against this map, so a
    typo or unknown field is caught at boot.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ---- Routing -------------------------------------------------------------

class LineOfBusiness(str, Enum):
    PERSONAL_AUTO = "personal_auto"
    COMMERCIAL_AUTO = "commercial_auto"
    HOME = "home"
    RENTERS = "renters"
    PERSONAL_UMBRELLA = "personal_umbrella"
    COMMERCIAL_GL = "commercial_gl"
    COMMERCIAL_PROP = "commercial_property"
    PACKAGE_BOP = "package_bop"
    OTHER = "other"


class Lane(str, Enum):
    PERSONAL_NO_ACORD = "personal_no_acord"   # -> Submission Summary -> Gretchen
    COMMERCIAL_ACORD = "commercial_acord"     # -> ACORD pack -> underwriter -> Lamar


# Dumb routing rule. This is the entire Routing Gate brain.
LANE_BY_LOB: dict[LineOfBusiness, Lane] = {
    LineOfBusiness.PERSONAL_AUTO:     Lane.PERSONAL_NO_ACORD,
    LineOfBusiness.COMMERCIAL_AUTO:   Lane.PERSONAL_NO_ACORD,   # Gretchen quotes; no ACORD
    LineOfBusiness.HOME:              Lane.PERSONAL_NO_ACORD,
    LineOfBusiness.RENTERS:           Lane.PERSONAL_NO_ACORD,
    LineOfBusiness.PERSONAL_UMBRELLA: Lane.PERSONAL_NO_ACORD,
    LineOfBusiness.COMMERCIAL_GL:     Lane.COMMERCIAL_ACORD,
    LineOfBusiness.COMMERCIAL_PROP:   Lane.COMMERCIAL_ACORD,
    LineOfBusiness.PACKAGE_BOP:       Lane.COMMERCIAL_ACORD,
    LineOfBusiness.OTHER:             Lane.COMMERCIAL_ACORD,    # safe default: full pack
}


# ---- Source / intake -----------------------------------------------------

class SourceChannel(str, Enum):
    DESKTOP = "desktop"
    WEBUI = "webui"               # Command Center intake page
    EMAIL_FORWARD = "email_forward"
    CHAT_UPLOAD = "chat_upload"
    FOLDER = "folder"


class IntakeMeta(BaseModel):
    channel: SourceChannel
    submitted_by: Optional[str] = None
    note: Optional[str] = None
    raw_files: list[str] = Field(default_factory=list)
    received_at: datetime = Field(default_factory=_utcnow)


# ---- Entities ------------------------------------------------------------

class Address(BaseModel):
    street: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip: Optional[str] = None
    county: Optional[str] = None


class EntityType(str, Enum):
    individual = "individual"
    llc = "llc"
    corporation = "corporation"
    s_corp = "s_corp"
    partnership = "partnership"
    joint_venture = "joint_venture"
    not_for_profit = "not_for_profit"
    trust = "trust"


class Applicant(BaseModel):
    legal_name: Optional[str] = None
    dbas: list[str] = Field(default_factory=list)
    mailing_address: Address = Field(default_factory=Address)
    entity_type: Optional[EntityType] = None
    fein: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    website: Optional[str] = None
    naics: Optional[str] = None
    sic: Optional[str] = None
    gl_class_code: Optional[str] = None


class Driver(BaseModel):
    name: Optional[str] = None
    dob: Optional[date] = None
    license_no: Optional[str] = None
    license_state: Optional[str] = None


class Vehicle(BaseModel):
    year: Optional[int] = None
    make: Optional[str] = None
    model: Optional[str] = None
    vin: Optional[str] = None
    usage: Optional[str] = None
    garaging: Address = Field(default_factory=Address)


class PropertyLocation(BaseModel):
    """Serves home/renters AND commercial property (ACORD 140)."""
    address: Address = Field(default_factory=Address)
    year_built: Optional[int] = None
    square_footage: Optional[int] = None
    construction_type: Optional[str] = None
    stories: Optional[int] = None
    roof_type: Optional[str] = None
    roof_age: Optional[int] = None
    protection_class: Optional[str] = None
    distance_to_hydrant_ft: Optional[int] = None
    distance_to_fire_station_mi: Optional[float] = None
    occupancy: Optional[str] = None
    building_limit: Optional[float] = None


class PriorCarrier(BaseModel):
    carrier: Optional[str] = None
    policy_no: Optional[str] = None
    premium: Optional[float] = None
    effective: Optional[date] = None
    expiration: Optional[date] = None
    limits: Optional[str] = None


class LossHistory(BaseModel):
    no_losses_attested: bool = False
    claims: list[dict] = Field(default_factory=list)


# ---- Enrichment provenance + gate ---------------------------------------

class Enrichment(BaseModel):
    sources: dict[str, str] = Field(default_factory=dict)
    needs_verification: list[str] = Field(default_factory=list)


class GateResult(BaseModel):
    lane: Optional[Lane] = None
    complete: bool = False
    missing: list[str] = Field(default_factory=list)
    ready_to_handoff: bool = False
    handoff_target: Optional[str] = None


# ---- The Submission Object ----------------------------------------------

class SubmissionObject(BaseModel):
    submission_id: str
    client_name: Optional[str] = None
    target_effective_date: Optional[date] = None
    lob: Optional[LineOfBusiness] = None
    lane: Optional[Lane] = None

    # Incumbent / renewal spine (the XDATE-first additions).
    current_carrier: Optional[str] = None
    current_premium: Optional[float] = None
    current_policy_expiration: Optional[date] = None   # XDATE

    intake: IntakeMeta
    applicant: Applicant = Field(default_factory=Applicant)
    contacts: list[dict] = Field(default_factory=list)
    drivers: list[Driver] = Field(default_factory=list)
    vehicles: list[Vehicle] = Field(default_factory=list)
    property_locations: list[PropertyLocation] = Field(default_factory=list)
    coverage_request: dict = Field(default_factory=dict)
    prior_carriers: list[PriorCarrier] = Field(default_factory=list)
    loss_history: LossHistory = Field(default_factory=LossHistory)

    enrichment: Enrichment = Field(default_factory=Enrichment)
    gate: GateResult = Field(default_factory=GateResult)

    crm_account_id: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)


# ---- Lane field vocabulary ----------------------------------------------
# Lane YAMLs reference human-readable field names; these resolve to real spine
# paths. The lane loader validates every `extraction_fields` entry against the
# keys here (boot fails on an unknown field), and `xdate` MUST appear in every
# lane (enforced by the loader) — which is only possible because the spine now
# has a first-class XDATE field.

FIELD_ALIASES: dict[str, str] = {
    # alias (lane vocabulary)      -> dotted spine path
    "xdate":              "current_policy_expiration",
    "insured_name":       "client_name",
    "client_name":        "client_name",
    "current_carrier":    "current_carrier",
    "current_premium":    "current_premium",
    "target_effective_date": "target_effective_date",
    "address":            "applicant.mailing_address",
    "mailing_address":    "applicant.mailing_address",
    "email":              "applicant.email",
    "phone":              "applicant.phone",
    "fein":               "applicant.fein",
    "entity_type":        "applicant.entity_type",
    "naics":              "applicant.naics",
    "sic":                "applicant.sic",
    "drivers":            "drivers",
    "vehicles":           "vehicles",
    "property_details":   "property_locations",
    "property_locations": "property_locations",
    "coverage_request":   "coverage_request",
    "prior_carriers":     "prior_carriers",
    "loss_history":       "loss_history",
}

# The field every lane must extract first, always (spec guardrail #5).
REQUIRED_LANE_FIELD = "xdate"


def resolve_alias(alias: str) -> Optional[str]:
    """Lane field alias -> dotted spine path, or None if unknown."""
    return FIELD_ALIASES.get(alias.strip())


def is_known_field(alias: str) -> bool:
    return alias.strip() in FIELD_ALIASES


def new_submission_id() -> str:
    import uuid
    return "sub_" + uuid.uuid4().hex[:12]
