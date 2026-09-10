---
name: nexus-ai-reconciler
description: >-
  Comprehensive development and architecture guide for Nexus AI Reconciler. Use when adding
  features, modifying reconciliation rules, extending the LangGraph copilot, altering DuckDB
  queries, debugging endpoints, or deploying changes to AWS EC2.
---

# Nexus AI Reconciler — Feature Development Skill & Architecture Guide

This skill serves as the definitive engineering manual for developing, extending, debugging, and testing features in the **Nexus AI Reconciler** codebase.

---

## 1. System Architecture & Component Map

The repository is organized into a decoupled frontend and backend:

```text
razorpay-reconciler/
├── .agents/skills/nexus-ai-reconciler/
│   └── SKILL.md                          # This development skill guide
├── backend/
│   ├── app/
│   │   ├── agent/
│   │   │   ├── router.py                 # LangGraph Agentic Controller (gpt-oss-20b Router, gpt-oss-120b SQL & Synthesizer)
│   │   │   └── pdf_reconciler.py         # Multi-Modal Invoice Parser (pypdf + Vision + gpt-oss-120b Pydantic)
│   │   ├── services/
│   │   │   ├── reconciliation.py         # In-Memory Vectorized DuckDB Multi-Pass Triangulation Engine
│   │   │   ├── pdf_report_generator.py   # ReportLab PDF Audit Dossier Generator (DejaVuSans Unicode ₹)
│   │   │   ├── excel_report_generator.py # OpenPyXL 4-Tab Financial Workbook Generator (.xlsx)
│   │   │   └── ledger_service.py         # GL 6100 Journal Postings & Treasury Resolutions
│   │   ├── worker.py                     # Celery Background Task Worker (with safe fallback)
│   │   └── main.py                       # FastAPI REST API Endpoints & CORS Management
│   ├── generate_monthly_data.py          # Synthetic Multi-Period Financial Dataset Generator
│   ├── requirements.txt                  # Python Dependencies
│   └── Dockerfile                        # Backend Container Spec
├── frontend/
│   ├── app/
│   │   ├── page.tsx                      # Main Client Dashboard (3-Way Inspector, Copilot Chat, Period Picker)
│   │   ├── layout.tsx                    # Root Layout & Metadata
│   │   └── globals.css                   # Tailwind v4 Styles & Custom Classes
│   ├── package.json                      # Next.js 16 + React 19 Dependencies
│   └── Dockerfile                        # Frontend Container Spec
├── data/
│   ├── 2026/july/                        # Monthly Ledgers (Invoices PDF, Gateway CSV, Bank CSV)
│   ├── 2026/august/
│   ├── 2026/september/
│   └── 2026/october/
└── docker-compose.yml                    # Multi-Container Orchestration
```

---

## 2. The 4 Golden Engineering Invariants (DO NOT BREAK)

Whenever writing code or modifying services, uphold these 4 core invariants:

### Invariant 1: Strict Mathematical Balance Invariant
```text
Total Ingested Volume ≡ Matched Records + Flagged Exceptions
```
Any record that enters the reconciliation pipeline must end up either in `matches` or in `exceptions`. No record may be silently dropped, discarded by an unhandled outer join, or double-counted.

### Invariant 2: Starlette / FastAPI Float Sanitization
DuckDB and pandas produce `float('nan')` or `float('inf')` for missing numerical columns (e.g. fees, taxes, or unlinked deposits). Standard Starlette `JSONResponse` will crash with:
`ValueError: Out of range float values are not JSON compliant: nan`
**Rule:** Always sanitize records before returning API responses:
```python
def sanitize_record(record: dict) -> dict:
    return {
        k: (None if isinstance(v, float) and (math.isnan(v) or math.isinf(v)) else v)
        for k, v in record.items()
    }
```

### Invariant 3: Zero-Hallucination Deterministic SQL
In `backend/app/agent/router.py`, the AI synthesizer must **never compute numerical balances or totals in prompt context**.
- All mathematical queries must be routed to the `sql_agent` node.
- The `sql_agent` converts natural language into vectorized DuckDB SQL queries over active tables.
- Responses must always output clickable **DuckDB SQL citations** showing the underlying query.

### Invariant 4: Graceful Dependency Fallbacks
Do not make hard crashes if optional packages (e.g. `celery`, `redis`, `pgvector`, `reportlab`, `openpyxl`) fail to initialize or connect. Provide in-process fallbacks (e.g. local memory, fallback string buffers) so the core REST API and dashboard remain fully functional.

---

## 3. LLM Model Hierarchy & Groq Configuration

All agents execute on **Groq LPU high-throughput inference**:

| Subsystem | Model Name | Role & Latency SLA |
|---|---|---|
| **Intent Router** | `openai/gpt-oss-20b` | Sub-50ms classification routing to SQL, RAG, or Forecasting |
| **Text-to-SQL Engine** | `openai/gpt-oss-120b` | Structured SQL query generation against DuckDB in-memory schemas |
| **Invoice Schema Extractor** | `openai/gpt-oss-120b` | Structured Pydantic extraction from OCR text (`InvoiceRecord`) |
| **Executive Synthesizer** | `openai/gpt-oss-120b` | Final audit answer synthesis with transparent SQL & document citations |
| **Neural Vision Fallback** | `llama-3.2-11b-vision-preview` | Low-density receipt image and mobile photo OCR extraction |

---

## 4. Reconciliation Engine Specification & Anomaly Taxonomy

Reconciliation executes in `backend/app/services/reconciliation.py`:

```text
[Input CSVs / Invoices]
       │
       ▼
[DuckDB In-Memory Staging]
       │
       ├── Pass 1: Exact Match (Invoice Ref == Bank UTR/Narration AND Delta < ₹0.01)
       │
       ├── Pass 2: Tolerant Fee & Clearance Match (MDR 2.0% + GST 18.0%, Date shifted ±2 days)
       │
       └── Pass 3: Actionable Exception Categorization (6 Standard Classes)
```

