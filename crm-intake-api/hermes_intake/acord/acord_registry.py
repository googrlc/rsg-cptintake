"""ACORD form registry — loads the extensible catalog (``acord_forms.yaml``).

The registry is the read side of "the place to store and add more accords and
supplementals": it turns the YAML catalog into ``AcordForm`` records the selection
model and pack generator use. Adding a form is a YAML edit; no code change is
needed to list, select, attach, or create the opportunity for it — only to also
fill its PDF (which needs a ``filler`` module).
"""

from __future__ import annotations

import functools
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

_CATALOG_PATH = Path(__file__).resolve().parent / "acord_forms.yaml"

ROLE_BASE = "base"
ROLE_LOB = "lob"
ROLE_SUPPLEMENTAL = "supplemental"


@dataclass(frozen=True)
class AcordForm:
    form_id: str
    title: str
    role: str
    line_of_business: Optional[str]
    template_env: Optional[str]
    filler: Optional[str]
    per_building: bool = False

    @property
    def selectable_line(self) -> bool:
        """A line the agent can check → 125 box + opportunity."""
        return self.role == ROLE_LOB and bool(self.line_of_business)

    @property
    def has_filler(self) -> bool:
        """True once a PDF filler module exists (else: selectable, but no PDF yet)."""
        return bool(self.filler)

    @property
    def lob_checkbox_125(self) -> Optional[str]:
        """The ACORD 125 line-of-business checkbox to set when this line is chosen."""
        if not self.line_of_business:
            return None
        from hermes_intake.acord.acord125 import LOB_CHECKBOX

        return LOB_CHECKBOX.get(self.line_of_business)


@functools.lru_cache(maxsize=1)
def load_registry() -> dict[str, AcordForm]:
    """form_id → AcordForm, from the YAML catalog (cached)."""
    import yaml

    with open(_CATALOG_PATH, "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh) or {}
    out: dict[str, AcordForm] = {}
    for entry in raw.get("forms", []):
        fid = entry.get("form_id")
        if not fid:
            continue
        out[fid] = AcordForm(
            form_id=fid,
            title=entry.get("title", fid),
            role=entry.get("role", ROLE_SUPPLEMENTAL),
            line_of_business=entry.get("line_of_business"),
            template_env=entry.get("template_env"),
            filler=entry.get("filler"),
            per_building=bool(entry.get("per_building", False)),
        )
    return out


def all_forms() -> list[AcordForm]:
    return list(load_registry().values())


def get(form_id: str) -> Optional[AcordForm]:
    return load_registry().get(form_id)


def selectable_lines() -> list[AcordForm]:
    """The line-of-business forms an agent can check (drives 125 box + opportunity)."""
    return [f for f in all_forms() if f.selectable_line]


def base_form() -> Optional[AcordForm]:
    return next((f for f in all_forms() if f.role == ROLE_BASE), None)
