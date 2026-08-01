"""ACORD checkbox questions — classify, scope, and gate (P3).

The 125/126 template carries 208 checkbox fields whose tooltips are the questions
(``docs/acord/field-catalogs/acord_125_126.questions.json``). This module answers:

  1. Which boxes does a human have to answer? (classification)
  2. Which of those are in scope for the lines being marketed? (scope)
  3. Is the submission allowed to stage to Supabase / the AMS yet? (gate)

Classification — three classes:
  structural     set by what the agent selected (LOB boxes, attachments, status,
                 legal entity, billing) — not prompted.
  derived        set deterministically from the record (business type, owner/tenant,
                 occurrence-vs-claims-made, phone type, interest type) — not prompted.
  agent_question everything else — a genuine underwriting Y/N the agent must answer.

The default is **agent_question**: a box is prompted unless it clearly matches a
structural/derived pattern. That bias is deliberate — "all the Y/N boxes should be
prompted before Supabase → AMS" — so a new/unrecognized box errs toward being asked,
never silently skipped.

Gate: a submission cannot stage while any **in-scope agent_question** is unanswered.
In scope = a base question, or one belonging to a line the agent selected (GL
questions only gate when GL is being marketed).
"""

from __future__ import annotations

import functools
import json
from dataclasses import dataclass
from pathlib import Path

# Packaged with the module (not under docs/) so load_questions works in a wheel
# install and in the Dockerfile image, which copy only `hermes`.
_QUESTIONS_PATH = Path(__file__).resolve().parent / "acord_125_126_questions.json"

CLASS_STRUCTURAL = "structural"
CLASS_DERIVED = "derived"
CLASS_AGENT = "agent_question"

SECTION_BASE = "base"

# Set by selection — never prompted.
_STRUCTURAL_TOKENS = (
    "Policy_Status_",
    "Policy_LineOfBusiness_",
    "CommercialPolicy_Attachment_",
    "Policy_SectionAttached_",
    "NamedInsured_LegalEntity_",
    "Policy_Payment_",
    "CancelNonRenew_",     # cancellation-reason boxes — driven by cancel status, not new-business
)
# Set from the record — never prompted.
_DERIVED_TOKENS = (
    "BusinessInformation_BusinessType_",
    "CommercialStructure_InsuredInterest_",
    "CommercialStructure_RiskLocation_",
    "GeneralLiability_OccurrenceIndicator",
    "GeneralLiability_ClaimsMadeIndicator",
    "GeneralLiability_CoverageIndicator",
    "GeneralLiability_GeneralAggregate_LimitApplies",
    "NamedInsured_Contact_",          # phone type (home/business/cell)
    "AdditionalInterest_Interest_",   # interest type (mortgagee/lienholder/…)
)
# Field-name tokens → the line of business a question belongs to (scope).
# More specific prefixes first: "GeneralLiabilityLineOfBusiness" must match before
# the shorter "GeneralLiability_", and inland-marine before the generic property.
_SECTION_TOKENS = (
    ("GeneralLiabilityLineOfBusiness", "commercial_gl"),
    ("CommercialInlandMarine", "commercial_inland_marine"),
    ("GeneralLiability_", "commercial_gl"),
    ("CommercialProperty_", "commercial_property"),
    ("CommercialStructure_", "commercial_property"),
    ("Construction_", "commercial_property"),
    ("BuildingFireProtection_", "commercial_property"),
    ("BuildingImprovement_", "commercial_property"),
    ("SwimmingPool_", "commercial_property"),
    ("AthleticTeam_", "commercial_property"),
    ("BusinessAuto", "commercial_auto"),
    ("VehicleSchedule", "commercial_auto"),
)


def classify(field: str) -> str:
    if any(tok in field for tok in _STRUCTURAL_TOKENS):
        return CLASS_STRUCTURAL
    if any(tok in field for tok in _DERIVED_TOKENS):
        return CLASS_DERIVED
    return CLASS_AGENT


def section_of(field: str) -> str:
    for tok, section in _SECTION_TOKENS:
        if tok in field:
            return section
    return SECTION_BASE


@dataclass(frozen=True)
class Question:
    field: str
    page: int
    question: str
    klass: str
    section: str


@functools.lru_cache(maxsize=1)
def load_questions() -> list[Question]:
    with open(_QUESTIONS_PATH, "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    return [
        Question(field=q["field"], page=q.get("page", 0), question=q.get("question", ""),
                 klass=classify(q["field"]), section=section_of(q["field"]))
        for q in raw
    ]


def _in_scope(q: Question, selected_lines: list[str]) -> bool:
    return q.section == SECTION_BASE or q.section in selected_lines


def agent_questions(selected_lines: list[str]) -> list[Question]:
    """The Y/N questions a human must answer for the selected lines."""
    return [q for q in load_questions()
            if q.klass == CLASS_AGENT and _in_scope(q, selected_lines)]


def _answered(answers: dict[str, object], field: str) -> bool:
    val = answers.get(field)
    return val not in (None, "")


def unanswered_required(selected_lines: list[str], answers: dict[str, object]) -> list[Question]:
    """In-scope agent questions that still have no answer — the staging blockers."""
    return [q for q in agent_questions(selected_lines) if not _answered(answers, q.field)]


def is_gated(selected_lines: list[str], answers: dict[str, object]) -> bool:
    """True while staging must be blocked (an in-scope agent question is unanswered)."""
    return bool(unanswered_required(selected_lines, answers))
