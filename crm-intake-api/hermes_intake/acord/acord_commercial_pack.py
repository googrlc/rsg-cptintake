"""Commercial ACORD pack — fill the combined 125/126 template in one pass.

At RSG the ACORD 125 (application) and 126 (general liability) are one template.
This composes both sections' field maps from a single ``SubmissionObject`` and
fills the shared PDF once, so a reviewer gets a single 125/126 draft rather than
two half-filled copies. ACORD 140 (property) is a separate template and stays in
``acord140`` — ``draft_pack`` can drive it too when a 140 template is supplied.

Design stays consistent with the individual fillers: pure map composition, then
one injected ``fill_pdf``; never auto-sends; each draft is agent_id-stamped.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from hermes_intake.acord import acord125, acord126, acord140, acord_pdf


def combined_field_map(
    sub: Any, *, selected_lobs: list[str] | None = None
) -> tuple[dict[str, str], dict[str, str]]:
    """(text_values, checkbox_values) for the combined 125/126 template.

    125 (the applicant hub) always fills, with every selected line's LOB box
    checked. The 126 GL section is added only when GL is among the selected lines
    — filling GL limits on a submission that isn't marketing GL would be wrong.
    ``selected_lobs`` defaults to the submission's single ``lob`` (pre-selection).
    Shared identity fields resolve to the same AcroForm name/value, so the merge
    is a no-op on those.
    """
    a125 = acord125.from_submission(sub)
    lobs = selected_lobs if selected_lobs is not None else ([a125.lob_key] if a125.lob_key else [])
    # Apply the documented HERMES_ACORD125/126_FIELDMAP overrides so a different
    # licensed template revision reconciles in the on-demand path too, not only in
    # the draft_* helpers.
    ov125 = acord_pdf.load_fieldmap_override(acord125.FIELDMAP_ENV)
    text = dict(acord125.build_field_map(a125, ov125))
    checks = dict(acord125.build_checkbox_map(a125, selected_lobs=lobs))
    if "commercial_gl" in lobs:
        a126 = acord126.from_submission(sub)
        ov126 = acord_pdf.load_fieldmap_override(acord126.FIELDMAP_ENV)
        text.update(acord126.build_field_map(a126, ov126))
        checks.update(acord126.build_checkbox_map(a126))
    return text, checks


def draft_pack(
    sub: Any,
    *,
    template_125_126: str,
    output_path: str,
    account_name: Optional[str] = None,
    template_140: Optional[str] = None,
    output_path_140: Optional[str] = None,
    file_upload: Optional[Callable[[str], str]] = None,
    slack_post: Optional[Callable[[str], None]] = None,
    supa_log: Optional[Callable[[dict[str, Any]], None]] = None,
) -> dict[str, Any]:
    """Fill the combined 125/126 (and optionally a 140) for one submission.

    Returns ``{"acord_125_126": <summary>, "acord_140": <summary|None>}``. Every
    side effect is injected; nothing is auto-sent. When ``template_140`` is given
    (with ``output_path_140``), the first property location is drafted too.
    """
    account = account_name or (sub.client_name or getattr(sub.applicant, "legal_name", "") or "")
    text, checks = combined_field_map(sub)
    fill = acord_pdf.fill_pdf(template_125_126, text, output_path,
                             checkboxes=checks, form_label="ACORD 125/126")

    if slack_post:
        msg = acord125.pre_send_checklist(acord125.from_submission(sub))
        slack_post(msg)

    summary_125_126 = {
        "account": account,
        "output_path": output_path,
        "placed_fields": fill["placed"],
        "skipped_fields": fill["skipped"],
        "auto_sent": False,
    }
    if supa_log:
        summary_125_126["file_url"] = file_upload(output_path) if file_upload else None
        supa_log({**summary_125_126, "form": "ACORD 125/126"})

    result: dict[str, Any] = {"acord_125_126": summary_125_126, "acord_140": None}

    if template_140 and output_path_140 and (sub.property_locations or []):
        a140 = acord140.from_submission(sub)
        result["acord_140"] = acord140.draft_acord140(
            a140, template_path=template_140, output_path=output_path_140,
            account_name=account, file_upload=file_upload, slack_post=slack_post,
            supa_log=supa_log,
        )
    return result
