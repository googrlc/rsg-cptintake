"""Intake → NowCerts insured write, with read-back verification (P4).

Turns a locked ``SubmissionObject`` into a NowCerts ``create_insured`` payload and
**proves the write landed** by reading the record back and comparing field-by-field.
The mapping is data-driven from ``ams_field_map.yaml`` — the one place that decides
which fields have an AMS home — so "correct into the AMS" has a single definition.

Contract (mirrors ``ams/writeback.py`` for corrections, adapted to a create):

    build payload (verified fields only)
      → duplicate search
      → create_insured
      → read back by the new GUID
      → verify field-by-field
      → receipt: VERIFIED | COMMITTED_UNVERIFIED | DUPLICATE_FOUND

Safety rules, unchanged from the writeback path:
- **Verified fields only reach the AMS.** A field whose NowCerts key is not yet
  confirmed (``verified: false``) is surfaced in ``unsupported_fields`` — staged
  and visible, never written, never counted as landed.
- **Read-back is the receipt.** A create that returns 200 but does not read back
  matching is ``COMMITTED_UNVERIFIED``, not success.
- I/O is injected (``create_fn`` / ``read_fn`` / ``dup_search_fn``) so the core is
  testable without the live AMS.
"""

from __future__ import annotations

import functools
import logging
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger(__name__)

_FIELD_MAP_PATH = Path(__file__).resolve().parent / "ams_field_map.yaml"

# insuredType connector code for a commercial risk; prospect at intake.
_COMMERCIAL_INSURED_TYPE = "0"
_PROSPECT_TYPE = 1

# This mapper builds a COMMERCIAL insured (CommercialName + insuredType=0). A
# personal-lines submission must not be force-written as commercial — it uses
# FirstName/LastName + insuredType=1 via hermes_intake.nowcerts_map.map_to_insured.
_PERSONAL_LANE = "personal_no_acord"

# When a verified field is blank, fall back to another submission path before
# dropping it — the Command Center creates submissions with client_name, and its
# approval validator accepts either name field, so legal_name can legitimately be
# absent on an approved submission.
_PATH_FALLBACKS: dict[str, str] = {
    "applicant.legal_name": "client_name",
}

# NowCerts writes PascalCase common fields but reads them back on the Insured in
# camelCase with different names (InsuredDetailList shape). Verification maps the
# write name to its read-back alias(es) so a correct write is not falsely flagged.
_READ_ALIASES: dict[str, tuple[str, ...]] = {
    "CommercialName": ("commercialName", "insuredName", "name"),
    "FEIN": ("fein",),
    "AddressLine1": ("addressLine1",),
    "City": ("city",),
    "State": ("state",),
    "Zip": ("zipCode", "zip"),
    "EMail": ("eMail", "email"),
    "PhoneNumber": ("phone", "phoneNumber"),
    "typeOfBusiness": ("typeOfBusiness",),
}


def _is_personal(sub: Any) -> bool:
    """True if the submission is personal-lines (must not be written as commercial)."""
    lane = getattr(sub, "lane", None)
    lane_val = str(getattr(lane, "value", lane) or "").lower()
    if lane_val:
        return lane_val == _PERSONAL_LANE
    # No lane set — infer from the line of business routing.
    try:
        from hermes_intake.lane.submission import LANE_BY_LOB
        lob = getattr(sub, "lob", None)
        if lob is not None:
            return str(getattr(LANE_BY_LOB.get(lob), "value", "")).lower() == _PERSONAL_LANE
    except Exception:  # pragma: no cover - routing table unavailable
        pass
    return False


