"""ACORD 25 — Certificate of Insurance generator.

"COI for <client>" → a *draft* ACORD 25 PDF, filled from agency policy data,
saved for filing in the client's Nextcloud folder and posted to #gretchen-tasks
for review. **Never auto-sent** — Gretchen reviews and sends.

Design (so the testable core has no I/O):

  policy/account records  --from_policy_records-->  Coi (logical model)
  Coi                     --build_field_map-->   {pdf_field_name: value}
  {pdf_field_name: value} --fill_pdf----------->  filled PDF bytes
  filled PDF              --draft_coi---------->   Nextcloud + Slack + Supabase log

`from_policy_records` and `build_field_map` are pure and unit-tested. `fill_pdf`
needs RSG's **licensed** ACORD 25 template (ACORD forms are copyrighted — pull
ours from NowCerts / agency files; never download a random copy). `draft_coi`
wires the live integrations, which are injected so they can be faked in tests.

IMPORTANT — template field names: the keys in ``FIELD_NAMES`` are the AcroForm
field names ACORD 25 (2016/03) commonly uses, but the exact names vary by source.
Before first use, run ``list_template_fields(<our template>)`` and reconcile any
mismatches (override via the ``field_names`` arg or HERMES_ACORD25_FIELDMAP json).
``fill_pdf`` skips unknown fields and reports them rather than failing silently.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Two policy endorsement flags this feature needs on the incoming policy record.
# AI/WOS checkboxes on the COI are driven by these; NowCerts does not expose them
# today, so absent means the box stays unchecked. camelCase to match the rest of
# the policy keys read below.
# ---------------------------------------------------------------------------
POLICY_FIELD_ADDITIONAL_INSURED = "additionalInsuredOnFile"
POLICY_FIELD_WAIVER_OF_SUB = "waiverOfSubOnFile"


# ---------------------------------------------------------------------------
# Logical COI model — what an ACORD 25 actually needs, independent of the PDF.
# ---------------------------------------------------------------------------
@dataclass
class CoverageLine:
    """One coverage row on the ACORD 25 (GL, Auto, Umbrella, WC, ...)."""
    kind: str                       # e.g. "general_liability", "automobile", "umbrella", "workers_comp"
    carrier: str = ""               # insurer name (maps to an INSURER row)
    naic: str = ""                  # carrier NAIC #
    policy_number: str = ""
    eff_date: str = ""              # MM/DD/YYYY
    exp_date: str = ""              # MM/DD/YYYY
    limits: dict[str, str] = field(default_factory=dict)  # logical limit -> value
    additional_insured: bool = False
    waiver_of_subrogation: bool = False


@dataclass
class Coi:
    """Everything needed to fill one ACORD 25 certificate."""
    insured_name: str = ""
    insured_address: str = ""
    producer_name: str = "Risk Solutions Group"
    producer_address: str = ""
    holder_name: str = ""           # certificate holder (from the request)
    holder_address: str = ""
    description: str = ""           # "Description of Operations" box
    coverages: list[CoverageLine] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Logical field map -> PDF AcroForm field names. VERIFY against our template.
# Insurer rows A..F and per-row policy/date fields follow ACORD's row model.
# ---------------------------------------------------------------------------
FIELD_NAMES: dict[str, str] = {
    "producer_name": "PRODUCER",
    "insured_name": "INSURED",
    "holder_name": "CERTIFICATE HOLDER",
    "description": "DESCRIPTION OF OPERATIONS",
}

# Per coverage-kind: the INSURER-letter row and the PDF fields for that row.
# ACORD 25 fixes GL/Auto/Umbrella/WC to specific rows on the form.
COVERAGE_ROWS: dict[str, dict[str, str]] = {
    "general_liability": {
        "policy_number": "GL POLICY NUMBER",
        "eff_date": "GL POLICY EFF",
        "exp_date": "GL POLICY EXP",
        "each_occurrence": "EACH OCCURRENCE",
        "general_aggregate": "GENERAL AGGREGATE",
    },
    "automobile": {
        "policy_number": "AUTO POLICY NUMBER",
        "eff_date": "AUTO POLICY EFF",
        "exp_date": "AUTO POLICY EXP",
        "combined_single_limit": "COMBINED SINGLE LIMIT",
    },
    "umbrella": {
        "policy_number": "UMBRELLA POLICY NUMBER",
        "eff_date": "UMBRELLA POLICY EFF",
        "exp_date": "UMBRELLA POLICY EXP",
        "each_occurrence": "UMBRELLA EACH OCCURRENCE",
    },
    "workers_comp": {
        "policy_number": "WC POLICY NUMBER",
        "eff_date": "WC POLICY EFF",
        "exp_date": "WC POLICY EXP",
        "el_each_accident": "EL EACH ACCIDENT",
    },
}


# ---------------------------------------------------------------------------
# policy / account records -> Coi  (pure)
# ---------------------------------------------------------------------------
def _g(d: dict[str, Any], *keys: str, default: str = "") -> str:
    """First non-empty value across candidate keys (handles dirty/mixed casing)."""
    for k in keys:
        v = d.get(k)
        if v not in (None, ""):
            return str(v)
    return default


def _classify_lob(lob: str) -> str:
    """Map a line-of-business string to an ACORD 25 coverage row kind."""
    t = (lob or "").lower()
    if "umbrella" in t or "excess" in t:
        return "umbrella"
    if "auto" in t or "vehicle" in t or "fleet" in t:
        return "automobile"
    if "comp" in t and "work" in t or "workers" in t or t in ("wc",):
        return "workers_comp"
    if "general" in t or "liability" in t or t in ("gl", "bop"):
        return "general_liability"
    return "general_liability"


def from_policy_records(
    policies: list[dict[str, Any]],
    account: dict[str, Any],
    *,
    holder_name: str,
    holder_address: str = "",
    description: str = "",
) -> Coi:
    """Build a Coi from one account and its policy records.

    Key reads are casing-tolerant and already match what NowCerts returns
    (``lineOfBusiness``, ``carrierName``, ``policyNumber``, ``effectiveDate``,
    ``expirationDate``).

    AI/WOS per row come from the policy's endorsement flags
    (``additionalInsuredOnFile`` / ``waiverOfSubOnFile``) — absent/false means
    the box stays unchecked. Nothing is invented; missing data stays blank.

    GAP: the ``account`` address reads still expect the old CRM's
    ``billing_address_*`` / ``billingAddress*`` keys. A NowCerts insured uses
    different names, so feeding one straight in yields a blank insured address.
    Map the address before calling, or extend ``_g`` here, when this gets a
    production caller — it has none today.
    """
    coverages: list[CoverageLine] = []
    for p in policies:
        coverages.append(
            CoverageLine(
                kind=_classify_lob(_g(p, "lineOfBusiness", "line_of_business", "lob")),
                carrier=_g(p, "carrier", "carrierName", "writingCompany"),
                naic=_g(p, "naic", "naicCode", "carrierNaic"),
                policy_number=_g(p, "policyNumber", "policy_number", "number"),
                eff_date=_g(p, "effectiveDate", "effective_date", "effdate"),
                exp_date=_g(p, "expirationDate", "expiration_date", "xdate"),
                additional_insured=bool(p.get(POLICY_FIELD_ADDITIONAL_INSURED)),
                waiver_of_subrogation=bool(p.get(POLICY_FIELD_WAIVER_OF_SUB)),
            )
        )
    addr = " ".join(
        x for x in (
            _g(account, "billing_address_street", "billingAddressStreet"),
            _g(account, "billing_address_city", "billingAddressCity"),
            _g(account, "billing_address_state", "billingAddressState"),
            _g(account, "billing_address_postal_code", "billingAddressPostalCode"),
        ) if x
    )
    return Coi(
        insured_name=_g(account, "name", "insured_name"),
        insured_address=addr,
        holder_name=holder_name,
        holder_address=holder_address,
        description=description,
        coverages=coverages,
    )


# ---------------------------------------------------------------------------
# Coi -> {pdf_field_name: value}  (pure)
# ---------------------------------------------------------------------------
def build_field_map(coi: Coi, field_names: Optional[dict[str, str]] = None) -> dict[str, str]:
    """Flatten a Coi into PDF AcroForm field values. Empty/missing render as ''."""
    names = {**FIELD_NAMES, **(field_names or {})}
    out: dict[str, str] = {
        names["producer_name"]: coi.producer_name,
        names["insured_name"]: "\n".join(x for x in (coi.insured_name, coi.insured_address) if x),
        names["holder_name"]: "\n".join(x for x in (coi.holder_name, coi.holder_address) if x),
        names["description"]: coi.description,
    }
    for cov in coi.coverages:
        row = COVERAGE_ROWS.get(cov.kind)
        if not row:
            continue
        if "policy_number" in row:
            out[row["policy_number"]] = cov.policy_number
        if "eff_date" in row:
            out[row["eff_date"]] = cov.eff_date
        if "exp_date" in row:
            out[row["exp_date"]] = cov.exp_date
        for limit_key, value in cov.limits.items():
            if limit_key in row:
                out[row[limit_key]] = value
    return {k: v for k, v in out.items() if v}


def acord_checkbox_state(coi: Coi) -> dict[str, bool]:
    """AI/WOS checkbox state per coverage kind, from the policy endorsement flags."""
    state: dict[str, bool] = {}
    for cov in coi.coverages:
        state[f"{cov.kind}:additional_insured"] = cov.additional_insured
        state[f"{cov.kind}:waiver_of_subrogation"] = cov.waiver_of_subrogation
    return state


# ---------------------------------------------------------------------------
# PDF I/O (needs the licensed template)
# ---------------------------------------------------------------------------
def list_template_fields(template_path: str) -> list[str]:
    """Return the AcroForm field names in a PDF — use to reconcile FIELD_NAMES."""
    from pypdf import PdfReader

    reader = PdfReader(template_path)
    fields = reader.get_fields() or {}
    return sorted(fields.keys())


def _load_field_name_overrides() -> dict[str, str]:
    """Optional FIELD_NAMES overrides from HERMES_ACORD25_FIELDMAP (a json path)."""
    path = os.environ.get("HERMES_ACORD25_FIELDMAP", "").strip()
    if not path:
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        log.warning("HERMES_ACORD25_FIELDMAP=%s unreadable: %s", path, exc)
        return {}


def fill_pdf(template_path: str, values: dict[str, str], output_path: str) -> dict[str, Any]:
    """Fill the ACORD 25 template and write a draft PDF.

    Returns {written: path, placed: [...], skipped: [...]}. Unknown field names
    are skipped (and reported) rather than raising — so a template-name mismatch
    degrades gracefully instead of producing nothing.
    """
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(template_path)
    known = set((reader.get_fields() or {}).keys())
    placed = {k: v for k, v in values.items() if k in known}
    skipped = [k for k in values if k not in known]
    if skipped:
        log.warning("ACORD25 fill: %d field(s) not in template, skipped: %s", len(skipped), skipped)

    writer = PdfWriter()
    writer.append(reader)
    for page in writer.pages:
        writer.update_page_form_field_values(page, placed)
    # Ensure viewers render the filled values.
    try:
        writer.set_need_appearances_writer(True)
    except Exception:  # pragma: no cover - pypdf version differences
        pass
    with open(output_path, "wb") as fh:
        writer.write(fh)
    return {"written": output_path, "placed": sorted(placed), "skipped": skipped}


# ---------------------------------------------------------------------------
# The 4-point pre-send checklist Gretchen sees in #gretchen-tasks
# ---------------------------------------------------------------------------
def pre_send_checklist(coi: Coi) -> str:
    holder = coi.holder_name or "the requester"
    return (
        f"*Draft certificate of insurance for {coi.insured_name or 'this client'}* — please review before sending:\n"
        f"1. *Certificate holder* spelled and addressed correctly ({holder})?\n"
        f"2. *Coverages, limits, and dates* match the current policy?\n"
        f"3. *Additional Insured / Waiver of Subrogation* boxes match what the holder actually requires?\n"
        f"4. *Description of Operations* says what this certificate is for?\n"
        f"_Nothing is sent automatically — you send it once it looks right._"
    )


# ---------------------------------------------------------------------------
# Orchestration — live integrations injected so the core stays testable.
# ---------------------------------------------------------------------------
def supabase_logger(supa) -> Callable[[dict[str, Any]], None]:
    """A ``supa_log`` callable that records a draft into coi_drafts, agent_id-stamped."""
    from hermes_core.identity import agent_id

    def _log(summary: dict[str, Any]) -> None:
        supa.insert("coi_drafts", {
            "agent_id": agent_id(),
            "account": summary.get("account", ""),
            "holder": summary.get("holder", ""),
            "output_path": summary.get("output_path"),
            "file_url": summary.get("file_url"),
            "placed_fields": summary.get("placed_fields", []),
            "skipped_fields": summary.get("skipped_fields", []),
            "auto_sent": False,
        })

    return _log


def draft_coi(
    coi: Coi,
    *,
    template_path: str,
    output_path: str,
    account_name: str,
    holder_name: str,
    file_upload: Optional[Callable[[str], str]] = None,
    slack_post: Optional[Callable[[str], None]] = None,
    supa_log: Optional[Callable[[dict[str, Any]], None]] = None,
    field_names: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    """Fill → (Nextcloud) → (#gretchen-tasks) → (Supabase log). Returns a summary.

    Each side effect is optional/injected: pass real callables in production, omit
    them (or pass fakes) in tests. The PDF fill always runs. ``file_upload`` is a
    generic uploader (e.g. Nextcloud) returning a URL; there is no Google Drive.
    """
    overrides = {**_load_field_name_overrides(), **(field_names or {})}
    values = build_field_map(coi, overrides)
    fill_result = fill_pdf(template_path, values, output_path)

    file_url = file_upload(output_path) if file_upload else None
    if slack_post:
        msg = pre_send_checklist(coi)
        if file_url:
            msg += f"\nDraft: {file_url}"
        slack_post(msg)

    summary = {
        "account": account_name,
        "holder": holder_name,
        "output_path": output_path,
        "file_url": file_url,
        "placed_fields": fill_result["placed"],
        "skipped_fields": fill_result["skipped"],
        "auto_sent": False,
    }
    if supa_log:
        supa_log(summary)
    return summary
