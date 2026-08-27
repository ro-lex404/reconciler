from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import duckdb


def default_finance_data_dir() -> Path:
    local_dir = Path(__file__).resolve().parents[3] / "razorpay-reconciler" / "data"
    return Path(os.getenv("FINANCE_DATA_DIR", str(local_dir)))


def reconcile_settlements(
    razorpay_path: str | Path,
    bank_path: str | Path,
) -> dict[str, Any]:
    rp_file = Path(razorpay_path).resolve().as_posix()
    bk_file = Path(bank_path).resolve().as_posix()

    con = duckdb.connect()

    # 1. Load CSVs directly into DuckDB tables using zero-copy scanning
    con.execute(f"""
        CREATE TABLE razorpay AS 
        SELECT * FROM read_csv_auto('{rp_file}')
    """)

    con.execute(f"""
        CREATE TABLE bank AS 
        SELECT *,
            COALESCE(REGEXP_EXTRACT(description, 'RZRPY/(REF[0-9]+)', 1), '') as merchant_ref
        FROM read_csv_auto('{bk_file}')
    """)

    # 2. Pass 1 — Exact Matches (Amount delta < ₹0.01 AND same date)
    con.execute("""
        CREATE TABLE exact_matches AS
        SELECT 
            r.payment_id,
            r.merchant_ref,
            r.amount as razorpay_amount,
            r.date::VARCHAR as razorpay_date,
            b.credit_amount as bank_amount,
            b.value_date::DATE::VARCHAR as bank_date,
            'EXACT' as match_type,
            1.00 as confidence,
            'Exact match on amount and reference ID' as explanation
        FROM razorpay r
        JOIN bank b ON r.merchant_ref = b.merchant_ref
        WHERE ABS(r.amount - b.credit_amount) < 0.01
          AND r.date::DATE = b.value_date::DATE
    """)

    # 3. Pass 2 — Fuzzy Matches (Amount within ₹5.00, date within 2 days)
    con.execute("""
        CREATE TABLE fuzzy_matches AS
        SELECT
            r.payment_id,
            r.merchant_ref,
            r.amount as razorpay_amount,
            r.date::VARCHAR as razorpay_date,
            b.credit_amount as bank_amount,
            b.value_date::DATE::VARCHAR as bank_date,
            'FUZZY' as match_type,
            CASE 
                WHEN ABS(r.amount - b.credit_amount) < 1.0 THEN 0.85
                WHEN ABS(r.amount - b.credit_amount) < 10.0 THEN 0.75
                ELSE 0.65
            END as confidence,
            CONCAT(
                'Fuzzy match: amount delta ₹',
                ROUND(ABS(r.amount - b.credit_amount), 2),
                ', date delta ',
                ABS(DATEDIFF('day', r.date::DATE, b.value_date::DATE)),
                ' day(s)'
            ) as explanation
        FROM razorpay r
        JOIN bank b ON r.merchant_ref = b.merchant_ref
        WHERE r.payment_id NOT IN (SELECT payment_id FROM exact_matches)
          AND ABS(r.amount - b.credit_amount) <= 5.0
          AND ABS(DATEDIFF('day', r.date::DATE, b.value_date::DATE)) <= 2
    """)

    # 4. Pass 3 — Categorized Exceptions
    con.execute("""
        CREATE TABLE exceptions AS
        -- Missing bank entry (Razorpay payment with no matching bank reference)
        SELECT
            r.payment_id,
            r.merchant_ref,
            r.amount,
            r.date::VARCHAR as date,
            'missing_bank_entry' as type,
            'HIGH' as severity,
            'Check bank portal for delayed NEFT settlement (T+1 window)' as recommended_action
        FROM razorpay r
        LEFT JOIN bank b ON r.merchant_ref = b.merchant_ref AND b.merchant_ref != ''
        WHERE b.merchant_ref IS NULL
        
        UNION ALL
        
        -- Mismatches (Found in bank statement but fails exact and fuzzy matching)
        SELECT
            r.payment_id,
            r.merchant_ref,
            r.amount,
            r.date::VARCHAR as date,
            CASE
                WHEN ABS(r.amount - b.credit_amount) >= 0.01 AND r.date::DATE != b.value_date::DATE THEN 'amount_and_date_mismatch'
                WHEN ABS(r.amount - b.credit_amount) >= 0.01 THEN 'amount_mismatch'
                ELSE 'date_mismatch'
            END as type,
            'HIGH' as severity,
            CASE
                WHEN ABS(r.amount - b.credit_amount) >= 0.01 THEN 'Verify GST rounding or gateway fee deduction with merchant'
                ELSE 'Check settlement clearance window / weekend date shift'
            END as recommended_action
        FROM razorpay r
        JOIN bank b ON r.merchant_ref = b.merchant_ref
        WHERE r.payment_id NOT IN (SELECT payment_id FROM exact_matches)
          AND r.payment_id NOT IN (SELECT payment_id FROM fuzzy_matches)
          AND b.merchant_ref != ''
        
        UNION ALL
        
        -- Ghost credits (Bank credit entries with no corresponding Razorpay record)
        SELECT
            NULL as payment_id,
            b.merchant_ref,
            b.credit_amount as amount,
            b.value_date::DATE::VARCHAR as date,
            'ghost_credit' as type,
            'HIGH' as severity,
            'Flag for compliance review — credit with no Razorpay record' as recommended_action
        FROM bank b
        WHERE b.merchant_ref = '' OR b.merchant_ref IS NULL
    """)

    # 5. Extract results as dictionaries
    matches_df = con.execute("""
        SELECT * FROM exact_matches
        UNION ALL
        SELECT * FROM fuzzy_matches
    """).df()

    exceptions_df = con.execute("SELECT * FROM exceptions").df()

    total_transactions = con.execute("SELECT COUNT(*) FROM razorpay").fetchone()[0]
    bank_entries = con.execute("SELECT COUNT(*) FROM bank").fetchone()[0]
    matched_count = len(matches_df)

    match_rate = round(matched_count / total_transactions * 100, 2) if total_transactions else 0.0

    return {
        "total_transactions": total_transactions,
        "bank_entries": bank_entries,
        "matched_transactions": matched_count,
        "match_rate": match_rate,
        "exception_count": len(exceptions_df),
        "exceptions": exceptions_df.to_dict(orient="records"),
        "throughput": {
            "razorpay_records_processed": total_transactions,
            "bank_records_processed": bank_entries,
            "engine": "DuckDB SQL Vectorized Engine",
        },
        "matches": matches_df.to_dict(orient="records"),
    }


