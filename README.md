# Razorpay AI Finance Controller & Reconciliation Engine 🚀

> **Track 04: AI Finance Controller — Run the books and the cash position**  
> *Razorpay Buildathon 2026*

An autonomous, multi-source financial reconciliation engine and AI Finance Controller powered by **DuckDB**, **LangGraph**, **Groq LLMs**, **PGVector**, and **ReportLab**.

---

## 🌟 Key Features

### 1. Vectorized Multi-Pass DuckDB Reconciliation Engine
* **Pass 1 — Exact Matching**: Instant matching on transaction reference ID and exact monetary amount ($\Delta < ₹0.01$).
* **Pass 2 — Fuzzy Matching**: Tolerant matching for gateway fee rounding ($\Delta \le ₹5.00$) and T+1/T+2 bank clearance date shifts with dynamic confidence scoring (65%–85%).
* **Pass 3 — Actionable Exception Categorization**:
  * `missing_bank_entry`: Gateway transaction with missing bank credit (T+1 delay check).
  * `amount_mismatch` & `date_mismatch`: Variance flagged for fee deduction/GST review.
  * `ghost_credit`: Bank credit with no corresponding gateway reference (flagged for compliance review).
* **Multi-Format Date Normalization**: Automatically handles `DD-MM-YYYY`, `DD/MM/YYYY`, and `YYYY-MM-DD` timestamps without casting failures.

### 2. Explainable AI (XAI) Source Attribution & Citations
* Every response from the AI Finance Controller cites the exact evidence used:
  * 📄 **Document Badges**: Direct page-level citations (e.g., `invoices_august.pdf (p. 1)`) with hoverable text snippets from PGVector.
  * 📊 **SQL Badges**: Cites active tabular datasets (e.g., `razorpay_settlements_august.csv`, `bank_statement_august.csv`).
* Zero hallucination proof for audit trails and compliance reviews.

### 3. Stateful LangGraph PDF Extractor & Reconciler
* Ingests multi-page invoice PDFs (`pypdf` + Groq LLM with structured Pydantic extraction).
* Dynamically reconciles extracted PDF invoice lines against bank settlements in DuckDB.
* Live memory injection synchronizes extracted invoice data directly into the agent's reasoning memory.

### 4. 7-Day Forward Cash Settlement Forecasting
* Automatically computes gross matched transaction volumes, gateway processing fees (2.0%), and applicable GST (18%).
* Projects upcoming net settlement inflows for next-week cash flow planning.

### 5. Official PDF Audit Report Generator
* One-click generation of professional executive reconciliation audit reports via **ReportLab**.
* Features TrueType Unicode Indian Rupee (`₹`) vector rendering, live generation timestamps, KPI summary metrics, and categorized exception tables.

---

## 🏗️ Architecture

```
                                 ┌───────────────────────────────┐
                                 │    Next.js 16 UI (Port 3000)  │
                                 │  Interactive Chat + Dashboard │
                                 └───────────────┬───────────────┘
                                                 │ HTTP / REST
                                                 ▼
                                 ┌───────────────────────────────┐
                                 │    FastAPI Backend (Port 8000)│
                                 │    Router + Endpoints         │
                                 └──────┬─────────────────┬──────┘
                                        │                 │
              ┌─────────────────────────┘                 └─────────────────────────┐
              ▼                                                                     ▼
┌───────────────────────────────┐                                     ┌───────────────────────────────┐
│     DuckDB In-Memory OLAP     │                                     │    LangGraph Agent Pipeline   │
│  • Multi-Pass Relational SQL  │                                     │  • Intent Router (20B)        │
│  • <10ms Query Execution      │                                     │  • Executive Synthesizer(120B)│
│  • Zero-Copy CSV Scanning     │                                     │  • Text-to-SQL Generation     │
└─────────────┬─────────────────┘                                     └───────────────┬───────────────┘
              │                                                                       │
              ▼                                                                       ▼
┌───────────────────────────────┐                                     ┌───────────────────────────────┐
│     Multi-Month Datasets      │                                     │      PostgreSQL + PGVector    │
│  • data/july/                 │                                     │  • 384-dim Dense Embeddings   │
│  • data/august/               │                                     │  • Chunk Metadata & Sources   │
└───────────────────────────────┘                                     └───────────────────────────────┘
```

