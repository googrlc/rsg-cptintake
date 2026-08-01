"""The intake worker's approved->complete arc commits to NowCerts+Supabase."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from hermes_intake import worker as w


def test_process_one_approved_commits_to_nowcerts():
    supa = MagicMock()
    claimed = {
        "id": "sub-1",
        "draft_summary": {
            "account": {"account_name": "X LLC"},
            "opportunities": [{"line_of_business": "General Liability"}],
        },
        "approved_by": "lamar",
    }
    with patch.object(w, "_claim_next_approved", return_value=claimed), \
         patch("hermes_intake.commit.commit_draft") as commit_draft, \
         patch("hermes_intake.submissions.transition") as transition, \
         patch("hermes_intake.approval._insert_retrieval_rows",
               return_value={"client_entities": ["e1"]}) as retrieval, \
         patch.object(w, "_post_alert"):
        commit_draft.return_value = {
            "opportunities": [{"id": "opp-1"}], "opportunity_count": 1,
            "intake_job_id": "job-1", "nextcloud_folder": None,
        }
        assert w.process_one_approved(supa) is True
        commit_draft.assert_called_once()
        retrieval.assert_called_once()
        # writing -> written -> complete
        assert [c.args[2] for c in transition.call_args_list] == ["written", "complete"]


def test_retrieval_rows_land_in_records_created():
    supa = MagicMock()
    claimed = {
        "id": "sub-2",
        "draft_summary": {"account": {"account_name": "Y LLC"}},
        "approved_by": "lamar",
    }
    with patch.object(w, "_claim_next_approved", return_value=claimed), \
         patch("hermes_intake.commit.commit_draft") as commit_draft, \
         patch("hermes_intake.submissions.transition") as transition, \
         patch("hermes_intake.approval._insert_retrieval_rows",
               return_value={"client_entities": ["e1"], "client_facts": ["f1", "f2"]}), \
         patch.object(w, "_post_alert"):
        commit_draft.return_value = {
            "opportunities": [], "opportunity_count": 0,
            "intake_job_id": "job-2", "nextcloud_folder": None,
        }
        assert w.process_one_approved(supa) is True

    records = transition.call_args_list[-1].kwargs["extra_fields"]["records_created"]
    assert records["target"] == "nowcerts"
    assert records["retrieval_row_ids"] == {
        "client_entities": ["e1"], "client_facts": ["f1", "f2"],
    }


def test_retrieval_failure_transitions_to_failed():
    supa = MagicMock()
    claimed = {
        "id": "sub-3",
        "draft_summary": {"account": {"account_name": "Z LLC"}},
        "approved_by": "lamar",
    }
    with patch.object(w, "_claim_next_approved", return_value=claimed), \
         patch("hermes_intake.commit.commit_draft") as commit_draft, \
         patch("hermes_intake.submissions.transition"), \
         patch("hermes_intake.approval._insert_retrieval_rows",
               side_effect=RuntimeError("supabase down")), \
         patch.object(w, "_safe_transition_to_failed") as stf, \
         patch.object(w, "_post_alert") as post:
        commit_draft.return_value = {
            "opportunities": [], "opportunity_count": 0,
            "intake_job_id": "job-3", "nextcloud_folder": None,
        }
        assert w.process_one_approved(supa) is True
        assert stf.call_args.kwargs["stage"] == "retrieval-inserts"
        post.assert_not_called()
