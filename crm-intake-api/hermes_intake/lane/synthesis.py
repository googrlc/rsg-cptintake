"""Top-model intake synthesis — the reasoning-heavy 'read the document' step.

`extract.py` is the deterministic (regex) baseline; this is the LLM-assisted upgrade
that slots behind the same interface. It reads raw intake text (a dec page, ACORD,
email, or dictated notes) and returns confident spine fields — the same
``{alias: value}`` shape `apply_extraction`/`apply_synthesis` gap-fill into a
``SubmissionObject``.

Design rules:
- **Highest-level AI.** Synthesis routes to ``HERMES_SYNTHESIS_MODEL`` (the top Claude
  group in LiteLLM), not the cheap default agent model — extraction is judgment work.
- **Never invent.** Only emit a field when the document clearly states it. Anything
  uncertain is omitted on purpose — it "stays on the PDF", not force-fit into a field.
- **Additive + safe.** Any failure (no key, bad JSON, model error) returns ``{}`` so the
  deterministic extractor still stands. Synthesis only ever *gap-fills*.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import date, datetime
from typing import Any

from hermes_intake.lane.submission import (
    SubmissionObject,
    is_known_field,
    resolve_alias,
)

log = logging.getLogger(__name__)

# The scalar spine fields synthesis fills in Phase 1. Lists (drivers, vehicles,
# property, coverage, prior carriers, loss history) are richer objects handled
# later; here we stay with the high-signal scalars the whole book turns on.
_SYNTH_ALIASES: tuple[str, ...] = (
    "insured_name",
    "xdate",
    "current_carrier",
    "current_premium",
    "target_effective_date",
    "email",
    "phone",
    "fein",
    "naics",
    "sic",
)

_DATE_PATHS = {"current_policy_expiration", "target_effective_date"}
_FLOAT_PATHS = {"current_premium"}

_SYNTH_SYSTEM = (
    "You are the intake synthesizer for an independent insurance agency. Read the "
    "provided document or notes and extract ONLY facts the text clearly states.\n\n"
    "Return a strict JSON object using ONLY these keys (omit any you are not confident "
    "about — do not guess; anything uncertain stays on the source document):\n"
    "  insured_name           - the named insured / business or person\n"
    "  xdate                  - current policy expiration date (YYYY-MM-DD)\n"
    "  current_carrier        - the incumbent carrier\n"
    "  current_premium        - current annual premium, number only\n"
    "  target_effective_date  - requested new effective date (YYYY-MM-DD)\n"
    "  email                  - primary contact email\n"
    "  phone                  - primary contact phone\n"
    "  fein                   - federal EIN\n"
    "  naics                  - NAICS code\n"
    "  sic                    - SIC code\n\n"
    "Rules: never invent a value; if the document does not clearly state a field, leave "
    "it out. Dates as YYYY-MM-DD. Premium as a bare number (no $ or commas). Output only "
    "the JSON object, nothing else."
)


def synthesis_model() -> str:
    """The top-tier model group for synthesis (falls back to the default group)."""
    from hermes_core.llm_client import default_model

    return os.environ.get("HERMES_SYNTHESIS_MODEL", "").strip() or default_model()


def synthesize_fields(text: str, *, doc_type: str = "dec_page", model: str | None = None) -> dict[str, Any]:
    """Raw intake text -> confident ``{alias: value}`` via the top model. ``{}`` on any failure."""
    text = (text or "").strip()
    if not text:
        return {}
    try:
        from hermes_core.llm_client import get_client, resolve_model

        oai = get_client()
    except Exception:  # noqa: BLE001  (LLMConfigError / ImportError / missing key)
        log.info("intake synthesis skipped — LLM client unavailable")
        return {}

    chosen = resolve_model(model or synthesis_model())
    try:
        resp = oai.chat.completions.create(
            model=chosen,
            messages=[
                {"role": "system", "content": _SYNTH_SYSTEM},
                {"role": "user", "content": f"Document type: {doc_type}\n\n{text[:20000]}"},
            ],
            temperature=0,
            response_format={"type": "json_object"},
        )
        raw = (resp.choices[0].message.content or "{}") if resp.choices else "{}"
        data = json.loads(raw)
    except Exception:  # noqa: BLE001
        log.exception("intake synthesis call/parse failed (model=%s)", chosen)
        return {}

    if not isinstance(data, dict):
        return {}
    out: dict[str, Any] = {}
    for key, value in data.items():
        if value in (None, "", [], {}):
            continue
        if key in _SYNTH_ALIASES and is_known_field(key):
            out[key] = value
    return out


def _to_date(value: Any) -> date | None:
    if isinstance(value, date):
        return value
    s = str(value).strip()[:10]
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        return None


def _to_float(value: Any) -> float | None:
    try:
        return float(str(value).replace("$", "").replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _coerce(path: str, value: Any) -> Any:
    if path in _DATE_PATHS:
        return _to_date(value)
    if path in _FLOAT_PATHS:
        return _to_float(value)
    return str(value).strip() or None


def _gap_fill_path(root: Any, dotted: str, value: Any) -> bool:
    """Set ``dotted`` on ``root`` only if currently empty. Returns True if set."""
    obj = root
    parts = dotted.split(".")
    for part in parts[:-1]:
        obj = getattr(obj, part, None)
        if obj is None:
            return False
    leaf = parts[-1]
    if getattr(obj, leaf, None) in (None, ""):
        setattr(obj, leaf, value)
        return True
    return False


def apply_synthesis(sub: SubmissionObject, alias_fields: dict[str, Any], source: str) -> SubmissionObject:
    """Gap-fill a submission from synthesized fields (never overwrite) + record provenance."""
    for alias, value in alias_fields.items():
        path = resolve_alias(alias)
        if not path:
            continue
        coerced = _coerce(path, value)
        if coerced in (None, ""):
            continue
        if _gap_fill_path(sub, path, coerced):
            sub.enrichment.sources[path] = source
    return sub


def enrich_submission(sub: SubmissionObject, text: str, *, doc_type: str = "dec_page",
                      model: str | None = None) -> SubmissionObject:
    """Convenience: run top-model synthesis over ``text`` and gap-fill ``sub``.

    Deterministic extraction (extract.py) still runs in the service; this adds the
    LLM layer on top, tagged with the synthesis model for provenance.
    """
    fields = synthesize_fields(text, doc_type=doc_type, model=model)
    if not fields:
        return sub
    return apply_synthesis(sub, fields, source=f"synthesis:{resolve_model_label(model)}")


def resolve_model_label(model: str | None) -> str:
    try:
        from hermes_core.llm_client import resolve_model

        return resolve_model(model or synthesis_model())
    except Exception:  # noqa: BLE001
        return "synthesis"
