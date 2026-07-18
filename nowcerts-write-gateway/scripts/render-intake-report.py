#!/usr/bin/env python3
"""Render a completed intake bundle as an RSG Risk Assessment PDF.

Two audiences, one shape - the generated doc closely resembles the RSG Risk
Assessment Standard (the interactive builder template), adapted to the client's
actual need (which lines / fields are relevant):

  Section 1  Identification Header
  Section 2  Snapshot  (Business / Household + Property Profile + Loss History)
  Section 3  Exposure Checklist  (LOB modules)
  Section 4  Risk Management Practices
  Section 5  Findings & Recommendations
  Section 6  Risk Score            (internal only - never client-facing)
  Appendix   Evidence & AMS Routing (internal only)

The bundle contract is unchanged; sections the pipeline has not populated yet
degrade to "Not provided" or are omitted, so this stays forward-compatible with
personal-lines and property fields as they come online.
"""
import json
import html
import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    Image,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

GREEN = colors.HexColor("#14314F")
GOLD = colors.HexColor("#E6A936")
PALE = colors.HexColor("#F1F4F7")
MUTED = colors.HexColor("#66798B")
LINE = colors.HexColor("#D5DCE3")
GOLDBG = colors.HexColor("#FFF8E2")


def safe(value, fallback="Not provided"):
    if value is None or value == "" or value == []:
        return fallback
    if isinstance(value, list):
        value = ", ".join(str(item) for item in value)
    return html.escape(str(value))


def as_list(value):
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return [item for item in value if item is not None and item != ""]
    return [value]


def assessment_only_map(bundle):
    """Index routing.assessment_only by lowercased field name for snapshot pulls."""
    result = {}
    for item in (bundle.get("routing", {}) or {}).get("assessment_only", []) or []:
        key = str(item.get("field", "")).strip().lower()
        if key:
            result[key] = item.get("value")
    return result


def lines_of_business(bundle):
    assessment = bundle.get("assessment", {}) or {}
    explicit = as_list(bundle.get("lines_of_business")) or as_list(assessment.get("lines_of_business"))
    if explicit:
        return explicit
    # Infer: classification/operations data means commercial; household means personal.
    if assessment.get("household") or assessment.get("household_snapshot"):
        return ["Personal Lines"]
    return ["Commercial Lines"]


def is_commercial(bundle):
    return any("commercial" in str(lob).lower() for lob in lines_of_business(bundle))


def on_page(canvas, doc):
    canvas.saveState()
    width, height = LETTER
    canvas.setFillColor(GREEN)
    canvas.rect(0, height - 0.42 * inch, width, 0.42 * inch, fill=1, stroke=0)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawString(0.6 * inch, height - 0.27 * inch, "RISK SOLUTIONS GROUP - RISK ASSESSMENT - INTERNAL / AGENCY FILE")
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 8)
    canvas.drawString(0.6 * inch, 0.35 * inch, "Evidence-backed intake and risk assessment - Never send to client")
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawRightString(width - 0.6 * inch, 0.35 * inch, f"Page {doc.page}")
    canvas.restoreState()


def section(story, number, title, styles):
    story.append(Spacer(1, 0.13 * inch))
    label = f"SECTION {number}" if number else ""
    story.append(Paragraph(f"<font color='#66798B' size=8>{label}</font>  {html.escape(title)}", styles["Section"]))
    story.append(Spacer(1, 0.05 * inch))


def sub(story, title, styles):
    story.append(Paragraph(title, styles["SubHead"]))


def bullet_rows(items, styles, empty="None identified"):
    values = items or [empty]
    return [Paragraph(f"- {safe(item)}", styles["BodySmall"]) for item in values]


