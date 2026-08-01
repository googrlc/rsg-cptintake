"""Supabase Storage helper — upload intake files, sign download URLs.

Private buckets only; downloads use short-lived signed URLs. Server-side
service-role key (the browser never sees it). Thin wrapper over the Storage
REST API so we don't add the supabase-py dependency.
"""
from __future__ import annotations

import os
from typing import Optional

import requests

UPLOAD_BUCKET = "cc-intake-uploads"
DELIVERABLE_BUCKET = "cc-deliverables"


def _base() -> str:
    url = os.environ.get("SUPABASE_URL")
    if not url:
        raise RuntimeError("SUPABASE_URL not set")
    return url.rstrip("/")


def _key() -> str:
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY")
    if not key:
        raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY) not set")
    return key


def upload_bytes(path: str, data: bytes, *, bucket: str = UPLOAD_BUCKET,
                 content_type: Optional[str] = None) -> str:
    """Upload bytes to ``bucket/path`` (upsert). Returns the ``bucket/path`` key."""
    url = f"{_base()}/storage/v1/object/{bucket}/{path}"
    headers = {
        "Authorization": f"Bearer {_key()}",
        "Content-Type": content_type or "application/octet-stream",
        "x-upsert": "true",
    }
    resp = requests.post(url, headers=headers, data=data, timeout=30)
    resp.raise_for_status()
    return f"{bucket}/{path}"


def signed_url(path: str, *, bucket: str = UPLOAD_BUCKET, expires_in: int = 3600) -> str:
    url = f"{_base()}/storage/v1/object/sign/{bucket}/{path}"
    headers = {"Authorization": f"Bearer {_key()}", "Content-Type": "application/json"}
    resp = requests.post(url, headers=headers, json={"expiresIn": expires_in}, timeout=15)
    resp.raise_for_status()
    return _base() + resp.json()["signedURL"]
