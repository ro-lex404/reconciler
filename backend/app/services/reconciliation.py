from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import duckdb


def default_finance_data_dir() -> Path:
    if os.getenv("FINANCE_DATA_DIR"):
        env_p = Path(os.getenv("FINANCE_DATA_DIR"))
        if env_p.exists() and env_p.is_dir():
            return env_p

    for p in [
        Path(__file__).resolve().parents[3] / "data",
        Path(__file__).resolve().parents[2] / "data",
        Path("/app/data"),
        Path("/app/finance-data"),
        Path("../data").resolve(),
        Path("data").resolve(),
    ]:
        if p.exists() and p.is_dir():
            if any(p.glob("*.csv")) or any(p.glob("*/*.csv")):
                return p

    return Path(__file__).resolve().parents[3] / "data"


_ACTIVE_YEAR: str = "2026"
_ACTIVE_MONTH: str = "july"


def get_active_period() -> tuple[str, str]:
    global _ACTIVE_YEAR, _ACTIVE_MONTH
    return _ACTIVE_YEAR, _ACTIVE_MONTH


def set_active_period(year: str, month: str) -> tuple[str, str]:
    global _ACTIVE_YEAR, _ACTIVE_MONTH
    y = year.strip()
    m = month.strip().lower()
    if y:
        _ACTIVE_YEAR = y
    if m:
        _ACTIVE_MONTH = m
    return _ACTIVE_YEAR, _ACTIVE_MONTH


def set_active_month(month: str) -> str:
    global _ACTIVE_MONTH
    clean = month.strip().lower()
    if clean:
        _ACTIVE_MONTH = clean
    return _ACTIVE_MONTH


def list_available_datasets() -> dict[str, Any]:
    global _ACTIVE_YEAR, _ACTIVE_MONTH
    root_data = default_finance_data_dir()
    datasets = []
    years_found = set(["2026"])
    
    # Strict Year/Month directory scan (data/<year>/<month>/)
    if root_data.exists() and root_data.is_dir():
        for y_dir in root_data.iterdir():
            if y_dir.is_dir() and re.match(r"^\d{4}$", y_dir.name):
                year_str = y_dir.name
                years_found.add(year_str)
                for m_dir in y_dir.iterdir():
                    if m_dir.is_dir():
                        m = m_dir.name.lower()
                        all_csvs = list(m_dir.glob("*.csv"))
                        bk = [f for f in all_csvs if "bank" in f.name.lower()]
                        rp = [f for f in all_csvs if "razorpay" in f.name.lower()]
                        inv = list(m_dir.glob("*.pdf"))
                        if bk or rp or inv:
                            datasets.append({
                                "year": year_str,
                                "month": m,
                                "label": f"{m.capitalize()} {year_str}",
                                "has_razorpay": len(rp) > 0,
                                "has_bank": len(bk) > 0,
                                "has_invoices": len(inv) > 0,
                                "razorpay_file": rp[0].name if rp else None,
                                "bank_file": bk[0].name if bk else None,
                                "invoice_file": inv[0].name if inv else None,
                                "path": f"{year_str}/{m}",
                            })
            
    return {
        "active_year": _ACTIVE_YEAR,
        "active_month": _ACTIVE_MONTH,
        "years": sorted(list(years_found), reverse=True),
        "datasets": datasets,
    }