def kv_table(rows, doc, styles):
    """Two-column label/value snapshot table. rows = [(label, value), ...]."""
    data = []
    for label, value in rows:
        data.append([Paragraph(html.escape(str(label)), styles["CellHead2"]), Paragraph(safe(value), styles["Cell"])])
    table = Table(data, colWidths=[1.9 * inch, doc.width - 1.9 * inch])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), PALE),
        ("GRID", (0, 0), (-1, -1), 0.35, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def heading_table(header, body_rows, col_widths, styles, empty_row=None):
    rows = [[Paragraph(h, styles["CellHead"]) for h in header]]
    for r in body_rows:
        rows.append([Paragraph(safe(c), styles["Cell"]) if not hasattr(c, "wrapOn") else c for c in r])
    if len(rows) == 1 and empty_row is not None:
        rows.append([Paragraph(empty_row, styles["Cell"])] + [Paragraph("", styles["Cell"]) for _ in header[1:]])
    table = Table(rows, colWidths=col_widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), GREEN),
        ("GRID", (0, 0), (-1, -1), 0.35, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PALE]),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def internal_styles():
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="TitleRSG", parent=styles["Title"], fontName="Times-Bold", fontSize=22, leading=25, textColor=GREEN, spaceAfter=2, alignment=0))
    styles.add(ParagraphStyle(name="Subtitle", parent=styles["Normal"], fontSize=9, leading=13, textColor=MUTED, spaceAfter=10))
    styles.add(ParagraphStyle(name="Section", parent=styles["Heading2"], fontName="Times-Bold", fontSize=13, leading=16, textColor=GREEN, spaceBefore=4, spaceAfter=2))
    styles.add(ParagraphStyle(name="SubHead", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=9, leading=12, textColor=colors.HexColor("#26332E"), spaceBefore=6, spaceAfter=3))
    styles.add(ParagraphStyle(name="BodySmall", parent=styles["BodyText"], fontSize=8.5, leading=12, textColor=colors.HexColor("#26332E")))
    styles.add(ParagraphStyle(name="Cell", parent=styles["BodyText"], fontSize=7.5, leading=10))
    styles.add(ParagraphStyle(name="CellSm", parent=styles["BodyText"], fontSize=6.6, leading=8.5))
    styles.add(ParagraphStyle(name="CellHead", parent=styles["BodyText"], fontName="Helvetica-Bold", fontSize=7.5, leading=9, textColor=colors.white))
    styles.add(ParagraphStyle(name="CellHeadSm", parent=styles["BodyText"], fontName="Helvetica-Bold", fontSize=6.4, leading=8, textColor=colors.white))
    styles.add(ParagraphStyle(name="CellHead2", parent=styles["BodyText"], fontName="Helvetica-Bold", fontSize=7.5, leading=9.5, textColor=GREEN))
    styles.add(ParagraphStyle(name="Right", parent=styles["BodySmall"], alignment=TA_RIGHT))
    return styles


