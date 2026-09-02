from typing import TypedDict, Literal
from pydantic import BaseModel, Field
from langgraph.graph import StateGraph, START, END
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_groq import ChatGroq
try:
    from langchain_huggingface import HuggingFaceEmbeddings
except ModuleNotFoundError:
    from langchain_community.embeddings import FakeEmbeddings as HuggingFaceEmbeddings
from langchain_community.vectorstores import PGVector
from app.services.duckdb_client import execute_text_to_sql
import os
import glob
from pathlib import Path
import duckdb

# ==========================================
# 1. Define the State and Expected Output
# ==========================================

print("Loading HuggingFace Embeddings into API memory...")
try:
    embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2", encode_kwargs={"batch_size": 32})
except Exception:
    embeddings = HuggingFaceEmbeddings(size=384)

DB_URL = os.getenv("DATABASE_URL", "postgresql+psycopg2://myuser:mypassword@db:5432/hybrid_ai")
COLLECTION_NAME = "enterprise_documents"

class AgentState(TypedDict):
    question: str
    route_decision: str
    reconciliation_context: str
    sql_result: str
    rag_context: str
    sources: list[dict]
    final_answer: str

class RouteDecision(BaseModel):
    """Pydantic model to force the LLM to output a strict JSON structure."""
    decision: Literal["sql", "rag", "both", "general"] = Field(
        description="Choose 'sql' for numerical/tabular data analysis, 'rag' for document context, 'both' if the query needs both, or 'general' for conversational greetings."
    )

class SQLQueryOutput(BaseModel):
    """Forces the LLM to output only the SQL query."""
    sql_query: str = Field(
        description="A valid DuckDB SQL query string. Do not include markdown formatting or explanations."
    )

# ==========================================
# 2. Define the Nodes (The Actions)
# ==========================================

def router_node(state: AgentState):
    """Analyzes the question and decides the routing path."""
    groq_api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not groq_api_key:
        return {"route_decision": "both"}

    try:
        llm = ChatGroq(model="openai/gpt-oss-20b", temperature=0, groq_api_key=groq_api_key)
        structured_llm = llm.with_structured_output(RouteDecision)

        system_prompt = """You are an intelligent routing agent for an enterprise platform. 
        You have access to two data sources:
        1. A SQL database (CSVs/Tabular data containing metrics, sales, rows, columns).
        2. A Vector database (PDFs/Documents containing text, reports, unstructured context).
        Analyze the user's query and decide which data source is needed."""

        result = structured_llm.invoke([
            SystemMessage(content=system_prompt),
            HumanMessage(content=state["question"])
        ])
        return {"route_decision": result.decision}
    except Exception as e:
        print(f"Router node LLM warning: {e}. Defaulting to 'both'.")
        return {"route_decision": "both"}


def sql_node(state: AgentState):
    """Generates SQL, executes it via DuckDB on active financial datasets, and returns the result with source metadata."""
    print("--- ROUTED TO SQL ENGINE ---")
    question = state.get("question", "")

    csv_file_path = ""
    try:
        from app.services.reconciliation import resolve_finance_dataset_paths
        rp_path, bk_path = resolve_finance_dataset_paths(hint_filename=question)
        if rp_path.exists() and rp_path.is_file():
            csv_file_path = str(rp_path)
        elif bk_path.exists() and bk_path.is_file():
            csv_file_path = str(bk_path)
    except Exception:
        csv_file_path = ""

    if not csv_file_path or not os.path.exists(csv_file_path):
        return {"sql_result": "No CSV statement dataset found for active accounting period.", "sources": []}
        
    csv_name = f"{Path(csv_file_path).parent.parent.name}/{Path(csv_file_path).parent.name}/{os.path.basename(csv_file_path)}" if Path(csv_file_path).parent.name in ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"] else os.path.basename(csv_file_path)
    sources = [{"type": "sql", "name": csv_name, "engine": "DuckDB SQL Engine"}]
    
    try:
        con = duckdb.connect(database=':memory:')
        schema_df = con.execute(f"DESCRIBE SELECT * FROM read_csv_auto('{csv_file_path}')").df()
        con.close()
        
        table_schema = "Columns:\n"
        for _, row in schema_df.iterrows():
            table_schema += f"- {row['column_name']} ({row['column_type']})\n"
    except Exception as e:
        return {"sql_result": f"Error reading CSV schema: {str(e)}", "sources": sources}

    groq_api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not groq_api_key:
        return {"sql_result": "Groq API key not set for dynamic text-to-sql generation.", "sources": sources}

    system_prompt = """You are a DuckDB SQL expert. 
    Your job is to write a SQL query that answers the user's question.
    
    CRITICAL RULES:
    1. You MUST query the table named exactly: user_data
    2. Only use the columns listed in the schema below. Do not hallucinate columns.
    3. Use DuckDB syntax (e.g., ILIKE for case-insensitive matching).
    4. Return ONLY the SQL string.
    
    SCHEMA:
    {schema}
    """
    
    prompt = ChatPromptTemplate.from_messages([
        ("system", system_prompt),
        ("human", "{question}")
    ])
    
    try:
        llm = ChatGroq(model="openai/gpt-oss-120b", temperature=0, groq_api_key=groq_api_key)
        structured_llm = llm.with_structured_output(SQLQueryOutput)
        
        chain = prompt | structured_llm
        llm_response = chain.invoke({
            "schema": table_schema,
            "question": state["question"]
        })
        
        generated_sql = llm_response.sql_query
        execution_result = execute_text_to_sql(csv_file_path, generated_sql)
        return {"sql_result": str(execution_result), "sources": sources}
    except Exception as e:
        return {"sql_result": f"SQL generation warning: {str(e)}", "sources": sources}