def delete_finance_dataset(
    year: str,
    month: str,
    file_type: str = "all",
) -> dict[str, Any]:
    """Deletes a monthly statement dataset directory or individual statement files.
    
    If the active period is purged, automatically falls back to the next available dataset.
    Resets cached PDF reconciliation if the deleted dataset was the source.
    """
    global _ACTIVE_YEAR, _ACTIVE_MONTH, LATEST_PDF_RECONCILIATION
    root_data = default_finance_data_dir()

    year_clean = str(year).strip()
    month_clean = str(month).strip().lower().replace("\\", "/")

    if "/" in month_clean:
        parts = [p.strip() for p in month_clean.split("/") if p.strip()]
        if len(parts) >= 2:
            year_clean = parts[0]
            month_clean = parts[1]
        elif len(parts) == 1:
            month_clean = parts[0]

    target_dir = root_data / year_clean / month_clean
    legacy_dir = root_data / month_clean

    candidate_dirs: list[Path] = []
    if target_dir.exists() and target_dir.is_dir():
        candidate_dirs.append(target_dir)
    if legacy_dir.exists() and legacy_dir.is_dir() and legacy_dir.resolve() != target_dir.resolve():
        candidate_dirs.append(legacy_dir)

    if not candidate_dirs:
        raise FileNotFoundError(f"Dataset directory for {year_clean}/{month_clean} not found.")

    deleted_paths: list[str] = []
    scope = (file_type or "all").strip().lower()

    if scope == "all":
        import shutil
        for d in candidate_dirs:
            for item in d.rglob("*"):
                if item.is_file():
                    deleted_paths.append(str(item))
            try:
                shutil.rmtree(d)
                deleted_paths.append(str(d))
            except Exception:
                for item in d.rglob("*"):
                    if item.is_file():
                        try:
                            item.unlink()
                        except Exception:
                            pass
                try:
                    d.rmdir()
                except Exception:
                    pass
    else:
        for d in candidate_dirs:
            matched_files: list[Path] = []
            if scope in ("bank", "bank_statement", "bank_statement.csv"):
                matched_files = (
                    list(d.glob(f"*{month_clean}*{year_clean}*bank*.csv"))
                    + list(d.glob(f"*bank*{month_clean}*{year_clean}*.csv"))
                    + list(d.glob(f"bank_statement_{month_clean}_{year_clean}.csv"))
                    + list(d.glob(f"bank_statements_{month_clean}_{year_clean}.csv"))
                    + list(d.glob(f"*{month_clean}*bank*.csv"))
                    + list(d.glob(f"*bank*{month_clean}*.csv"))
                    + list(d.glob(f"bank_statement_{month_clean}.csv"))
                    + list(d.glob("*bank*.csv"))
                )
            elif scope in ("razorpay", "razorpay_settlements", "razorpay_settlements.csv"):
                matched_files = (
                    list(d.glob(f"*{month_clean}*{year_clean}*razorpay*.csv"))
                    + list(d.glob(f"*razorpay*{month_clean}*{year_clean}*.csv"))
                    + list(d.glob(f"razorpay_settlements_{month_clean}_{year_clean}.csv"))
                    + list(d.glob(f"*{month_clean}*razorpay*.csv"))
                    + list(d.glob(f"*razorpay*{month_clean}*.csv"))
                    + list(d.glob(f"razorpay_settlements_{month_clean}.csv"))
                    + list(d.glob("*razorpay*.csv"))
                )
            elif scope in ("invoice", "invoices", "pdf", "invoices.pdf"):
                matched_files = (
                    list(d.glob(f"*{month_clean}*{year_clean}*invoice*.pdf"))
                    + list(d.glob(f"*invoice*{month_clean}*{year_clean}*.pdf"))
                    + list(d.glob(f"invoices_{month_clean}_{year_clean}.pdf"))
                    + list(d.glob(f"*{month_clean}*invoice*.pdf"))
                    + list(d.glob(f"*invoice*{month_clean}*.pdf"))
                    + list(d.glob(f"invoices_{month_clean}.pdf"))
                    + list(d.glob("*.pdf"))
                )
            else:
                direct_file = d / file_type
                if direct_file.exists() and direct_file.is_file():
                    matched_files = [direct_file]
                else:
                    matched_files = list(d.glob(file_type))

            seen = set()
            unique_files = []
            for f in matched_files:
                resolved = f.resolve()
                if resolved not in seen:
                    seen.add(resolved)
                    unique_files.append(f)

            for f in unique_files:
                if f.exists() and f.is_file():
                    try:
                        f.unlink()
                        deleted_paths.append(str(f))
                    except Exception:
                        pass

    if not deleted_paths:
        raise FileNotFoundError(f"No files matching scope '{file_type}' found in dataset {year_clean}/{month_clean}.")

    # Refresh available datasets
    refreshed_info = list_available_datasets()
    refreshed_datasets = refreshed_info.get("datasets", [])

    # Check if active period was purged/invalidated
    if _ACTIVE_YEAR == year_clean and _ACTIVE_MONTH == month_clean:
        active_still_exists = any(
            d.get("year") == year_clean and d.get("month") == month_clean and (d.get("has_bank") or d.get("has_razorpay"))
            for d in refreshed_datasets
        )
        if not active_still_exists or scope == "all":
            if refreshed_datasets:
                _ACTIVE_YEAR = refreshed_datasets[0]["year"]
                _ACTIVE_MONTH = refreshed_datasets[0]["month"]
            else:
                _ACTIVE_YEAR = "2026"
                _ACTIVE_MONTH = "july"

    # Reset cached PDF reconciliation if the deleted dataset was the source
    if LATEST_PDF_RECONCILIATION is not None:
        source_fn = str(LATEST_PDF_RECONCILIATION.get("filename") or LATEST_PDF_RECONCILIATION.get("source") or "").lower()
        if scope in ("all", "invoice", "invoices", "pdf") or month_clean in source_fn or any(Path(p).name.lower() in source_fn for p in deleted_paths):
            LATEST_PDF_RECONCILIATION = None

    return {
        "status": "success",
        "deleted": {
            "year": year_clean,
            "month": month_clean,
            "scope": scope,
            "deleted_paths": deleted_paths,
        },
        "active_period": {
            "year": _ACTIVE_YEAR,
            "month": _ACTIVE_MONTH,
        },
        "datasets": refreshed_datasets,
    }


