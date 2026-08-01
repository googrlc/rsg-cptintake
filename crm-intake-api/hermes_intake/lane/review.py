"""The review gate — the protected core of the Command Center.

Nothing leaves the building unreviewed. This module owns the lifecycle state
machine and the hard gates; the API layer (and the worker) call these and map
``ReviewError.status_code`` straight to an HTTP status.

State machine (spec §6):

    draft -> extracting -> in_review -> approved -> delivered
                              ^   |
                              +---+  (fixing flagged fields keeps it in_review)

Hard rules (proved in tests/test_cc_review_gate.py):
  1. ``download`` raises 403 for any status other than approved.
  2. ``approve`` raises 422 if any blocking-severity flag remains.
  3. State can never skip — ``draft`` cannot jump to ``approved``.
  4. Every transition appends a ``review_events`` row (actor + timestamp).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional


class ReviewState(str, Enum):
    DRAFT = "draft"
    EXTRACTING = "extracting"
    IN_REVIEW = "in_review"
    APPROVED = "approved"
    DELIVERED = "delivered"


# The only legal moves. Everything else is rejected (no skipping).
ALLOWED_TRANSITIONS: dict[ReviewState, set[ReviewState]] = {
    ReviewState.DRAFT: {ReviewState.EXTRACTING},
    ReviewState.EXTRACTING: {ReviewState.IN_REVIEW},
    ReviewState.IN_REVIEW: {ReviewState.IN_REVIEW, ReviewState.APPROVED},
    ReviewState.APPROVED: {ReviewState.DELIVERED},
    ReviewState.DELIVERED: set(),
}

# Statuses from which artifacts may leave the building.
_RELEASED = {ReviewState.APPROVED, ReviewState.DELIVERED}


class Severity(str, Enum):
    BLOCKING = "blocking"
    WARNING = "warning"


@dataclass
class Flag:
    """A validator finding. Blocking flags hold back approval."""
    field: str
    message: str
    severity: Severity = Severity.BLOCKING

    def to_dict(self) -> dict[str, str]:
        return {"field": self.field, "message": self.message, "severity": self.severity.value}


class ReviewError(Exception):
    """Carries the HTTP status the API should return (403/409/422)."""

    def __init__(self, message: str, status_code: int = 409):
        super().__init__(message)
        self.status_code = status_code


def _coerce_state(value: Any) -> ReviewState:
    if isinstance(value, ReviewState):
        return value
    try:
        return ReviewState(str(value).strip().lower())
    except ValueError as exc:
        raise ReviewError(f"unknown review state: {value!r}", 400) from exc


def _flag_severity(flag: Any) -> str:
    if isinstance(flag, dict):
        return str(flag.get("severity", "blocking"))
    sev = getattr(flag, "severity", Severity.BLOCKING)
    return sev.value if isinstance(sev, Severity) else str(sev)


def has_blocking_flags(flags: list[Any]) -> bool:
    """True if any flag is blocking-severity. Accepts Flag objects or dicts."""
    return any(_flag_severity(f) == Severity.BLOCKING.value for f in (flags or []))


# ---- the gates -----------------------------------------------------------

def assert_transition(current: Any, target: Any) -> None:
    """Raise ReviewError(409) if current -> target is not a legal move."""
    cur, nxt = _coerce_state(current), _coerce_state(target)
    if nxt not in ALLOWED_TRANSITIONS.get(cur, set()):
        raise ReviewError(f"illegal transition: {cur.value} -> {nxt.value}", 409)


def assert_can_approve(current: Any, flags: list[Any]) -> None:
    """Approve is only valid from in_review with zero blocking flags."""
    cur = _coerce_state(current)
    if cur is not ReviewState.IN_REVIEW:
        raise ReviewError(f"can only approve from in_review (was {cur.value})", 409)
    if has_blocking_flags(flags):
        raise ReviewError("cannot approve: blocking flags remain", 422)


def assert_can_download(status: Any) -> None:
    """Download is locked until approved."""
    if _coerce_state(status) not in _RELEASED:
        raise ReviewError("download locked: submission is not approved", 403)


def review_event(submission_id: str, actor: str, action: str,
                 detail: Optional[dict] = None) -> dict[str, Any]:
    """Build an immutable audit row for the ``review_events`` table."""
    return {
        "submission_id": submission_id,
        "actor": actor,
        "action": action,
        "detail": detail or {},
        "at": datetime.now(timezone.utc).isoformat(),
    }
