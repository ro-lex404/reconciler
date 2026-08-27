from __future__ import annotations

import io
import os
from datetime import datetime
from typing import Any, Dict, List

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import HRFlowable, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

# Register Unicode TTF fonts to support Indian Rupee symbol (₹) cleanly in ReportLab
UNICODE_FONT = "Helvetica"
UNICODE_FONT_BOLD = "Helvetica-Bold"

for font_family, reg_path, bold_path in [
    ("SegoeUI", "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/segoeuib.ttf"),
    ("Arial", "C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
    ("DejaVuSans", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
]:
    if os.path.exists(reg_path):
        try:
            pdfmetrics.registerFont(TTFont(font_family, reg_path))
            if os.path.exists(bold_path):
                pdfmetrics.registerFont(TTFont(f"{font_family}-Bold", bold_path))
                pdfmetrics.registerFontFamily(font_family, normal=font_family, bold=f"{font_family}-Bold")
                UNICODE_FONT_BOLD = f"{font_family}-Bold"
            else:
                pdfmetrics.registerFontFamily(font_family, normal=font_family, bold=font_family)
                UNICODE_FONT_BOLD = font_family
            UNICODE_FONT = font_family
            break
        except Exception:
            pass

EXCEPTION_TYPE_LABELS = {
    "unmatched_pdf_invoice": "Invoice Unmatched",
    "missing_bank_entry": "Missing Bank Entry",
    "amount_mismatch": "Amount Mismatch",
    "date_mismatch": "Date Mismatch",
    "amount_and_date_mismatch": "Amount & Date Mismatch",
    "ghost_credit": "Ghost Credit",
}

DEFAULT_RECOMMENDED_ACTIONS = {
    "unmatched_pdf_invoice": "Invoice recorded in ledger but missing from bank settlement statement. Verify gateway payout clearance.",
    "missing_bank_entry": "Check bank portal for delayed NEFT settlement (T+1 window).",
    "amount_mismatch": "Verify GST rounding or gateway fee deduction with merchant.",
    "date_mismatch": "Check settlement clearance window / weekend date shift.",
    "amount_and_date_mismatch": "High variance in amount and date; flag for compliance audit.",
    "ghost_credit": "Flag for compliance review — bank credit entry with no corresponding Razorpay record.",
}


def generate_reconciliation_pdf_report(
    source_filename: str,
    extracted_count: int,
    matched_count: int,
    exception_count: int,
    exceptions: List[Dict[str, Any]],
    matches: List[Dict[str, Any]] | None = None,
    engine_name: str = "DuckDB SQL Vectorized Engine",
) -> bytes:
    """Generates a professional PDF audit report of faulty transactions using ReportLab."""
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=letter,
        rightMargin=36,
        leftMargin=36,
        topMargin=36,
        bottomMargin=36,
    )

    story = []
    styles = getSampleStyleSheet()

    # Custom styles using registered Unicode font
    title_style = ParagraphStyle(
        "ReportTitle",
        parent=styles["Heading1"],
        fontName=UNICODE_FONT_BOLD,
        fontSize=20,
        leading=24,
        textColor=colors.HexColor("#0F172A"),
    )

    subtitle_style = ParagraphStyle(
        "ReportSubtitle",
        parent=styles["Normal"],
        fontName=UNICODE_FONT,
        fontSize=10,
        leading=14,
        textColor=colors.HexColor("#475569"),
    )

    section_heading = ParagraphStyle(
        "SectionHeading",
        parent=styles["Heading2"],
        fontName=UNICODE_FONT_BOLD,
        fontSize=13,
        leading=17,
        textColor=colors.HexColor("#1E293B"),
        spaceBefore=12,
        spaceAfter=6,
    )

    cell_style = ParagraphStyle(
        "TableCell",
        parent=styles["Normal"],
        fontName=UNICODE_FONT,
        fontSize=8.5,
        leading=11,
        textColor=colors.HexColor("#1E293B"),
    )

    cell_bold = ParagraphStyle(
        "TableCellBold",
        parent=cell_style,
        fontName=UNICODE_FONT_BOLD,
    )

    cell_header = ParagraphStyle(
        "TableHeaderCell",
        parent=cell_style,
        fontName=UNICODE_FONT_BOLD,
        fontSize=8.5,
        textColor=colors.white,
    )

    cell_red = ParagraphStyle(
        "TableCellRed",
        parent=cell_style,
        fontName=UNICODE_FONT_BOLD,
        textColor=colors.HexColor("#991B1B"),
    )

    timestamp_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Header Title
    story.append(Paragraph("Razorpay Reconciliation Audit Report", title_style))
    story.append(Spacer(1, 4))
    story.append(Paragraph(f"Faulty Transactions & Discrepancy Breakdown | Generated: {timestamp_str}", subtitle_style))
    story.append(Spacer(1, 10))
    story.append(HRFlowable(width="100%", thickness=1.5, color=colors.HexColor("#2563EB"), spaceAfter=12))

    # Document Meta Table
    meta_data = [
        [
            Paragraph("<b>Source Document:</b>", cell_style),
            Paragraph(source_filename, cell_bold),
            Paragraph("<b>Generated Timestamp:</b>", cell_style),
            Paragraph(timestamp_str, cell_style),
        ],
        [
            Paragraph("<b>Reconciliation Engine:</b>", cell_style),
            Paragraph(f"<b>{engine_name}</b>", cell_style),
            Paragraph("<b>Audit Status:</b>", cell_style),
            Paragraph(f"<font color='#DC2626'><b>{exception_count} Faulty Exceptions Found</b></font>", cell_style),
        ],
    ]
    meta_table = Table(meta_data, colWidths=[120, 150, 130, 140])
    meta_table.setStyle(
        TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F8FAFC")),
            ("PADDING", (0, 0), (-1, -1), 6),
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#E2E8F0")),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ])
    )
    story.append(meta_table)
    story.append(Spacer(1, 14))

    # Summary Metrics Cards Table
    match_rate = round((matched_count / extracted_count * 100), 2) if extracted_count else 0.0
    summary_data = [
        [
            Paragraph("<b>TOTAL RECORDS</b>", cell_style),
            Paragraph("<b>RECONCILED MATCHES</b>", cell_style),
            Paragraph("<b>FAULTY EXCEPTIONS</b>", cell_style),
            Paragraph("<b>MATCH RATE</b>", cell_style),
        ],
        [
            Paragraph(f"<font size=13><b>{extracted_count}</b></font>", cell_style),
            Paragraph(f"<font size=13 color='#16A34A'><b>{matched_count}</b></font>", cell_style),
            Paragraph(f"<font size=13 color='#DC2626'><b>{exception_count}</b></font>", cell_style),
            Paragraph(f"<font size=13 color='#2563EB'><b>{match_rate}%</b></font>", cell_style),
        ],
    ]
    summary_table = Table(summary_data, colWidths=[135, 135, 135, 135])
    summary_table.setStyle(
        TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F5F9")),
            ("BACKGROUND", (0, 1), (-1, 1), colors.white),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("PADDING", (0, 0), (-1, -1), 7),
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#E2E8F0")),
        ])
    )
    story.append(summary_table)
    story.append(Spacer(1, 14))

    # Section Heading
    story.append(Paragraph(f"Faulty Transactions & Exception Audit Details ({len(exceptions)})", section_heading))
    story.append(Spacer(1, 6))

    if exceptions:
        # Table Headers
        table_rows = [
            [
                Paragraph("Ref ID", cell_header),
                Paragraph("Amount (INR)", cell_header),
                Paragraph("Date", cell_header),
                Paragraph("Exception Type", cell_header),
                Paragraph("Severity", cell_header),
                Paragraph("Recommended Resolution", cell_header),
            ]
        ]

        for exc in exceptions:
            ref = str(exc.get("invoice_ref") or exc.get("merchant_ref") or "N/A")
            amt = float(exc.get("invoice_amount") or exc.get("amount") or 0.0)
            date_val = str(exc.get("invoice_date") or exc.get("date") or "N/A")
            raw_type = str(exc.get("exception_type") or exc.get("type") or "unmatched_entry")

            exc_label = EXCEPTION_TYPE_LABELS.get(raw_type, raw_type.replace("_", " ").title())
            severity = str(exc.get("severity") or "HIGH").upper()
            action = str(exc.get("recommended_action") or DEFAULT_RECOMMENDED_ACTIONS.get(raw_type, "Verify transaction with bank statement"))

            table_rows.append([
                Paragraph(ref, cell_bold),
                Paragraph(f"₹{amt:,.2f}", cell_style),
                Paragraph(date_val, cell_style),
                Paragraph(exc_label, cell_red),
                Paragraph(severity, cell_red),
                Paragraph(action, cell_style),
            ])

        exceptions_table = Table(table_rows, colWidths=[65, 75, 65, 100, 50, 185])
        exceptions_table.setStyle(
            TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#991B1B")),
                ("PADDING", (0, 0), (-1, -1), 5),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#FECACA")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FEF2F2")]),
            ])
        )
        story.append(exceptions_table)
    else:
        story.append(Paragraph("<b>No faulty transactions found. All records successfully reconciled!</b>", cell_style))

    story.append(Spacer(1, 16))
    story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#CBD5E1"), spaceAfter=8))
    story.append(Paragraph("Confidential Audit Document — Generated by Razorpay Financial Reconciliation Engine", subtitle_style))

    doc.build(story)
    buffer.seek(0)
    return buffer.getvalue()