---

## 📁 Repository Structure

```
razorpay-reconciler/
├── backend/
│   ├── app/
│   │   ├── agent/
│   │   │   ├── router.py               # LangGraph Router, SQL Node, RAG Node & Synthesizer
│   │   │   └── pdf_reconciler.py       # LangGraph PDF Extraction & Reconciliation Workflow
│   │   ├── services/
│   │   │   ├── reconciliation.py       # Vectorized DuckDB Multi-Pass Matching Engine
│   │   │   └── pdf_report_generator.py # ReportLab PDF Audit Report Generator
│   │   ├── worker.py                   # Celery Worker for Background Vector Ingestion
│   │   └── main.py                     # FastAPI REST API Endpoints
│   ├── generate_monthly_data.py        # Automated Dataset Generator for any Month
│   ├── Dockerfile                      # Backend Container Definition
│   └── requirements.txt                # Python Dependencies
│
├── frontend/
│   ├── app/
│   │   ├── page.tsx                    # Dual-Tab Dashboard (Reconciler + AI Agent Chat)
│   │   └── layout.tsx                  # Root Next.js Layout
│   ├── Dockerfile                      # Frontend Container Definition
│   └── package.json                    # Node Dependencies
│
├── data/
│   ├── july/                           # July 2026 Dataset (PDFs, Razorpay CSVs, Bank CSVs)
│   └── august/                         # August 2026 Dataset (PDFs, Razorpay CSVs, Bank CSVs)
│
├── .github/workflows/
│   └── ci.yml                          # GitHub Actions CI Pipeline (Python Tests + Next.js Build)
├── docker-compose.yml                  # Full-Stack Multi-Container Orchestration
├── .env.example                        # Environment Variable Template
└── README.md                           # Documentation
```

---

## ⚡ Quickstart Guide

### Prerequisites
* [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Docker Compose v2+)
* [Groq API Key](https://console.groq.com/keys)

### 1. Clone & Configure Environment
```bash
git clone https://github.com/ro-lex404/razorpay-reconciler.git
cd razorpay-reconciler
cp .env.example .env
```
Edit `.env` and add your Groq API key:
```env
GROQ_API_KEY=gsk_your_groq_api_key_here
```

### 2. Launch with Docker Compose
```bash
docker compose up --build
```

### 3. Open the Application
* **Frontend Web Dashboard**: `http://localhost:3000`
* **Interactive Swagger API Docs**: `http://localhost:8000/docs`

---

## 🧪 Testing & Verification

### Running the CI Pipeline Locally
```bash
# Backend Test & Reconciliation Verification
cd backend
python -c "from app.services.reconciliation import reconcile_settlements, resolve_finance_dataset_paths; rp, bk = resolve_finance_dataset_paths(); res = reconcile_settlements(rp, bk); print('Reconciliation OK. Matched:', res['matched_transactions'], 'Rate:', res['match_rate'])"

# Frontend Build & Typecheck
cd ../frontend
npm run build
```

---

## 💡 Suggested Prompt Inquiries

In the **AI Agent Chat** tab, test queries such as:
1. `"What's the total unreconciled amount?"`
2. `"Why was REF1004 flagged?"`
3. `"Show me all exceptions above ₹1,000"`
4. `"What is the projected settlement inflow next week?"`
5. `"Why was REF2004 flagged in August?"`

---

## 📄 License
MIT License. Built for the Razorpay Buildathon 2026 (Track 04: AI Finance Controller).
