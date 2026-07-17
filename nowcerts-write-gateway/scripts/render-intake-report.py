#!/usr/bin/env python3
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


def safe(value, fallback="Not provided"):
    if value is None or value == "" or value == []:
        return fallback
    if isinstance(value, list):
        value = ", ".join(str(item) for item in value)
    return html.escape(str(value))


def on_page(canvas, doc):
    canvas.saveState()
    width, height = LETTER
    canvas.setFillColor(GREEN)
    canvas.rect(0, height - 0.42 * inch, width, 0.42 * inch, fill=1, stroke=0)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawString(0.6 * inch, height - 0.27 * inch, "RISK SOLUTIONS GROUP - CLIENT INTAKE GATE")
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 8)
    canvas.drawString(0.6 * inch, 0.35 * inch, "Evidence-backed intake and risk assessment")
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawRightString(width - 0.6 * inch, 0.35 * inch, f"Page {doc.page}")
    canvas.restoreState()


def section(story, title, styles):
    story.append(Spacer(1, 0.12 * inch))
    story.append(Paragraph(title, styles["Section"]))
    story.append(Spacer(1, 0.05 * inch))


def bullet_rows(items, styles):
    values = items or ["None identified"]
    return [Paragraph(f"- {safe(item)}", styles["BodySmall"]) for item in values]


