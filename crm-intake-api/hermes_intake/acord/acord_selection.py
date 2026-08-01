"""ACORD selection model — turn checked forms into the pack + opportunities.

The 125 is the hub. Given the form_ids the agent selected for a commercial
submission, this produces (all pure — no I/O):

  - the lines of business chosen (each = a checked 125 box + one opportunity)
  - the 125 line-of-business checkbox map
  - the forms to fill (base 125/126 + supplementals, 140 expanded one-per-building)
  - one opportunity draft per checked line, in the shape the existing intake_crm
    path (`intake_executor.map_opportunity_row`) already consumes

Nothing is written here; the caller stages the opportunities and (on the
on-demand action) fills the PDFs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from hermes_intake.acord import acord125, acord_registry


@dataclass
class FormToFill:
    form_id: str
    template_env: str | None
    count: int = 1          # >1 for per-building forms (one 140 per property location)
    has_filler: bool = True


@dataclass
class SelectionPlan:
    lines: list[str] = field(default_factory=list)                 # LineOfBusiness values
    lob_checkboxes_125: dict[str, str] = field(default_factory=dict)
    forms_to_fill: list[FormToFill] = field(default_factory=list)
    opportunities: list[dict[str, Any]] = field(default_factory=list)
    unknown_form_ids: list[str] = field(default_factory=list)
    selectable_without_filler: list[str] = field(default_factory=list)  # checked, no PDF yet


def opportunity_draft(sub: Any, line_of_business: str) -> dict[str, Any]:
    """One opportunity per checked line, shaped for intake_executor.map_opportunity_row."""
    name = sub.client_name or getattr(sub.applicant, "legal_name", None)
    return {
        "insured_name": name,
        "line_of_business": line_of_business,
        "opportunity_type": "New Business",
        "stage": "new",
        "source": "acord_selection",
    }


def plan_selection(sub: Any, form_ids: list[str]) -> SelectionPlan:
    """Resolve selected form_ids against the registry into a SelectionPlan."""
    plan = SelectionPlan()
    n_buildings = len(sub.property_locations or [])

    resolved = []
    for fid in form_ids:
        form = acord_registry.get(fid)
        if form is None:
            plan.unknown_form_ids.append(fid)
        else:
            resolved.append(form)

    # Lines of business → 125 boxes + opportunities.
    for form in resolved:
        if form.selectable_line:
            plan.lines.append(form.line_of_business)
            plan.opportunities.append(opportunity_draft(sub, form.line_of_business))

    a125 = acord125.from_submission(sub)
    plan.lob_checkboxes_125 = {
        acord125.LOB_CHECKBOX[lob]: acord125.CHECKBOX_ON
        for lob in plan.lines
        if lob in acord125.LOB_CHECKBOX
    }

    # Forms with a filler get produced; per-building forms expand to one per location.
    for form in resolved:
        if not form.has_filler:
            plan.selectable_without_filler.append(form.form_id)
            continue
        count = max(1, n_buildings) if form.per_building else 1
        plan.forms_to_fill.append(FormToFill(
            form_id=form.form_id, template_env=form.template_env,
            count=count, has_filler=True,
        ))

    return plan
