"""Shared ACORD PDF I/O — the licensed-template layer for the form fillers.

The logical core of each form (``from_submission`` → ``build_field_map``) is pure
and unit-tested with no I/O. This module is the *other* half: turning a
``{pdf_field_name: value}`` map into a filled PDF against RSG's **licensed** ACORD
template. ACORD forms are copyrighted — pull ours from NowCerts / agency files;
never download a random copy.

``acord25.py`` predates this helper and keeps its own copy of these functions;
new fillers (125, 126, …) share this one so the PDF plumbing lives in one place.

Template field names vary by template source. Before first use of any form, run
``list_template_fields(<our template>)`` and reconcile the filler's ``FIELD_NAMES``
against it (override via the filler's ``field_names`` arg or its ``*_FIELDMAP``
env var). ``fill_pdf`` skips unknown fields and reports them rather than failing
silently, so a name mismatch degrades to a partially-filled draft instead of
nothing.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional

log = logging.getLogger(__name__)


def list_template_fields(template_path: str) -> list[str]:
    """Return the AcroForm field names in a PDF — use to reconcile FIELD_NAMES."""
    from pypdf import PdfReader

    reader = PdfReader(template_path)
    fields = reader.get_fields() or {}
    return sorted(fields.keys())


def load_fieldmap_override(env_var: str) -> dict[str, str]:
    """Optional FIELD_NAMES overrides from a json file named by ``env_var``.

    Lets a deployment reconcile field names against its own licensed template
    without a code change. An unset var or an unreadable file degrades to no
    overrides (logged), never an exception.
    """
    path = os.environ.get(env_var, "").strip()
    if not path:
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        log.warning("%s=%s unreadable: %s", env_var, path, exc)
        return {}


def all_field_names(template_path: str) -> set[str]:
    """Every fillable field name in a template.

    ACORD PDFs nest widgets under a /Parent hierarchy, and ``get_fields`` only
    surfaces the AcroForm /Fields roots (on these templates, a small subset). The
    real, fully-qualified names come from walking each page's widget annotations
    and composing ``parent.child`` from the /T chain — the same names the fillers
    target.
    """
    from pypdf import PdfReader
    from pypdf.generic import IndirectObject

    def deref(o):
        return o.get_object() if isinstance(o, IndirectObject) else o

    def fqn(widget) -> str:
        parts: list[str] = []
        node, seen = widget, set()
        while node is not None and id(node) not in seen:
            seen.add(id(node))
            t = node.get("/T")
            if t:
                parts.append(str(t))
            node = deref(node.get("/Parent")) if node.get("/Parent") else None
        return ".".join(reversed(parts))

    reader = PdfReader(template_path)
    names: set[str] = set()
    for page in reader.pages:
        annots = deref(page.get("/Annots")) or []
        for a in annots:
            w = deref(a)
            if w.get("/Subtype") == "/Widget":
                name = fqn(w)
                if name:
                    names.add(name)
    return names


def fill_pdf(
    template_path: str,
    values: dict[str, str],
    output_path: str,
    *,
    checkboxes: Optional[dict[str, str]] = None,
    form_label: str = "ACORD",
) -> dict[str, Any]:
    """Fill an ACORD template and write a draft PDF.

    ``values`` are text fields; ``checkboxes`` map a field name to its on-state
    (e.g. ``"/1"``) for boolean/enum boxes. Returns ``{written, placed, skipped}``.
    Unknown field names are skipped (and reported) rather than raising — so a
    template-name mismatch degrades gracefully instead of producing nothing.
    ``form_label`` only tags the log line so a mismatch is attributable to the
    right form.
    """
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import NameObject

    checkboxes = checkboxes or {}
    reader = PdfReader(template_path)
    known = all_field_names(template_path)

    text_place = {k: v for k, v in values.items() if k in known}
    check_place = {k: NameObject(v) for k, v in checkboxes.items() if k in known}
    skipped = [k for k in (*values, *checkboxes) if k not in known]
    if skipped:
        log.warning(
            "%s fill: %d field(s) not in template, skipped: %s",
            form_label,
            len(skipped),
            skipped,
        )

    writer = PdfWriter()
    writer.append(reader)
    merged = {**text_place, **check_place}
    for page in writer.pages:
        writer.update_page_form_field_values(page, merged)
    # Ensure viewers render the filled values.
    try:
        writer.set_need_appearances_writer(True)
    except Exception:  # pragma: no cover - pypdf version differences
        pass
    with open(output_path, "wb") as fh:
        writer.write(fh)
    return {"written": output_path, "placed": sorted(merged), "skipped": skipped}