def build_report(bundle, destination):
    assessment = bundle.get("assessment", {})
    if assessment.get("status") != "COMPLETE":
        raise ValueError("Risk assessment must be COMPLETE before the retained PDF is generated.")

    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="TitleRSG", parent=styles["Title"], fontName="Times-Bold", fontSize=22, leading=25, textColor=GREEN, spaceAfter=6))
    styles.add(ParagraphStyle(name="Subtitle", parent=styles["Normal"], fontSize=9, leading=13, textColor=MUTED, spaceAfter=12))
    styles.add(ParagraphStyle(name="Section", parent=styles["Heading2"], fontName="Times-Bold", fontSize=13, leading=16, textColor=GREEN, borderColor=GOLD, borderWidth=0, borderPadding=0))
    styles.add(ParagraphStyle(name="BodySmall", parent=styles["BodyText"], fontSize=8.5, leading=12, textColor=colors.HexColor("#26332E")))
    styles.add(ParagraphStyle(name="Cell", parent=styles["BodyText"], fontSize=7.5, leading=10))
    styles.add(ParagraphStyle(name="CellHead", parent=styles["BodyText"], fontName="Helvetica-Bold", fontSize=7.5, leading=9, textColor=colors.white))
    styles.add(ParagraphStyle(name="Right", parent=styles["BodySmall"], alignment=TA_RIGHT))

    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    doc = BaseDocTemplate(
        str(destination),
        pagesize=LETTER,
        rightMargin=0.58 * inch,
        leftMargin=0.58 * inch,
        topMargin=0.68 * inch,
        bottomMargin=0.62 * inch,
        title=f"{bundle['client']['display_name']} - Risk Assessment",
        author="Risk Solutions Group",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
    doc.addPageTemplates([PageTemplate(id="rsg", frames=[frame], onPage=on_page)])

    story = []
    client = bundle.get("client", {})
    logo_path = Path(__file__).resolve().parent.parent / "web" / "assets" / "rsg-logo.jpg"
    if logo_path.exists():
        logo = Image(str(logo_path), width=1.45 * inch, height=1.25 * inch)
        logo.hAlign = "LEFT"
        story.append(logo)
        story.append(Spacer(1, 0.03 * inch))
    story.append(Paragraph(safe(client.get("display_name")), styles["TitleRSG"]))
    story.append(Paragraph(f"Client intake and underwriting assessment | Intake {bundle.get('intake_id')} | Created {bundle.get('created_at')}", styles["Subtitle"]))

    summary_data = [
        [Paragraph("Client status", styles["CellHead"]), Paragraph("Assessment status", styles["CellHead"]), Paragraph("AI confidence", styles["CellHead"]), Paragraph("AMS operation", styles["CellHead"])],
        [Paragraph("Existing client" if client.get("existing_client_id") else "New prospect", styles["Cell"]), Paragraph(safe(assessment.get("review_status"), "Needs Review"), styles["Cell"]), Paragraph(f"{safe(assessment.get('confidence'), 'Not scored')}%" if assessment.get("confidence") is not None else "Not scored", styles["Cell"]), Paragraph(safe(client.get("intended_operation"), "Pending"), styles["Cell"])],
    ]
    table = Table(summary_data, colWidths=[doc.width / 4] * 4)
    table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), GREEN), ("BACKGROUND", (0, 1), (-1, 1), PALE), ("GRID", (0, 0), (-1, -1), 0.35, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7), ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
    story.append(table)

    section(story, "Underwriting Summary", styles)
    story.append(Paragraph(safe(assessment.get("summary"), "INSUFFICIENT EVIDENCE"), styles["BodySmall"]))

    section(story, "Source Inventory", styles)
    source_rows = [[Paragraph("ID", styles["CellHead"]), Paragraph("Type", styles["CellHead"]), Paragraph("Source", styles["CellHead"]), Paragraph("Captured", styles["CellHead"])]]
    for source in bundle.get("source_index", []):
        source_rows.append([Paragraph(safe(source.get("source_id")), styles["Cell"]), Paragraph(safe(source.get("kind")).replace("_", " ").title(), styles["Cell"]), Paragraph(safe(source.get("reference")), styles["Cell"]), Paragraph(safe(source.get("captured_at")), styles["Cell"])])
    source_table = Table(source_rows, colWidths=[0.65 * inch, 0.9 * inch, 3.75 * inch, 1.35 * inch], repeatRows=1)
    source_table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), GREEN), ("GRID", (0, 0), (-1, -1), 0.35, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PALE]), ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    story.append(source_table)

    section(story, "Operations and Classification", styles)
    class_rows = [[Paragraph("Operation", styles["CellHead"]), Paragraph("NAICS", styles["CellHead"]), Paragraph("GL", styles["CellHead"]), Paragraph("WC", styles["CellHead"]), Paragraph("Evidence", styles["CellHead"])]]
    for operation in assessment.get("operations", []):
        class_rows.append([Paragraph(safe(operation.get("name")), styles["Cell"]), Paragraph(safe(operation.get("naics")), styles["Cell"]), Paragraph(safe(operation.get("gl_codes")), styles["Cell"]), Paragraph(safe(operation.get("wc_codes")), styles["Cell"]), Paragraph(safe(operation.get("evidence")), styles["Cell"])])
    if len(class_rows) == 1:
        class_rows.append([Paragraph("INSUFFICIENT EVIDENCE", styles["Cell"]), "", "", "", ""])
    class_table = Table(class_rows, colWidths=[1.35 * inch, 0.9 * inch, 0.75 * inch, 0.75 * inch, 2.9 * inch], repeatRows=1)
    class_table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), GREEN), ("GRID", (0, 0), (-1, -1), 0.35, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    story.append(class_table)

    for title, key in [("Coverage Requirements", "coverage_requirements"), ("Key Endorsements", "endorsements"), ("Red Flags", "red_flags"), ("Favorable Factors", "favorable_factors"), ("Missing Items", "missing_items")]:
        section(story, title, styles)
        story.extend(bullet_rows(assessment.get(key), styles))

    section(story, "AMS Routing Preview", styles)
    ams_rows = [[Paragraph("Entity / field", styles["CellHead"]), Paragraph("Proposed value", styles["CellHead"]), Paragraph("Source", styles["CellHead"])]]
    for item in bundle.get("routing", {}).get("ams_fields", []):
        ams_rows.append([Paragraph(safe(item.get("field")), styles["Cell"]), Paragraph(safe(item.get("value")), styles["Cell"]), Paragraph(safe(item.get("citation")), styles["Cell"])])
    if len(ams_rows) == 1:
        ams_rows.append([Paragraph("No AMS fields approved", styles["Cell"]), "", ""])
    ams_table = Table(ams_rows, colWidths=[1.8 * inch, 2.2 * inch, 2.65 * inch], repeatRows=1)
    ams_table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), GREEN), ("GRID", (0, 0), (-1, -1), 0.35, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    story.append(ams_table)

    section(story, "Assessment-Only Information Retained in This PDF", styles)
    for item in bundle.get("routing", {}).get("assessment_only", []) or [{"field": "None", "value": "No assessment-only facts identified."}]:
        story.append(Paragraph(f"<b>{safe(item.get('field'))}:</b> {safe(item.get('value'))} <font color='#66716C'>({safe(item.get('citation'), 'source pending')})</font>", styles["BodySmall"]))

    section(story, "Evidence Map", styles)
    evidence_rows = [[Paragraph("Source", styles["CellHead"]), Paragraph("Reference", styles["CellHead"]), Paragraph("Fact supported", styles["CellHead"])]]
    for item in assessment.get("evidence_map", []):
        evidence_rows.append([Paragraph(safe(item.get("source")), styles["Cell"]), Paragraph(safe(item.get("reference")), styles["Cell"]), Paragraph(safe(item.get("fact")), styles["Cell"])])
    if len(evidence_rows) == 1:
        evidence_rows.append([Paragraph("INSUFFICIENT EVIDENCE", styles["Cell"]), "", ""])
    evidence_table = Table(evidence_rows, colWidths=[1.7 * inch, 1.35 * inch, 3.6 * inch], repeatRows=1)
    evidence_table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), GREEN), ("GRID", (0, 0), (-1, -1), 0.35, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PALE]), ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    story.append(evidence_table)

    story.append(Spacer(1, 0.15 * inch))
    story.append(Paragraph("This report classifies and flags evidence for human review. It does not make an underwriting decision. AMS changes require a separate NowCerts preview and explicit confirmation.", styles["Subtitle"]))
    doc.build(story)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: render-intake-report.py OUTPUT.pdf")
    payload = json.load(sys.stdin)
    build_report(payload, sys.argv[1])
