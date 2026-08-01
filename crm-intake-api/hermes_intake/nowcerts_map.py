"""Map an intake account into a NowCerts Insured (prospect) payload.

Uses the **connected NowCerts tool contract**, not raw ProspectType/InsuredType
keys:
    insuredType : "0" commercial, "1" personal   (string codes)
    type        : 0 insured,       1 prospect     (int codes)
Name/address fields are the connector's PascalCase common fields:
    CommercialName, FirstName, LastName, FEIN, AddressLine1, City, State, Zip,
    EMail, PhoneNumber.

Nothing here writes — it only builds the payload for the approval-gated intake
executor. The lead temperature (Hot/Cold) is kept on the Supabase opportunities
row (``prospect_type``), not sent to NowCerts.
"""

from __future__ import annotations

from typing import Any

from hermes_core.opportunities import INSURED_TYPES, PROSPECT_TYPES

DEFAULT_PROSPECT_TYPE = "Prospect"

# NowCerts connector codes.
_INSURED_TYPE_CODE = {"Commercial": "0", "Personal": "1"}
TYPE_INSURED = 0
TYPE_PROSPECT = 1


def _first(account: dict[str, Any], *keys: str) -> Any:
    for k in keys:
        v = account.get(k)
        if v not in (None, ""):
            return v
    return None


def normalize_insured_type(value: Any) -> str | None:
    """Map a free segment label to Personal | Commercial, else None."""
    s = str(value or "").strip().lower()
    if not s:
        return None
    if s in ("personal", "personal lines", "pl", "home", "auto"):
        return "Personal"
    if s in ("commercial", "commercial lines", "cl", "business", "group benefits", "benefits", "medicare", "life"):
        return "Commercial"
    if value in INSURED_TYPES:
        return value  # already canonical
    return None


def insured_type_code(value: Any) -> str | None:
    """Personal|Commercial (or a segment label) -> connector code '1'|'0', else None."""
    label = normalize_insured_type(value)
    return _INSURED_TYPE_CODE.get(label) if label else None


def normalize_prospect_type(value: Any) -> str:
    """Lead temperature -> Supabase prospect_type (Hot/Cold/Prospect); default 'Prospect'.

    Used for the opportunities pipeline row; NOT sent to NowCerts.
    """
    s = str(value or "").strip().lower().replace(" ", "_")
    mapping = {
        "hot": "Hot_Prospect", "hot_prospect": "Hot_Prospect", "warm": "Hot_Prospect",
        "cold": "Cold_Prospect", "cold_prospect": "Cold_Prospect",
        "prospect": "Prospect",
    }
    result = mapping.get(s, DEFAULT_PROSPECT_TYPE)
    return result if result in PROSPECT_TYPES else DEFAULT_PROSPECT_TYPE


def map_to_insured(
    account: dict[str, Any],
    *,
    insured_type: str | None = None,
    is_prospect: bool = True,
) -> dict[str, Any]:
    """Build a NowCerts Insured Insert payload from an intake account (connector contract)."""
    itype_label = normalize_insured_type(insured_type) or normalize_insured_type(
        _first(account, "insured_type", "segment", "type")
    )

    name = _first(account, "commercial_name", "account_name", "name")
    first = _first(account, "first_name", "firstName", "primary_first_name")
    last = _first(account, "last_name", "lastName", "primary_last_name")

    payload: dict[str, Any] = {
        "FEIN": _first(account, "fein", "ein", "FEIN"),
        "AddressLine1": _first(account, "address_line1", "address", "street", "AddressLine1"),
        "City": _first(account, "city", "City"),
        "State": _first(account, "state", "State"),
        "Zip": _first(account, "zip", "zip_code", "postal_code", "ZipCode", "Zip"),
        "EMail": _first(account, "email", "eMail", "email_address"),
        "PhoneNumber": _first(account, "phone", "cell_phone", "mobile", "phoneNumber"),
        # Connector codes (not raw ProspectType/InsuredType keys).
        "type": TYPE_PROSPECT if is_prospect else TYPE_INSURED,
    }
    code = _INSURED_TYPE_CODE.get(itype_label) if itype_label else None
    if code is not None:
        payload["insuredType"] = code

    # Personal => First/Last; else CommercialName.
    if itype_label == "Personal" and (first or last):
        payload["FirstName"] = first
        payload["LastName"] = last
    else:
        payload["CommercialName"] = name or (f"{first or ''} {last or ''}".strip() or None)
        if first:
            payload["FirstName"] = first
        if last:
            payload["LastName"] = last

    # Drop blanks (but keep type=0, which is a valid code, not "empty").
    return {k: v for k, v in payload.items() if v not in (None, "")}
