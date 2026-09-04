import os
import re
from pathlib import Path
import duckdb

from fastapi import FastAPI, UploadFile, File, Form, Response, Body, Query, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from app.services.reconciliation import (
    default_finance_data_dir,
    reconcile_settlements,
    verify_reconciliation_integrity,
    get_reconciliation_context_summary,
    resolve_finance_dataset_paths,
    delete_finance_dataset,
    set_active_period,
    set_active_month,
    list_available_datasets,
    update_latest_pdf_reconciliation,
)
from app.agent.pdf_reconciler import pdf_reconciler_graph
from app.services.pdf_report_generator import generate_reconciliation_pdf_report

# Import the Celery worker task and compiled LangGraph workflow
from app.worker import process_document_task
from app.agent.router import app as agent_app

VALID_PASSCODES = {"admin", "controller", "controller2026", "razorpay2026", "secret", "password"}

app = FastAPI(title="Hybrid AI Analytics API")


def _resolve_allowed_origins() -> list[str]:
    default_origins = {
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://0.0.0.0:3000",
    }
    configured = os.getenv("ALLOWED_ORIGINS", "")
    configured_origins = {origin.strip() for origin in configured.split(",") if origin.strip()}
    return sorted(default_origins | configured_origins)

# Enable CORS for Next.js frontend across any IP or domain
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    query: str
    year: str | None = None
    month: str | None = None


class ReconciliationRequest(BaseModel):
    razorpay_path: str | None = None
    bank_path: str | None = None


class DeleteDatasetRequest(BaseModel):
    passcode: str | None = None
    year: str | None = None
    month: str | None = None
    file_type: str | None = "all"


def _collapse_exact_repetition(text: str) -> str:
    """Collapses exact contiguous repetition such as A+A or A+A+A."""
    normalized = (text or "").strip()
    if not normalized:
        return ""

    for repeats in (3, 2):
        if len(normalized) % repeats != 0:
            continue
        chunk_size = len(normalized) // repeats
        chunk = normalized[:chunk_size]
        if chunk * repeats == normalized:
            return chunk.strip()

    lines = normalized.splitlines()
    if len(lines) % 2 == 0:
        half = len(lines) // 2
        if lines[:half] == lines[half:]:
            return "\n".join(lines[:half]).strip()

    return normalized


def _collapse_adjacent_word_repeats(text: str) -> str:
    """Collapses duplicated adjacent words such as 'hello hello'."""
    return re.sub(r"\b(\w+)\b(?:\s+\1\b)+", r"\1", text, flags=re.IGNORECASE)


def normalize_final_answer(answer: str) -> str:
    deduped = _collapse_exact_repetition(answer)
    deduped = _collapse_adjacent_word_repeats(deduped)
    return deduped.strip()

@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """Saves uploaded PDFs/CSVs, triggers Celery vector embedding, and runs live PDF reconciliation if PDF."""
    upload_dir = "./uploads"
    os.makedirs(upload_dir, exist_ok=True)
    
    file_location = f"{upload_dir}/{file.filename}"
    pdf_bytes = await file.read()
    
    with open(file_location, "wb+") as file_object:
        file_object.write(pdf_bytes)
        
    # Dispatch vector store embedding task to Celery
    process_document_task.delay(file_location, file.filename)

    # If uploaded file is a PDF, run live PDF reconciliation to update context memory immediately
    if file.filename.lower().endswith(".pdf"):
        try:
            initial_state = {
                "pdf_bytes": pdf_bytes,
                "filename": file.filename,
                "full_text": "",
                "extracted_records": [],
                "reconciliation_results": {},
            }
            await pdf_reconciler_graph.ainvoke(initial_state)
        except Exception as e:
            print(f"Live PDF reconciliation on upload notice: {e}")
    
    return {"info": f"File '{file.filename}' uploaded and processed."}

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    from app.services.reconciliation import set_active_period, set_active_month
    q_lower = request.query.lower()
    
    # Universal Year detection
    m_yr = re.search(r"(202\d)", q_lower)
    parsed_year = m_yr.group(1) if m_yr else (request.year or "2026")
    
    # Universal Month detection
    MONTH_MAP = {
        "january": "january", "february": "february", "march": "march", "april": "april",
        "may": "may", "june": "june", "july": "july", "august": "august",
        "september": "september", "october": "october", "november": "november", "december": "december",
        "jan": "january", "feb": "february", "mar": "march", "apr": "april",
        "jun": "june", "jul": "july", "aug": "august", "sep": "september",
        "oct": "october", "nov": "november", "dec": "december"
    }
    
    parsed_month = None
    if request.month:
        parsed_month = request.month.lower().strip()
    else:
        for k, v in MONTH_MAP.items():
            if re.search(r"\b" + k + r"\b", q_lower):
                parsed_month = v
                break

    if parsed_month:
        set_active_period(parsed_year, parsed_month)
    elif request.year:
        set_active_period(request.year, "july")

    reconciliation_context = get_reconciliation_context_summary(hint_filename=f"{parsed_year}/{parsed_month}" if parsed_month else request.query)
    inputs = {
        "question": request.query,
        "reconciliation_context": reconciliation_context,
    }
    
    try:
        final_state = await agent_app.ainvoke(inputs)
        final_answer = final_state.get("final_answer", "")
        normalized_answer = normalize_final_answer(final_answer)
        sources = final_state.get("sources", [])
        return JSONResponse({"answer": normalized_answer, "sources": sources})
    except Exception as e:
        print(f"Chat execution fallback notice: {e}")
        fallback_text = f"### Reconciliation Summary\n\n{reconciliation_context}" if reconciliation_context else "No active reconciliation dataset found for this query period."
        return JSONResponse({"answer": fallback_text, "sources": []})


