"""The synchronous commit — one click and the intake IS in the CRM.

The asynchronous worker buys time for an LLM extraction, a Slack round trip and a
wait for a human. A submission that arrives already synthesized and already
approved has none of those pending, so there is nothing to wait for — and nothing
in this deployment runs the worker loop anyway, so a queued row never moves.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from hermes_intake import worker as W

APPROVED_PAYLOAD = {
    "synthesized_payload": {
        "action": "crm_intake_upsert",
        "approval_required": True,
        "duplicate_search": {},
        "account": {"account_name": "Jarah Group LLC", "fein": "12-3456789"},
        "contacts": [{"full_name": "Jane Ukoh"}],
        "opportunities": [
            {"opportunity_name": "Jarah - GL", "line_of_business": "General Liability"},
            {"opportunity_name": "Jarah - WC", "line_of_business": "Worker's Compensation"},
        ],
        "facts": [{"entity": "Jarah Group LLC", "fact_label": "EIN", "fact_value": "12-3456789",
                   "source": "SRC-001"}],
        "note": {"title": "Discovery call", "body": "Cited."},
    },
    "approval": {"approved_by": "lamar", "token": "APPROVE ALL"},
}


def _supa(payload=None, *, status="received"):
    """A supa whose selects answer both the submission fetch and the dedup probes."""
    supa = MagicMock()
    row = {"id": "sub-1", "status": status, "status_history": [],
           "source": "intake_gate", "payload": payload if payload is not None else APPROVED_PAYLOAD}
    state = {"status": status}

    def _select(table, **kw):
        if table == "intake_submissions":
            return [{**row, "status": state["status"]}]
        return []      # no existing opportunity → create

    counters = {}

    def _insert(table, body):
        counters[table] = counters.get(table, 0) + 1
        return {**body, "id": f"{table[:3]}-{counters[table]}"}

    def _update(table, row_id, body):
        if table == "intake_submissions" and body.get("status"):
            state["status"] = body["status"]
        return {"id": row_id, **body}

    supa.select.side_effect = _select
    supa.insert.side_effect = _insert
    supa.update.side_effect = _update
    supa.counters = counters
    supa.state = state
    return supa


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """Nextcloud + AMS priming are best-effort side trips; keep them offline."""
    monkeypatch.setattr("hermes_intake.opportunity_priming.prime_new_opportunities",
                        lambda *a, **k: {})
    import hermes_integrations.nextcloud_client as nc
    monkeypatch.setattr(nc.NextcloudClient, "is_configured", lambda self: False)
    monkeypatch.setattr(W, "render_blocks", lambda payload: "rendered")
    yield


def test_one_call_takes_the_intake_all_the_way_to_complete(monkeypatch):
    inserted_facts = []
    monkeypatch.setattr(
        "hermes_intake.approval._insert_retrieval_rows",
        lambda supa, payload: {"client_entities": ["e1", "e2"],
                               "client_facts": ["f1"], "client_notes": ["n1"]},
    )
    supa = _supa()
    out = W.commit_submission_now(supa, "sub-1")

    assert out["ok"] is True
    assert out["status"] == "complete"
    assert out["approved_by"] == "lamar"
    assert out["opportunity_count"] == 2
    assert out["entity_count"] == 2 and out["fact_count"] == 1 and out["note_count"] == 1
    # The row really walked the state machine — no jumped states.
    statuses = [c.args[2]["status"] for c in supa.update.call_args_list
                if c.args[0] == "intake_submissions" and c.args[2].get("status")]
    assert statuses == ["synthesizing", "synthesized", "drafting", "awaiting_approval",
                        "approved", "writing", "written", "complete"]


def test_nothing_is_queued_for_the_ams(monkeypatch):
    monkeypatch.setattr(
        "hermes_intake.approval._insert_retrieval_rows",
        lambda supa, payload: {},
    )
    supa = _supa()
    out = W.commit_submission_now(supa, "sub-1")
    assert out["ok"] is True
    assert out["ams_insured_staged"] is False
    assert "outbound_sync_queue" not in supa.counters
    assert supa.counters.get("opportunities") == 2


def test_a_submission_without_an_approver_is_refused_not_committed():
    supa = _supa({"synthesized_payload": {"account": {"account_name": "X"}}})
    out = W.commit_submission_now(supa, "sub-1")
    assert out["ok"] is False
    assert "approver" in out["error"]
    assert "opportunities" not in supa.counters


def test_a_submission_without_a_payload_is_refused():
    supa = _supa({"approval": {"approved_by": "lamar", "token": "APPROVE ALL"}})
    out = W.commit_submission_now(supa, "sub-1")
    assert out["ok"] is False
    assert "synthesized payload" in out["error"]


def test_an_unknown_submission_is_an_error_not_a_crash():
    supa = MagicMock()
    supa.select.return_value = []
    out = W.commit_submission_now(supa, "nope")
    assert out["ok"] is False and "not found" in out["error"]


def test_a_commit_failure_is_reported_and_the_row_is_failed(monkeypatch):
    """The caller is a person looking at a screen; they have to be told."""
    monkeypatch.setattr("hermes_intake.commit.commit_draft",
                        MagicMock(side_effect=RuntimeError("supabase down")))
    supa = _supa()
    out = W.commit_submission_now(supa, "sub-1")
    assert out["ok"] is False
    assert "supabase down" in out["error"]
    assert supa.state["status"] == "failed"


def test_the_approval_scope_is_honoured(monkeypatch):
    """APPROVE CRM ONLY opens the pipeline but writes no retrieval rows."""
    called = {"retrieval": False}

    def _retrieval(supa, payload):
        called["retrieval"] = True
        return {}

    monkeypatch.setattr(
        "hermes_intake.approval._insert_retrieval_rows", _retrieval)
    payload = {**APPROVED_PAYLOAD,
               "approval": {"approved_by": "lamar", "token": "APPROVE CRM ONLY"}}
    supa = _supa(payload)
    out = W.commit_submission_now(supa, "sub-1")
    assert out["ok"] is True
    assert out["opportunity_count"] == 2
    assert called["retrieval"] is False
