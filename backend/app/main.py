import os
import re
from pathlib import Path
import duckdb

from fastapi import FastAPI, UploadFile, File, Form, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from app.services.reconciliation import (
    default_finance_data_dir,
    reconcile_settlements,
    verify_reconciliation_integrity,
    get_reconciliation_context_summary,
    resolve_finance_dataset_paths,
)

# Import the Celery worker task and compiled LangGraph workflow
from app.worker import process_document_task
from app.agent.router import app as agent_app

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


class ReconciliationRequest(BaseModel):
    razorpay_path: str | None = None
    bank_path: str | None = None


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
    reconciliation_context = get_reconciliation_context_summary()
    inputs = {
        "question": request.query,
        "reconciliation_context": reconciliation_context,
    }
    final_state = await agent_app.ainvoke(inputs)
    final_answer = final_state.get("final_answer", "")
    normalized_answer = normalize_final_answer(final_answer)
    sources = final_state.get("sources", [])
    return JSONResponse({"answer": normalized_answer, "sources": sources})


@app.post("/finance/reconcile")
async def finance_reconciliation(request: ReconciliationRequest):
    """Reconcile a settlement batch and return measurable exceptions."""
    if request.razorpay_path and request.bank_path:
        rp_path, bk_path = request.razorpay_path, request.bank_path
    else:
        rp_file, bk_file = resolve_finance_dataset_paths()
        rp_path, bk_path = str(rp_file), str(bk_file)
    return reconcile_settlements(rp_path, bk_path)


# Verification endpoint to check for duplicates across match sets
@app.get("/finance/verify")
def verify_no_duplicates():
    rp_file, bk_file = resolve_finance_dataset_paths()
    return verify_reconciliation_integrity(str(rp_file), str(bk_file))


@app.get("/finance/datasets")
async def get_datasets():
    """Lists available monthly statement batches and the current active month."""
    from app.services.reconciliation import list_available_datasets
    return list_available_datasets()


class SetActiveMonthRequest(BaseModel):
    month: str


@app.post("/finance/set-active-month")
async def change_active_month(request: SetActiveMonthRequest):
    """Switches the active reconciliation month in memory."""
    from app.services.reconciliation import set_active_month, reconcile_settlements, resolve_finance_dataset_paths
    month = set_active_month(request.month)
    try:
        rp, bk = resolve_finance_dataset_paths()
        res = reconcile_settlements(rp, bk)
    except Exception:
        res = None
    return {"status": "ok", "active_month": month, "reconciliation_summary": res}


@app.post("/finance/upload-dataset")
async def upload_finance_dataset(
    file: UploadFile = File(...),
    dataset_type: str = Form("bank"),
    month: str = Form("august"),
    passcode: str = Form(""),
):
    """Uploads a bank statement CSV, Razorpay CSV, or Invoice PDF directly to the data folder."""
    if passcode and passcode.strip() not in ["admin", "controller", "razorpay2026", "secret"]:
        return JSONResponse({"error": "Unauthorized: Invalid Controller Passcode"}, status_code=401)

    from app.services.reconciliation import default_finance_data_dir
    root_data = default_finance_data_dir()
    month_clean = month.strip().lower()
    target_dir = root_data / month_clean
    target_dir.mkdir(parents=True, exist_ok=True)

    file_bytes = await file.read()
    dest_path = target_dir / file.filename
    with open(dest_path, "wb") as f:
        f.write(file_bytes)

    return {
        "status": "success",
        "filename": file.filename,
        "saved_to": str(dest_path),
        "dataset_type": dataset_type,
        "month": month_clean,
    }


from app.agent.pdf_reconciler import pdf_reconciler_graph


@app.post("/finance/extract-pdf")
async def extract_and_reconcile_pdf(file: UploadFile = File(...)):
    """Extracts invoice records from uploaded PDF and reconciles against bank statements via LangGraph."""
    pdf_bytes = await file.read()

    initial_state = {
        "pdf_bytes": pdf_bytes,
        "filename": file.filename,
        "full_text": "",
        "extracted_records": [],
        "reconciliation_results": {},
    }

    final_state = await pdf_reconciler_graph.ainvoke(initial_state)

    return {
        "source": file.filename,
        "extracted_count": len(final_state["extracted_records"]),
        "records": final_state["extracted_records"],
        "reconciliation": final_state["reconciliation_results"],
    }


from app.services.pdf_report_generator import generate_reconciliation_pdf_report


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