"""Service layer — orchestrates the intake lane lifecycle.

The endpoints are thin wrappers over these functions; the gate rules live in
review.py and are enforced here. Everything takes the Supabase client injected,
so the full flow is testable end-to-end against a fake (see test_cc_service.py).

    create -> ingest_files (extract+validate) -> [apply_fixes] -> approve -> download
"""
from __future__ import annotations

import io
import re
import zipfile
from typing import Any, Optional

from . import store
from .deliverables import _canonical, build_all
from .extract import apply_extraction, classify_doc, extract_fields, read_document_text
from .review import (
    ReviewError,
    assert_can_approve,
    assert_can_download,
)
from .submission import (
    IntakeMeta,
    Lane,
    SourceChannel,
    SubmissionObject,
    resolve_alias,
)
from .validators import run_validators


def _spine_lane(lane_cfg) -> Lane:
    return Lane.PERSONAL_NO_ACORD if lane_cfg.owner == "gretchen" else Lane.COMMERCIAL_ACORD


def _load_or_new(row: dict, lane_cfg) -> SubmissionObject:
    obj = row.get("submission_object")
    if obj:
        return SubmissionObject.model_validate(obj)
    return SubmissionObject(
        submission_id=str(row["id"]),
        client_name=row.get("client_name"),
        lane=_spine_lane(lane_cfg),
        intake=IntakeMeta(channel=SourceChannel.WEBUI, submitted_by=row.get("created_by")),
    )


def _assign(data: dict, dotted: str, value: Any) -> None:
    parts = dotted.split(".")
    d = data
    for p in parts[:-1]:
        nxt = d.get(p)
        if not isinstance(nxt, dict):
            nxt = {}
            d[p] = nxt
        d = nxt
    d[parts[-1]] = value


def _finalize_review(supa, submission_id: str, sub: SubmissionObject, lane_cfg, actor: str) -> dict:
    flags = run_validators(sub, lane_cfg.validators)
    store.save_object_and_flags(supa, submission_id, sub.model_dump(mode="json"), flags)
    store.replace_deliverables(supa, submission_id, build_all(lane_cfg, sub))
    store.set_status(supa, submission_id, "in_review", actor)
    return {"submission": store.get_submission(supa, submission_id), "flags": flags}


# ---- lifecycle -----------------------------------------------------------

def create(supa, lane_key: str, client_name: str, created_by: str, lanes: dict) -> dict:
    if lane_key not in lanes:
        raise ReviewError(f"unknown lane: {lane_key}", 400)
    if not (client_name or "").strip():
        raise ReviewError("client_name is required", 400)
    return store.create_submission(supa, lane=lane_key, client_name=client_name, created_by=created_by)


def ingest_files(supa, submission_id: str, files: list[dict], lanes: dict, actor: str = "gretchen") -> dict:
    """files: [{filename, local_path?|text?, storage_path, doc_type?}]."""
    row = store.get_submission(supa, submission_id)
    if row is None:
        raise ReviewError("submission not found", 404)
    lane_cfg = lanes[row["lane"]]
    sub = _load_or_new(row, lane_cfg)
    store.set_status(supa, submission_id, "extracting", actor)

    for f in files:
        doc_type = f.get("doc_type") or classify_doc(f["filename"])
        store.add_file(supa, submission_id, filename=f["filename"], doc_type=doc_type,
                       storage_path=f["storage_path"], size_bytes=f.get("size_bytes"))
        text = f.get("text")
        if text is None and f.get("local_path"):
            text = read_document_text(f["local_path"])
        fields = extract_fields(text or "", doc_type)
        apply_extraction(sub, fields, source=doc_type)
        store.log_event(supa, submission_id, actor, "extracted",
                        {"file": f["filename"], "doc_type": doc_type, "fields": sorted(fields)})

    return _finalize_review(supa, submission_id, sub, lane_cfg, actor)


def apply_fixes(supa, submission_id: str, field_updates: dict, lanes: dict, actor: str = "gretchen") -> dict:
    """Apply human edits from the review UI (e.g. enter the missing XDATE)."""
    row = store.get_submission(supa, submission_id)
    if row is None:
        raise ReviewError("submission not found", 404)
    lane_cfg = lanes[row["lane"]]
    sub = _load_or_new(row, lane_cfg)
    data = sub.model_dump(mode="python")
    for alias, value in field_updates.items():
        _assign(data, resolve_alias(alias) or alias, value)
    sub = SubmissionObject.model_validate(data)        # re-validate -> coerces types
    for alias in field_updates:
        sub.enrichment.sources[resolve_alias(alias) or alias] = "human"
    store.log_event(supa, submission_id, actor, "fixed", {"fields": sorted(field_updates)})
    return _finalize_review(supa, submission_id, sub, lane_cfg, actor)


def approve(supa, submission_id: str, actor: str, lanes: Optional[dict] = None) -> dict:
    row = store.get_submission(supa, submission_id)
    if row is None:
        raise ReviewError("submission not found", 404)
    assert_can_approve(row["status"], row.get("flags") or [])   # 409 / 422
    return store.set_status(supa, submission_id, "approved", actor, {"approved_by": actor})


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name or "deliverable").strip("_") or "deliverable"


def download_bundle(supa, submission_id: str) -> bytes:
    row = store.get_submission(supa, submission_id)
    if row is None:
        raise ReviewError("submission not found", 404)
    assert_can_download(row["status"])                          # 403 unless approved
    delivs = store.list_deliverables(supa, submission_id)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for d in delivs:
            z.writestr(f"{_safe(d['title'])}.md", d.get("content") or "")
    store.log_event(supa, submission_id, "system", "downloaded", {"count": len(delivs)})
    return buf.getvalue()