def resolve_finance_dataset_paths(
    hint_filename: str | None = None,
    razorpay_path: str | Path | None = None,
    bank_path: str | Path | None = None,
) -> tuple[Path, Path]:
    """Dynamically resolves the appropriate razorpay settlements and bank statement CSV files
    based on year/month hints or directory structure.
    Strictly enforces hierarchical directory isolation: data/<year>/<month>/ with zero cross-period fallback.
    """
    if razorpay_path and bank_path:
        return Path(razorpay_path), Path(bank_path)

    global _ACTIVE_YEAR, _ACTIVE_MONTH
    year = _ACTIVE_YEAR
    month = _ACTIVE_MONTH

    if hint_filename:
        lower = str(hint_filename).lower()
        if "202" in lower:
            m_yr = re.search(r"(202\d)", lower)
            if m_yr:
                year = m_yr.group(1)
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
        for k, full_m in MONTH_LOOKUP.items():
            if len(k) >= 3 and re.search(r"\b" + k + r"\b", lower):
                month = full_m
                break

    root_data = default_finance_data_dir()
    period_dir = root_data / year / month

    if period_dir.exists() and period_dir.is_dir():
        rp_candidates = (
            list(period_dir.glob(f"razorpay_settlements_{month}_{year}.csv"))
            + list(period_dir.glob(f"razorpay_settlements_{month}.csv"))
            + list(period_dir.glob("razorpay_settlements.csv"))
            + list(period_dir.glob("*razorpay*.csv"))
        )
        bk_candidates = (
            list(period_dir.glob(f"bank_statement_{month}_{year}.csv"))
            + list(period_dir.glob(f"bank_statements_{month}_{year}.csv"))
            + list(period_dir.glob(f"bank_statement_{month}.csv"))
            + list(period_dir.glob(f"bank_statements_{month}.csv"))
            + list(period_dir.glob("bank_statement.csv"))
            + list(period_dir.glob("bank_statements.csv"))
            + list(period_dir.glob("*bank*.csv"))
        )
        rp_file = rp_candidates[0] if rp_candidates else period_dir / f"razorpay_settlements_{month}_{year}.csv"
        bk_file = bk_candidates[0] if bk_candidates else period_dir / f"bank_statement_{month}_{year}.csv"
        return rp_file, bk_file

    # If the period directory does not exist, return expected canonical paths inside that period (do not fall back to root)
    return period_dir / f"razorpay_settlements_{month}_{year}.csv", period_dir / f"bank_statement_{month}_{year}.csv"


