"""Command Center dashboard reads — KPIs, approval queue, activity feed.

Wired to live data where it's cheap and honest:
  - KPIs from the canonical book (canonical_clients / canonical_policies) + the
    latest agency snapshot for retention.
  - Approval queue from cc_submissions still in review (Phase 1 output).
  - Feed from cc_review_events (the real intake activity).

Pipeline stays None: the Supabase `opportunities` rollup for this card is not
wired yet (`opportunity_summary` below serves the LOB view). We show
real premium/clients, not a placeholder, and compare retention to RSG's standing
75% target (the book was 54.92%) rather than an invented goal.
"""
from __future__ import annotations

from typing import Any

from hermes_core import book as ams_book

RETENTION_GOAL = 75.0   # RSG standing target


def _premium(p: dict) -> float:
    for k in ("annualized_premium", "current_term_amount", "premium_amount"):
        v = p.get(k)
        if v not in (None, ""):
            try:
                return float(v)
            except (TypeError, ValueError):
                pass
    return 0.0


def kpi_summary(supa) -> dict[str, Any]:
    clients = supa.select("canonical_clients", columns="nowcerts_insured_guid", limit=5000)
    policies = ams_book.select_policies(
        supa,
        columns="active,annualized_premium,current_term_amount,premium_amount",
        limit=5000,
    )
    active = [p for p in policies if p.get("active")]
    snap = supa.select("agency_snapshots", params={"order": "snapshot_date.desc"}, limit=1)
    s = snap[0] if snap else {}
    return {
        "active_premium": round(sum(_premium(p) for p in active)),
        "total_premium": round(sum(_premium(p) for p in policies)),
        "client_count": len(clients),
        "policy_count": len(policies),
        "active_policy_count": len(active),
        "retention_rate": s.get("retention_rate"),
        "retention_goal": RETENTION_GOAL,
        "retention_snapshot_date": s.get("snapshot_date"),
        "pipeline": None,   # not wired — see module docstring
    }


def approval_queue(supa, limit: int = 50) -> list[dict]:
    rows = supa.select("cc_submissions", params={
        "status": "eq.in_review", "order": "updated_at.desc",
    }, limit=limit)
    out = []
    for r in rows:
        flags = r.get("flags") or []
        out.append({
            "id": r.get("id"),
            "client_name": r.get("client_name"),
            "lane": r.get("lane"),
            "created_by": r.get("created_by"),
            "updated_at": r.get("updated_at"),
            "blocking": sum(1 for f in flags if f.get("severity") == "blocking"),
            "warnings": sum(1 for f in flags if f.get("severity") == "warning"),
        })
    return out


def activity_feed(supa, limit: int = 25) -> list[dict]:
    return supa.select("cc_review_events", params={"order": "at.desc"}, limit=limit)


EMAIL_SOURCES = ("email-ms365", "email-gmail")


def _submission_title(row: dict) -> tuple[str, str]:
    """What to call a waiting submission, and the line under it.

    An email row is identified by its subject and sender. An intake row is
    identified by the account it is about and the lines of business it opens —
    reading it as "(no subject)" from nobody, which is what the email shape gives
    you, makes a real intake look like junk mail.
    """
    payload = row.get("payload") or {}
    draft = row.get("draft_summary") or {}
    account = (draft.get("account") or {}).get("account_name")
    if account:
        lobs = [
            o.get("line_of_business")
            for o in (draft.get("opportunities") or [])
            if o.get("line_of_business")
        ]
        return account, ", ".join(lobs) or str(row.get("source") or "")
    subject = payload.get("subject")
    if subject:
        return str(subject), str(payload.get("from") or payload.get("from_address") or "")
    # Pre-synthesis, or a shape we don't recognize: say what it is rather than
    # inventing a title.
    return f"({row.get('source') or 'submission'})", str(row.get("status") or "")


