"""Persistence for the intake lane — CRUD over the cc_* tables.

Every function takes the Supabase client as its first argument (dependency
injection), so the API wires the real ``SupabaseClient`` and tests pass a fake.
Every state change appends a ``cc_review_events`` row — the immutable audit
trail the gate relies on.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from .review import review_event

SUBMISSIONS = "cc_submissions"
FILES = "cc_files"
DELIVERABLES = "cc_deliverables"
EVENTS = "cc_review_events"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---- submissions ---------------------------------------------------------

def create_submission(supa, *, lane: str, client_name: str, created_by: str = "gretchen") -> dict:
    from hermes_core.identity import agent_id

    row = supa.insert(SUBMISSIONS, {
        "lane": lane,
        "client_name": client_name,
        "status": "draft",
        "created_by": created_by,
        "agent_id": agent_id(),
    })
    log_event(supa, row["id"], created_by, "created", {"lane": lane})
    return row


def get_submission(supa, submission_id: str) -> Optional[dict]:
    rows = supa.select(SUBMISSIONS, params={"id": f"eq.{submission_id}"}, limit=1)
    return rows[0] if rows else None


def list_submissions(supa, status: Optional[str] = None, limit: int = 200) -> list[dict]:
    params: dict[str, Any] = {"order": "updated_at.desc"}
    if status:
        params["status"] = f"eq.{status}"
    return supa.select(SUBMISSIONS, params=params, limit=limit)


def save_object_and_flags(supa, submission_id: str, submission_object: dict, flags: list[dict]) -> dict:
    return supa.update(SUBMISSIONS, submission_id, {
        "submission_object": submission_object,
        "flags": flags,
        "updated_at": _now_iso(),
    })


def set_status(supa, submission_id: str, status: str, actor: str, detail: Optional[dict] = None) -> dict:
    row = supa.update(SUBMISSIONS, submission_id, {"status": status, "updated_at": _now_iso()})
    log_event(supa, submission_id, actor, status, detail)
    return row


# ---- files ---------------------------------------------------------------

def add_file(supa, submission_id: str, *, filename: str, doc_type: Optional[str],
             storage_path: str, size_bytes: Optional[int] = None) -> dict:
    return supa.insert(FILES, {
        "submission_id": submission_id,
        "filename": filename,
        "doc_type": doc_type,
        "storage_path": storage_path,
        "size_bytes": size_bytes,
    })


def list_files(supa, submission_id: str) -> list[dict]:
    return supa.select(FILES, params={
        "submission_id": f"eq.{submission_id}", "order": "uploaded_at.asc",
    }, limit=200)


# ---- deliverables --------------------------------------------------------

def add_deliverable(supa, submission_id: str, *, kind: str, title: str,
                    content: str, content_type: str = "text/markdown") -> dict:
    return supa.insert(DELIVERABLES, {
        "submission_id": submission_id,
        "kind": kind,
        "title": title,
        "content": content,
        "content_type": content_type,
        "status": "ready",
    })


def replace_deliverables(supa, submission_id: str, built: list[dict]) -> list[dict]:
    """Rebuild a submission's deliverables (delete-then-insert). Called after a
    fresh extraction/fix so the artifacts reflect the current data."""
    for old in list_deliverables(supa, submission_id):
        supa.delete(DELIVERABLES, old["id"])
    return [
        add_deliverable(supa, submission_id, kind=d["kind"], title=d["title"],
                        content=d["content"], content_type=d.get("content_type", "text/markdown"))
        for d in built
    ]


def list_deliverables(supa, submission_id: str) -> list[dict]:
    return supa.select(DELIVERABLES, params={
        "submission_id": f"eq.{submission_id}", "order": "created_at.asc",
    }, limit=200)


# ---- audit trail ---------------------------------------------------------

def log_event(supa, submission_id: str, actor: str, action: str,
              detail: Optional[dict] = None) -> dict:
    return supa.insert(EVENTS, review_event(submission_id, actor, action, detail))


def list_events(supa, submission_id: str) -> list[dict]:
    return supa.select(EVENTS, params={
        "submission_id": f"eq.{submission_id}", "order": "at.asc",
    }, limit=500)
