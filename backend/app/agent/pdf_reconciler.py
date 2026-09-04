from __future__ import annotations

import io
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, TypedDict

import duckdb
import pandas as pd
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_groq import ChatGroq
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field
try:
    from pypdf import PdfReader
except ImportError:
    PdfReader = None

from app.services.reconciliation import default_finance_data_dir


# --- 1. Pydantic Schemas for Strict Structured LLM Output ---
class InvoiceRecord(BaseModel):
    ref: str = Field(description="Merchant reference ID or payment ref e.g. REF1000 or INV-1001")
    amount: float = Field(description="Numerical transaction amount")
    date: str = Field(description="Transaction date formatted as YYYY-MM-DD")
    description: Optional[str] = Field(default="", description="Invoice description or category details")
    status: Optional[str] = Field(default="PAID", description="Payment status e.g. PAID or UNPAID")


class ExtractedInvoiceList(BaseModel):
    records: List[InvoiceRecord] = Field(description="List of extracted financial/invoice records")


# --- 2. LangGraph State ---
class PDFReconcilerState(TypedDict):
    pdf_bytes: bytes
    filename: str
    full_text: str
    extracted_records: List[Dict[str, Any]]
    reconciliation_results: Dict[str, Any]


# --- 3. LangGraph Nodes ---
def extract_pdf_text_node(state: PDFReconcilerState) -> Dict[str, Any]:
    """Extracts raw text from PDF or image invoice bytes across all pages using PyPDF, OCR, and Vision models."""
    pdf_bytes = state.get("pdf_bytes")
    filename = state.get("filename", "").lower()
    if not pdf_bytes:
        return {"full_text": ""}

    full_text = ""
    page_texts = []

    # 1. If uploaded file is an image (e.g. photo of paper invoice / receipt .png/.jpg/.jpeg/.webp)
    if any(filename.endswith(ext) for ext in [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff"]):
        # A. Try local OCR
        try:
            from PIL import Image
            import pytesseract
            img = Image.open(io.BytesIO(pdf_bytes))
            full_text = pytesseract.image_to_string(img)
            if full_text and len(full_text.strip()) > 10:
                return {"full_text": full_text}
        except Exception:
            pass

        # B. Try Multi-modal Neural Vision extraction via Groq
        groq_api_key = os.getenv("GROQ_API_KEY", "").strip()
        if groq_api_key:
            try:
                import base64
                from groq import Groq
                client = Groq(api_key=groq_api_key)
                mime = "image/png" if filename.endswith(".png") else "image/jpeg"
                b64 = base64.b64encode(pdf_bytes).decode("utf-8")
                resp = client.chat.completions.create(
                    model="llama-3.2-11b-vision-preview",
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": "Extract all text from this invoice/receipt photo, including invoice reference ID, transaction date, amount, description, and status:"},
                                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                            ],
                        }
                    ],
                )
                vision_text = resp.choices[0].message.content or ""
                if vision_text.strip():
                    return {"full_text": vision_text}
            except Exception as e:
                print(f"Vision extraction notice: {e}")

        return {"full_text": full_text}

    # 2. Extract standard PDF text
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        for page in reader.pages:
            extracted = page.extract_text()
            if extracted and extracted.strip():
                page_texts.append(extracted)
        full_text = "\n".join(page_texts)
    except Exception as e:
        print(f"PyPDF reader notice: {e}")

    # 3. If PDF contains 0 or very few text characters (Scanned paper receipt), run OCR fallback
    if len(full_text.strip()) < 30:
        try:
            from PIL import Image
            import pytesseract
            reader = PdfReader(io.BytesIO(pdf_bytes))
            ocr_pages = []
            for page in reader.pages:
                for img_obj in page.images:
                    img = Image.open(io.BytesIO(img_obj.data))
                    txt = pytesseract.image_to_string(img)
                    if txt.strip():
                        ocr_pages.append(txt)
            if ocr_pages:
                full_text = "\n".join(ocr_pages)
        except Exception as e:
            print(f"Scanned PDF OCR notice: {e}")

    return {"full_text": full_text}


