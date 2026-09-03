import os
import random
import shutil
from pathlib import Path
import pandas as pd
from datetime import datetime, timedelta
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

root_data = Path(__file__).resolve().parent.parent / "data"
july_dir = root_data / "2026" / "july"
august_dir = root_data / "2026" / "august"

july_dir.mkdir(parents=True, exist_ok=True)
august_dir.mkdir(parents=True, exist_ok=True)

# 2. Generate August Data
random.seed(101)
start_date = datetime(2026, 8, 1)

rp_records = []
bk_records = []
pdf_records = []

categories = ["retail", "services", "food", "electronics", "travel"]

# Generate 150 August Razorpay records (REF2000 .. REF2149)
for i in range(150):
    pay_id = f"pay_AUG{i+1000:04d}"
    ref_id = f"REF2{i:03d}"
    amt = round(random.choice([
        random.uniform(150, 950),
        random.uniform(1000, 8500),
        random.uniform(12000, 48000)
    ]), 2)
    dt = (start_date + timedelta(days=random.randint(0, 27))).strftime("%Y-%m-%d")
    category = random.choice(categories)
    
    rp_records.append({
        "payment_id": pay_id,
        "amount": amt,
        "date": dt,
        "status": "SUCCESS",
        "merchant_ref": ref_id,
        "merchant_category": category
    })

# 120 Exact Matches in Bank Statement
for r in rp_records[:120]:
    ref = r["merchant_ref"]
    num = ref.replace("REF", "")
    bk_records.append({
        "bank_ref": f"NEFT/2026/AUG{num}",
        "value_date": r["date"],
        "credit_amount": r["amount"],
        "description": f"RZRPY/{ref}",
        "utr_number": f"AUG_{num}"
    })

# 15 Fuzzy Matches (amount delta <= 4.50 or 1-2 days clearance shift)
for r in rp_records[120:135]:
    ref = r["merchant_ref"]
    num = ref.replace("REF", "")
    amt_delta = round(random.uniform(0.50, 4.20), 2)
    days_shift = random.choice([1, 2])
    b_date = (datetime.strptime(r["date"], "%Y-%m-%d") + timedelta(days=days_shift)).strftime("%Y-%m-%d")
    bk_records.append({
        "bank_ref": f"NEFT/2026/AUG{num}",
        "value_date": b_date,
        "credit_amount": round(r["amount"] - amt_delta, 2),
        "description": f"RZRPY/{ref}",
        "utr_number": f"AUG_{num}"
    })

# 15 Missing Bank Entries (rp_records[135:150] are NOT in bank statement)

# 8 Ghost Credits (Bank entries with no Razorpay ID)
for g in range(8):
    g_date = (start_date + timedelta(days=random.randint(0, 27))).strftime("%Y-%m-%d")
    g_amt = round(random.uniform(2500, 35000), 2)
    bk_records.append({
        "bank_ref": f"NEFT/2026/GHOST_{g+100}",
        "value_date": g_date,
        "credit_amount": g_amt,
        "description": f"DIRECT_DEPOSIT_CLIENT_{g+1}",
        "utr_number": f"GHOST_{g+100}"
    })

# First 50 Razorpay records are in August invoices.pdf
for r in rp_records[:50]:
    num = r["merchant_ref"].replace("REF", "")
    pdf_records.append({
        "invoice_num": f"INV-2026-{num}",
        "ref": r["merchant_ref"],
        "amount": r["amount"],
        "date": r["date"],
        "category": r["merchant_category"],
        "status": "PAID"
    })

# Save August CSVs
df_rp = pd.DataFrame(rp_records)
df_bk = pd.DataFrame(bk_records)
df_rp.to_csv(august_dir / "razorpay_settlements_august_2026.csv", index=False)
df_bk.to_csv(august_dir / "bank_statement_august_2026.csv", index=False)
print("Saved August CSVs (RP:", len(df_rp), "Bank:", len(df_bk), ")")

# Build August invoices.pdf via ReportLab
pdf_path = str(august_dir / "invoices_august_2026.pdf")
doc = SimpleDocTemplate(pdf_path, pagesize=letter, leftMargin=36, rightMargin=36, topMargin=36, bottomMargin=36)
styles = getSampleStyleSheet()

font_family = "Helvetica"
font_family_bold = "Helvetica-Bold"
for f_fam, reg_p, b_p in [
    ("SegoeUI", "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/segoeuib.ttf"),
    ("Arial", "C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
]:
    if os.path.exists(reg_p):
        try:
            pdfmetrics.registerFont(TTFont(f_fam, reg_p))
            if os.path.exists(b_p):
                pdfmetrics.registerFont(TTFont(f"{f_fam}-Bold", b_p))
                pdfmetrics.registerFontFamily(f_fam, normal=f_fam, bold=f"{f_fam}-Bold")
                font_family_bold = f"{f_fam}-Bold"
            font_family = f_fam
            break
        except Exception:
            pass

title_style = ParagraphStyle("TitleStyle", fontName=font_family_bold, fontSize=16, leading=20, textColor=colors.HexColor("#0F172A"))
th_style = ParagraphStyle("THStyle", fontName=font_family_bold, fontSize=9, leading=11, textColor=colors.white)
td_style = ParagraphStyle("TDStyle", fontName=font_family, fontSize=8, leading=10, textColor=colors.HexColor("#1E293B"))

story = []
story.append(Paragraph("Invoice Register – August 2026", title_style))
story.append(Paragraph("Automated Billing & Payout Ledger (Razorpay Platform)", ParagraphStyle("Sub", fontName=font_family, fontSize=9, textColor=colors.HexColor("#64748B"))))
story.append(Spacer(1, 14))

table_data = [
    [
        Paragraph("<b>Invoice #</b>", th_style),
        Paragraph("<b>Payment Ref</b>", th_style),
        Paragraph("<b>Amount (₹)</b>", th_style),
        Paragraph("<b>Date</b>", th_style),
        Paragraph("<b>Category</b>", th_style),
        Paragraph("<b>Status</b>", th_style),
    ]
]

for inv in pdf_records:
    inv_ref = inv["ref"]
    inv_amt = inv["amount"]
    inv_status = inv["status"]
    table_data.append([
        Paragraph(inv["invoice_num"], td_style),
        Paragraph(f"<b>{inv_ref}</b>", td_style),
        Paragraph(f"₹{inv_amt:,.2f}", td_style),
        Paragraph(inv["date"], td_style),
        Paragraph(inv["category"], td_style),
        Paragraph(f"<b>{inv_status}</b>", td_style),
    ])

t = Table(table_data, colWidths=[90, 80, 85, 75, 80, 60], repeatRows=1)
t.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0284C7")),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ("TOPPADDING", (0, 0), (-1, -1), 4),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F8FAFC")]),
    ("LINEBELOW", (0, 0), (-1, -1), 0.5, colors.HexColor("#E2E8F0")),
]))

story.append(t)
doc.build(story)
print(f"Successfully built August invoices.pdf with {len(pdf_records)} records! Size: {os.path.getsize(pdf_path)} bytes")