def intake_queue(supa, limit: int = 50, *, sources: tuple[str, ...] | None = None) -> dict[str, Any]:
    """Everything waiting in ``intake_submissions``, whatever produced it.

    This used to be filtered to the two email lanes, which meant a submission
    from any other source — the intake gate, cowork, n8n — was committed to the
    database and then invisible to the only person who could approve it. With
    Slack out of the picture this list IS the approval surface, so it cannot be
    the email list wearing a different name.

    ``awaiting_approval`` rows are the ones a person needs to act on; ``failed``
    rows flag a triage/synthesis gap. Pass ``sources`` to narrow it.
    """
    params: dict[str, str] = {"order": "created_at.desc"}
    if sources:
        params["source"] = f"in.({','.join(sources)})"
    rows = supa.select("intake_submissions", params=params, limit=limit)
    items, counts = [], {}
    for r in rows:
        p = r.get("payload") or {}
        status = r.get("status")
        counts[status] = counts.get(status, 0) + 1
        title, subtitle = _submission_title(r)
        items.append({
            "id": r.get("id"),
            "status": status,
            "source": r.get("source"),
            "title": title,
            "subtitle": subtitle,
            # Only an awaiting_approval row can be acted on. Sent so the UI can
            # disable the button rather than offer an action that will 400.
            "actionable": status == "awaiting_approval",
            "received_at": p.get("received_at") or r.get("created_at"),
            "lob_guess": p.get("lob_guess"),
            "classifier_reason": p.get("classifier_reason"),
            # Kept so the existing email card renders unchanged.
            "from": p.get("from") or p.get("from_address"),
            "subject": p.get("subject"),
        })
    return {"items": items, "counts": counts, "total": len(items)}


def email_queue(supa, limit: int = 50) -> dict[str, Any]:
    """The email lanes only — the original card, unchanged in behaviour."""
    return intake_queue(supa, limit=limit, sources=EMAIL_SOURCES)


# ---- reports (Advanced-Pack-equivalent, on open core) --------------------

def _to_float(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def retention_trend(supa, limit: int = 24) -> dict[str, Any]:
    """Retention rate over time from agency_snapshots — RSG's headline metric
    (the book was 54.92%, target 75%). The dashboard KPI shows only the latest
    point; this surfaces the trajectory the weekly book-health snapshots build.
    """
    rows = supa.select("agency_snapshots",
                       params={"order": "snapshot_date.asc"}, limit=limit)
    points = [{"date": r.get("snapshot_date"), "rate": r.get("retention_rate")}
              for r in rows if r.get("retention_rate") is not None]
    current = points[-1]["rate"] if points else None
    first = points[0]["rate"] if points else None
    return {
        "points": points,
        "goal": RETENTION_GOAL,
        "current": current,
        "delta": (round(current - first, 2) if current is not None and first is not None else None),
        "count": len(points),
    }



def pipeline_report(supa) -> dict[str, Any]:
    """Open pipeline from the Supabase `opportunities` table, aggregated by stage
    and by line of business.

    Previously read EspoCRM Opportunities. That CRM is decommissioned, so the
    endpoint 503'd on every call; opportunities now live in Supabase and carry a
    real `line_of_business` column, so the LOB rollup no longer has to guess by
    substring-matching the description.
    """
    rows = supa.select(
        "opportunities",
        columns="id,insured_name,line_of_business,stage,status,premium_estimate",
        limit=1000,
    )

    stages: dict[str, dict] = {}
    lob: dict[str, dict] = {}
    total = 0.0
    for r in rows:
        if not isinstance(r, dict):
            continue
        amt = _to_float(r.get("premium_estimate"))
        total += amt
        st = r.get("stage") or "Unknown"
        sd = stages.setdefault(st, {"stage": st, "count": 0, "premium": 0.0})
        sd["count"] += 1
        sd["premium"] += amt
        matched = r.get("line_of_business") or "Other"
        b = lob.setdefault(matched, {"lob": matched, "count": 0, "premium": 0.0})
        b["count"] += 1
        b["premium"] += amt
    rnd = lambda xs: [{**x, "premium": round(x["premium"])} for x in xs]
    return {
        "stages": rnd(sorted(stages.values(), key=lambda x: x["premium"], reverse=True)),
        "lob": rnd(sorted(lob.values(), key=lambda x: x["premium"], reverse=True)),
        "total": round(total),
        "deals": len(rows),
    }
