"""General document extraction endpoint — POST a PDF, get structured quote JSON.

The "any extraction I may request" door. Runs the OCR-aware pipeline
(``quote_extract.extract_quote_from_pdf``): text-layer read, vision OCR fallback
for scanned pages, then top-model field extraction. Mounted by hermes/api.py.
"""
from __future__ import annotations

import logging
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/extract", tags=["extract"])

_MAX_BYTES = 25 * 1024 * 1024  # 25 MB — quotes/dec pages are small


@router.post("")
async def extract_document(file: UploadFile = File(...)):
    """Extract carrier, policy number, premium, dates, coverage limits, and
    deductible from an uploaded quote/dec PDF. OCR fires automatically on
    scanned pages. Returns ``{fields, ocr_used, pages, text_chars, filename}``."""
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    if len(data) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="file too large (25 MB max)")

    suffix = Path(file.filename or "upload.pdf").suffix or ".pdf"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(data)
        tmp.flush()
        try:
            from .quote_extract import extract_quote_from_pdf

            result = extract_quote_from_pdf(tmp.name)
        except Exception as exc:  # noqa: BLE001
            log.exception("extract failed for %s", file.filename)
            raise HTTPException(status_code=502, detail=f"extraction failed: {exc}")

    result["filename"] = file.filename
    return result