def _robust_parse_invoice_text(text: str) -> List[Dict[str, Any]]:
    """Robust parser to handle tabular PDF extraction formats (including currency symbols)."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    records = []
    i = 0
    while i < len(lines):
        line = lines[i]
        # Single line format: REF1000 200.09 2026-07-21 retail PAID
        single_match = re.search(r"(REF\d+)\s+[\u20b9$₹]?([\d,]+\.?\d*)\s+(\d{4}-\d{2}-\d{2})", line)
        if single_match:
            ref, amt_str, dt_str = single_match.groups()
            records.append({
                "ref": ref,
                "amount": float(amt_str.replace(",", "")),
                "date": dt_str,
                "description": "",
                "status": "PAID",
            })
            i += 1
            continue

        # Multi-line tabular block format (INV-..., REF..., Amount, Date, Category, Status)
        if (line.startswith("INV-") or line.startswith("REF")) and i + 3 < len(lines):
            ref = line if line.startswith("REF") else (lines[i+1] if lines[i+1].startswith("REF") else "")
            offset = 1 if line.startswith("REF") else 2
            
            if ref and i + offset + 1 < len(lines):
                raw_amt = lines[i + offset]
                raw_date = lines[i + offset + 1]
                amt_cleaned = re.sub(r"[^\d.]", "", raw_amt)
                
                if amt_cleaned and re.match(r"^\d{4}-\d{2}-\d{2}$", raw_date):
                    category = lines[i + offset + 2] if i + offset + 2 < len(lines) and lines[i + offset + 2] in ["retail", "food", "travel", "electronics", "services"] else ""
                    status = lines[i + offset + 3] if i + offset + 3 < len(lines) and lines[i + offset + 3] in ["PAID", "UNPAID", "PENDING"] else "PAID"
                    
                    records.append({
                        "ref": ref,
                        "amount": float(amt_cleaned),
                        "date": raw_date,
                        "description": category,
                        "status": status,
                    })
                    i += (offset + 4)
                    continue

        i += 1
    return records


def llm_extraction_node(state: PDFReconcilerState) -> Dict[str, Any]:
    """Uses Groq Llama 3.3 70B with structured output to parse invoice records, with fallback parser."""
    full_text = state.get("full_text", "")
    if not full_text.strip():
        return {"extracted_records": []}

    groq_api_key = os.getenv("GROQ_API_KEY", "").strip()

    if groq_api_key:
        try:
            llm = ChatGroq(model="openai/gpt-oss-120b", temperature=0, groq_api_key=groq_api_key)
            structured_llm = llm.with_structured_output(ExtractedInvoiceList)

            prompt = f"""Extract all transaction or invoice records from this financial document text.
Return the structured invoice records with exact reference IDs (e.g. REF1000), amounts, dates (YYYY-MM-DD), descriptions, and statuses.

