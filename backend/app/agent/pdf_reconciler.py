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
from pypdf import PdfReader

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
    """Extracts raw text from PDF bytes across all pages using PyPDF."""
    pdf_bytes = state.get("pdf_bytes")
    if not pdf_bytes:
        return {"full_text": ""}

    reader = PdfReader(io.BytesIO(pdf_bytes))
    page_texts = []
    for page in reader.pages:
        extracted = page.extract_text()
        if extracted:
            page_texts.append(extracted)

    full_text = "\n".join(page_texts)
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
    if not records:
        return {
            "reconciliation_results": {
                "pdf_records_extracted": 0,
                "matched_count": 0,
                "matches": [],
                "exceptions": [],
            }
        }

    data_dir = default_finance_data_dir()
    bk_file = (data_dir / "bank_statement.csv").resolve().as_posix()
    rp_file = (data_dir / "razorpay_settlements.csv").resolve().as_posix()

    con = duckdb.connect()

    # Register PDF DataFrame in DuckDB
    pdf_df = pd.DataFrame(records)
    con.register("pdf_invoices", pdf_df)

    # Load Bank Statement
    con.execute(f"""
        CREATE TABLE bank AS 
        SELECT *, COALESCE(REGEXP_EXTRACT(description, 'RZRPY/(REF[0-9]+)', 1), '') as merchant_ref 
        FROM read_csv_auto('{bk_file}')
    """)

    # Load Razorpay Settlements
    con.execute(f"""
        CREATE TABLE razorpay AS 
        SELECT * FROM read_csv_auto('{rp_file}')
    """)

    # Match PDF Invoices against Bank Statement
    matches_df = con.execute("""
        SELECT 
            p.ref as invoice_ref,
            p.amount as invoice_amount,
            p.date as invoice_date,
            b.credit_amount as bank_amount,
            b.value_date::DATE::VARCHAR as bank_date,
            CASE 
                WHEN ABS(p.amount - b.credit_amount) < 0.01 AND p.date = b.value_date::DATE::VARCHAR THEN 'EXACT'
                ELSE 'FUZZY'
            END as match_type,
            CASE 
                WHEN ABS(p.amount - b.credit_amount) < 0.01 AND p.date = b.value_date::DATE::VARCHAR THEN 1.00
                ELSE 0.85
            END as confidence
        FROM pdf_invoices p
        JOIN bank b ON p.ref = b.merchant_ref
        WHERE ABS(p.amount - b.credit_amount) <= 5.0
    """).df()

    # Unmatched PDF invoices (Exceptions)
    exceptions_df = con.execute("""
        SELECT 
            p.ref as invoice_ref,
            p.amount as invoice_amount,
            p.date as invoice_date,
            'unmatched_pdf_invoice' as exception_type,
            'HIGH' as severity,
            'Verify if invoice payout was delayed or omitted from bank settlement' as recommended_action
        FROM pdf_invoices p
        LEFT JOIN bank b ON p.ref = b.merchant_ref AND b.merchant_ref != ''
        WHERE b.merchant_ref IS NULL
    """).df()

    matches = matches_df.to_dict(orient="records")
    exceptions = exceptions_df.to_dict(orient="records")

    results = {
        "reconciliation_results": {
            "pdf_records_extracted": len(records),
            "matched_count": len(matches),
            "exception_count": len(exceptions),
            "matches": matches,
            "exceptions": exceptions,
            "engine": "DuckDB SQL Vectorized Engine",
        }
    }

    try:
        from app.services.reconciliation import update_latest_pdf_reconciliation
        update_latest_pdf_reconciliation(results)
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
