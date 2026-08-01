"""The POST /api/intake request contract.

Covers the two things a caller can carry that change what the worker does: an
already-synthesized payload (skip extraction) and an approval (skip the wait).
Both exist for the RSG intake gate, which reviews an intake in front of a person
before sending it — and which has no Slack to fall back on if the row parks.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from hermes_intake.router import IntakeSubmissionRequest

BASE = {
    "idempotency_key": "rsg-intake-gate:abc",
    "source": "intake_gate",
    "agent": "lamar",
    "captured_at": "2026-06-03T12:00:00+00:00",
}
PAYLOAD = {"account": {"account_name": "Acme"}, "opportunities": [{"line_of_business": "General Liability"}]}


def test_the_intake_gate_is_a_named_source():
    """Not folded into manual_curl — a reviewed, cited intake is not a hand-rolled curl."""
    assert IntakeSubmissionRequest(**BASE, synthesized_payload=PAYLOAD).source == "intake_gate"


def test_a_synthesized_payload_is_content_enough_on_its_own():
    """Requiring a transcript alongside it would mean sending text nothing reads."""
    req = IntakeSubmissionRequest(**BASE, synthesized_payload=PAYLOAD)
    assert req.transcript is None and not req.documents


def test_a_submission_with_no_content_at_all_is_refused():
    with pytest.raises(ValidationError, match="synthesized_payload"):
        IntakeSubmissionRequest(**BASE)


def test_an_approval_names_who_gave_it():
    req = IntakeSubmissionRequest(**BASE, synthesized_payload=PAYLOAD, approved_by="lamar")
    assert req.approved_by == "lamar"


def test_a_token_without_an_approver_is_an_unsigned_approval():
    """The whole point of the field is accountability; a token alone has none."""
    with pytest.raises(ValidationError, match="approved_by"):
        IntakeSubmissionRequest(**BASE, synthesized_payload=PAYLOAD, approval_token="APPROVE ALL")


def test_a_blank_approver_is_refused_rather_than_read_as_unapproved():
    with pytest.raises(ValidationError, match="approved_by"):
        IntakeSubmissionRequest(**BASE, synthesized_payload=PAYLOAD, approved_by="   ")


def test_an_unknown_approval_token_is_refused():
    with pytest.raises(ValidationError, match="not allowed"):
        IntakeSubmissionRequest(
            **BASE, synthesized_payload=PAYLOAD, approved_by="lamar", approval_token="YOLO",
        )


@pytest.mark.parametrize("token", ["APPROVE ALL", "approve crm only", "APPROVE SUPABASE ONLY"])
def test_the_documented_tokens_are_accepted_case_insensitively(token):
    req = IntakeSubmissionRequest(
        **BASE, synthesized_payload=PAYLOAD, approved_by="lamar", approval_token=token,
    )
    assert req.approval_token == token


def test_no_approval_is_a_valid_submission():
    """Absent means 'wait for an approver' — the historical behaviour, unchanged."""
    req = IntakeSubmissionRequest(**BASE, synthesized_payload=PAYLOAD)
    assert req.approved_by is None and req.approval_token is None
