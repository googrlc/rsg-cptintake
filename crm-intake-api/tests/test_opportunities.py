"""Tests for the opportunities pipeline library (hermes_core/opportunities.py).

Supabase mocked. Synthetic identifiers only.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from hermes_core import opportunities as opp


def _supa(existing=None, inserted_id="opp-1"):
    s = MagicMock()
    s.select.return_value = existing or []
    s.insert.side_effect = lambda table, payload: {**payload, "id": inserted_id}
    s.update.side_effect = lambda table, rid, payload: {"id": rid, **payload}
    return s


# ---------------------------------------------------------------- helpers

def test_make_client_identifier():
    assert opp.make_client_identifier("Acme Plumbing LLC", "12-3456789") == "acme-plumbing-llc:123456789"
    assert opp.make_client_identifier("Acme Plumbing LLC") == "acme-plumbing-llc"
    assert opp.make_client_identifier("") == "unknown"


def test_status_for_stage():
    assert opp.status_for_stage(opp.STAGE_BOUND) == opp.STATUS_WON            # new-business won
    assert opp.status_for_stage(opp.STAGE_COMPLETE_RENEWAL) == opp.STATUS_WON  # renewal won
    assert opp.status_for_stage(opp.STAGE_LOST) == opp.STATUS_LOST
    assert opp.status_for_stage(opp.STAGE_NOT_RENEWED) == opp.STATUS_LOST      # renewal lost
    assert opp.status_for_stage(opp.STAGE_QUOTES_RECEIVED) == opp.STATUS_OPEN


def test_stage_probability_and_likelihood_mapping():
    # Pipeline drives the % ; % maps to the NowCerts likelihood category.
    assert opp.probability_for_stage(opp.STAGE_PREP) == 10
    assert opp.probability_for_stage(opp.STAGE_BOUND) == 100
    assert opp.likelihood_for_probability(100) == opp.LIKELIHOOD_EXCELLENT
    assert opp.likelihood_for_probability(50) == opp.LIKELIHOOD_GOOD
    assert opp.likelihood_for_probability(10) == opp.LIKELIHOOD_NOT_LIKELY
    assert opp.likelihood_for_probability(None) == opp.DEFAULT_LIKELIHOOD == "Good"


def test_stages_for_type_splits_pipelines():
    assert opp.stages_for_type(opp.TYPE_RENEWALS) == opp.RENEWAL_STAGES
    assert opp.stages_for_type(opp.TYPE_NEW_BUSINESS) == opp.NEW_BUSINESS_STAGES
    assert opp.stages_for_type("Cross-selling") == opp.NEW_BUSINESS_STAGES
    assert opp.default_stage_for_type(opp.TYPE_RENEWALS) == opp.STAGE_RENEWAL_90
    assert opp.default_stage_for_type(opp.TYPE_NEW_BUSINESS) == opp.STAGE_PREP


# ---------------------------------------------------------------- create

def test_create_opportunity_new():
    supa = _supa(existing=[])
    row, created = opp.create_opportunity(
        supa, client_identifier="acme:1", line_of_business="General Liability",
        insured_name="Acme", prospect_type="Hot_Prospect", insured_type="Commercial",
    )
    assert created is True
    # defaults: New Business type → first stage, stage-driven probability + likelihood.
    assert row["opportunity_type"] == "New Business"
    assert row["stage"] == opp.STAGE_PREP and row["status"] == "open"
    assert row["probability"] == 10 and row["likelihood"] == opp.LIKELIHOOD_NOT_LIKELY
    assert row["prospect_type"] == "Hot_Prospect"
    supa.insert.assert_called_once()


def test_create_renewal_opportunity_uses_renewal_stages():
    supa = _supa(existing=[])
    row, created = opp.create_opportunity(
        supa, client_identifier="acme:1", line_of_business="General Liability",
        opportunity_type=opp.TYPE_RENEWALS,
    )
    assert created is True
    assert row["opportunity_type"] == "Renewals"
    assert row["stage"] == opp.STAGE_RENEWAL_90


def test_create_likelihood_defaults_to_good_when_probability_midrange():
    supa = _supa(existing=[])
    row, _ = opp.create_opportunity(
        supa, client_identifier="acme:1", line_of_business="GL",
        stage=opp.STAGE_QUOTES_RECEIVED,   # 50% → Good
    )
    assert row["probability"] == 50 and row["likelihood"] == "Good"


def test_create_opportunity_idempotent_scoped_by_type():
    supa = _supa(existing=[{"id": "opp-9", "stage": opp.STAGE_SENT_QUOTING}])
    row, created = opp.create_opportunity(
        supa, client_identifier="acme:1", line_of_business="General Liability"
    )
    assert created is False and row["id"] == "opp-9"
    # existence check is scoped by opportunity_type now
    _, kw = supa.select.call_args
    assert kw["params"]["opportunity_type"] == "eq.New Business"
    supa.insert.assert_not_called()


def test_create_unknown_stage_for_type_raises():
    with pytest.raises(ValueError):
        # a renewal stage is invalid for a New Business opportunity
        opp.create_opportunity(MagicMock(), client_identifier="a", line_of_business="GL",
                               opportunity_type=opp.TYPE_NEW_BUSINESS, stage=opp.STAGE_RENEWAL_90)


def test_create_unknown_type_raises():
    with pytest.raises(ValueError):
        opp.create_opportunity(MagicMock(), client_identifier="a", line_of_business="GL",
                               opportunity_type="Nonsense")


def test_create_requires_client_and_lob():
    with pytest.raises(ValueError):
        opp.create_opportunity(MagicMock(), client_identifier="", line_of_business="GL")


# ---------------------------------------------------------------- advance / link

def test_advance_stage_to_bound_is_won():
    supa = _supa()
    row = opp.advance_stage(supa, "opp-1", opp.STAGE_BOUND)   # 'Bound / Won'
    assert row["stage"] == opp.STAGE_BOUND and row["status"] == "won"


def test_advance_stage_to_lost_records_reason():
    supa = _supa()
    row = opp.advance_stage(supa, "opp-1", opp.STAGE_LOST, lost_reason="price")
    assert row["status"] == "lost" and row["lost_reason"] == "price"


def test_advance_stage_marks_crm_worked():
    # A CRM stage move claims the row so the AMS sync won't overwrite it.
    supa = _supa()
    row = opp.advance_stage(supa, "opp-1", opp.STAGE_QUOTES_RECEIVED)
    assert row["sync_source"] == "crm"


def test_advance_accepts_any_nonempty_stage():
    # NowCerts owns the pipeline vocabulary — advance_stage takes any non-empty stage.
    supa = _supa()
    row = opp.advance_stage(supa, "opp-1", "Annual Policy Review")
    assert row["stage"] == "Annual Policy Review"


def test_advance_empty_stage_raises():
    with pytest.raises(ValueError):
        opp.advance_stage(MagicMock(), "opp-1", "   ")


def test_link_nowcerts_backfills_ids():
    supa = _supa()
    row = opp.link_nowcerts(supa, "opp-1", insured_id="ins-1", quote_number="QOUS-1")
    assert row["insured_id"] == "ins-1" and row["quote_number"] == "QOUS-1"


def test_link_nowcerts_noop_when_empty():
    supa = _supa()
    assert opp.link_nowcerts(supa, "opp-1") == {}
    supa.update.assert_not_called()


# ---------------------------------------------------------------- list

def test_list_opportunities_filters():
    supa = _supa(existing=[{"id": "o1"}])
    opp.list_opportunities(supa, stage=opp.STAGE_SENT_QUOTING, opportunity_type=opp.TYPE_RENEWALS,
                           assigned_to="gretchen")
    _, kw = supa.select.call_args
    params = kw["params"]
    assert params["stage"] == "eq.Sent For Quoting"
    assert params["opportunity_type"] == "eq.Renewals"
    assert params["status"] == "eq.open"
    assert params["assigned_to"] == "eq.gretchen"
