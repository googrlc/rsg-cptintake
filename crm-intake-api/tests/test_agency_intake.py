"""Round-trip tests for the agency intake adapter.

Covers:
  - validate_payload catches bundled LOBs and illegal stages
  - stage_draft writes to agency_intake_drafts and returns a prompt
  - approve_draft(APPROVE ALL) enqueues per-LOB CRM writes AND retrieval rows
  - approve_draft(CANCEL) writes nothing
  - The Slack action_id → token mapping matches the HTTP token vocabulary
"""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from hermes_intake.agency_intake import (
    ALLOWED_APPROVAL_TOKENS,
    AgencyIntakeError,
    stage_draft,
    validate_payload,
)
from hermes_intake.approval import ApprovalError, approve_draft


PUMPS_PAYLOAD = {
    "action": "crm_intake_upsert",
    "approval_required": True,
    "source": {"type": "slack_summary", "submitted_by": "Lamar Coates", "date": "2026-05-19"},
    "classification": ["Commercial Account", "Underwriting Submission"],
    "lines_of_business": [
        "General Liability",
        "Workers Compensation",
        "Commercial Auto",
        "Inland Marine",
        "Contractors Pollution Liability",
        "Umbrella / Excess",
    ],
    "account": {
        "account_name": "3D Pumps LLC",
        "legal_name": "3D Pumps LLC",
        "fein": "33-3725730",
        "entity_type": "LLC",
        "industry": "Construction",
        "address": "503 S Evelyn Pl NW",
        "city": "Atlanta",
        "state": "GA",
        "zip": "30318",
        "operations_summary": "Bypass pumping for water/wastewater treatment plants",
        "annual_revenue": 335000,
        "estimated_payroll": 80000,
        "account_type": "Prospect",
        "account_status": "Urgent",
        "tags": ["prospect", "commercial", "contractor"],
    },
    "contacts": [
        {
            "full_name": "Jarod Denero Mattison",
            "first_name": "Jarod",
            "last_name": "Mattison",
            "role": "Sole Member",
            "phone": "(770) 780-8848",
            "email": "jarod.mattison@gmail.com",
            "relationship_to_account": "Principal",
            "primary_contact": True,
        }
    ],
    "opportunities": [
        {
            "opportunity_name": "3D Pumps LLC - General Liability - 05/19/2026",
            "line_of_business": "General Liability",
            "stage": "Quoting",
            "quote_number": "656137",
            "carrier": "Shield Commercial",
            "premium": 1533.00,
            "fees": 477.32,
            "total": 2010.32,
            "proposed_effective_date": "2026-05-19",
            "opportunity_type": "New Business",
        },
        {
            "opportunity_name": "3D Pumps LLC - Inland Marine - 05/19/2026",
            "line_of_business": "Inland Marine",
            "stage": "Quoting",
            "quote_number": "656139",
            "carrier": "Shield Commercial",
            "premium": 450.00,
            "fees": 18.00,
            "total": 468.00,
            "proposed_effective_date": "2026-05-19",
            "opportunity_type": "New Business",
        },
        {
            "opportunity_name": "3D Pumps LLC - Workers Compensation - 05/19/2026",
            "line_of_business": "Workers Compensation",
            "stage": "Discovery",
            "proposed_effective_date": "2026-05-19",
            "opportunity_type": "New Business",
        },
        {
            "opportunity_name": "3D Pumps LLC - Commercial Auto - 05/19/2026",
            "line_of_business": "Commercial Auto",
            "stage": "Discovery",
            "proposed_effective_date": "2026-05-19",
            "opportunity_type": "New Business",
        },
        {
            "opportunity_name": "3D Pumps LLC - Contractors Pollution Liability - 05/19/2026",
            "line_of_business": "Contractors Pollution Liability",
            "stage": "Discovery",
            "proposed_effective_date": "2026-05-19",
            "opportunity_type": "New Business",
        },
        {
            "opportunity_name": "3D Pumps LLC - Umbrella / Excess - 05/19/2026",
            "line_of_business": "Umbrella / Excess",
            "stage": "Discovery",
            "proposed_effective_date": "2026-05-19",
            "opportunity_type": "New Business",
        },
    ],
    "note": {
        "title": "3D Pumps LLC - Underwriting Summary",
        "note_type": "Underwriting Summary",
        "body": "Bypass pumping operator, GA, $335K revenue, $80K payroll. 6 lines requested.",
        "tags": ["underwriting", "prospect"],
    },
    "facts": [
        {"entity": "3D Pumps LLC", "entity_type": "Account", "fact_label": "EIN",
         "fact_value": "33-3725730", "sensitivity": "restricted", "source": "underwriting summary"},
        {"entity": "Jarod Denero Mattison", "entity_type": "Contact", "fact_label": "Phone",
         "fact_value": "(770) 780-8848", "sensitivity": "standard", "source": "underwriting summary"},
        {"entity": "Jarod Denero Mattison", "entity_type": "Contact", "fact_label": "Email",
         "fact_value": "jarod.mattison@gmail.com", "sensitivity": "standard", "source": "underwriting summary"},
    ],
    "duplicate_search": {
        "account": ["3D Pumps LLC", "3D Pumps", "33-3725730", "503 S Evelyn Pl NW"],
        "contacts": ["Jarod Denero Mattison", "jarod.mattison@gmail.com", "(770) 780-8848"],
        "opportunities": ["656137", "656139"],
    },
}


