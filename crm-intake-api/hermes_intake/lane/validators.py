"""Lane validators — turn a SubmissionObject into review flags.

A lane lists validator names; ``run_validators`` executes them and returns the
flags (blocking flags hold back approval, warnings don't). Extraction fills what
it can; validators flag what's missing; the human fixes it in the review UI —
the gate catches what extraction misses. That's the design, not a failure.

XDATE gets the strongest treatment: ``xdate_present`` is blocking in every lane.
"""
from __future__ import annotations

from typing import Callable, Optional

from .review import Flag, Severity
from .submission import SubmissionObject

Validator = Callable[[SubmissionObject], Optional[Flag]]


def xdate_present(sub: SubmissionObject) -> Optional[Flag]:
    if sub.current_policy_expiration is None:
        return Flag("xdate", "X-date (current policy expiration) is required", Severity.BLOCKING)
    return None


def insured_name_present(sub: SubmissionObject) -> Optional[Flag]:
    if not (sub.client_name or sub.applicant.legal_name):
        return Flag("insured_name", "Insured name is required", Severity.BLOCKING)
    return None


# alias — same check, spine field name
client_name_present = insured_name_present


def address_present(sub: SubmissionObject) -> Optional[Flag]:
    a = sub.applicant.mailing_address
    if not (a and (a.street or a.city)):
        return Flag("address", "Mailing address is required", Severity.BLOCKING)
    return None


def current_carrier_present(sub: SubmissionObject) -> Optional[Flag]:
    if not sub.current_carrier:
        return Flag("current_carrier", "Current carrier is required", Severity.BLOCKING)
    return None


def premium_is_number(sub: SubmissionObject) -> Optional[Flag]:
    p = sub.current_premium
    if p is None:
        return None  # absence is a different concern; this checks the type only
    if not isinstance(p, (int, float)) or isinstance(p, bool):
        return Flag("current_premium", "Premium must be a number", Severity.WARNING)
    return None


REGISTRY: dict[str, Validator] = {
    "xdate_present": xdate_present,
    "insured_name_present": insured_name_present,
    "client_name_present": client_name_present,
    "address_present": address_present,
    "current_carrier_present": current_carrier_present,
    "premium_is_number": premium_is_number,
}


def run_validators(sub: SubmissionObject, names: list[str]) -> list[dict]:
    """Run the named validators against a submission; return flag dicts
    (``review_events``/``submissions.flags`` jsonb shape). Unknown names are
    skipped — the lane loader already rejects unknown validators at boot."""
    flags: list[dict] = []
    for name in names:
        fn = REGISTRY.get(name)
        if fn is None:
            continue
        flag = fn(sub)
        if flag is not None:
            flags.append(flag.to_dict())
    return flags