def reconcile_settlements(
    razorpay_path: str | Path,
    bank_path: str | Path,
) -> dict[str, Any]:
    rp_p = Path(razorpay_path)
    bk_p = Path(bank_path)

    con = duckdb.connect()

    # 1. Load CSVs directly into DuckDB tables with robust date normalization and missing file tolerance
    if not rp_p.exists() or not rp_p.is_file():
        con.execute("""
            CREATE TABLE razorpay (
                payment_id VARCHAR,
                merchant_ref VARCHAR,
                amount DOUBLE,
                date VARCHAR,
                clean_date DATE
            )
        """)
    else:
        rp_file = rp_p.resolve().as_posix()
        con.execute(f"""
            CREATE TABLE razorpay AS 
            SELECT 
                *,
                COALESCE(
                    TRY_CAST(date AS DATE),
                    TRY_STRPTIME(date::VARCHAR, '%d-%m-%Y'),
                    TRY_STRPTIME(date::VARCHAR, '%d/%m/%Y'),
                    TRY_STRPTIME(date::VARCHAR, '%Y/%m/%d'),
                    TRY_STRPTIME(date::VARCHAR, '%Y-%m-%d')
                ) as clean_date
            FROM read_csv_auto('{rp_file}')
        """)

    if not bk_p.exists() or not bk_p.is_file():
        con.execute("""
            CREATE TABLE bank (
                bank_ref VARCHAR,
                credit_amount DOUBLE,
                value_date VARCHAR,
                description VARCHAR,
                clean_date DATE,
                merchant_ref VARCHAR
            )
        """)
    else:
        bk_file = bk_p.resolve().as_posix()
        con.execute(f"""
            CREATE TABLE bank AS 
            SELECT 
                *,
                COALESCE(
                    TRY_CAST(value_date AS DATE),
                    TRY_STRPTIME(value_date::VARCHAR, '%d-%m-%Y'),
                    TRY_STRPTIME(value_date::VARCHAR, '%d/%m/%Y'),
                    TRY_STRPTIME(value_date::VARCHAR, '%Y/%m/%d'),
                    TRY_STRPTIME(value_date::VARCHAR, '%Y-%m-%d')
                ) as clean_date,
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
            strftime(r.clean_date, '%Y-%m-%d') as razorpay_date,
            b.credit_amount as bank_amount,
            strftime(b.clean_date, '%Y-%m-%d') as bank_date,
            'EXACT' as match_type,
            1.00 as confidence,
            'Exact match on amount and reference ID' as explanation
        FROM razorpay r
        JOIN bank b ON r.merchant_ref = b.merchant_ref
        WHERE ABS(r.amount - b.credit_amount) < 0.01
          AND r.clean_date = b.clean_date
    """)

    # 3. Pass 2 — Fuzzy Matches (Amount within ₹5.00, date within 2 days)
    con.execute("""
        CREATE TABLE fuzzy_matches AS
        SELECT
            r.payment_id,
            r.merchant_ref,
            r.amount as razorpay_amount,
            strftime(r.clean_date, '%Y-%m-%d') as razorpay_date,
            b.credit_amount as bank_amount,
            strftime(b.clean_date, '%Y-%m-%d') as bank_date,
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
                ABS(DATEDIFF('day', r.clean_date, b.clean_date)),
                ' day(s)'
            ) as explanation
        FROM razorpay r
        JOIN bank b ON r.merchant_ref = b.merchant_ref
        WHERE r.payment_id NOT IN (SELECT payment_id FROM exact_matches)
          AND ABS(r.amount - b.credit_amount) <= 5.0
          AND ABS(DATEDIFF('day', r.clean_date, b.clean_date)) <= 2
    """)

    # 4. Pass 2.5 — Many-to-One Matches (Lump-sum bank settlement paying multiple invoices)
    con.execute("""
        CREATE TABLE raw_many_to_one AS
        SELECT
            r1.payment_id as r1_id,
            r2.payment_id as r2_id,
            r1.payment_id || ' + ' || r2.payment_id as payment_id,
            r1.merchant_ref || ' + ' || r2.merchant_ref as merchant_ref,
            r1.amount + r2.amount as razorpay_amount,
            strftime(r1.clean_date, '%Y-%m-%d') as razorpay_date,
            b.credit_amount as bank_amount,
            strftime(b.clean_date, '%Y-%m-%d') as bank_date,
            'MANY_TO_ONE' as match_type,
            0.92 as confidence,
            CONCAT('Many-to-one lump-sum batch settlement: combined 2 transactions (', r1.merchant_ref, ' ₹', r1.amount, ' + ', r2.merchant_ref, ' ₹', r2.amount, ')') as explanation,
            ROW_NUMBER() OVER (PARTITION BY r1.payment_id ORDER BY ABS((r1.amount + r2.amount) - b.credit_amount)) as rn1,
            ROW_NUMBER() OVER (PARTITION BY r2.payment_id ORDER BY ABS((r1.amount + r2.amount) - b.credit_amount)) as rn2
        FROM razorpay r1
        JOIN razorpay r2 ON r1.payment_id < r2.payment_id
        JOIN bank b ON ABS((r1.amount + r2.amount) - b.credit_amount) <= 1.0
        WHERE r1.payment_id NOT IN (SELECT payment_id FROM exact_matches)
          AND r2.payment_id NOT IN (SELECT payment_id FROM exact_matches)
          AND r1.payment_id NOT IN (SELECT payment_id FROM fuzzy_matches)
          AND r2.payment_id NOT IN (SELECT payment_id FROM fuzzy_matches)
    """)

    con.execute("""
        CREATE TABLE many_to_one_matches AS
        SELECT payment_id, merchant_ref, razorpay_amount, razorpay_date, bank_amount, bank_date, match_type, confidence, explanation
        FROM raw_many_to_one
        WHERE rn1 = 1 AND rn2 = 1
    """)

    # Matched IDs set to mathematically guarantee disjoint partition between matches and exceptions
    con.execute("""
        CREATE TABLE all_matched_payment_ids AS
        SELECT payment_id FROM exact_matches
        UNION ALL
        SELECT payment_id FROM fuzzy_matches
        UNION ALL
        SELECT r1_id FROM raw_many_to_one WHERE rn1 = 1 AND rn2 = 1
        UNION ALL
        SELECT r2_id FROM raw_many_to_one WHERE rn1 = 1 AND rn2 = 1
    """)

    # 5. Pass 3 — Categorized Exceptions (Strictly mutually exclusive with matches)
    con.execute("""
        CREATE TABLE exceptions AS
        -- Missing bank entry (Razorpay payment with no matching bank reference)
        SELECT
            r.payment_id,
            r.merchant_ref,
            r.amount,
            strftime(r.clean_date, '%Y-%m-%d') as date,
            CAST(NULL AS DOUBLE) as bank_amount,
            CAST(NULL AS VARCHAR) as bank_date,
            'MISSING_BANK' as type,
            'HIGH' as severity,
            'Check bank portal for delayed NEFT settlement (T+1 window)' as recommended_action
        FROM razorpay r
        LEFT JOIN bank b ON r.merchant_ref = b.merchant_ref AND b.merchant_ref != ''
        WHERE b.merchant_ref IS NULL
          AND r.payment_id NOT IN (SELECT payment_id FROM all_matched_payment_ids)
        
        UNION ALL
        
        -- Mismatches (Found in bank statement but fails exact and fuzzy matching)
        SELECT
            r.payment_id,
            r.merchant_ref,
            r.amount,
            strftime(r.clean_date, '%Y-%m-%d') as date,
            b.credit_amount as bank_amount,
            strftime(b.clean_date, '%Y-%m-%d') as bank_date,
            CASE
                WHEN ABS(r.amount - b.credit_amount) > 1.0 THEN 'AMOUNT_MISMATCH'
                WHEN ABS(DATEDIFF('day', r.clean_date, b.clean_date)) > 2 THEN 'DATE_MISMATCH'
                ELSE 'AMOUNT_MISMATCH'
            END as type,
            'HIGH' as severity,
            CASE
                WHEN ABS(r.amount - b.credit_amount) > 1.0 THEN CONCAT('Bank credited ₹', b.credit_amount, ' vs Gateway ₹', r.amount, ' (₹', ROUND(ABS(r.amount - b.credit_amount), 2), ' variance); verify MDR fee deduction')
                ELSE 'Check settlement clearance window / weekend date shift'
            END as recommended_action
        FROM razorpay r
        JOIN bank b ON r.merchant_ref = b.merchant_ref
        WHERE r.payment_id NOT IN (SELECT payment_id FROM all_matched_payment_ids)
          AND b.merchant_ref != ''
        
        UNION ALL
        
        -- Ghost credits (Bank credit entries with no merchant ref or ledger record)
        SELECT
            NULL as payment_id,
            b.merchant_ref,
            CAST(NULL AS DOUBLE) as amount,
            strftime(b.clean_date, '%Y-%m-%d') as date,
            b.credit_amount as bank_amount,
            strftime(b.clean_date, '%Y-%m-%d') as bank_date,
            'GHOST_CREDIT' as type,
            'HIGH' as severity,
            'Flag for compliance review — unreferenced credit with no Razorpay record' as recommended_action
        FROM bank b
        WHERE (b.merchant_ref = '' OR b.merchant_ref IS NULL)
          AND b.bank_ref NOT IN (SELECT bank_ref FROM exact_matches)
        
        UNION ALL
        
        -- Missing Invoice (Bank credit has merchant reference, but no Razorpay ledger transaction exists)
        SELECT
            NULL as payment_id,
            b.merchant_ref,
            CAST(NULL AS DOUBLE) as amount,
            strftime(b.clean_date, '%Y-%m-%d') as date,
            b.credit_amount as bank_amount,
            strftime(b.clean_date, '%Y-%m-%d') as bank_date,
            'MISSING_INVOICE' as type,
            'HIGH' as severity,
            CONCAT('Bank credited reference ', b.merchant_ref, ' has no matching ledger transaction; verify unrecorded gateway payment') as recommended_action
        FROM bank b
        WHERE b.merchant_ref != '' AND b.merchant_ref IS NOT NULL
          AND b.merchant_ref NOT IN (SELECT merchant_ref FROM razorpay WHERE merchant_ref IS NOT NULL AND merchant_ref != '')
    """)

    # 6. Extract results as dictionaries
    matches_df = con.execute("""
        SELECT * FROM exact_matches
        UNION ALL
        SELECT * FROM fuzzy_matches
        UNION ALL
        SELECT * FROM many_to_one_matches
    """).df()

    raw_matches = matches_df.to_dict(orient="records")
    raw_exceptions = exceptions_df.to_dict(orient="records")

    import math
    matches = [
        {k: (None if (isinstance(v, float) and (math.isnan(v) or math.isinf(v))) else v) for k, v in r.items()}
        for r in raw_matches
    ]
    exceptions = [
        {k: (None if (isinstance(v, float) and (math.isnan(v) or math.isinf(v))) else v) for k, v in r.items()}
        for r in raw_exceptions
    ]

    total_transactions = con.execute("SELECT COUNT(*) FROM razorpay").fetchone()[0]
    bank_entries = con.execute("SELECT COUNT(*) FROM bank").fetchone()[0]
    matched_count = con.execute("SELECT COUNT(*) FROM all_matched_payment_ids").fetchone()[0]

    match_rate = round(matched_count / total_transactions * 100, 2) if total_transactions else 0.0

    return {
        "total_transactions": total_transactions,
        "bank_entries": bank_entries,
        "matched_transactions": matched_count,
        "match_rate": match_rate,
        "exception_count": len(exceptions),
        "exceptions": exceptions,
        "throughput": {
            "razorpay_records_processed": total_transactions,
            "bank_records_processed": bank_entries,
            "engine": "DuckDB SQL Vectorized Engine",
        },
        "matches": matches,
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
    hint_filename: str | None = None,
) -> str:
    """Generates a structured context string of live reconciliation metrics and exception details for the AI Settlement Q&A Agent."""
    global LATEST_PDF_RECONCILIATION

    hint = hint_filename
    if not hint and LATEST_PDF_RECONCILIATION:
        hint = LATEST_PDF_RECONCILIATION.get("filename") or LATEST_PDF_RECONCILIATION.get("source")

    rp_file_path, bk_file_path = resolve_finance_dataset_paths(hint, razorpay_path, bank_path)
    
    rp_exists = rp_file_path.exists() and rp_file_path.is_file()
    bk_exists = bk_file_path.exists() and bk_file_path.is_file()

    # Determine period label
    period_year = rp_file_path.parent.parent.name if rp_file_path.parent.parent.name.isdigit() else _ACTIVE_YEAR
    period_month = rp_file_path.parent.name if rp_file_path.parent.name in ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"] else _ACTIVE_MONTH

    if not rp_exists and not bk_exists:
        return f"No reconciliation dataset (bank statement or Razorpay settlements) is available for {period_month.capitalize()} {period_year}."

    res = reconcile_settlements(rp_file_path, bk_file_path)
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

    # Aggregate counts by exception type
    from collections import Counter
    type_counts = Counter(e.get("type") or e.get("exception_type") or "UNKNOWN" for e in exceptions)
    type_breakdown_lines = [f"  • {k}: {v} record(s)" for k, v in type_counts.items()]
    type_breakdown_str = "\n".join(type_breakdown_lines) if type_breakdown_lines else "  • None"

    # Top sample exceptions (up to 6) for quick reference
    sample_exceptions_lines = []
    for e in exceptions[:6]:
        ref = e.get("merchant_ref") or e.get("invoice_ref") or "N/A"
        amt = float(e.get("razorpay_amount") or e.get("amount") or 0.0)
        dt = e.get("date") or e.get("razorpay_date") or "N/A"
        exc_type = e.get("type") or e.get("exception_type") or "UNKNOWN"
        act = e.get("recommended_action") or "Verify transaction ledger"
        sample_exceptions_lines.append(f"  • {ref} | ₹{amt:,.2f} | {dt} | {exc_type} | {act}")
    sample_exceptions_str = "\n".join(sample_exceptions_lines) if sample_exceptions_lines else "  • No exceptions"
    summary_context = f"""Live Reconciliation Snapshot ({period_month.capitalize()} {period_year}):
- Total Processed Transactions / Invoices: {res['total_transactions']}
- Successfully Matched Records: {res['matched_transactions']} ({res['match_rate']}%)
- Bank Statement Ledger Entries: {res['bank_entries']}
- Flagged Unreconciled Exceptions: {res['exception_count']}
- Total Unreconciled Discrepancy Amount: ₹{total_unreconciled:,.2f}

Exception Type Breakdown:
{type_breakdown_str}

Key Flagged Exception Samples:
{sample_exceptions_str}

Forward Cash Settlement Forecast (7-Day Clearance Window):
- Gross Matched Payment Volume: ₹{gross_matched:,.2f}
- Projected Gateway Fees (2%): ₹{estimated_fees:,.2f}
- Estimated GST on Fees (18%): ₹{estimated_gst:,.2f}
- Net Projected Bank Settlement Inflow: ₹{net_projected_payout:,.2f}"""
    return summary_context