class ValidatePayloadTests(unittest.TestCase):
    def test_clean_payload_returns_no_warnings(self) -> None:
        self.assertEqual(validate_payload(PUMPS_PAYLOAD), [])

    def test_catches_bundled_lobs(self) -> None:
        payload = {**PUMPS_PAYLOAD, "opportunities": [
            *PUMPS_PAYLOAD["opportunities"],
            {  # second GL row — bundling forbidden
                "opportunity_name": "3D Pumps LLC - General Liability - duplicate",
                "line_of_business": "General Liability",
                "stage": "Discovery",
            },
        ]}
        warnings = validate_payload(payload)
        self.assertTrue(
            any("bundling forbidden" in w for w in warnings),
            f"warnings did not flag bundling: {warnings}",
        )

    def test_catches_illegal_stage(self) -> None:
        payload = {**PUMPS_PAYLOAD, "opportunities": [
            {
                "opportunity_name": "X - GL - 2026",
                "line_of_business": "General Liability",
                "stage": "Hot Lead",  # not in the canonical enum
            }
        ]}
        warnings = validate_payload(payload)
        self.assertTrue(any("not in the canonical enum" in w for w in warnings))

    def test_catches_missing_account_name(self) -> None:
        payload = {**PUMPS_PAYLOAD, "account": {"fein": "33-3725730"}}
        warnings = validate_payload(payload)
        self.assertIn("account.account_name is missing", warnings)


class StageDraftTests(unittest.TestCase):
    def test_stage_draft_inserts_and_returns_prompt(self) -> None:
        supa = MagicMock()
        supa.insert.return_value = {"id": "draft-abc"}

        with patch(
            "hermes_intake.agency_intake._extract_payload",
            return_value=PUMPS_PAYLOAD,
        ):
            draft = stage_draft(
                supa,
                raw_text="3D Pumps LLC underwriting summary",
                submitted_by="Lamar",
                source_type="slack_summary",
            )

        self.assertEqual(draft.draft_id, "draft-abc")
        self.assertEqual(draft.validation_warnings, [])
        # Approval prompt should list every LOB.
        for lob in (
            "General Liability",
            "Workers Compensation",
            "Commercial Auto",
            "Inland Marine",
            "Contractors Pollution Liability",
            "Umbrella / Excess",
        ):
            self.assertIn(lob, draft.approval_prompt, f"{lob} missing from prompt")
        # 1 restricted fact = EIN
        self.assertIn("1 restricted", draft.approval_prompt)
        supa.insert.assert_called_once_with(
            "agency_intake_drafts",
            unittest.mock.ANY,
        )

    def test_stage_draft_propagates_extraction_error(self) -> None:
        supa = MagicMock()
        with patch(
            "hermes_intake.agency_intake._extract_payload",
            side_effect=AgencyIntakeError("no key"),
        ):
            with self.assertRaises(AgencyIntakeError):
                stage_draft(supa, raw_text="anything")


