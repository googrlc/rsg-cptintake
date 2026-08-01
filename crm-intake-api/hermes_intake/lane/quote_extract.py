"""General insurance-quote field extractor — a PDF (or its text) -> structured JSON.

This is the "any extraction I may request" engine: given a quote, dec page, or
binder, it returns the key fields (carrier, policy number, premium, effective /
expiration dates, coverage limits, deductible, insured). It's built on the same
top-model gateway as intake synthesis and reuses the OCR tier, so:

  * text-layer PDFs  -> read text -> top model extracts fields
  * scanned PDFs     -> render pages -> top model reads + extracts in one vision call

Never invents: a field the document doesn't clearly state is omitted (it "stays
on the PDF"). Any failure (no key, bad JSON, model error) returns empty fields
rather than raising — callers get partial truth, never fiction.
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

# The quote spine. `coverage_limits` is an object (coverage name -> limit string)
# so multi-line policies keep their per-coverage detail.
_QUOTE_KEYS = (
    "carrier", "policy_number", "quote_number", "insured_name",
    "line_of_business", "premium", "effective_date", "expiration_date",
    "coverage_limits", "deductible",
)

_QUOTE_SYSTEM = (
    "You extract structured data from insurance quotes, declaration pages, and "
    "binders for an independent agency. Return a strict JSON object using ONLY "
    "these keys (omit any you cannot read with confidence — never guess):\n"
    "  carrier          - issuing carrier / insurer name\n"
    "  policy_number    - policy number (or binder number)\n"
    "  quote_number     - quote number, if distinct from the policy number\n"
    "  insured_name     - named insured (business or person)\n"
    "  line_of_business - e.g. General Liability, Commercial Auto, BOP, Workers Comp, Property, Home, Auto\n"
    "  premium          - total premium as a bare number (no $ or commas)\n"
    "  effective_date   - policy effective date (YYYY-MM-DD)\n"
    "  expiration_date  - policy expiration date (YYYY-MM-DD)\n"
    "  coverage_limits  - object mapping each coverage name to its limit as written "
    "(e.g. {\"Each Occurrence\": \"$1,000,000\", \"General Aggregate\": \"$2,000,000\"})\n"
    "  deductible       - deductible as written (e.g. \"$1,000\" or \"$2,500 wind/hail\")\n\n"
    "Rules: transcribe values exactly as shown for limits/deductible; dates as "
    "YYYY-MM-DD; premium as a bare number. If the document clearly does not state "
    "a field, leave the key out. Output only the JSON object."
)


def _loads(raw: str) -> dict[str, Any]:
    """Parse a JSON object out of a model reply, tolerating code fences / prose."""
    raw = (raw or "").strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{.*\}", raw, re.S)  # first {...last} span
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return {}
    return {}


def _clean(data: Any) -> dict[str, Any]:
    """Keep only known, non-empty quote keys."""
    if not isinstance(data, dict):
        return {}
    out: dict[str, Any] = {}
    for key in _QUOTE_KEYS:
        value = data.get(key)
        if value in (None, "", [], {}):
            continue
        out[key] = value
    return out


def _model():
    from hermes_core.llm_client import get_client, resolve_model
    from hermes_intake.lane.synthesis import synthesis_model

    return get_client(), resolve_model(synthesis_model())


def extract_quote(*, text: str | None = None, images: list[bytes] | None = None,
                  model: str | None = None) -> dict[str, Any]:
    """Text OR page images -> confident quote fields. ``{}`` on any failure."""
    if not (text and text.strip()) and not images:
        return {}
    try:
        oai, chosen = _model()
        if model:
            from hermes_core.llm_client import resolve_model
            chosen = resolve_model(model)
    except Exception:  # noqa: BLE001
        log.info("quote extraction skipped — LLM client unavailable")
        return {}

    if images:
        from .ocr import image_data_url

        content: list[dict] = [{"type": "text",
                                "text": "Extract the quote fields from these page images."}]
        content += [{"type": "image_url", "image_url": {"url": image_data_url(p)}} for p in images]
        user_msg: Any = content
    else:
        user_msg = f"Extract the quote fields from this document text:\n\n{text[:20000]}"

    try:
        kwargs: dict[str, Any] = {"temperature": 0}
        if not images:  # json_object mode is reliable for text; skip for vision
            kwargs["response_format"] = {"type": "json_object"}
        resp = oai.chat.completions.create(
            model=chosen,
            messages=[{"role": "system", "content": _QUOTE_SYSTEM},
                      {"role": "user", "content": user_msg}],
            **kwargs,
        )
        raw = (resp.choices[0].message.content or "") if resp.choices else ""
    except Exception:  # noqa: BLE001
        log.exception("quote extraction call failed (model=%s)", chosen)
        return {}
    return _clean(_loads(raw))


def extract_quote_from_pdf(path: str | Path, *, model: str | None = None) -> dict[str, Any]:
    """Full pipeline: read the text layer; OCR via vision when it's a scanned
    page; extract quote fields. Returns fields plus provenance metadata."""
    from .extract import read_text
    from .ocr import render_pdf_to_images

    text = read_text(path)
    substantive = len(text.strip()) >= 40
    if substantive:
        fields = extract_quote(text=text, model=model)
        return {"fields": fields, "ocr_used": False,
                "pages": None, "text_chars": len(text.strip())}

    images = render_pdf_to_images(path)
    fields = extract_quote(images=images, model=model)
    return {"fields": fields, "ocr_used": bool(images),
            "pages": len(images), "text_chars": len(text.strip())}