@functools.lru_cache(maxsize=1)
def load_field_map() -> dict[str, Any]:
    """The intake→NowCerts field map (cached)."""
    import yaml

    with open(_FIELD_MAP_PATH, "r", encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


# ---------------------------------------------------------------------------
# Normalization — applied before write; the read-back is compared in kind.
# String comparison in verify_readback is case-insensitive, so normalizers stay
# conservative (trim) to match the proven map_to_insured behavior and avoid a
# false mismatch; only the connector codes are real transforms.
# ---------------------------------------------------------------------------
def _trim(v: Any) -> str:
    return str(v).strip()


def _join_comma(v: Any) -> str:
    if isinstance(v, (list, tuple)):
        return ", ".join(str(x).strip() for x in v if str(x).strip())
    return str(v).strip()


# SubmissionObject EntityType value → NowCerts "Type of Business" option string.
# The option set is the NowCerts insured "Type of Business" picklist (confirmed
# from the AMS UI); the field key is `typeOfBusiness` (confirmed from the insured
# read mapping in sync/canonical_book_sync). A value not in the picklist -> "Other".
ENTITY_TYPE_LABELS: dict[str, str] = {
    "individual": "Individual",
    "llc": "LLC",
    "corporation": "Corporation",
    "s_corp": "Subchapter Corp",
    "partnership": "Partnership",
    "joint_venture": "Joint Venture",
    "not_for_profit": "Not For Profit Org",
    "trust": "Trust",
}


def _business_type(v: Any) -> str:
    """EntityType (enum or value) → NowCerts 'Type of Business' option label."""
    key = str(getattr(v, "value", v)).strip().lower()
    return ENTITY_TYPE_LABELS.get(key, "Other")


_NORMALIZERS: dict[str, Callable[[Any], Any]] = {
    "trim": _trim,
    "fein": _trim,          # send as-entered; confirm digit-vs-dashed with NowCerts later
    "state_2letter": lambda v: str(v).strip().upper(),
    "zip": _trim,
    "phone": _trim,
    "digits": lambda v: "".join(ch for ch in str(v) if ch.isdigit()),
    "join_comma": _join_comma,
    "money": _trim,
    "date": _trim,
    "business_type": _business_type,   # EntityType → NowCerts "Type of Business" label
}


def _normalize(name: Optional[str], value: Any) -> Any:
    fn = _NORMALIZERS.get(name or "trim", _trim)
    return fn(value)


def _resolve(sub: Any, dotted: str) -> Any:
    """Walk a dotted attribute path on the SubmissionObject; None if any hop is missing."""
    node: Any = sub
    for part in dotted.split("."):
        if node is None:
            return None
        node = getattr(node, part, None)
    return node


def _blank(v: Any) -> bool:
    return v in (None, "") or (isinstance(v, (list, tuple, dict)) and len(v) == 0)


# ---------------------------------------------------------------------------
# Payload  (pure)
# ---------------------------------------------------------------------------
def build_insured_payload(sub: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """(payload, unsupported_fields) for create_insured.

    Only ``ams_insured`` entries that are ``verified: true`` and have a present
    value reach the payload. Present-but-unverified fields become
    ``unsupported_fields`` — visible, never written.

    Raises ``ValueError`` for a personal-lines submission — this mapper builds a
    commercial insured; personal insureds go through ``nowcerts_map.map_to_insured``.
    """
    if _is_personal(sub):
        raise ValueError(
            "ams_intake_mapper builds a COMMERCIAL insured; this submission is "
            "personal-lines. Use hermes_intake.nowcerts_map.map_to_insured instead."
        )

    fm = load_field_map()
    payload: dict[str, Any] = {}
    unsupported: list[dict[str, Any]] = []

    for entry in fm.get("insured", []):
        path = entry.get("path")
        # Synthetic, code-derived connector codes.
        if path == "(commercial)":
            payload["insuredType"] = _COMMERCIAL_INSURED_TYPE
            continue
        if path == "(prospect)":
            payload["type"] = _PROSPECT_TYPE
            continue

        value = _resolve(sub, path)
        if _blank(value) and path in _PATH_FALLBACKS:
            value = _resolve(sub, _PATH_FALLBACKS[path])
        if _blank(value):
            continue

        nowcerts_field = entry.get("nowcerts_field")
        if not entry.get("verified") or not nowcerts_field:
            unsupported.append({
                "path": path,
                "nowcerts_field": nowcerts_field,
                "reason": "NowCerts field key not confirmed",
            })
            continue

        payload[nowcerts_field] = _normalize(entry.get("normalize"), value)

    return payload, unsupported


def classify_fields(sub: Any) -> dict[str, list[dict[str, Any]]]:
    """Group the submission's PRESENT fields by where they will actually land.

    Reads ``sub``: only fields with a value on this submission are grouped, so the
    preview reflects the real record, not the whole map. An ``ams_insured`` field
    whose NowCerts key is unconfirmed (``verified: false``) is grouped under
    ``unsupported`` — matching what ``build_insured_payload`` actually does — so a
    reviewer is never told data will reach the AMS when the write drops it.
    """
    fm = load_field_map()
    out: dict[str, list[dict[str, Any]]] = {}
    for section in ("insured", "coverage"):
        for entry in fm.get(section, []):
            path = entry.get("path", "")
            if path in ("(commercial)", "(prospect)"):
                continue
            value = _resolve(sub, path)
            if _blank(value) and path in _PATH_FALLBACKS:
                value = _resolve(sub, _PATH_FALLBACKS[path])
            if _blank(value):
                continue                       # not present on this submission — omit
            home = entry.get("home", "unsupported")
            if home == "ams_insured" and not (entry.get("verified") and entry.get("nowcerts_field")):
                home = "unsupported"           # unconfirmed key → not actually written
            out.setdefault(home, []).append({
                "path": path,
                "nowcerts_field": entry.get("nowcerts_field"),
                "verified": bool(entry.get("verified")),
            })
    return out


# ---------------------------------------------------------------------------
# Verify  (pure)
# ---------------------------------------------------------------------------
# Connector codes may not read back identically (NowCerts may echo a label), so
# they are written but not strictly verified.
_UNVERIFIED_ON_READBACK = {"insuredType", "type"}


def verify_readback(sent: dict[str, Any], after: dict[str, Any] | None) -> tuple[bool, list[str]]:
    """Did the read-back carry what we sent? Case-insensitive, per field.

    Mirrors ``ams/writeback._verify``. No record back → unverified (the write may
    have landed; the caller reports rather than asserting).
    """
    checkable = [k for k in sent if k not in _UNVERIFIED_ON_READBACK]
    if not after:
        return (False, checkable)
    lowered = {str(k).lower(): v for k, v in after.items()}

    def _read_value(write_key: str) -> Any:
        # Try the write name and each known read-back alias (all case-insensitive).
        for candidate in (write_key, *_READ_ALIASES.get(write_key, ())):
            if candidate.lower() in lowered:
                return lowered[candidate.lower()]
        return None

    mismatched: list[str] = []
    for key in checkable:
        got = _read_value(key)
        if str(got or "").strip().casefold() != str(sent[key]).strip().casefold():
            mismatched.append(key)
    return (not mismatched, mismatched)


def _extract_guid(created: Any) -> str | None:
    """Pull the new insured's identifier out of a create response, tolerant of casing."""
    if not isinstance(created, dict):
        return None
    for key in ("insuredDatabaseId", "InsuredDatabaseId", "databaseId", "DatabaseId",
                "id", "Id", "guid", "Guid"):
        v = created.get(key)
        if v not in (None, ""):
            return str(v)
    return None


# ---------------------------------------------------------------------------
# Orchestration — I/O injected, so the create+verify is testable without the AMS.
# ---------------------------------------------------------------------------
STATUS_VERIFIED = "VERIFIED"
STATUS_UNVERIFIED = "COMMITTED_UNVERIFIED"
STATUS_DUPLICATE = "DUPLICATE_FOUND"


def create_and_verify(
    sub: Any,
    *,
    create_fn: Callable[[dict[str, Any]], Any],
    read_fn: Callable[[str], dict[str, Any] | None],
    dup_search_fn: Callable[[dict[str, Any]], list[dict[str, Any]]],
) -> dict[str, Any]:
    """Create the insured in NowCerts and prove it landed. Returns a receipt.

    ``create_fn(payload)`` creates and returns the AMS response; ``read_fn(guid)``
    reads the record back; ``dup_search_fn(payload)`` returns candidate duplicates.

    ``dup_search_fn`` is **required**: create_insured upserts by ``CommercialName``,
    so creating without a duplicate check could overwrite an existing insured and
    still read back as ``VERIFIED``. A caller that has genuinely already checked
    must pass an explicit ``lambda _p: []`` — the gate is never implicit.
    """
    if dup_search_fn is None:
        raise ValueError("dup_search_fn is required — creating without a duplicate check "
                         "can overwrite an existing insured (create_insured upserts by name)")

    payload, unsupported = build_insured_payload(sub)

    dups = dup_search_fn(payload) or []
    if dups:
        return {
            "status": STATUS_DUPLICATE,
            "duplicates": dups,
            "sent": payload,
            "unsupported_fields": unsupported,
        }

    created = create_fn(payload)
    guid = _extract_guid(created)
    # The create may have committed even if the read-back fails (timeout / AMS read
    # down). Never propagate — report COMMITTED_UNVERIFIED so the caller doesn't
    # blindly retry an ambiguous write.
    readback_error: str | None = None
    after: dict[str, Any] | None = None
    if guid:
        try:
            after = read_fn(guid)
        except Exception as exc:  # noqa: BLE001 — a failed read must not lose the receipt
            readback_error = str(exc)
    verified, mismatched = verify_readback(payload, after)

    return {
        "status": STATUS_VERIFIED if verified else STATUS_UNVERIFIED,
        "nowcerts_guid": guid,
        "sent": payload,
        "read_back": after,
        "readback_error": readback_error,
        "mismatched": mismatched,
        "unsupported_fields": unsupported,
    }