class ApproveDraftTests(unittest.TestCase):
    """Phase 3: approve_draft now reads intake_submissions by submission_id.
    The pre-Phase-3 agency_intake_drafts behavior is gone — full coverage of
    the new behavior lives in tests/test_intake_worker.py::TestApproveDraftRewrite.

    Kept here: the small handful of pre-Phase-3 contract assertions that
    survive the rewrite (token validation, missing-submission error).
    """

    def test_rejects_unknown_token(self) -> None:
        supa = MagicMock()
        supa.select.return_value = []  # never reached — token validated first
        with self.assertRaises(ApprovalError):
            approve_draft(
                supa, draft_id="any-id", token="SHIP IT", approver="U123"
            )

    def test_rejects_missing_submission(self) -> None:
        supa = MagicMock()
        supa.select.return_value = []
        with self.assertRaises(ApprovalError):
            approve_draft(
                supa, draft_id="missing", token="APPROVE ALL", approver="U123"
            )


class ApprovalTokenContractTests(unittest.TestCase):
    """The Slack handler hardcodes a token_map; this guards that it stays
    in sync with the canonical ALLOWED_APPROVAL_TOKENS set."""

    def test_slack_handler_token_map_matches_canonical_tokens(self) -> None:
        slack_handler_token_map = {
            "agency_intake_approve_all": "APPROVE ALL",
            "agency_intake_approve_crm": "APPROVE CRM ONLY",
            "agency_intake_approve_supabase": "APPROVE SUPABASE ONLY",
            "agency_intake_approve_tasks": "APPROVE TASKS ONLY",
            "agency_intake_revise": "REVISE",
            "agency_intake_cancel": "CANCEL",
        }
        self.assertEqual(
            set(slack_handler_token_map.values()),
            ALLOWED_APPROVAL_TOKENS,
        )


class BuildApprovalBlocksTests(unittest.TestCase):
    def test_returns_section_plus_six_action_buttons(self) -> None:
        from hermes_intake.agency_intake import build_approval_blocks

        blocks = build_approval_blocks("draft-abc", "Intake draft ready — 3D Pumps LLC")
        self.assertEqual(len(blocks), 2)
        self.assertEqual(blocks[0]["type"], "section")
        self.assertIn("3D Pumps LLC", blocks[0]["text"]["text"])
        actions = blocks[1]
        self.assertEqual(actions["type"], "actions")
        self.assertEqual(len(actions["elements"]), 6)
        action_ids = {e["action_id"] for e in actions["elements"]}
        self.assertEqual(action_ids, {
            "agency_intake_approve_all",
            "agency_intake_approve_crm",
            "agency_intake_approve_supabase",
            "agency_intake_approve_tasks",
            "agency_intake_revise",
            "agency_intake_cancel",
        })
        # Every button carries the draft id so the action handler can route it
        # to approve_draft without state.
        for elem in actions["elements"]:
            self.assertEqual(elem["value"], "draft-abc")
        # Approve All is primary; Cancel is danger.
        styles = {e["action_id"]: e.get("style") for e in actions["elements"]}
        self.assertEqual(styles["agency_intake_approve_all"], "primary")
        self.assertEqual(styles["agency_intake_cancel"], "danger")


class DispatcherHandleTests(unittest.TestCase):
    def test_handle_strips_verb_and_stages(self) -> None:
        from hermes_intake.agency_intake import handle

        supa = MagicMock()
        supa.insert.return_value = {"id": "draft-xyz"}

        with patch(
            "hermes_intake.agency_intake._extract_payload",
            return_value=PUMPS_PAYLOAD,
        ):
            result = handle(
                    text="stage intake: 3D Pumps LLC — bypass pumping…",
                supa=supa,
                channel_id="C123",
                user_id="U999",
                message_ts="1700000000.0",
            )

        self.assertTrue(result.ok)
        self.assertEqual(result.data["draft_id"], "draft-xyz")
        self.assertIn("slack_blocks", result.data)
        self.assertEqual(len(result.data["slack_blocks"]), 2)
        self.assertEqual(result.data["slack_blocks"][1]["type"], "actions")

    def test_handle_requires_body_after_verb(self) -> None:
        from hermes_intake.agency_intake import handle

        supa = MagicMock()
        result = handle(
            text="stage intake:",
            supa=supa,
        )
        self.assertFalse(result.ok)
        self.assertIn("Paste", result.message)
        supa.insert.assert_not_called()

    def test_handle_requires_supa(self) -> None:
        from hermes_intake.agency_intake import handle

        result = handle(
            text="stage intake: anything",
            supa=None,
        )
        self.assertFalse(result.ok)
        self.assertIn("Supabase", result.message)


if __name__ == "__main__":
    unittest.main()
