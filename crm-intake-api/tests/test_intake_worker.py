"""Tests for the Phase 3 intake_submissions worker."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from hermes_intake import worker as intake_worker
from hermes_intake.worker import process_one_received, tick


@pytest.fixture(autouse=True)
def _reset_module_stubs():
    """Restore the module-level synthesize/render/post indirections after each test."""
    orig = (intake_worker.synthesize_payload, intake_worker.render_blocks, intake_worker.post_draft)
    yield
    (intake_worker.synthesize_payload, intake_worker.render_blocks, intake_worker.post_draft) = orig


@pytest.fixture
def supa_with_received_row():
    """A MagicMock SupabaseClient where claim_next_received returns one row."""
    supa = MagicMock()
    # The select called by claim_next_received → return one candidate.
    supa.select.return_value = [{"id": "sub-1", "status_history": []}]
    # The update_where called by claim_next_received → atomic claim win.
    supa.update_where.return_value = [{
        "id": "sub-1",
        "status": "synthesizing",
        "status_history": [{"from": "received", "to": "synthesizing", "at": "t0", "note": "claimed by worker"}],
        "payload": {"transcript": "hi"},
    }]
    return supa


@pytest.fixture
def supa_with_empty_queue():
    """A MagicMock SupabaseClient where the received queue is empty."""
    supa = MagicMock()
    supa.select.return_value = []
    return supa


# ---------------------------------------------------------------------------
# Claim arc
# ---------------------------------------------------------------------------


class TestProcessOneReceived:
    def test_empty_queue_returns_false(self, supa_with_empty_queue) -> None:
        assert process_one_received(supa_with_empty_queue) is False
        # No transitions attempted on an empty queue
        supa_with_empty_queue.update.assert_not_called()
        supa_with_empty_queue.update_where.assert_not_called()

    def test_claim_race_lost_returns_false(self) -> None:
        """If the UPDATE-WHERE conditional returns [] (another worker won),
        the function reports no work done."""
        supa = MagicMock()
        supa.select.return_value = [{"id": "sub-1", "status_history": []}]
        supa.update_where.return_value = []  # race lost
        assert process_one_received(supa) is False

    def test_happy_path_reaches_awaiting_approval(self, supa_with_received_row) -> None:
        supa = supa_with_received_row
        # Re-fetch row inside transition() returns the row in its latest state.
        # First call: synthesized (after claim). Subsequent: drafting, awaiting_approval.
        supa.select.side_effect = [
            [{"id": "sub-1", "status_history": []}],  # claim_next_received select
            [{"id": "sub-1", "status": "synthesizing", "status_history": []}],  # transition: synthesizing -> synthesized
            [{"id": "sub-1", "status": "synthesized", "status_history": []}],  # synthesized -> drafting
            [{"id": "sub-1", "status": "drafting", "status_history": []}],  # drafting -> awaiting_approval
        ]
        supa.update.return_value = {"id": "sub-1"}

        intake_worker.synthesize_payload = lambda payload: ({"account": {"account_name": "Acme"}}, [])
        intake_worker.render_blocks = lambda payload: "rendered text"
        intake_worker.post_draft = MagicMock()

        assert process_one_received(supa) is True

        # Each forward transition issues an update with a new status.
        updates = [call.args[2] for call in supa.update.call_args_list]
        statuses = [u["status"] for u in updates]
        assert statuses == ["synthesized", "drafting", "awaiting_approval"]

        # Synthesized update carries hermes_blocks + draft_summary.
        synthesized = updates[0]
        assert synthesized["hermes_blocks"] == "rendered text"
        assert synthesized["draft_summary"] == {"account": {"account_name": "Acme"}}

        # Slack post called once with submission_id + draft_summary.
        intake_worker.post_draft.assert_called_once_with("sub-1", {"account": {"account_name": "Acme"}})

    def test_supplied_payload_is_used_verbatim_and_skips_extraction(self) -> None:
        """A caller that already synthesized must not be re-extracted.

        The intake gate enriches its payload with cited PDF text, reference-table
        codes and split contact names. A second LLM pass would drop all of that and
        commit something the operator never reviewed.
        """
        supplied = {
            "account": {"account_name": "Acme Plumbing LLC", "naics": "238220"},
            "opportunities": [{"line_of_business": "General Liability"}],
            "facts": [{"entity": "Acme Plumbing LLC", "fact_label": "EIN", "fact_value": "12-3456789"}],
        }
        supa = MagicMock()
        supa.select.side_effect = [
            [{"id": "sub-1", "status_history": []}],
            [{"id": "sub-1", "status": "synthesizing", "status_history": []}],
            [{"id": "sub-1", "status": "synthesized", "status_history": []}],
            [{"id": "sub-1", "status": "drafting", "status_history": []}],
        ]
        supa.update_where.return_value = [{
            "id": "sub-1",
            "status": "synthesizing",
            "status_history": [],
            "payload": {"transcript": "raw text nobody should re-read", "synthesized_payload": supplied},
        }]
        supa.update.return_value = {"id": "sub-1"}

        def _must_not_run(payload):  # pragma: no cover - the assertion is that it isn't
            raise AssertionError("the worker re-ran extraction on a supplied payload")

        intake_worker.synthesize_payload = _must_not_run
        intake_worker.render_blocks = lambda payload: "rendered text"
        intake_worker.post_draft = MagicMock()

        assert process_one_received(supa) is True

        updates = [call.args[2] for call in supa.update.call_args_list]
        assert [u["status"] for u in updates] == ["synthesized", "drafting", "awaiting_approval"]
        # Committed verbatim — the NAICS and the cited fact survive intact.
        assert updates[0]["draft_summary"] == supplied

    def test_supplied_payload_is_still_validated(self) -> None:
        """Skipping extraction must not skip validation — warnings still surface."""
        supa = MagicMock()
        supa.select.side_effect = [
            [{"id": "sub-1", "status_history": []}],
            [{"id": "sub-1", "status": "synthesizing", "status_history": []}],
            [{"id": "sub-1", "status": "synthesized", "status_history": []}],
            [{"id": "sub-1", "status": "drafting", "status_history": []}],
        ]
        supa.update_where.return_value = [{
            "id": "sub-1", "status": "synthesizing", "status_history": [],
            # No account_name and no opportunities — validate_payload has something to say.
            "payload": {"synthesized_payload": {"account": {}, "opportunities": []}},
        }]
        supa.update.return_value = {"id": "sub-1"}
        intake_worker.render_blocks = lambda payload: "rendered"
        intake_worker.post_draft = MagicMock()

        with patch.object(intake_worker, "validate_payload", return_value=["missing account_name"]) as v:
            assert process_one_received(supa) is True
        v.assert_called_once()

    def test_a_pre_approved_submission_walks_straight_to_approved(self) -> None:
        """The submitter already had a human approve it, so nobody is asked again.

        RSG does not use Slack. A row parked at awaiting_approval waits for a
        button that will never be pressed, so an approval carried on the
        submission has to be honoured — and no draft is posted anywhere.
        """
        supa = MagicMock()
        supa.select.side_effect = [
            [{"id": "sub-1", "status_history": []}],
            [{"id": "sub-1", "status": "synthesizing", "status_history": []}],
            [{"id": "sub-1", "status": "synthesized", "status_history": []}],
            [{"id": "sub-1", "status": "drafting", "status_history": []}],
            [{"id": "sub-1", "status": "awaiting_approval", "status_history": []}],
        ]
        supa.update_where.return_value = [{
            "id": "sub-1", "status": "synthesizing", "status_history": [],
            "payload": {
                "synthesized_payload": {"account": {"account_name": "Acme"}},
                "approval": {"approved_by": "lamar", "token": "APPROVE ALL"},
            },
        }]
        supa.update.return_value = {"id": "sub-1"}
        intake_worker.render_blocks = lambda payload: "rendered"
        intake_worker.post_draft = MagicMock()

        assert process_one_received(supa) is True

        updates = [call.args[2] for call in supa.update.call_args_list]
        assert [u["status"] for u in updates] == [
            "synthesized", "drafting", "awaiting_approval", "approved",
        ]
        # It passes THROUGH awaiting_approval rather than skipping the state, so
        # the audit trail records the approval the same way Slack would have.
        approved = updates[-1]
        assert approved["approved_by"] == "lamar"
        assert approved["approval_token"] == "APPROVE ALL"
        assert approved["approved_at"]
        intake_worker.post_draft.assert_not_called()

    def test_an_unapproved_submission_still_waits_and_still_posts(self, supa_with_received_row) -> None:
        """The Slack path is unchanged for anything that did not carry an approval."""
        supa = supa_with_received_row
        supa.select.side_effect = [
            [{"id": "sub-1", "status_history": []}],
            [{"id": "sub-1", "status": "synthesizing", "status_history": []}],
            [{"id": "sub-1", "status": "synthesized", "status_history": []}],
            [{"id": "sub-1", "status": "drafting", "status_history": []}],
        ]
        supa.update.return_value = {"id": "sub-1"}
        intake_worker.synthesize_payload = lambda payload: ({"account": {"account_name": "Acme"}}, [])
        intake_worker.render_blocks = lambda payload: "rendered"
        intake_worker.post_draft = MagicMock()

        assert process_one_received(supa) is True
        statuses = [call.args[2]["status"] for call in supa.update.call_args_list]
        assert statuses == ["synthesized", "drafting", "awaiting_approval"]
        intake_worker.post_draft.assert_called_once()

    def test_synthesizer_exception_transitions_to_failed(self, supa_with_received_row) -> None:
        supa = supa_with_received_row
        # Used: claim_next_received select, then transition() select for the failed transition.
        supa.select.side_effect = [
            [{"id": "sub-1", "status_history": []}],  # claim select
            [{"id": "sub-1", "status": "synthesizing", "status_history": [], "error_log": []}],  # failed transition select
        ]
        supa.update.return_value = {"id": "sub-1"}

        def boom(_):
            raise RuntimeError("openai timeout")
        intake_worker.synthesize_payload = boom

        with patch.object(intake_worker, "_post_alert") as mock_alert:
            assert process_one_received(supa) is True
            mock_alert.assert_called_once()
            assert "submission failed" in mock_alert.call_args.args[0]
            assert "openai timeout" in mock_alert.call_args.args[0]

        # The transition to 'failed' was attempted.
        update = supa.update.call_args.args[2]
        assert update["status"] == "failed"
        assert update["error_log"][-1]["stage"] == "synthesize"
        assert update["error_log"][-1]["exception_type"] == "RuntimeError"

    def test_slack_post_failure_does_not_break_pipeline_when_post_swallows(
        self, supa_with_received_row,
    ) -> None:
        """post_draft is expected to be non-fatal (Slack post helper swallows
        errors). If it returns normally even after a Slack hiccup, the row
        should still settle at awaiting_approval."""
        supa = supa_with_received_row
        supa.select.side_effect = [
            [{"id": "sub-1", "status_history": []}],
            [{"id": "sub-1", "status": "synthesizing", "status_history": []}],
            [{"id": "sub-1", "status": "synthesized", "status_history": []}],
            [{"id": "sub-1", "status": "drafting", "status_history": []}],
        ]
        supa.update.return_value = {"id": "sub-1"}

        intake_worker.synthesize_payload = lambda payload: ({}, [])
        intake_worker.render_blocks = lambda payload: ""
        # The real post_draft swallows Slack errors internally. Simulate that.
        intake_worker.post_draft = MagicMock(return_value=None)

        assert process_one_received(supa) is True
        statuses = [c.args[2]["status"] for c in supa.update.call_args_list]
        assert statuses[-1] == "awaiting_approval"


# ---------------------------------------------------------------------------
# tick() smoke
# ---------------------------------------------------------------------------


class TestTick:
    def test_tick_reports_zero_when_empty(self) -> None:
        supa = MagicMock()
        supa.select.return_value = []
        result = tick(supa)
        assert result == {
            "received_processed": 0,
            "approved_processed": 0,
        }

    def test_tick_reports_one_when_row_processed(self) -> None:
        """tick() drives both arcs; only received_processed should
        increment when only the received queue has work."""
        supa = MagicMock()

        # Route each call by its arguments so the test isn't position-fragile.
        def _select(table, *, columns="*", params=None, limit=100):
            params = params or {}
            status_filter = params.get("status")
            if status_filter == "eq.received":
                return [{"id": "sub-1", "status_history": []}]
            # claim_next_received's update_where target / transition re-reads
            if params.get("id") == "eq.sub-1":
                return [{"id": "sub-1", "status": "synthesizing",
                         "status_history": [], "error_log": []}]
            # Approved queue empty
            return []

        supa.select.side_effect = _select
        supa.update.return_value = {"id": "sub-1"}
        supa.update_where.return_value = [{
            "id": "sub-1", "payload": {"transcript": "x"}, "status_history": [],
        }]

        # Make the synthesizer raise so the flow stops after the claim
        # (we only care that received_processed counts the claim).
        def _raise(_payload):
            raise RuntimeError("stub")
        intake_worker.synthesize_payload = _raise

        with patch.object(intake_worker, "_post_alert"):
            result = tick(supa)
        assert result["received_processed"] == 1
        assert result["approved_processed"] == 0


# ---------------------------------------------------------------------------
# Channel resolution
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Step 3: synthesizer port (agency_intake.synthesize_from_payload + render_hermes_blocks)
# ---------------------------------------------------------------------------


class TestPayloadToRawText:
    def test_flattens_transcript_notes_documents_coaching(self) -> None:
        from hermes_intake.agency_intake import _payload_dict_to_raw_text

        raw = _payload_dict_to_raw_text({
            "transcript": "Sandra called.",
            "notes": "Follow up on umbrella.",
            "documents": [
                {"type": "drivers_license", "extracted_data": {"name": "Sandra", "state": "GA"}},
            ],
            "coaching_snapshot": {
                "covered_topics": ["vehicles", "drivers"],
                "remaining_gaps": ["claims"],
                "flags_detected": [{"flag": "no garaging address", "severity": "med", "context": "..."}],
            },
        })
        assert "=== TRANSCRIPT ===" in raw
        assert "Sandra called." in raw
        assert "=== NOTES ===" in raw
        assert "=== DOCUMENTS ===" in raw
        assert "drivers_license" in raw
        assert "name: Sandra" in raw
        assert "=== COACHING SNAPSHOT ===" in raw
        assert "Covered topics: vehicles, drivers" in raw
        assert "[med] no garaging address" in raw

    def test_skips_empty_sections(self) -> None:
        from hermes_intake.agency_intake import _payload_dict_to_raw_text

        raw = _payload_dict_to_raw_text({"transcript": "hi", "documents": [], "notes": ""})
        assert "TRANSCRIPT" in raw
        assert "DOCUMENTS" not in raw
        assert "NOTES" not in raw

    def test_documents_only_payload_still_produces_text(self) -> None:
        from hermes_intake.agency_intake import _payload_dict_to_raw_text

        raw = _payload_dict_to_raw_text({
            "documents": [{"type": "dec_page", "raw_text": "POLICY: ABC-123"}],
        })
        assert "POLICY: ABC-123" in raw

    def test_empty_payload_returns_empty_string(self) -> None:
        from hermes_intake.agency_intake import _payload_dict_to_raw_text

        assert _payload_dict_to_raw_text({}) == ""
        assert _payload_dict_to_raw_text({"notes": ""}) == ""


class TestSynthesizeFromPayload:
    @patch("hermes_intake.agency_intake._extract_payload")
    def test_happy_path_returns_extracted_plus_warnings(self, mock_extract) -> None:
        from hermes_intake.agency_intake import synthesize_from_payload

        mock_extract.return_value = {
            "action": "crm_intake_upsert",
            "approval_required": True,
            "account": {"account_name": "Acme"},
            "contacts": [],
            "opportunities": [
                {"opportunity_name": "Acme - GL - 06/01", "line_of_business": "General Liability", "stage": "Discovery"},
            ],
            "facts": [],
            "duplicate_search": {},
        }
        result, warnings = synthesize_from_payload({"transcript": "Acme is a contractor."})
        assert result["account"]["account_name"] == "Acme"
        assert isinstance(warnings, list)
        mock_extract.assert_called_once()
        # The flattened text must have been handed to the LLM.
        assert "=== TRANSCRIPT ===" in mock_extract.call_args.args[0]

    def test_empty_payload_raises(self) -> None:
        from hermes_intake.agency_intake import AgencyIntakeError, synthesize_from_payload

        with pytest.raises(AgencyIntakeError, match="nothing to synthesize"):
            synthesize_from_payload({})

    @patch("hermes_intake.agency_intake._extract_payload")
    def test_extractor_error_propagates(self, mock_extract) -> None:
        from hermes_intake.agency_intake import AgencyIntakeError, synthesize_from_payload

        mock_extract.side_effect = AgencyIntakeError("openai timeout")
        with pytest.raises(AgencyIntakeError, match="openai timeout"):
            synthesize_from_payload({"transcript": "..."})


class TestRenderHermesBlocks:
    def test_renders_full_3D_pumps_style_payload(self) -> None:
        from hermes_intake.agency_intake import render_hermes_blocks

        payload = {
            "account": {
                "account_name": "3D Pumps LLC",
                "legal_name": "3D Pumps LLC",
                "entity_type": "LLC",
                "industry": "Water Infrastructure / Specialty Contracting",
                "phone": "(770) 780-8848",
                "email": "jarod.mattison@gmail.com",
                "city": "Atlanta",
                "state": "GA",
                "tags": ["Critical CPL binding gap"],
            },
            "contacts": [
                {"full_name": "Jarod Denero Mattison", "role": "Sole Member / Principal",
                 "phone": "(770) 780-8848", "primary_contact": True},
            ],
            "opportunities": [
                {"opportunity_name": "3D Pumps LLC - GL - 05/21/2026",
                 "line_of_business": "General Liability", "stage": "Discovery",
                 "opportunity_type": "New Business"},
                {"opportunity_name": "3D Pumps LLC - CPL - 05/21/2026",
                 "line_of_business": "Commercial Package", "stage": "Discovery"},
            ],
            "note": {"title": "3D Pumps Summary", "body": "Facts:\n- bypass pumping\n", "note_type": "Quote Summary"},
            "facts": [{"sensitivity": "restricted"}, {"sensitivity": "standard"}],
        }
        rendered = render_hermes_blocks(payload)
        assert rendered.startswith("Hermes:")
        assert "MODULE: account" in rendered
        assert "NAME: 3D Pumps LLC" in rendered
        assert "PHONE: (770) 780-8848" in rendered
        assert "MODULE: contact" in rendered
        assert "NAME: Jarod Denero Mattison" in rendered
        assert "PRIMARY CONTACT: yes" in rendered
        # Both opportunities present.
        assert rendered.count("MODULE: opportunity") == 2
        assert "LINE OF BUSINESS: General Liability" in rendered
        assert "LINE OF BUSINESS: Commercial Package" in rendered
        assert "MODULE: note" in rendered
        assert "TITLE: 3D Pumps Summary" in rendered
        assert "BODY:" in rendered
        # Indented body lines
        assert "    Facts:" in rendered or "Facts:" in rendered
        # Facts summary
        assert "MODULE: facts (2 total, 1 restricted)" in rendered

    def test_skips_empty_modules(self) -> None:
        from hermes_intake.agency_intake import render_hermes_blocks

        rendered = render_hermes_blocks({
            "account": {"account_name": "Acme"},
            "contacts": [{}],  # invalid contact (no name) → skipped
            "opportunities": [],
            "note": {},
        })
        assert "MODULE: account" in rendered
        assert "MODULE: contact" not in rendered
        assert "MODULE: opportunity" not in rendered
        assert "MODULE: note" not in rendered

    def test_empty_payload_returns_header_only(self) -> None:
        from hermes_intake.agency_intake import render_hermes_blocks

        rendered = render_hermes_blocks({})
        assert rendered.strip() == "Hermes:"


class TestWorkerWithRealSynthesizer:
    """End-to-end of the Step 3 wiring: worker -> synthesize_from_payload ->
    render_hermes_blocks -> transitions, with the LLM call itself mocked."""

    @patch("hermes_intake.agency_intake._extract_payload")
    def test_valid_payload_reaches_awaiting_approval(self, mock_extract) -> None:
        mock_extract.return_value = {
            "action": "crm_intake_upsert",
            "approval_required": True,
            "account": {"account_name": "Acme"},
            "contacts": [{"full_name": "Jane Doe"}],
            "opportunities": [{"opportunity_name": "Acme - GL", "line_of_business": "General Liability", "stage": "Discovery"}],
            "facts": [],
            "duplicate_search": {},
            "note": {"title": "t", "body": "b"},
        }

        supa = MagicMock()
        supa.select.side_effect = [
            [{"id": "sub-1", "status_history": []}],  # claim_next_received select
            [{"id": "sub-1", "status": "synthesizing", "status_history": []}],
            [{"id": "sub-1", "status": "synthesized", "status_history": []}],
            [{"id": "sub-1", "status": "drafting", "status_history": []}],
        ]
        supa.update.return_value = {"id": "sub-1"}
        supa.update_where.return_value = [{
            "id": "sub-1", "payload": {"transcript": "Acme is a contractor."},
            "status_history": []
        }]

        # Use the real synthesize_from_payload + render_hermes_blocks
        # (already wired into the worker by Step 3). Slack post stubbed.
        intake_worker.post_draft = MagicMock(return_value=None)

        assert process_one_received(supa) is True

        statuses = [c.args[2]["status"] for c in supa.update.call_args_list]
        assert statuses == ["synthesized", "drafting", "awaiting_approval"]
        synth_update = supa.update.call_args_list[0].args[2]
        assert "Hermes:" in synth_update["hermes_blocks"]
        assert "MODULE: account" in synth_update["hermes_blocks"]
        assert synth_update["draft_summary"]["account"]["account_name"] == "Acme"


# ---------------------------------------------------------------------------
# Step 4: Slack draft post (post_draft_to_slack)
# ---------------------------------------------------------------------------


class TestPostDraftToSlack:
    @patch("hermes_intake.worker.SlackNotifier")
    def test_post_format_includes_summary_and_blocks(self, MockNotifier) -> None:
        from hermes_intake.worker import post_draft_to_slack

        notifier = MockNotifier.return_value
        notifier.post_message.return_value = {"ok": True}

        draft_summary = {
            "account": {"account_name": "3D Pumps LLC", "entity_type": "LLC", "industry": "Construction"},
            "contacts": [{"full_name": "Jarod Mattison"}],
            "opportunities": [
                {"line_of_business": "General Liability", "stage": "Discovery"},
                {"line_of_business": "Commercial Package", "stage": "Discovery"},
            ],
            "facts": [{"sensitivity": "restricted"}, {}],
            "note": {"title": "Quote summary", "note_type": "Quote Summary"},
        }
        post_draft_to_slack("sub-abc-123", draft_summary)

        notifier.post_message.assert_called_once()
        kwargs = notifier.post_message.call_args.kwargs
        text = kwargs["text"]
        blocks = kwargs["blocks"]

        # Text body conveys the key fields.
        assert "Intake draft ready" in text
        assert "submission_id" in text
        assert "sub-abc-123" in text
        assert "3D Pumps LLC" in text
        assert "Jarod Mattison" in text
        assert "General Liability" in text
        assert "Commercial Package" in text
        assert "(1 restricted)" in text

        # Blocks are the 6 approval buttons.
        actions_block = next(b for b in blocks if b.get("type") == "actions")
        button_ids = [el["action_id"] for el in actions_block["elements"]]
        assert button_ids == [
            "agency_intake_approve_all",
            "agency_intake_approve_crm",
            "agency_intake_approve_supabase",
            "agency_intake_approve_tasks",
            "agency_intake_revise",
            "agency_intake_cancel",
        ]

    @patch("hermes_intake.worker.SlackNotifier")
    def test_metadata_carries_submission_id_not_draft_id(self, MockNotifier) -> None:
        from hermes_intake.worker import post_draft_to_slack

        notifier = MockNotifier.return_value
        notifier.post_message.return_value = {"ok": True}

        post_draft_to_slack("submission-uuid-zzz", {"account": {"account_name": "Acme"}})

        blocks = notifier.post_message.call_args.kwargs["blocks"]
        actions_block = next(b for b in blocks if b.get("type") == "actions")

        # block_id encodes submission_id
        assert actions_block["block_id"] == "agency_intake_actions_submission-uuid-zzz"

        # Every button's `value` is the submission_id (the Slack listener
        # reads action.value to recover it).
        for element in actions_block["elements"]:
            assert element["value"] == "submission-uuid-zzz"

    @patch("hermes_intake.worker._post_alert")
    @patch("hermes_intake.worker.SlackNotifier")
    def test_slack_failure_routes_to_alert_channel(
        self, MockNotifier, mock_alert,
    ) -> None:
        """If the draft post fails, the helper must NOT crash the worker —
        it should log and post a warning to the alert channel so the
        operator knows the row is stuck at awaiting_approval."""
        from hermes_integrations.slack_notifier import SlackNotifierError
        from hermes_intake.worker import post_draft_to_slack

        notifier = MockNotifier.return_value
        notifier.post_message.side_effect = SlackNotifierError("rate limited")

        # Should not raise.
        post_draft_to_slack("sub-1", {"account": {"account_name": "X"}})

        # An alert post happened with the submission_id surfaced.
        mock_alert.assert_called_once()
        alert_text = mock_alert.call_args.args[0]
        assert "Slack post failed" in alert_text
        assert "sub-1" in alert_text
        assert "rate limited" in alert_text

    @patch("hermes_intake.worker.SlackNotifier")
    def test_uses_draft_channel_env(self, MockNotifier, monkeypatch) -> None:
        from hermes_intake.worker import post_draft_to_slack

        monkeypatch.setenv("HERMES_INTAKE_DRAFT_CHANNEL", "CCUSTOMDRAFT")
        MockNotifier.return_value.post_message.return_value = {"ok": True}

        post_draft_to_slack("sub-1", {"account": {"account_name": "X"}})

        MockNotifier.assert_called_with(channel="CCUSTOMDRAFT")


class TestPostDraftWiredIntoWorker:
    """Confirms the module-level indirection actually points at the real
    post_draft_to_slack after import (Step 4 wiring)."""

    def test_post_draft_is_real_function_not_stub(self) -> None:
        from hermes_intake.worker import post_draft, post_draft_to_slack

        assert post_draft is post_draft_to_slack


# ---------------------------------------------------------------------------
# Step 5: APPROVE handler port + approved/writing/written/complete arc
# ---------------------------------------------------------------------------


class TestApproveDraftRewrite:
    """approve_draft now reads intake_submissions by submission_id."""

    def _supa_with_submission(self, status="awaiting_approval"):
        supa = MagicMock()
        row = {
            "id": "sub-1",
            "status": status,
            "status_history": [],
            "error_log": [],
            "draft_summary": {"account": {"account_name": "Acme"}},
        }
        # First select call → fetch_by_id; subsequent → transition's re-read.
        supa.select.return_value = [row]
        supa.update.return_value = row
        return supa

    def test_approve_all_transitions_to_approved(self) -> None:
        from hermes_intake.approval import approve_draft

        supa = self._supa_with_submission()
        result = approve_draft(supa, draft_id="sub-1", token="APPROVE ALL", approver="U-LAMAR")

        assert result.ok is True
        assert result.status == "approved"
        assert result.token == "APPROVE ALL"

        update = supa.update.call_args.args[2]
        assert update["status"] == "approved"
        assert update["approved_by"] == "U-LAMAR"
        assert update["approved_at"].endswith("+00:00")
        # Status history note records the token + approver.
        last_entry = update["status_history"][-1]
        assert last_entry["to"] == "approved"
        assert "APPROVE ALL" in last_entry["note"]
        assert "U-LAMAR" in last_entry["note"]

    def test_approve_crm_only_also_lands_at_approved(self) -> None:
        from hermes_intake.approval import approve_draft

        supa = self._supa_with_submission()
        result = approve_draft(supa, draft_id="sub-1", token="APPROVE CRM ONLY", approver="U-X")

        assert result.status == "approved"
        assert "APPROVE CRM ONLY" in supa.update.call_args.args[2]["status_history"][-1]["note"]

    def test_approval_token_is_persisted_on_the_row(self) -> None:
        """The token must land in the approval_token column so the worker can branch
        on it, not only in the status_history note."""
        from hermes_intake.approval import approve_draft

        for token in ("APPROVE ALL", "APPROVE CRM ONLY", "APPROVE SUPABASE ONLY", "APPROVE TASKS ONLY"):
            supa = self._supa_with_submission()
            approve_draft(supa, draft_id="sub-1", token=token, approver="U-X")
            update = supa.update.call_args.args[2]
            assert update["approval_token"] == token

    def test_cancel_transitions_to_failed(self) -> None:
        from hermes_intake.approval import approve_draft

        supa = self._supa_with_submission()
        result = approve_draft(supa, draft_id="sub-1", token="CANCEL", approver="U-X")

        assert result.status == "failed"
        update = supa.update.call_args.args[2]
        assert update["status"] == "failed"
        # error_log carries the cancel reason
        last_err = update["error_log"][-1]
        assert last_err["reason"] == "canceled by approver"
        assert last_err["token"] == "CANCEL"

    def test_revise_transitions_to_failed(self) -> None:
        """intake_submissions enum has no 'revised' state — revise maps to failed."""
        from hermes_intake.approval import approve_draft

        supa = self._supa_with_submission()
        result = approve_draft(supa, draft_id="sub-1", token="REVISE", approver="U-X")
        assert result.status == "failed"
        assert "revised" in supa.update.call_args.args[2]["error_log"][-1]["reason"]

    def test_unknown_token_raises(self) -> None:
        from hermes_intake.approval import ApprovalError, approve_draft

        supa = self._supa_with_submission()
        with pytest.raises(ApprovalError, match="not allowed"):
            approve_draft(supa, draft_id="sub-1", token="MAYBE", approver="U-X")

    def test_missing_submission_raises(self) -> None:
        from hermes_intake.approval import ApprovalError, approve_draft

        supa = MagicMock()
        supa.select.return_value = []
        with pytest.raises(ApprovalError, match="not found"):
            approve_draft(supa, draft_id="missing", token="APPROVE ALL", approver="U-X")

    def test_wrong_status_raises(self) -> None:
        from hermes_intake.approval import ApprovalError, approve_draft

        supa = self._supa_with_submission(status="synthesizing")
        with pytest.raises(ApprovalError, match="not 'awaiting_approval'"):
            approve_draft(supa, draft_id="sub-1", token="APPROVE ALL", approver="U-X")


class TestProcessOneApproved:
    def test_empty_queue_returns_false(self) -> None:
        from hermes_intake.worker import process_one_approved

        supa = MagicMock()
        supa.select.return_value = []
        assert process_one_approved(supa) is False

    def test_happy_path_commits_and_transitions(self) -> None:
        from hermes_intake.worker import process_one_approved

        supa = MagicMock()
        # First select → _claim_next_approved
        supa.select.return_value = [{
            "id": "sub-1",
            "status_history": [],
            "draft_summary": {"account": {"account_name": "Acme"}},
            "approved_by": "U-LAMAR",
        }]
        supa.update_where.return_value = [{"id": "sub-1", "status": "writing", "status_history": []}]
        supa.update.return_value = {"id": "sub-1"}

        with patch("hermes_intake.commit.commit_draft") as commit_draft, \
             patch("hermes_intake.submissions.transition"), \
             patch("hermes_intake.approval._insert_retrieval_rows",
                   return_value={}), \
             patch.object(intake_worker, "_post_alert"):
            commit_draft.return_value = {
                "opportunities": [{"id": "opp-1"}], "opportunity_count": 1,
                "intake_job_id": "job-1", "nextcloud_folder": None,
            }
            assert process_one_approved(supa) is True

        # The atomic claim was conditional on status='approved'.
        upd_kwargs = supa.update_where.call_args.kwargs
        assert upd_kwargs["filters"]["status"] == "eq.approved"

        # records_created stash names the commit target and the created opportunities.
        stash_update = supa.update.call_args.args[2]
        assert stash_update["records_created"]["target"] == "nowcerts"
        assert stash_update["records_created"]["opportunities"] == ["opp-1"]

    def test_race_lost_returns_false(self) -> None:
        from hermes_intake.worker import process_one_approved

        supa = MagicMock()
        supa.select.return_value = [{
            "id": "sub-1", "status_history": [], "draft_summary": {}, "approved_by": "U-X",
        }]
        supa.update_where.return_value = []  # race lost
        assert process_one_approved(supa) is False

    def test_commit_failure_transitions_to_failed(self) -> None:
        from hermes_intake.worker import process_one_approved

        supa = MagicMock()
        supa.select.side_effect = [
            [{"id": "sub-1", "status_history": [], "draft_summary": {}, "approved_by": "U-X"}],
            # transition() re-read for the failed state
            [{"id": "sub-1", "status": "writing", "status_history": [], "error_log": []}],
        ]
        supa.update_where.return_value = [{"id": "sub-1", "status": "writing"}]
        supa.update.return_value = {"id": "sub-1"}

        with patch("hermes_intake.commit.commit_draft", side_effect=RuntimeError("supabase down")), \
             patch.object(intake_worker, "_post_alert"):
            assert process_one_approved(supa) is True

        update = supa.update.call_args.args[2]
        assert update["status"] == "failed"
        assert update["error_log"][-1]["stage"] == "commit-nowcerts-intake"

    # --- partial-scope approval tokens (FOLLOWUPS #1) -----------------------

    def _claimed_supa(self, token: str | None) -> MagicMock:
        supa = MagicMock()
        row = {
            "id": "sub-1",
            "status_history": [],
            "draft_summary": {"account": {"account_name": "Acme"}},
            "approved_by": "U-LAMAR",
        }
        if token is not None:
            row["approval_token"] = token
        supa.select.return_value = [row]
        supa.update_where.return_value = [{"id": "sub-1", "status": "writing", "status_history": []}]
        supa.update.return_value = {"id": "sub-1"}
        return supa
    def test_approve_all_runs_both_crm_and_retrieval(self) -> None:
        from hermes_intake.worker import process_one_approved

        supa = self._claimed_supa("APPROVE ALL")
        with patch("hermes_intake.commit.commit_draft") as commit_draft, \
             patch("hermes_intake.submissions.transition"), \
             patch("hermes_intake.approval._insert_retrieval_rows",
                   return_value={}) as insert_retrieval, \
             patch.object(intake_worker, "_post_alert"):
            commit_draft.return_value = {"opportunities": [{"id": "opp-1"}],
                                         "opportunity_count": 1, "intake_job_id": "job-1",
                                         "nextcloud_folder": None}
            assert process_one_approved(supa) is True
        assert commit_draft.called
        assert insert_retrieval.called
        # records_created stashes the token that drove the scope.
        stash = supa.update.call_args.args[2]
        assert stash["records_created"]["approval_token"] == "APPROVE ALL"

    def test_approve_crm_only_skips_retrieval_rows(self) -> None:
        from hermes_intake.worker import process_one_approved

        supa = self._claimed_supa("APPROVE CRM ONLY")
        with patch("hermes_intake.commit.commit_draft") as commit_draft, \
             patch("hermes_intake.submissions.transition"), \
             patch("hermes_intake.approval._insert_retrieval_rows",
                   return_value={}) as insert_retrieval, \
             patch.object(intake_worker, "_post_alert"):
            commit_draft.return_value = {"opportunities": [{"id": "opp-1"}],
                                         "opportunity_count": 1, "intake_job_id": "job-1",
                                         "nextcloud_folder": None}
            assert process_one_approved(supa) is True
        assert commit_draft.called, "CRM ONLY must still create opportunities"
        assert not insert_retrieval.called, "CRM ONLY must skip retrieval/RAG rows"
        assert supa.update.call_args.args[2]["records_created"]["approval_token"] == "APPROVE CRM ONLY"

    def test_approve_supabase_only_skips_crm_writes(self) -> None:
        from hermes_intake.worker import process_one_approved

        supa = self._claimed_supa("APPROVE SUPABASE ONLY")
        with patch("hermes_intake.commit.commit_draft") as commit_draft, \
             patch("hermes_intake.submissions.transition"), \
             patch("hermes_intake.approval._insert_retrieval_rows",
                   return_value={"client_entities": ["e1"]}) as insert_retrieval, \
             patch.object(intake_worker, "_post_alert"):
            assert process_one_approved(supa) is True
        assert not commit_draft.called, "SUPABASE ONLY must skip CRM/AMS writes"
        assert insert_retrieval.called, "SUPABASE ONLY must still insert retrieval rows"
        stash = supa.update.call_args.args[2]
        assert stash["records_created"]["opportunities"] == []
        assert stash["records_created"]["approval_token"] == "APPROVE SUPABASE ONLY"

    def test_approve_tasks_only_is_a_noop_that_still_completes(self) -> None:
        from hermes_intake.worker import process_one_approved

        supa = self._claimed_supa("APPROVE TASKS ONLY")
        with patch("hermes_intake.commit.commit_draft") as commit_draft, \
             patch("hermes_intake.submissions.transition") as transition, \
             patch("hermes_intake.approval._insert_retrieval_rows",
                   return_value={}) as insert_retrieval, \
             patch.object(intake_worker, "_post_alert"):
            assert process_one_approved(supa) is True
        assert not commit_draft.called, "TASKS ONLY must not write CRM/AMS"
        assert not insert_retrieval.called, "TASKS ONLY must not write retrieval rows"
        # The row must still walk through to complete so it is not stranded.
        statuses = [call.args[2] for call in transition.call_args_list]
        assert "written" in statuses
        assert "complete" in statuses

    def test_null_token_defaults_to_approve_all(self) -> None:
        """Old rows without an approval_token column value keep historical behaviour."""
        from hermes_intake.worker import process_one_approved

        supa = self._claimed_supa(None)
        with patch("hermes_intake.commit.commit_draft") as commit_draft, \
             patch("hermes_intake.submissions.transition"), \
             patch("hermes_intake.approval._insert_retrieval_rows",
                   return_value={}) as insert_retrieval, \
             patch.object(intake_worker, "_post_alert"):
            commit_draft.return_value = {"opportunities": [{"id": "opp-1"}],
                                         "opportunity_count": 1, "intake_job_id": "job-1",
                                         "nextcloud_folder": None}
            assert process_one_approved(supa) is True
        assert commit_draft.called
        assert insert_retrieval.called
        assert supa.update.call_args.args[2]["records_created"]["approval_token"] == "APPROVE ALL"


class TestTickAllArcs:
    """tick() must drive both arcs once each."""

    def test_tick_reports_all_arcs(self) -> None:
        supa = MagicMock()
        supa.select.return_value = []  # all queues empty
        result = tick(supa)
        assert set(result.keys()) == {"received_processed", "approved_processed"}
        assert all(v == 0 for v in result.values())


class TestChannelResolution:
    def test_alert_channel_default(self, monkeypatch) -> None:
        monkeypatch.delenv("HERMES_INTAKE_ALERT_CHANNEL", raising=False)
        monkeypatch.delenv("HERMES_SYSTEMS_CHECK_CHANNEL", raising=False)
        assert intake_worker._intake_alert_channel() == "C0ANSEP6SSD"

    def test_alert_channel_override(self, monkeypatch) -> None:
        monkeypatch.setenv("HERMES_INTAKE_ALERT_CHANNEL", "C123ABCDEF")
        assert intake_worker._intake_alert_channel() == "C123ABCDEF"

    def test_draft_channel_falls_back_to_sentinel(self, monkeypatch) -> None:
        monkeypatch.delenv("HERMES_INTAKE_DRAFT_CHANNEL", raising=False)
        monkeypatch.setenv("HERMES_SENTINEL_SLACK_CHANNEL", "DSENTINEL")
        assert intake_worker._intake_draft_channel() == "DSENTINEL"