### The 6 Standard Anomaly Classes:
1. `AMOUNT_MISMATCH`: Net variance caused by irregular MDR fee deduction or GST discrepancy.
2. `DATE_MISMATCH`: Bank clearing date exceeds allowable T+2 clearance window.
3. `MISSING_BANK`: Gateway settlement logged but no credit found in bank ledger.
4. `MISSING_GATEWAY`: Direct deposit found in bank without an originating gateway batch.
5. `FEE_MISMATCH`: MDR fee charged diverges from negotiated contract terms.
6. `STATUS_MISMATCH`: Invoice marked PAID in ERP, but settlement failed or refunded.

---

## 5. Feature Extension Playbooks

### Playbook A: Adding or Modifying a Reconciliation Rule
1. Open `backend/app/services/reconciliation.py`.
2. Add your DuckDB SQL matching CTE or join condition inside `reconcile_settlements()`.
3. If creating a new table, ensure it is queried into a DataFrame (e.g., `my_df = con.execute("SELECT * FROM my_table").df()`).
4. Update `raw_matches` or `raw_exceptions` ensuring all floats are sanitized.
5. Verify invariant: `len(raw_matches) + len(raw_exceptions) == total_ingested`.
6. Update frontend UI badges in `frontend/app/page.tsx` (e.g. `renderExceptionBadge`).
7. Update `backend/app/services/excel_report_generator.py` and `pdf_report_generator.py` if new columns are introduced.

### Playbook B: Extending the LangGraph Copilot / New Agent Tools
1. Open `backend/app/agent/router.py`.
2. To add a new intent route, modify `router_agent()` prompt with the new intent class (e.g., `"forecast"`, `"dispute"`).
3. Add a corresponding node function (e.g., `def dispute_node(state: AgentState) -> dict:`).
4. Add the node to `workflow = StateGraph(AgentState)`, add conditional edges from `"router"`, and route back to `"synthesizer"`.
5. Ensure prompt instructions maintain Indian Rupee (`₹`) formatting and executive brevity.

### Playbook C: Adding a New Treasury Resolution Workflow
1. In `backend/app/main.py`, define your REST endpoint (e.g., `POST /finance/treasury/action`).
2. Add transaction status updates in `reconciliation.py` or ledger store.
3. In `frontend/app/page.tsx`:
   - Add the action button inside the **Treasury Action Center** or **3-Way Inspector Modal**.
   - Call the backend endpoint via `fetch(`${getApiBaseUrl()}/finance/treasury/action`, ...)`.
   - Update client state to reflect the resolved status immediately with visual feedback (toast/badge).
4. In `backend/app/services/excel_report_generator.py`, record the journal entry on Sheet 4 (`Treasury Adjustments`).

### Playbook D: Adding New Document Formats / Extraction Logic
1. Open `backend/app/agent/pdf_reconciler.py`.
2. If adding support for new receipt formats (e.g., thermal receipts or Excel purchase orders), add the parsing logic in `extract_document_text()`.
3. Ensure structured extraction leverages `ExtractedInvoiceList` Pydantic model with fields:
   - `invoice_ref`: str
   - `invoice_amount`: float
   - `invoice_date`: str (normalized to YYYY-MM-DD)
   - `description`: str
   - `status`: str
4. Add fallback to regex parser if LLM extraction fails.

---

## 6. Common Pitfalls & Debugging Checklist

| Symptom | Root Cause | Fix |
|---|---|---|
| **HTTP 500 on `/chat`** | `reconcile_settlements` raised `NameError` or returned unhandled `NaN` float | Ensure all DataFrames are initialized before `.to_dict()` and float values are sanitized to `None`. |
| **HTTP 422 on `/chat`** | Request payload key mismatch | Ensure request body is `{"query": "..."}` (not `{"message": "..."}`). |
| **DuckDB `BinderException`** | Date function called on string | DuckDB `strftime()` requires `DATE` or `TIMESTAMP`. If column is `VARCHAR`, cast with `TRY_CAST(col AS DATE)` or use column as-is. |
| **`UnicodeEncodeError` in Console** | Windows cp1252 terminal printing `₹` symbol | Wrap terminal prints with `.encode('utf-8', errors='replace')` or avoid raw printing of non-ASCII characters. |
| **Frontend Network Error on EC2** | Hardcoded `localhost:8000` | Ensure all API calls use `getApiBaseUrl()`, which dynamically resolves `${protocol}//${hostname}:8000`. |
| **ReportLab Font Missing `₹`** | Default Helvetica does not support Indian Rupee glyph | Always use `UNICODE_FONT` (`DejaVuSans`) registered via `pdfmetrics.registerFont`. |

---

## 7. Testing & Verification Runbook

### Step 1: Run Backend Unit Tests
```powershell
$env:PYTHONPATH="backend"
python -m unittest discover -s backend/tests -p "test_*.py" -v
```

### Step 2: Test Core Endpoints with Synthetic Client
```powershell
backend/venv/Scripts/python.exe -c "from fastapi.testclient import TestClient; from app.main import app; client = TestClient(app); print('API status:', client.get('/finance/list-datasets').status_code)"
```

### Step 3: Verify Frontend Production Build
```powershell
cd frontend
npm run build
```

### Step 4: Deploy Updates to AWS EC2
```bash
# On EC2 Ubuntu Host:
cd ~/reconciler
git pull origin main

# Rebuild frontend:
cd frontend
npm run build
pm2 restart all

# Restart backend:
cd ../backend
export PYTHONPATH=.
pkill -f uvicorn
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > backend.log 2>&1 &
```
