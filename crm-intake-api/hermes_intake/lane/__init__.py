"""Hermes Command Center — agency intake + review-gate + lane engine.

The new Command Center (approved spec 2026-06-10). Built fresh; reuses pieces
from the wider `hermes` package (Supabase client, outbound_sync_queue gated
writes, renewal/retention reads) and the submissions spine/extraction
ported from the archived `freshhermes` repo.

Layers:
  submission.py  — THE SPINE (Pydantic v2 canonical record). One per submission.
  lanes.py       — LaneConfig model + YAML loader (validated against the spine).
  review.py      — review-gate state machine (the protected core).
  extract.py     — file -> SubmissionObject field extraction (XDATE-first).
  validators.py  — XDATE-first + per-lane validators.
"""
from __future__ import annotations