def verify_reconciliation_integrity(
    razorpay_path: str | Path,
    bank_path: str | Path,
) -> dict[str, Any]:
    res = reconcile_settlements(razorpay_path, bank_path)
    matches = res["matches"]
    payment_ids = [m["payment_id"] for m in matches if m.get("payment_id")]

    unique_ids = set(payment_ids)
    duplicate_count = len(payment_ids) - len(unique_ids)

    exact_count = sum(1 for m in matches if m.get("match_type") == "EXACT")
    fuzzy_count = sum(1 for m in matches if m.get("match_type") == "FUZZY")

    return {
        "duplicates": duplicate_count,
        "total_matched": len(matches),
        "exact_matches": exact_count,
        "fuzzy_matches": fuzzy_count,
        "clean": duplicate_count == 0,
        "engine": res["throughput"]["engine"],
    }


LATEST_PDF_RECONCILIATION: dict[str, Any] | None = None


def update_latest_pdf_reconciliation(results: dict[str, Any]) -> None:
    """Updates the live PDF reconciliation state in API memory when a new PDF is processed."""
    global LATEST_PDF_RECONCILIATION
    LATEST_PDF_RECONCILIATION = results


def get_reconciliation_context_summary(
    razorpay_path: str | Path | None = None,
    bank_path: str | Path | None = None,
) -> str:
    """Generates a structured context string of live reconciliation metrics and exception details for the AI Settlement Q&A Agent."""
    global LATEST_PDF_RECONCILIATION
    data_dir = default_finance_data_dir()
    rp_file = razorpay_path or str(data_dir / "razorpay_settlements.csv")
    bk_file = bank_path or str(data_dir / "bank_statement.csv")

    res = reconcile_settlements(rp_file, bk_file)
    exceptions = res["exceptions"]
    matches = res["matches"]

    total_unreconciled = sum(
        float(e.get("razorpay_amount") or e.get("amount") or e.get("bank_amount") or 0.0)
        for e in exceptions
    )

    # Forward Cash Settlement Forecasting Breakdown (T+1/T+2 clearance windows)
    gross_matched = sum(
        float(m.get("amount") or m.get("razorpay_amount") or 0.0)
        for m in matches
    )
    estimated_fees = gross_matched * 0.02
    estimated_gst = estimated_fees * 0.18
    net_projected_payout = gross_matched - (estimated_fees + estimated_gst)

    exceptions_summary = []
    for e in exceptions:
        ref = e.get("merchant_ref") or e.get("invoice_ref") or "N/A"
        amt = float(e.get("razorpay_amount") or e.get("amount") or 0.0)
        dt = e.get("date") or e.get("razorpay_date") or "N/A"
        exc_type = e.get("type") or e.get("exception_type") or "unknown"
        sev = e.get("severity") or "HIGH"
        action = e.get("recommended_action") or "Verify with bank statement"

        exceptions_summary.append({
            "ref": ref,
            "amount": f"₹{amt:,.2f}",
            "amount_raw": amt,
            "date": dt,
            "type": exc_type,
            "severity": sev,
            "recommended_action": action,
        })

    pdf_context_section = ""
    if LATEST_PDF_RECONCILIATION:
        pdf_res = LATEST_PDF_RECONCILIATION.get("reconciliation_results", LATEST_PDF_RECONCILIATION)
        extracted_cnt = pdf_res.get("pdf_records_extracted", len(LATEST_PDF_RECONCILIATION.get("records", [])))
        matched_cnt = pdf_res.get("matched_count", 0)
        exc_cnt = pdf_res.get("exception_count", 0)
        pdf_exceptions = pdf_res.get("exceptions", [])
        pdf_matches = pdf_res.get("matches", [])
        
        pdf_context_section = f"""

Uploaded PDF Invoice Reconciliation Data (Latest File Processed):
- Extracted PDF Invoices Count: {extracted_cnt}
- Reconciled PDF Matches: {matched_cnt} ({round(matched_cnt/extracted_cnt*100, 2) if extracted_cnt else 0}%)
- Unmatched PDF Invoice Exceptions: {exc_cnt}
- Detailed PDF Exception Records: {pdf_exceptions}
- PDF Matches Records: {pdf_matches}
"""

    summary_context = f"""Live Reconciliation Metrics (Batch Settlements):
- Total Transactions Processed: {res['total_transactions']}
- Successfully Matched Transactions: {res['matched_transactions']} ({res['match_rate']}%)
- Bank Statement Entries: {res['bank_entries']}
- Unmatched Exceptions Count: {res['exception_count']}
- Total Unreconciled Discrepancy Amount: ₹{total_unreconciled:,.2f}

Forward Cash Settlement Forecast (Next 7-Day Clearance Window):
- Gross Matched Payment Volume: ₹{gross_matched:,.2f}
- Projected Gateway Fees (2.0% Standard): ₹{estimated_fees:,.2f}
- Estimated GST on Fees (18.0%): ₹{estimated_gst:,.2f}
- Net Projected Bank Settlement Inflow: ₹{net_projected_payout:,.2f}
{pdf_context_section}

Detailed Exception List ({len(exceptions_summary)} records):
{exceptions_summary}"""
    return summary_context