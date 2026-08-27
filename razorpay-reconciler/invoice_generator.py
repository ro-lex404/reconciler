from pathlib import Path

import pandas as pd
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

DATA_DIR = Path(__file__).resolve().parent / 'data'
FONT_PATH = Path('C:/Windows/Fonts/arial.ttf')
pdfmetrics.registerFont(TTFont('ArialUnicode', str(FONT_PATH)))


def generate_invoice_pdf(df_razorpay, output_path=DATA_DIR / 'invoices.pdf'):
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(str(output_path), pagesize=A4)
    styles = getSampleStyleSheet()
    styles['Title'].fontName = 'ArialUnicode'
    elements = []
    
    elements.append(Paragraph("Invoice Register — July 2026", 
                               styles['Title']))
    
    data = [["Invoice #", "Payment Ref", "Amount (₹)", 
             "Date", "Category", "Status"]]
    
    # Use first 50 Razorpay records as invoices
    for i, row in df_razorpay.head(50).iterrows():
        data.append([
            f"INV-2026-{1000+i}",
            row['merchant_ref'],
            f"₹{row['amount']:,.2f}",
            row['date'],
            row['merchant_category'],
            "PAID"
        ])
    
    table = Table(data)
    table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.darkblue),
        ('TEXTCOLOR', (0,0), (-1,0), colors.white),
        ('GRID', (0,0), (-1,-1), 0.5, colors.grey),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), 
            [colors.white, colors.lightgrey]),
           ('FONTNAME', (0,0), (-1,-1), 'ArialUnicode')
    ]))
    elements.append(table)
    doc.build(elements)
    print(f"PDF generated: {output_path}")

if __name__ == '__main__':
    razorpay_path = DATA_DIR / 'razorpay_settlements.csv'
    df_razorpay = pd.read_csv(razorpay_path)
    generate_invoice_pdf(df_razorpay)