@app.post("/finance/reconcile")
async def finance_reconciliation(request: ReconciliationRequest):
    """Reconcile a settlement batch and return measurable exceptions."""
    if request.razorpay_path and request.bank_path:
        rp_path, bk_path = request.razorpay_path, request.bank_path
    else:
        rp_file, bk_file = resolve_finance_dataset_paths()
        rp_path, bk_path = str(rp_file), str(bk_file)

    try:
        results = reconcile_settlements(rp_path, bk_path)
        return JSONResponse(results)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Verification endpoint to check for duplicates across match sets
@app.get("/finance/verify")
def verify_no_duplicates():
    rp_file, bk_file = resolve_finance_dataset_paths()
    return verify_reconciliation_integrity(str(rp_file), str(bk_file))


@app.get("/finance/datasets")
async def get_finance_datasets():
    """Lists available multi-year monthly financial datasets."""
    from app.services.reconciliation import list_available_datasets
    return JSONResponse(list_available_datasets())


class SetActiveMonthRequest(BaseModel):
    month: str
    year: str | None = None


@app.post("/finance/set-active-month")
async def change_active_month(request: SetActiveMonthRequest):
    """Switches the active reconciliation month in memory."""
    from app.services.reconciliation import set_active_period, set_active_month, reconcile_settlements, resolve_finance_dataset_paths
    if request.year:
        set_active_period(request.year, request.month)
    else:
        set_active_month(request.month)

    try:
        rp, bk = resolve_finance_dataset_paths()
        res = reconcile_settlements(rp, bk)
    except Exception:
        res = None
    return {"status": "ok", "active_month": request.month, "active_year": request.year or "2026", "reconciliation_summary": res}


@app.post("/finance/upload-dataset")
async def upload_finance_dataset(
    file: UploadFile = File(...),
    dataset_type: str = Form(...),
    month: str = Form("july"),
    passcode: str = Form(...),
):
    """Ingests a monthly bank statement CSV or Razorpay settlements CSV."""
    if passcode != "admin":
        raise HTTPException(status_code=401, detail="Invalid admin passcode")

    month_clean = month.strip().lower().replace("\\", "/")
    root_data = default_finance_data_dir()
    
    if "/" in month_clean:
        y, m = month_clean.split("/", 1)
        target_dir = root_data / y / m
    else:
        target_dir = root_data / "2026" / month_clean
        
    target_dir.mkdir(parents=True, exist_ok=True)
    file_bytes = await file.read()

    parts = month_clean.split("/")
    if len(parts) >= 2:
        y_name, m_name = parts[0], parts[1]
    else:
        y_name, m_name = "2026", parts[0]

    # Save month-and-year-specific canonical filename
    if dataset_type in ("bank", "bank_statement"):
        dest_path = target_dir / f"bank_statement_{m_name}_{y_name}.csv"
    elif dataset_type in ("razorpay", "razorpay_settlements"):
        dest_path = target_dir / f"razorpay_settlements_{m_name}_{y_name}.csv"
    elif dataset_type in ("invoice", "invoices"):
        dest_path = target_dir / f"invoices_{m_name}_{y_name}.pdf"
    else:
        dest_path = target_dir / file.filename

    with open(dest_path, "wb") as f:
        f.write(file_bytes)

    parts = month_clean.split("/")
    if len(parts) >= 2:
        set_active_period(parts[0], parts[1])
    else:
        set_active_period("2026", parts[0])

    # Dispatch vector store embedding task to Celery in real time
    try:
        process_document_task.delay(str(dest_path), file.filename)
    except Exception as e:
        print(f"Celery vector store indexing notice: {e}")

    return {
        "status": "success",
        "filename": dest_path.name,
        "saved_to": str(dest_path),
        "dataset_type": dataset_type,
        "month": month_clean,
    }


