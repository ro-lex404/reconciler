# E2E Test Infra: Razorpay Reconciler

## Test Philosophy
- Opaque-box and requirement-driven testing.
- Verification methodology: Category-Partition + Boundary Value Analysis + Pairwise Combinations + Real-World Workload Testing.
- Python `unittest` test suite + `httpx` / `TestClient` for backend APIs and DuckDB reconciliation queries.
- Next.js Turbopack build + TypeScript typechecking for frontend.

## Feature Inventory & Test Coverage
| # | Feature | Source (Requirement) | Tier 1 (Coverage) | Tier 2 (Boundary) | Tier 3 (Pairwise) | Tier 4 (Scenario) |
|---|---------|---------------------|:-----------------:|:-----------------:|:-----------------:|:-----------------:|
| 1 | `DELETE /finance/dataset` | ORIGINAL_REQUEST R1 | 5 | 5 | Yes | Yes |
| 2 | Ingestion & DuckDB Sync | ORIGINAL_REQUEST R1 | 5 | 5 | Yes | Yes |
| 3 | Calendar Year Horizontal Scroll | ORIGINAL_REQUEST R2 | 5 | 5 | Yes | Yes |
| 4 | Dataset Purge Modal UI | ORIGINAL_REQUEST R1 | 5 | 5 | Yes | Yes |
| 5 | Calendar Badge & Table Refresh | ORIGINAL_REQUEST R1 | 5 | 5 | Yes | Yes |
| 6 | 6-Class Exception Engine | ORIGINAL_REQUEST R3 | 5 | 5 | Yes | Yes |
| 7 | DuckDB SQL & Date Normalization | ORIGINAL_REQUEST R3 | 5 | 5 | Yes | Yes |
| 8 | Mathematical Invariant | ORIGINAL_REQUEST R4 | 5 | 5 | Yes | Yes |
| 9 | AI Chatbot Citations & Period | ORIGINAL_REQUEST R4 | 5 | 5 | Yes | Yes |

## Test Architecture
- **Backend Test Runner**: `venv/Scripts/python.exe -m unittest discover -s backend/tests -p "test_*.py" -v`
- **Frontend Test Runner**: `cd frontend && npm run build`
- **Test Directory Layout**:
  - `backend/tests/test_dataset_api.py`: Tests `DELETE /finance/dataset`, passcode verification (`admin`), 401 on invalid passcode, single file deletion, full monthly batch deletion, and DuckDB dataset state refresh.
  - `backend/tests/test_reconciliation_duckdb.py`: Tests standard 6-class exception classification (`AMOUNT_MISMATCH`, `DATE_MISMATCH`, `MISSING_BANK`, `MISSING_INVOICE`, `DUPLICATE`, `GHOST_CREDIT`), date normalization, timestamp formats (`%d-%m-%Y %H:%M`), variance calculations, and binder fix.
  - `backend/tests/test_mathematical_invariant.py`: Tests `Total == Matched + Exceptions` invariant across multiple periods, edge case datasets, and AI context generator summaries.
  - `backend/tests/test_e2e_integration.py`: End-to-end multi-period workflow testing: upload -> reconcile -> chat synthesis -> purge -> state refresh.

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Corrupted Statement Purge & Re-ingestion | Deletion API, Passcode Auth, DuckDB Sync, Calendar Badge Refresh | High |
| 2 | Multi-Year Historical Navigation (2018–2030) | Calendar Year Horizontal Scroll, Period Switching, Active Month State | Medium |
| 3 | High-Volume Multi-Anomaly Audit Batch | 6-Class Exception Engine, Date Parsing, Variance Calculation | High |
| 4 | Accounting Invariant Balance & AI Chatbot Reconciliation | Mathematical Invariant, Citations, Explainable Chatbot Synthesis | High |
| 5 | Granular Single-File Removal in Active Period | Granular File Purge, Fallback Active Period, Partial Presence Indicator | Medium |