def rag_node(state: AgentState):
    """Searches PostgreSQL for relevant document chunks and extracts source citations."""
    print("--- RETRIEVING DOCUMENT CONTEXT ---")
    question = state["question"]
    sources = []
    
    try:
        vectorstore = PGVector(
            collection_name=COLLECTION_NAME,
            connection_string=DB_URL,
            embedding_function=embeddings,
        )
        retriever = vectorstore.as_retriever(search_kwargs={"k": 4})
        docs = retriever.invoke(question)
        rag_context = "\n\n---\n\n".join([doc.page_content for doc in docs])
        if not rag_context:
            rag_context = "No relevant documents found in PGVector store."

        seen = set()
        for doc in docs:
            file_name = doc.metadata.get("source_file", "Document")
            page_num = doc.metadata.get("page_number", 1)
            key = f"{file_name}:{page_num}"
            if key not in seen:
                seen.add(key)
                sources.append({
                    "type": "document",
                    "name": file_name,
                    "page": page_num,
                    "snippet": doc.page_content[:120] + "..." if len(doc.page_content) > 120 else doc.page_content
                })

        return {"rag_context": rag_context, "sources": sources}
    except Exception as e:
        return {"rag_context": f"PGVector store notice: {str(e)}", "sources": []}


def both_node(state: AgentState):
    """Runs SQL + RAG collection in one node and combines source citations."""
    sql_output = sql_node(state)
    rag_output = rag_node(state)
    combined_sources = sql_output.get("sources", []) + rag_output.get("sources", [])
    return {**sql_output, **rag_output, "sources": combined_sources}


def synthesizer_node(state: AgentState):
    """Combines live reconciliation metrics, DuckDB SQL results, and RAG document context into a final executive answer with sources."""
    print("--- SYNTHESIZING FINAL ANSWER ---")

    sql_data = state.get("sql_result", "")
    rag_data = state.get("rag_context", "")
    reconciliation_context = state.get("reconciliation_context", "")
    sources = state.get("sources", [])
    question = state.get("question", "")

    # Ensure active monthly settlement datasets are cited only if dataset files exist on disk
    if reconciliation_context and "No reconciliation dataset" not in reconciliation_context:
        try:
            from app.services.reconciliation import resolve_finance_dataset_paths
            rp_path, bk_path = resolve_finance_dataset_paths(hint_filename=question)
            if rp_path.exists() and rp_path.is_file() and not any(s.get("name") == rp_path.name for s in sources):
                sources.append({"type": "sql", "name": rp_path.name, "engine": "DuckDB SQL Engine"})
            if bk_path.exists() and bk_path.is_file() and not any(s.get("name") == bk_path.name for s in sources):
                sources.append({"type": "sql", "name": bk_path.name, "engine": "DuckDB SQL Engine"})
        except Exception:
            pass

    groq_api_key = os.getenv("GROQ_API_KEY", "").strip()

    if groq_api_key:
        try:
            llm = ChatGroq(model="openai/gpt-oss-120b", temperature=0.1, groq_api_key=groq_api_key)
            system_prompt = """You are an intelligent, executive AI Finance Controller for the Razorpay Financial Reconciliation Engine.
Your goal is to provide concise, direct, professional, and mathematically accurate answers regarding reconciliation metrics, exceptions, transaction references, unreconciled totals, and cash flow forecasting.

CRITICAL INSTRUCTIONS:
1. Answer the question directly without repeating or echoing the user's prompt (NEVER output "Question: ...", "AI Finance Controller Audit Response", or boilerplate headers).
2. ALWAYS format monetary amounts with the Indian Rupee symbol (₹) (e.g., ₹54,272.43).
3. Keep responses clean, concise, and executive. Use bullet points or small markdown tables.
4. DO NOT dump raw Python dictionaries, bracketed lists, or raw JSON data unless the user explicitly asks to "dump raw records" or "show raw JSON".
5. When asked to summarize a batch or period, provide an executive KPI summary with match rate, exception counts by type, and cash flow projections.
6. If asked about a specific transaction reference (e.g., REF1004), state its exact amount, date, exception type, and actionable remediation steps.
"""

            human_prompt = f"""USER QUESTION: {question}

--- LIVE RECONCILIATION DATA & METRICS ---
{reconciliation_context}

--- TABULAR DATA (DUCKDB SQL) ---
{sql_data}

--- DOCUMENT CONTEXT (PGVECTOR RAG) ---
{rag_data}
"""

            response = llm.invoke(
                [SystemMessage(content=system_prompt), HumanMessage(content=human_prompt)],
                config={"tags": ["final_node"]}
            )
            return {"final_answer": response.content, "sources": sources}
        except Exception as e:
            print(f"Synthesizer LLM warning: {e}")

    # Clean executive fallback response if GROQ_API_KEY is not configured or fails
    fallback_text = f"### 📊 Reconciliation Summary\n\n{reconciliation_context}" if reconciliation_context else "No active reconciliation dataset found for this query period."
    return {"final_answer": fallback_text, "sources": sources}


# ==========================================
# 3. Build the LangGraph Workflow
# ==========================================

builder = StateGraph(AgentState)

builder.add_node("router", router_node)
builder.add_node("sql", sql_node)
builder.add_node("rag", rag_node)
builder.add_node("both", both_node)
builder.add_node("synthesizer", synthesizer_node)

builder.add_edge(START, "router")

builder.add_conditional_edges(
    "router",
    lambda state: state["route_decision"],
    {
        "sql": "sql",
        "rag": "rag",
        "both": "both",
        "general": "synthesizer"
    }
)

builder.add_edge("sql", "synthesizer")
builder.add_edge("rag", "synthesizer")
builder.add_edge("both", "synthesizer")
builder.add_edge("synthesizer", END)

app = builder.compile()