Document Text:
{full_text[:12000]}"""

            result: ExtractedInvoiceList = structured_llm.invoke([
                SystemMessage(content="You are an expert financial data extraction AI. Extract structured records accurately."),
                HumanMessage(content=prompt),
            ])
            records = [r.model_dump() for r in result.records]
            if records:
                return {"extracted_records": records}
        except Exception as e:
            print(f"Groq LLM extraction warning: {e}. Falling back to document text parser.")

    # Fallback to robust parser if Groq LLM key is absent or errored
    records = _robust_parse_invoice_text(full_text)
    return {"extracted_records": records}


def duckdb_reconcile_node(state: PDFReconcilerState) -> Dict[str, Any]:
    """Ingests extracted PDF records into DuckDB and relationally reconciles against Bank Statement."""
    records = state.get("extracted_records", [])
    filename = state.get("filename", "")

    # Universal Month and Year Detection across all 12 months
    MONTH_LOOKUP = {
        "01": "january", "1": "january", "jan": "january", "january": "january",
        "02": "february", "2": "february", "feb": "february", "february": "february",
        "03": "march", "3": "march", "mar": "march", "march": "march",
        "04": "april", "4": "april", "apr": "april", "april": "april",
        "05": "may", "5": "may", "may": "may",
        "06": "june", "6": "june", "jun": "june", "june": "june",
        "07": "july", "7": "july", "jul": "july", "july": "july",
        "08": "august", "8": "august", "aug": "august", "august": "august",
        "09": "september", "9": "september", "sep": "september", "september": "september",
        "10": "october", "oct": "october", "october": "october",
        "11": "november", "nov": "november", "november": "november",
        "12": "december", "dec": "december", "december": "december",
    }

    detected_month = "july"
    detected_year = "2026"

    if filename:
        fn_lower = filename.lower()
        for k, m_val in MONTH_LOOKUP.items():
            if len(k) >= 3 and k in fn_lower:
                detected_month = m_val
                break
        m_yr = re.search(r"(202\d)", fn_lower)
        if m_yr:
            detected_year = m_yr.group(1)

    dates = [str(r.get("date", "")) for r in records if r.get("date")]
    for d in dates:
        m_d = re.search(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})", d)
        if m_d:
            detected_year = m_d.group(1)
            m_num = m_d.group(2).zfill(2)
            if m_num in MONTH_LOOKUP:
                detected_month = MONTH_LOOKUP[m_num]
                break

    from app.services.reconciliation import resolve_finance_dataset_paths, set_active_period
    set_active_period(detected_year, detected_month)

    if not records:
        return {
            "reconciliation_results": {
                "pdf_records_extracted": 0,
                "matched_count": 0,
                "matches": [],
                "exceptions": [],
                "detected_year": detected_year,
                "detected_month": detected_month,
            }
        }
    rp_path, bk_path = resolve_finance_dataset_paths(hint_filename=f"{detected_year}/{detected_month}")
    bk_file = bk_path.resolve().as_posix()
    rp_file = rp_path.resolve().as_posix()

    con = duckdb.connect()

    # Register PDF DataFrame in DuckDB
    pdf_df = pd.DataFrame(records)
    con.register("pdf_invoices", pdf_df)

    # Load Bank Statement with robust multi-format date parsing
    con.execute(f"""
        CREATE TABLE bank AS 
        SELECT 
            *,
            strftime(COALESCE(
                TRY_CAST(value_date AS DATE),
                TRY_STRPTIME(value_date::VARCHAR, '%d-%m-%Y'),
                TRY_STRPTIME(value_date::VARCHAR, '%d/%m/%Y'),
                TRY_STRPTIME(value_date::VARCHAR, '%Y/%m/%d'),
                TRY_STRPTIME(value_date::VARCHAR, '%Y-%m-%d')
            ), '%Y-%m-%d') as clean_bank_date,
            COALESCE(REGEXP_EXTRACT(description, 'RZRPY/(REF[0-9]+)', 1), '') as merchant_ref 
        FROM read_csv_auto('{bk_file}')
    """)

    # Load Razorpay Settlements
    con.execute(f"""
        CREATE TABLE razorpay AS 
        SELECT 
            *,
            strftime(COALESCE(
                TRY_CAST(date AS DATE),
                TRY_STRPTIME(date::VARCHAR, '%d-%m-%Y'),
                TRY_STRPTIME(date::VARCHAR, '%d/%m/%Y'),
                TRY_STRPTIME(date::VARCHAR, '%Y/%m/%d'),
                TRY_STRPTIME(date::VARCHAR, '%Y-%m-%d')
            ), '%Y-%m-%d') as clean_rp_date
        FROM read_csv_auto('{rp_file}')
    """)

    # Clean PDF Invoices date with unique row identifier
    con.execute("""
        CREATE TABLE clean_pdf_invoices AS
        SELECT 
            ROW_NUMBER() OVER () as invoice_id,
            ref,
            amount,
            strftime(COALESCE(
                TRY_CAST(date AS DATE),
                TRY_STRPTIME(date::VARCHAR, '%d-%m-%Y'),
                TRY_STRPTIME(date::VARCHAR, '%d/%m/%Y'),
                TRY_STRPTIME(date::VARCHAR, '%Y/%m/%d'),
                TRY_STRPTIME(date::VARCHAR, '%Y-%m-%d')
            ), '%Y-%m-%d') as invoice_date
        FROM pdf_invoices
    """)

    # 1. Exact & Fuzzy matches
    con.execute("""
        CREATE TABLE single_matches AS
        SELECT 
            p.invoice_id,
            p.ref as invoice_ref,
            p.amount as invoice_amount,
            p.invoice_date as invoice_date,
            b.credit_amount as bank_amount,
            b.clean_bank_date as bank_date,
            CASE 
                WHEN ABS(p.amount - b.credit_amount) < 0.01 AND p.invoice_date = b.clean_bank_date THEN 'EXACT'
                ELSE 'FUZZY'
            END as match_type,
            CASE 
                WHEN ABS(p.amount - b.credit_amount) < 0.01 AND p.invoice_date = b.clean_bank_date THEN 1.00
                ELSE 0.88
            END as confidence
        FROM clean_pdf_invoices p
        JOIN bank b ON p.ref = b.merchant_ref
        WHERE ABS(p.amount - b.credit_amount) <= 5.0
          AND (p.invoice_date IS NULL OR b.clean_bank_date IS NULL OR ABS(DATEDIFF('day', TRY_CAST(p.invoice_date AS DATE), TRY_CAST(b.clean_bank_date AS DATE))) <= 2)
    """)

    # 2. Distinct Many-to-One Lump Sum Matches (2 invoices -> 1 lump sum bank credit)
    con.execute("""
        CREATE TABLE raw_many_to_one AS
        SELECT
            p1.invoice_id as p1_id,
            p2.invoice_id as p2_id,
            p1.ref as p1_ref,
            p2.ref as p2_ref,
            p1.ref || ' + ' || p2.ref as invoice_ref,
            p1.amount + p2.amount as invoice_amount,
            p1.invoice_date as invoice_date,
            b.credit_amount as bank_amount,
            b.clean_bank_date as bank_date,
            'MANY_TO_ONE' as match_type,
            0.92 as confidence,
            ROW_NUMBER() OVER (PARTITION BY p1.invoice_id ORDER BY ABS((p1.amount + p2.amount) - b.credit_amount)) as rn1,
            ROW_NUMBER() OVER (PARTITION BY p2.invoice_id ORDER BY ABS((p1.amount + p2.amount) - b.credit_amount)) as rn2
        FROM clean_pdf_invoices p1
        JOIN clean_pdf_invoices p2 ON p1.invoice_id < p2.invoice_id
        JOIN bank b ON ABS((p1.amount + p2.amount) - b.credit_amount) <= 1.0
        WHERE p1.invoice_id NOT IN (SELECT invoice_id FROM single_matches)
          AND p2.invoice_id NOT IN (SELECT invoice_id FROM single_matches)
    """)

    con.execute("""
        CREATE TABLE many_to_one_pdf_matches AS
        SELECT invoice_ref, invoice_amount, invoice_date, bank_amount, bank_date, match_type, confidence
        FROM raw_many_to_one
        WHERE rn1 = 1 AND rn2 = 1
    """)

    con.execute("""
        CREATE TABLE all_matched_pdf_ids AS
        SELECT invoice_id FROM single_matches
        UNION ALL
        SELECT p1_id FROM raw_many_to_one WHERE rn1 = 1 AND rn2 = 1
        UNION ALL
        SELECT p2_id FROM raw_many_to_one WHERE rn1 = 1 AND rn2 = 1
    """)

    matches_df = con.execute("""
        SELECT invoice_ref, invoice_amount, invoice_date, bank_amount, bank_date, match_type, confidence FROM single_matches
        UNION ALL
        SELECT invoice_ref, invoice_amount, invoice_date, bank_amount, bank_date, match_type, confidence FROM many_to_one_pdf_matches
    """).df()

    # 3. Comprehensive & Precise Exceptions Standardized across 6 Anomaly Classes
    con.execute("""
        CREATE TABLE exceptions AS
        -- Type A: Missing Bank Entry (Invoice never cleared in bank statement)
        SELECT 
            p.ref as invoice_ref,
            p.amount as invoice_amount,
            p.invoice_date as invoice_date,
            CAST(NULL AS DOUBLE) as bank_amount,
            CAST(NULL AS VARCHAR) as bank_date,
            'MISSING_BANK' as exception_type,
            'HIGH' as severity,
            'No matching credit found in bank statement; verify if payout was delayed (T+1) or dropped by gateway' as recommended_action
        FROM clean_pdf_invoices p
        LEFT JOIN bank b ON p.ref = b.merchant_ref AND b.merchant_ref != ''
        WHERE b.merchant_ref IS NULL
          AND p.invoice_id NOT IN (SELECT invoice_id FROM all_matched_pdf_ids)

        UNION ALL

        -- Type B: Amount or Date Mismatch (Invoice found in bank statement, but fails exact/fuzzy matching criteria)
        SELECT
            p.ref as invoice_ref,
            p.amount as invoice_amount,
            p.invoice_date as invoice_date,
            b.credit_amount as bank_amount,
            strftime(b.clean_bank_date, '%Y-%m-%d') as bank_date,
            CASE
                WHEN ABS(p.amount - b.credit_amount) > 5.0 THEN 'AMOUNT_MISMATCH'
                WHEN ABS(DATEDIFF('day', TRY_CAST(p.invoice_date AS DATE), TRY_CAST(b.clean_bank_date AS DATE))) > 2 THEN 'DATE_MISMATCH'
                ELSE 'AMOUNT_MISMATCH'
            END as exception_type,
            'HIGH' as severity,
            CASE
                WHEN ABS(p.amount - b.credit_amount) > 5.0 THEN CONCAT('Bank credited ₹', b.credit_amount, ' vs Invoice ₹', p.amount, ' (₹', ROUND(ABS(p.amount - b.credit_amount), 2), ' variance); verify MDR fee deduction or GST dispute hold')
                ELSE 'Check settlement clearance window / weekend date shift'
            END as recommended_action
        FROM clean_pdf_invoices p
        JOIN bank b ON p.ref = b.merchant_ref
        WHERE p.invoice_id NOT IN (SELECT invoice_id FROM all_matched_pdf_ids)
          AND b.merchant_ref != ''
    """)

    exceptions_df = con.execute("SELECT * FROM exceptions").df()

    single_count = len(con.execute("SELECT * FROM single_matches").df())
    mto_df = con.execute("SELECT * FROM many_to_one_pdf_matches").df()
    mto_invoices_count = len(mto_df) * 2
    total_invoices_matched = single_count + mto_invoices_count

    matches = matches_df.to_dict(orient="records")
    exceptions = exceptions_df.to_dict(orient="records")

    results = {
        "reconciliation_results": {
            "pdf_records_extracted": len(records),
            "matched_count": total_invoices_matched,
            "exception_count": len(exceptions),
            "matches": matches,
            "exceptions": exceptions,
            "detected_year": detected_year,
            "detected_month": detected_month,
            "source_dataset": f"{rp_path.name} & {bk_path.name}",
            "engine": "DuckDB SQL Vectorized Engine",
        }
    }

    try:
        from app.services.reconciliation import update_latest_pdf_reconciliation
        update_latest_pdf_reconciliation({"filename": filename, **results["reconciliation_results"]})
    except Exception:
        pass

    return results


# --- 4. Build & Compile LangGraph Workflow ---
builder = StateGraph(PDFReconcilerState)
builder.add_node("extract_text", extract_pdf_text_node)
builder.add_node("llm_extract", llm_extraction_node)
builder.add_node("duckdb_reconcile", duckdb_reconcile_node)

builder.add_edge(START, "extract_text")
builder.add_edge("extract_text", "llm_extract")
builder.add_edge("llm_extract", "duckdb_reconcile")
builder.add_edge("duckdb_reconcile", END)

pdf_reconciler_graph = builder.compile()
