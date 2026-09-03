# Project: Razorpay Reconciler

Autonomous Multi-Source Financial Reconciliation Engine: Period Deletion Management, Calendar Year Overflow Navigation, and Comprehensive 6-Class Exception Engine.

## Architecture
- **Backend**: FastAPI (`backend/app/main.py`), in-memory DuckDB (`backend/app/services/reconciliation.py`, `backend/app/services/duckdb_client.py`), LangGraph AI Agent & PDF Extractor (`backend/app/agent/router.py`, `backend/app/agent/pdf_reconciler.py`), PDF Audit Report Generator (`backend/app/services/pdf_report_generator.py`).
- **Frontend**: Next.js 16 App Router, React 19, Tailwind CSS v4 (`frontend/app/page.tsx`, `frontend/app/layout.tsx`, `frontend/app/globals.css`).
- **Data Storage**: `data/<year>/<month>/` statement batches containing `bank_statement.csv`, `razorpay_settlements.csv`, `invoices.pdf`.
- **Reconciliation Engine**: Vectorized multi-pass DuckDB SQL engine standardizing 6 industry anomaly classes (`AMOUNT_MISMATCH`, `DATE_MISMATCH`, `MISSING_BANK`, `MISSING_INVOICE`, `DUPLICATE`, `GHOST_CREDIT`) with strict mathematical invariant `Total == Matched + Exceptions`.

## Code Layout
- `backend/app/main.py`: FastAPI endpoints, router mounting, controller passcode security.
- `backend/app/services/reconciliation.py`: Dataset discovery, period deletion, 6-class DuckDB matching engine, invariant calculations, context summary.
- `backend/app/agent/pdf_reconciler.py`: LangGraph PDF invoice extraction & 6-class reconciliation against bank records.
- `backend/app/agent/router.py`: LangGraph AI Controller chatbot with active accounting period citations & invariant-preserving synthesis.
- `backend/app/services/pdf_report_generator.py`: PDF discrepancy audit report builder.
- `frontend/app/page.tsx`: UI Dashboard, Calendar period popover with horizontal scrollable year pills, Dataset Purge confirmation modal, KPI cards, AI Chat stream.
- `backend/tests/`: Automated test suite for backend API, DuckDB engine, and invariants.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | `DELETE /finance/dataset` API | Secure deletion endpoint with passcode `admin`, full batch or granular file removal | M1 | ORIGINAL_REQUEST R1 |
| 2 | Ingestion & DuckDB Sync | Automatic synchronization of file storage, active period fallback, and DuckDB queries | M1 | ORIGINAL_REQUEST R1 |
| 3 | Calendar Year Horizontal Scroll | Smooth horizontal scrollable year pill bar with `<` and `>` controls supporting 2018–2030+ | M2 | ORIGINAL_REQUEST R2 |
| 4 | Dataset Purge Confirmation Modal | Frontend modal for finance officers to purge datasets with scope selection and passcode verification | M2 | ORIGINAL_REQUEST R1, R2 |
| 5 | Calendar Badge & Table Refresh | Immediate UI state update of calendar presence indicators and DuckDB reconciliation tables on purge/switch | M2 | ORIGINAL_REQUEST R1 |
| 6 | Comprehensive 6-Class Exception Engine | Standardized anomaly classification: `AMOUNT_MISMATCH`, `DATE_MISMATCH`, `MISSING_BANK`, `MISSING_INVOICE`, `DUPLICATE`, `GHOST_CREDIT` across all services | M3 | ORIGINAL_REQUEST R3 |
| 7 | DuckDB SQL Fixes & Date Parsing | Fix BinderException in exception query and support datetime formats `%d-%m-%Y %H:%M` in date normalization | M3 | ORIGINAL_REQUEST R3 |
| 8 | Strict Mathematical Invariant | Strict enforcement of `Total Invoices / Transactions == Matched Records + Flagged Exceptions` across dashboard and chat | M4 | ORIGINAL_REQUEST R4 |
| 9 | AI Chatbot Active Period Citations | LangGraph chatbot responses citing active period datasets (`razorpay_settlements.csv`, `bank_statement.csv`) and anomaly classes | M4 | ORIGINAL_REQUEST R4 |
| 10| E2E Integration & Verification | 100% test pass rate across Tiers 1-4, `npm run build` with 0 errors, and adversarial coverage hardening | M5 / Final | Acceptance Criteria |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Backend Period Deletion Management | `DELETE /finance/dataset`, file deletion, passcode `admin`, DuckDB state sync | none | PLANNED |
| M2 | Frontend Calendar Scroll & Purge Modal | Year pill horizontal scroll (2018–2030+), purge confirmation modal, UI refresh | M1 | PLANNED |
| M3 | 6-Class Financial Exception Engine | Standardize 6 classes in `reconciliation.py`, `pdf_reconciler.py`, `router.py`, SQL fixes | none | PLANNED |
| M4 | Mathematical Invariant & AI Synthesis | `Total == Matched + Exceptions` invariant, explainable citations in AI Chatbot | M1, M3 | PLANNED |
| M5 | E2E Integration & Hardening | Full verification across all tiers, TypeScript build, adversarial testing | M1, M2, M3, M4 | PLANNED |

## Interface Contracts
### `DELETE /finance/dataset` Contract
- **Method**: `DELETE`
- **Path**: `/finance/dataset`
- **Request Body (JSON) / Query Parameters**:
  ```json
  {
    "passcode": "admin",
    "year": "2026",
    "month": "august",
    "file_type": "all" // options: "all", "bank", "razorpay", "invoice", or specific filename
  }
  ```
- **Responses**:
  - `401 Unauthorized`: `{"error": "Unauthorized: Invalid Finance Controller Passcode."}`
  - `400 Bad Request`: `{"error": "Missing required year or month."}`
  - `404 Not Found`: `{"error": "Dataset period or file not found."}`
  - `200 OK`:
    ```json
    {
      "status": "success",
      "deleted": { "year": "2026", "month": "august", "scope": "all", "deleted_paths": [...] },
      "active_period": { "year": "2026", "month": "july" },
      "datasets": [...]
    }
    ```

### 6-Class Anomaly Schema Contract
- Anomaly Types:
  1. `AMOUNT_MISMATCH`: Matching reference, amount variance > ₹1.00 (`variance` calculated as exact absolute difference).
  2. `DATE_MISMATCH`: Matching reference, amount within ₹1.00, settlement cleared > 2 days apart.
  3. `MISSING_BANK`: Ledger record exists, no bank credit found.
  4. `MISSING_INVOICE`: Bank credit entry has merchant reference, no ledger record found.
  5. `DUPLICATE`: Same merchant reference appears multiple times.
  6. `GHOST_CREDIT`: Unreferenced bank credit with no ledger record.

### Invariant Contract
- Ledger Invariant: `Total Ledger Transactions == Matched Records + Exceptions (AMOUNT_MISMATCH + DATE_MISMATCH + MISSING_BANK + DUPLICATE)`
- Bank Invariant: `Total Bank Entries == Matched Bank Entries + Exceptions (GHOST_CREDIT + MISSING_INVOICE + DUPLICATE)`
- Extracted Invoices Invariant: `Total Extracted Invoices == Matched Invoices + Flagged Exceptions`
