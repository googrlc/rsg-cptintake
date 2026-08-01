"""Lane configs — adding a lane is adding a YAML file, never code.

``LaneConfig`` is validated against the spine at load time: every
``extraction_fields`` entry must be a known field alias (see
``submission.FIELD_ALIASES``) and ``xdate`` must appear in every lane
(spec guardrail #5 — XDATE is the highest-priority field, always). The app
refuses to boot on an invalid lane file, so a typo can't ship silently.

If a new lane ever needs new code, the engine design is wrong — add the field
to the spine + FIELD_ALIASES, not a special case here.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field, model_validator

from .submission import REQUIRED_LANE_FIELD, is_known_field
from .validators import REGISTRY as _VALIDATOR_REGISTRY

try:  # PyYAML when available; a zero-dep subset loader otherwise.
    import yaml

    def _parse_yaml(text: str):
        return yaml.safe_load(text)

    _YAMLError: type[Exception] = yaml.YAMLError
except ModuleNotFoundError:  # pragma: no cover - environment dependent
    from . import _miniyaml

    def _parse_yaml(text: str):
        return _miniyaml.load(text)

    _YAMLError = ValueError

# Validator names a lane may reference — the single source of truth is the
# implementation registry in validators.py, so a lane can't name a validator
# that doesn't exist.
KNOWN_VALIDATORS: set[str] = set(_VALIDATOR_REGISTRY)

_LANES_DIR = Path(__file__).parent / "lanes"


class Deliverable(BaseModel):
    kind: str
    title: str


class LaneConfig(BaseModel):
    key: str
    owner: str                      # "gretchen" | "lamar"
    label: str
    sublabel: Optional[str] = None
    theme: str = "teal"             # teal = Gretchen, purple = Lamar
    accepted_doc_types: list[str] = Field(default_factory=list)
    extraction_fields: list[str] = Field(default_factory=list)
    validators: list[str] = Field(default_factory=list)
    deliverables: list[Deliverable] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_against_spine(self) -> "LaneConfig":
        unknown = [f for f in self.extraction_fields if not is_known_field(f)]
        if unknown:
            raise ValueError(
                f"lane '{self.key}': unknown extraction_fields {unknown} "
                f"— add them to submission.FIELD_ALIASES or fix the typo"
            )
        if REQUIRED_LANE_FIELD not in self.extraction_fields:
            raise ValueError(
                f"lane '{self.key}': '{REQUIRED_LANE_FIELD}' must be in "
                f"extraction_fields (XDATE-first rule)"
            )
        bad = [v for v in self.validators if v not in KNOWN_VALIDATORS]
        if bad:
            raise ValueError(f"lane '{self.key}': unknown validators {bad}")
        return self


class LaneError(Exception):
    pass


def load_lane(path: str | Path) -> LaneConfig:
    p = Path(path)
    try:
        data = _parse_yaml(p.read_text(encoding="utf-8")) or {}
    except FileNotFoundError as exc:
        raise LaneError(f"lane file not found: {p}") from exc
    except _YAMLError as exc:
        raise LaneError(f"lane '{p.name}' is not valid YAML: {exc}") from exc
    if not isinstance(data, dict):
        raise LaneError(f"lane '{p.name}' must be a YAML mapping")
    try:
        return LaneConfig(**data)
    except Exception as exc:  # pydantic ValidationError or our ValueError
        raise LaneError(f"lane '{p.name}' invalid: {exc}") from exc


def load_all_lanes(directory: str | Path | None = None) -> dict[str, LaneConfig]:
    """Load + validate every lane YAML. Raises LaneError on the first bad file
    or a duplicate key — the app should call this at startup and refuse to boot
    if it raises."""
    d = Path(directory) if directory else _LANES_DIR
    lanes: dict[str, LaneConfig] = {}
    for path in sorted(d.glob("*.yaml")):
        lane = load_lane(path)
        if lane.key in lanes:
            raise LaneError(f"duplicate lane key '{lane.key}' ({path.name})")
        lanes[lane.key] = lane
    return lanes
