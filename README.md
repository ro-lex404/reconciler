# Razorpay AI Finance Controller Engine 🚀

> **Track 04: AI Finance Controller** | *Razorpay Buildathon 2026*

Automated, multi-source financial reconciliation engine powered by **DuckDB**, **LangGraph**, **Groq Llama 3.3 70B**, and **ReportLab**.

---

## 🌟 Key Features

* **Sub-Millisecond Vectorized DuckDB Reconciliation**:
  * Multi-pass matching engine (**Exact**, **Fuzzy** with confidence scoring, and **Honest Exception Categorization**).
  * Sub-10ms processing across settlement CSVs and bank statements.
* **Stateful LangGraph PDF Extractor**:
  * Extracts multi-page invoice PDFs (`pypdf` + Groq Llama 3.3 70B with Pydantic schema enforcement).
  * Automatically reconciles extracted PDF invoice lines against bank statements.
* **Timestamped PDF Audit Report Export**:
  * One-click generation of audit reports via **ReportLab**.
  * Complete with live generation timestamps, TrueType Rupee symbol (`₹`) rendering, severity badges, and actionable resolution guidance.
* **Interactive AI Finance Controller Q&A Agent**:
  * Natural language Q&A interface with live reconciliation context memory injection.
  * Provides answers for unreconciled totals, transaction lookups (`REF1004`), exception filters, and **7-day Forward Cash Settlement Forecasting**.

---

## 🏗️ System Architecture

```
                               ┌───────────────────────────┐
                               │   Next.js Frontend (3000) │
                               └─────────────┬─────────────┘
                                             │
                                             ▼
                               ┌───────────────────────────┐
                               │   FastAPI Backend (8000)  │
                               └──────┬─────────────┬──────┘
                                      │             │
              ┌───────────────────────┘             └───────────────────────┐
              ▼                                                             ▼
┌───────────────────────────────┐                             ┌───────────────────────────────┐
│  DuckDB Vectorized Engine     │                             │   LangGraph Agent Pipeline    │
│  • Multi-Pass SQL Joins       │                             │   • Groq Llama 3.3 70B        │
│  • Fast In-Memory Analytics   │                             │   • PGVector Document Search  │
└───────────────────────────────┘                             └───────────────────────────────┘
```

---

## ⚡ Quickstart

### 1. Environment Configuration
Copy `.env.example` to `.env` and set your Groq API key:

```bash
cp .env.example .env
```

### 2. Launch via Docker Compose
```bash
docker compose up --build
```

Access the Web Application at `http://localhost:3000` and API docs at `http://localhost:8000/docs`.

---

## 📄 License
MIT License