@app.delete("/finance/dataset")
async def delete_dataset_endpoint(
    request: DeleteDatasetRequest | None = Body(None),
    passcode: str | None = Query(None),
    year: str | None = Query(None),
    month: str | None = Query(None),
    file_type: str | None = Query(None),
    x_passcode: str | None = Header(None),
):
    """Deletes a full monthly statement batch or specific statement files."""
    req_passcode = request.passcode if request and request.passcode is not None else None
    req_year = request.year if request and request.year is not None else None
    req_month = request.month if request and request.month is not None else None
    req_file_type = request.file_type if request and request.file_type is not None else None

    effective_passcode = req_passcode or passcode or x_passcode or ""
    effective_year = req_year or year or ""
    effective_month = req_month or month or ""
    effective_file_type = req_file_type or file_type or "all"

    if not effective_passcode or str(effective_passcode).strip().lower() not in VALID_PASSCODES:
        return JSONResponse({"error": "Unauthorized: Invalid Finance Controller Passcode."}, status_code=401)

    # Support compound month path like "2026/august"
    if "/" in str(effective_month):
        parts = [p.strip() for p in str(effective_month).replace("\\", "/").split("/") if p.strip()]
        if len(parts) >= 2:
            if not effective_year:
                effective_year = parts[0]
            effective_month = parts[1]
        elif len(parts) == 1:
            effective_month = parts[0]

    if not effective_year or not str(effective_year).strip() or not effective_month or not str(effective_month).strip():
        return JSONResponse({"error": "Missing required year or month."}, status_code=400)

    try:
        result = delete_finance_dataset(
            year=str(effective_year).strip(),
            month=str(effective_month).strip(),
            file_type=str(effective_file_type).strip(),
        )
        return JSONResponse(result, status_code=200)
    except FileNotFoundError:
        return JSONResponse({"error": "Dataset period or file not found."}, status_code=404)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/finance/extract-pdf")
async def extract_and_reconcile_pdf(file: UploadFile = File(...)):
    """Extracts invoice records from uploaded PDF and reconciles against bank statements via LangGraph."""
    pdf_bytes = await file.read()

    # Save uploaded PDF to ./uploads and trigger background vector indexing in real time
    upload_dir = "./uploads"
    os.makedirs(upload_dir, exist_ok=True)
    temp_path = f"{upload_dir}/{file.filename}"
    with open(temp_path, "wb") as f:
        f.write(pdf_bytes)

    try:
        process_document_task.delay(temp_path, file.filename)
    except Exception as e:
        print(f"Celery vector store indexing notice: {e}")

    initial_state = {
        "pdf_bytes": pdf_bytes,
        "filename": file.filename,
        "full_text": "",
        "extracted_records": [],
        "reconciliation_results": {},
    }

    final_state = await pdf_reconciler_graph.ainvoke(initial_state)

    # Also update in-memory latest PDF reconciliation for immediate chat awareness
    update_latest_pdf_reconciliation({
        "filename": file.filename,
        "source": file.filename,
        "records": final_state.get("extracted_records", []),
        "reconciliation_results": final_state.get("reconciliation_results", {}),
    })

    return {
        "source": file.filename,
        "extracted_count": len(final_state["extracted_records"]),
        "records": final_state["extracted_records"],
        "reconciliation": final_state["reconciliation_results"],
    }


class AuditReportRequest(BaseModel):
    source_filename: str = "invoices.pdf"
    extracted_count: int = 0
    matched_count: int = 0
    exception_count: int = 0
    exceptions: list[dict] = []
    matches: list[dict] = []


@app.post("/finance/export-report")
async def export_audit_pdf_report(request: AuditReportRequest):
    """Generates and downloads a timestamped PDF audit report of faulty transactions."""
    pdf_bytes = generate_reconciliation_pdf_report(
        source_filename=request.source_filename,
        extracted_count=request.extracted_count,
        matched_count=request.matched_count,
        exception_count=request.exception_count,
        exceptions=request.exceptions,
        matches=request.matches,
    )

    clean_name = request.source_filename.replace(".pdf", "")
    filename = f"Reconciliation_Audit_Report_{clean_name}.pdf"

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )