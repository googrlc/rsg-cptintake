"""FastAPI routes for the Command Center intake lane.

Thin wrappers over the tested service layer; the review gate's ``ReviewError``
status codes (403/409/422/404/400) map straight to HTTP. Mounted by hermes/api.py
under ``/api/command-center/intake`` (plus the ``/command-center/intake`` page).
"""
from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel

from . import dashboard, service, storage, store
from .extract import read_text
from .lanes import load_all_lanes
from .review import ReviewError

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/command-center/intake", tags=["command-center-intake"])

# Lanes load once at import — an invalid lane file fails the app fast (by design).
LANES = load_all_lanes()

_supa = None


def _get_supa():
    global _supa
    if _supa is None:
        from hermes_integrations.supabase_client import SupabaseClient
        _supa = SupabaseClient()
    return _supa


def _http(exc: ReviewError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=str(exc))


class CreateReq(BaseModel):
    lane: str
    client_name: str
    created_by: str = "gretchen"


class FixReq(BaseModel):
    updates: dict[str, Any]
    actor: str = "gretchen"


class ApproveReq(BaseModel):
    actor: str = "gretchen"



@router.get("/lanes")
async def list_lanes():
    return {"lanes": [
        {"key": l.key, "owner": l.owner, "label": l.label, "sublabel": l.sublabel,
         "theme": l.theme, "accepted_doc_types": l.accepted_doc_types,
         "deliverables": [d.kind for d in l.deliverables]}
        for l in LANES.values()
    ]}


@router.post("/submissions")
async def create_submission(req: CreateReq):
    try:
        return service.create(_get_supa(), req.lane, req.client_name, req.created_by, LANES)
    except ReviewError as exc:
        raise _http(exc)


@router.get("/submissions")
async def list_submissions(status: Optional[str] = None):
    rows = store.list_submissions(_get_supa(), status=status)
    return {"submissions": rows, "count": len(rows)}


@router.get("/submissions/{submission_id}")
async def get_submission(submission_id: str):
    supa = _get_supa()
    row = store.get_submission(supa, submission_id)
    if row is None:
        raise HTTPException(404, "submission not found")
    row["deliverables"] = store.list_deliverables(supa, submission_id)
    row["files"] = store.list_files(supa, submission_id)
    row["events"] = store.list_events(supa, submission_id)
    return row


@router.post("/submissions/{submission_id}/files")
async def upload_files(submission_id: str, files: list[UploadFile] = File(...)):
    specs = []
    for uf in files:
        data = await uf.read()
        key = storage.upload_bytes(f"{submission_id}/{uf.filename}", data,
                                   content_type=uf.content_type)
        suffix = Path(uf.filename).suffix
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name
        try:
            text = read_text(tmp_path)
        finally:
            os.unlink(tmp_path)
        specs.append({"filename": uf.filename, "text": text,
                      "storage_path": key, "size_bytes": len(data)})
    try:
        return service.ingest_files(_get_supa(), submission_id, specs, LANES)
    except ReviewError as exc:
        raise _http(exc)


@router.post("/submissions/{submission_id}/fields")
async def fix_fields(submission_id: str, req: FixReq):
    try:
        return service.apply_fixes(_get_supa(), submission_id, req.updates, LANES, actor=req.actor)
    except ReviewError as exc:
        raise _http(exc)


@router.post("/submissions/{submission_id}/approve")
async def approve(submission_id: str, req: ApproveReq):
    try:
        return service.approve(_get_supa(), submission_id, req.actor, LANES)
    except ReviewError as exc:
        raise _http(exc)


@router.get("/submissions/{submission_id}/download")
async def download(submission_id: str):
    try:
        blob = service.download_bundle(_get_supa(), submission_id)
    except ReviewError as exc:
        raise _http(exc)
    return Response(content=blob, media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{submission_id}.zip"'})


@router.get("/page", response_class=HTMLResponse)
async def intake_page():
    html = Path(__file__).parent / "webui" / "intake.html"
    if not html.is_file():
        raise HTTPException(404, "intake page not built")
    return HTMLResponse(html.read_text(encoding="utf-8"))


# --- Dashboard (Phase 2) — separate router, correctly scoped ---------------
dashboard_router = APIRouter(prefix="/api/command-center/dashboard", tags=["command-center-dashboard"])


@dashboard_router.get("/summary")
async def dashboard_summary():
    return dashboard.kpi_summary(_get_supa())


@dashboard_router.get("/approval-queue")
async def dashboard_approval_queue():
    return {"queue": dashboard.approval_queue(_get_supa())}


@dashboard_router.get("/feed")
async def dashboard_feed(limit: int = 25):
    return {"events": dashboard.activity_feed(_get_supa(), limit=limit)}


@dashboard_router.get("/email-queue")
async def dashboard_email_queue(limit: int = 50):
    """The two email lanes only — what the existing dashboard card renders."""
    return dashboard.email_queue(_get_supa(), limit=limit)


@dashboard_router.get("/intake-queue")
async def dashboard_intake_queue(limit: int = 50):
    """Every intake_submissions row, whatever produced it.

    With no Slack in the loop this is the window onto the intake pipeline: what
    is waiting, what is mid-flight, and what failed. Filtering it to the email
    lanes (as /email-queue does) hides every intake-gate submission from the only
    person who could act on it.
    """
    return dashboard.intake_queue(_get_supa(), limit=limit)


@dashboard_router.get("/retention-trend")
async def dashboard_retention_trend(limit: int = 24):
    return dashboard.retention_trend(_get_supa(), limit=limit)


@dashboard_router.get("/pipeline")
async def dashboard_pipeline():
    # Supabase read — degrade gracefully so the rest of the dashboard still loads.
    try:
        return dashboard.pipeline_report(_get_supa())
    except Exception as exc:  # noqa: BLE001 — surface, don't 500 the dashboard
        log.warning("pipeline report failed: %s", exc)
        raise HTTPException(503, f"pipeline unavailable: {exc}")


@dashboard_router.get("/page", response_class=HTMLResponse)
async def dashboard_page():
    html = Path(__file__).parent / "webui" / "dashboard.html"
    if not html.is_file():
        raise HTTPException(404, "dashboard not built")
    return HTMLResponse(html.read_text(encoding="utf-8"))