def build_report(bundle, destination):
    assessment = bundle.get("assessment", {}) or {}
    if assessment.get("status") != "COMPLETE":
        raise ValueError("Risk assessment must be COMPLETE before the retained PDF is generated.")

    styles = internal_styles()
    client = bundle.get("client", {}) or {}
    routing = bundle.get("routing", {}) or {}
    only = assessment_only_map(bundle)
    commercial = is_commercial(bundle)

    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    doc = BaseDocTemplate(
        str(destination),
        pagesize=LETTER,
        rightMargin=0.58 * inch, leftMargin=0.58 * inch,
        topMargin=0.68 * inch, bottomMargin=0.62 * inch,
        title=f"{safe(client.get('display_name'), 'Client')} - Risk Assessment",
        author="Risk Solutions Group",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
    doc.addPageTemplates([PageTemplate(id="rsg", frames=[frame], onPage=on_page)])

    story = []
    logo_path = Path(__file__).resolve().parent.parent / "web" / "assets" / "rsg-logo.jpg"
    if logo_path.exists():
        logo = Image(str(logo_path), width=1.35 * inch, height=1.16 * inch)
        logo.hAlign = "LEFT"
        story.append(logo)
        story.append(Spacer(1, 0.02 * inch))
    story.append(Paragraph("Risk Assessment", styles["TitleRSG"]))
    story.append(Paragraph("<b>INTERNAL - AGENCY FILE ONLY &nbsp;&middot;&nbsp; NEVER SEND TO CLIENT</b>", styles["Subtitle"]))

    # --- Section 1 - Identification Header ---
    section(story, 1, "Identification Header", styles)
    story.append(kv_table([
        ("Client / Prospect", client.get("display_name")),
        ("Date prepared", bundle.get("created_at")),
        ("Prepared by", "Risk Solutions Group - Hermes intake gateway"),
        ("Lines assessed", ", ".join(lines_of_business(bundle))),
        ("Current carrier(s)", only.get("current carrier") or only.get("current carriers")),
        ("Client status", "Existing client" if client.get("existing_client_id") else "New prospect"),
        ("Intake ID", bundle.get("intake_id")),
        ("Review status", assessment.get("review_status") or "Needs Review"),
    ], doc, styles))

    # --- Section 2 - Snapshot ---
    section(story, 2, "Snapshot", styles)
    if commercial:
        sub(story, "Business Snapshot", styles)
        story.append(kv_table([
            ("NAICS", ", ".join(as_list(assessment.get("naics")))),
            ("SIC", ", ".join(as_list(assessment.get("sic")))),
            ("Annual revenue", only.get("annual revenue")),
            ("Estimated payroll", only.get("estimated payroll")),
            ("Employee count", only.get("employee count")),
            ("Operations", only.get("operations summary") or only.get("operations narrative")),
        ], doc, styles))
    else:
        sub(story, "Household Snapshot", styles)
        household = assessment.get("household") or {}
        story.append(kv_table([
            ("Named insured", household.get("named_insured") or client.get("display_name")),
            ("Co-applicant", household.get("co_applicant")),
            ("Prior carrier", household.get("prior_carrier") or only.get("prior carrier")),
            ("Prior liability limit", household.get("prior_liability_limit")),
            ("Continuous coverage", household.get("continuous_coverage")),
            ("Umbrella in force", household.get("umbrella")),
        ], doc, styles))

    # Property / Location Profile (any property - PL or CL) - render when present.
    properties = as_list(bundle.get("property_profile")) or as_list(assessment.get("properties"))
    if properties:
        sub(story, "Property / Location Profile", styles)
        header = ["Location / Address", "Yr Built", "Sq Ft", "Construction", "Roof", "Prot. Cl.", "Flood", "Est. Repl. Cost"]
        rows = []
        for p in properties:
            rows.append([
                Paragraph(safe(p.get("address")), styles["CellSm"]),
                Paragraph(safe(p.get("year_built"), ""), styles["CellSm"]),
                Paragraph(safe(p.get("square_feet"), ""), styles["CellSm"]),
                Paragraph(safe(p.get("construction"), ""), styles["CellSm"]),
                Paragraph(safe(p.get("roof"), ""), styles["CellSm"]),
                Paragraph(safe(p.get("protection_class"), ""), styles["CellSm"]),
                Paragraph(safe(p.get("flood_zone"), ""), styles["CellSm"]),
                Paragraph(safe(p.get("replacement_cost"), ""), styles["CellSm"]),
            ])
        widths = [2.02 * inch, 0.55 * inch, 0.55 * inch, 0.95 * inch, 0.8 * inch, 0.62 * inch, 0.55 * inch, 0.9 * inch]
        head = [[Paragraph(h, styles["CellHeadSm"]) for h in header]]
        table = Table(head + rows, colWidths=widths, repeatRows=1)
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), GREEN),
            ("BACKGROUND", (7, 0), (7, 0), colors.HexColor("#8A6D00")),
            ("GRID", (0, 0), (-1, -1), 0.35, LINE),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PALE]),
            ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
        story.append(table)
        story.append(Paragraph("<font size=7 color='#66798B'>Replacement cost &amp; building data sourced online (RC estimator / ISO PPC / FEMA).</font>", styles["BodySmall"]))

    # Prior claims - 3-year loss history.
    sub(story, "Prior Claims - 3-Year Loss History", styles)
    loss_history = as_list(assessment.get("loss_history"))
    if loss_history:
        rows = [[l.get("date"), l.get("line"), l.get("description"), l.get("amount_paid"), l.get("status")] for l in loss_history]
        story.append(heading_table(
            ["Date", "Line", "Description", "Amount Paid", "Status"],
            rows, [0.95 * inch, 1.05 * inch, 3.14 * inch, 1.1 * inch, 1.0 * inch], styles,
        ))
    else:
        story.append(Paragraph("No prior-claims / loss-run data captured. Request 3-5 year loss runs before binding.", styles["BodySmall"]))

    # --- Section 3 - Exposure Checklist ---
    section(story, 3, "Exposure Checklist", styles)
    operations = assessment.get("operations", []) or []
    if operations:
        sub(story, "Operations &amp; Classification", styles)
        rows = [[op.get("name"), op.get("naics"), op.get("gl_codes"), op.get("wc_codes"), op.get("evidence")] for op in operations]
        story.append(heading_table(
            ["Operation", "NAICS", "GL", "WC", "Evidence"],
            rows, [1.35 * inch, 0.9 * inch, 0.75 * inch, 0.75 * inch, 2.49 * inch], styles,
            empty_row="INSUFFICIENT EVIDENCE",
        ))
    sub(story, "Coverage Requirements", styles)
    story.extend(bullet_rows(as_list(assessment.get("coverage_requirements")), styles, empty="INSUFFICIENT EVIDENCE"))
    sub(story, "Key Endorsements", styles)
    story.extend(bullet_rows(as_list(assessment.get("endorsements")), styles))

    # --- Section 4 - Risk Management Practices ---
    section(story, 4, "Risk Management Practices", styles)
    sub(story, "Favorable Factors", styles)
    story.extend(bullet_rows(as_list(assessment.get("favorable_factors")), styles, empty="None noted"))
    practices = only.get("risk management") or only.get("safety program")
    if practices:
        story.append(Paragraph(safe(practices), styles["BodySmall"]))

    # --- Section 5 - Findings & Recommendations ---
    section(story, 5, "Findings & Recommendations", styles)
    sub(story, "Coverage Gaps / Red Flags", styles)
    story.extend(bullet_rows(as_list(assessment.get("red_flags")), styles, empty="None identified"))
    sub(story, "Missing Items", styles)
    story.extend(bullet_rows(as_list(assessment.get("missing_items")) or as_list(routing.get("missing_items")), styles, empty="None outstanding"))
    carrier_strategy = assessment.get("carrier_strategy") or only.get("carrier strategy")
    if carrier_strategy:
        sub(story, "Carrier Strategy (internal only)", styles)
        story.append(Paragraph(safe(carrier_strategy), styles["BodySmall"]))

    # --- Section 6 - Risk Score (internal only) ---
    section(story, 6, "Risk Score  -  INTERNAL ONLY", styles)
    scores = assessment.get("scores") or {}
    if commercial:
        categories = ["Loss History", "Exposure Severity", "Risk Management Maturity", "Coverage Adequacy", "Account Profitability Potential"]
    else:
        categories = ["Loss / Claims History", "Coverage Adequacy", "Household Stability / Retention Likelihood", "Monoline -> Multiline Upside", "Household Lifetime Value"]
    rows = [[Paragraph(c, styles["Cell"]), Paragraph(str(scores.get(c)) + " / 5" if scores.get(c) else "___ / 5", styles["Cell"])] for c in categories]
    numeric = [scores.get(c) for c in categories if isinstance(scores.get(c), (int, float))]
    overall = f"{sum(numeric) / len(numeric):.1f} / 5" if len(numeric) == len(categories) else "___ / 5"
    rows.append([Paragraph("<b>Overall Retention Risk</b>", styles["Cell"]), Paragraph(f"<b>{overall}</b>", styles["Cell"])])
    conf = assessment.get("confidence")
    rows.append([Paragraph("AI extraction confidence", styles["Cell"]), Paragraph(f"{conf}%" if conf is not None else "Not scored", styles["Cell"])])
    score_table = Table(rows, colWidths=[doc.width - 1.6 * inch, 1.6 * inch])
    score_table.setStyle(TableStyle([
        ("BACKGROUND", (0, -2), (-1, -2), PALE),
        ("GRID", (0, 0), (-1, -1), 0.35, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (1, 0), (1, -1), "CENTER"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(score_table)
    bottom_line = assessment.get("bottom_line") or only.get("bottom line")
    if bottom_line:
        sub(story, "Bottom Line - is this worth pursuing, and why?", styles)
        story.append(Paragraph(safe(bottom_line), styles["BodySmall"]))

    # --- Appendix - Evidence & AMS Routing (internal only) ---
    section(story, None, "Appendix - Evidence & AMS Routing", styles)
    sub(story, "Source Inventory", styles)
    src_rows = [[s.get("source_id"), str(s.get("kind", "")).replace("_", " ").title(), s.get("reference"), s.get("captured_at")] for s in bundle.get("source_index", []) or []]
    story.append(heading_table(
        ["ID", "Type", "Source", "Captured"],
        src_rows, [0.7 * inch, 0.95 * inch, 3.64 * inch, 1.45 * inch], styles, empty_row="No sources",
    ))
    sub(story, "AMS Routing Preview", styles)
    ams_rows = [[i.get("field"), i.get("value"), i.get("citation")] for i in routing.get("ams_fields", []) or []]
    story.append(heading_table(
        ["Entity / field", "Proposed value", "Source"],
        ams_rows, [1.8 * inch, 2.44 * inch, 2.5 * inch], styles, empty_row="No AMS fields approved",
    ))
    sub(story, "Assessment-Only Information Retained in This PDF", styles)
    ao = routing.get("assessment_only", []) or [{"field": "None", "value": "No assessment-only facts identified."}]
    for item in ao:
        story.append(Paragraph(f"<b>{safe(item.get('field'))}:</b> {safe(item.get('value'))} <font color='#66716C'>({safe(item.get('citation'), 'source pending')})</font>", styles["BodySmall"]))
    sub(story, "Evidence Map", styles)
    ev_rows = [[i.get("source"), i.get("reference"), i.get("fact")] for i in assessment.get("evidence_map", []) or []]
    story.append(heading_table(
        ["Source", "Reference", "Fact supported"],
        ev_rows, [1.7 * inch, 1.35 * inch, 3.69 * inch], styles, empty_row="INSUFFICIENT EVIDENCE",
    ))

    story.append(Spacer(1, 0.15 * inch))
    story.append(Paragraph("This report classifies and flags evidence for human review. It does not make an underwriting decision. AMS changes require a separate NowCerts preview and explicit confirmation.", styles["Subtitle"]))
    doc.build(story)


def rich(value, fallback=""):
    text = safe(value, fallback)
    return text.replace("\n", "<br/>") if text else text


def on_client_page(canvas, doc):
    canvas.saveState()
    width, height = LETTER
    canvas.setFillColor(GOLD)
    canvas.rect(0, height - 0.16 * inch, width, 0.16 * inch, fill=1, stroke=0)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 8)
    canvas.drawString(0.75 * inch, 0.45 * inch, "Risk Solutions Group  -  Insurance Review & Recommendations")
    canvas.drawRightString(width - 0.75 * inch, 0.45 * inch, f"Page {doc.page}")
    canvas.restoreState()


def build_client_report(bundle, destination):
    """Clean, client-presentable version - the same Risk Assessment family, but
    deliberately omits internal mechanics: intake IDs, AMS routing, evidence map,
    source inventory, AI confidence, red flags, Section 6 scoring, and warnings.
    Findings are reframed as protection opportunities, never a sales pitch."""
    client = bundle.get("client", {}) or {}
    assessment = bundle.get("assessment", {}) or {}
    if assessment.get("status") != "COMPLETE":
        raise ValueError("Risk assessment must be COMPLETE before the client report is generated.")

    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="CTitle", parent=styles["Title"], fontName="Times-Bold", fontSize=24, leading=28, textColor=GREEN, spaceAfter=2))
    styles.add(ParagraphStyle(name="CSubtitle", parent=styles["Normal"], fontSize=11, leading=15, textColor=MUTED))
    styles.add(ParagraphStyle(name="CSection", parent=styles["Heading2"], fontName="Times-Bold", fontSize=14.5, leading=18, textColor=GREEN, spaceBefore=17, spaceAfter=6))
    styles.add(ParagraphStyle(name="CBody", parent=styles["BodyText"], fontSize=10.5, leading=15.5, textColor=colors.HexColor("#243038"), spaceAfter=7))
    styles.add(ParagraphStyle(name="CBullet", parent=styles["BodyText"], fontSize=10.5, leading=15, leftIndent=16, bulletIndent=3, textColor=colors.HexColor("#243038"), spaceAfter=4))

    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    doc = BaseDocTemplate(
        str(destination),
        pagesize=LETTER,
        rightMargin=0.75 * inch, leftMargin=0.75 * inch,
        topMargin=0.72 * inch, bottomMargin=0.75 * inch,
        title=f"{safe(client.get('display_name'), 'Client')} - Insurance Review",
        author="Risk Solutions Group",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
    doc.addPageTemplates([PageTemplate(id="client", frames=[frame], onPage=on_client_page)])

    commercial = is_commercial(bundle)
    story = []
    logo_path = Path(__file__).resolve().parent.parent / "web" / "assets" / "rsg-logo.jpg"
    if logo_path.exists():
        logo = Image(str(logo_path), width=1.7 * inch, height=1.46 * inch)
        logo.hAlign = "LEFT"
        story.append(logo)
        story.append(Spacer(1, 0.08 * inch))
    story.append(Paragraph(safe(client.get("display_name")), styles["CTitle"]))
    story.append(Paragraph("Risk Assessment &amp; Coverage Recommendations", styles["CSubtitle"]))
    story.append(Paragraph("Prepared by Risk Solutions Group", styles["CSubtitle"]))
    story.append(Spacer(1, 0.22 * inch))

    intro_subject = "your business" if commercial else "your household"
    story.append(Paragraph(
        f"Thank you for the opportunity to review {intro_subject}. Based on the information you provided, "
        "the following summarizes our understanding and the coverages we recommend for your consideration.",
        styles["CBody"],
    ))

    summary = assessment.get("summary")
    if summary and summary != "INSUFFICIENT EVIDENCE":
        story.append(Paragraph("Your Business at a Glance" if commercial else "Your Household at a Glance", styles["CSection"]))
        story.append(Paragraph(rich(summary), styles["CBody"]))

    operations = [op.get("name") for op in assessment.get("operations", []) if op.get("name")]
    if operations:
        story.append(Paragraph("What We Reviewed", styles["CSection"]))
        for name in operations:
            story.append(Paragraph(safe(name), styles["CBullet"], bulletText="•"))

    coverages = [item for item in as_list(assessment.get("coverage_requirements")) if item]
    if coverages:
        story.append(Paragraph("Recommended Coverages", styles["CSection"]))
        for item in coverages:
            story.append(Paragraph(safe(item), styles["CBullet"], bulletText="•"))

    favorable = [item for item in as_list(assessment.get("favorable_factors")) if item]
    if favorable:
        story.append(Paragraph("Strengths We Noted", styles["CSection"]))
        for item in favorable:
            story.append(Paragraph(safe(item), styles["CBullet"], bulletText="•"))

    story.append(Paragraph("Next Steps", styles["CSection"]))
    story.append(Paragraph(
        "We would welcome the chance to review these recommendations with you, answer any questions, "
        "and tailor coverage to your needs. Please reach out at your convenience and we will take it from there.",
        styles["CBody"],
    ))

    doc.build(story)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Usage: render-intake-report.py OUTPUT.pdf [audience]")
    audience = sys.argv[2] if len(sys.argv) > 2 else "internal"
    payload = json.load(sys.stdin)
    if audience == "client":
        build_client_report(payload, sys.argv[1])
    else:
        build_report(payload, sys.argv[1])
