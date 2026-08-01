"""OCR tier for image-only / scanned PDFs — the fallback `extract.read_text`
flags as needed when a PDF has no text layer.

Approach: render pages to PNG with **PyMuPDF** (a pip wheel with bundled native
libs — no `tesseract`/`poppler` system packages, so the box deploy stays a
bind-mount + recreate), then read them with the **top vision model** through the
same LiteLLM gateway synthesis uses. Vision beats local OCR on the dense,
multi-column dec pages and quote PDFs that actually matter, and it's the same
"highest-level AI key" the rest of intake already routes through.

Everything degrades safely: if PyMuPDF is missing, the LLM key is unset, or a
call fails, functions return ``[]`` / ``""`` and the deterministic text tier
still stands. OCR only ever *adds* text that wasn't otherwise readable.
"""
from __future__ import annotations

import base64
import logging
import os
from pathlib import Path

log = logging.getLogger(__name__)

# Bound cost/latency: OCR at most this many pages, at this render resolution.
_MAX_OCR_PAGES = int(os.environ.get("HERMES_OCR_MAX_PAGES", "15"))
_OCR_DPI = int(os.environ.get("HERMES_OCR_DPI", "180"))

_OCR_SYSTEM = (
    "You are an OCR engine for insurance documents (dec pages, quotes, ACORD "
    "forms). Transcribe ALL text from the page images verbatim, preserving "
    "labels, numbers, dates, money amounts, and limits exactly as shown. Read "
    "tables row by row. Do not summarize, interpret, or add commentary — output "
    "only the transcribed text."
)


def render_pdf_to_images(path: str | Path, *, max_pages: int = _MAX_OCR_PAGES,
                         dpi: int = _OCR_DPI) -> list[bytes]:
    """Render up to *max_pages* of a PDF to PNG bytes. ``[]`` if PyMuPDF is
    missing or the file can't be opened."""
    try:
        import pymupdf as fitz  # PyMuPDF 1.24+ primary name
    except Exception:  # noqa: BLE001
        try:
            import fitz  # legacy import name
        except Exception:  # noqa: BLE001
            log.info("OCR skipped — PyMuPDF (pymupdf) not installed")
            return []
    images: list[bytes] = []
    try:
        with fitz.open(str(path)) as doc:
            for page in doc:
                if len(images) >= max_pages:
                    break
                pix = page.get_pixmap(dpi=dpi)
                images.append(pix.tobytes("png"))
    except Exception:  # noqa: BLE001
        log.exception("OCR render failed for %s", path)
        return []
    return images


def image_data_url(png_bytes: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")


def vision_read(images: list[bytes], *, model: str | None = None,
                system: str = _OCR_SYSTEM, instruction: str | None = None) -> str:
    """Send page images to the top vision model and return its text. ``""`` on
    any failure. Shared by the OCR-to-text path and the fused quote extractor."""
    if not images:
        return ""
    try:
        from hermes_core.llm_client import get_client, resolve_model
        from hermes_intake.lane.synthesis import synthesis_model

        oai = get_client()
    except Exception:  # noqa: BLE001
        log.info("vision OCR skipped — LLM client unavailable")
        return ""

    content: list[dict] = [{"type": "text",
                            "text": instruction or "Transcribe every page below."}]
    for png in images:
        content.append({"type": "image_url", "image_url": {"url": image_data_url(png)}})

    chosen = resolve_model(model or synthesis_model())
    try:
        resp = oai.chat.completions.create(
            model=chosen,
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": content}],
            temperature=0,
        )
        return (resp.choices[0].message.content or "").strip() if resp.choices else ""
    except Exception:  # noqa: BLE001
        log.exception("vision OCR call failed (model=%s, pages=%d)", chosen, len(images))
        return ""


def ocr_pdf(path: str | Path, *, model: str | None = None) -> str:
    """Render a PDF and OCR it via the vision model. ``""`` on any failure."""
    return vision_read(render_pdf_to_images(path), model=model)
