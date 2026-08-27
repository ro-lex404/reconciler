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
import duckdb

# ==========================================
# 1. Define the State and Expected Output
# ==========================================

print("Loading HuggingFace Embeddings into API memory...")
try:
    embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
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
    """Generates SQL, executes it via DuckDB, and returns the result."""
    print("--- ROUTED TO SQL ENGINE ---")
    
    upload_dir = "/app/uploads"
    list_of_csvs = glob.glob(os.path.join(upload_dir, "*.csv"))
    
    if not list_of_csvs:
        return {"sql_result": "No dynamic CSV files found in upload directory."}
        
    csv_file_path = max(list_of_csvs, key=os.path.getctime)
    
    try:
        con = duckdb.connect(database=':memory:')
        schema_df = con.execute(f"DESCRIBE SELECT * FROM read_csv_auto('{csv_file_path}')").df()
        con.close()
        
        table_schema = "Columns:\n"
        for _, row in schema_df.iterrows():
            table_schema += f"- {row['column_name']} ({row['column_type']})\n"
    except Exception as e:
        return {"sql_result": f"Error reading CSV schema: {str(e)}"}

    groq_api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not groq_api_key:
        return {"sql_result": "Groq API key not set for dynamic text-to-sql generation."}

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
        return {"sql_result": str(execution_result)}
    except Exception as e:
        return {"sql_result": f"SQL generation warning: {str(e)}"}


def rag_node(state: AgentState):
    """Searches PostgreSQL for relevant document chunks."""
    print("--- RETRIEVING DOCUMENT CONTEXT ---")
    question = state["question"]
    
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
        return {"rag_context": rag_context}
    except Exception as e:
        return {"rag_context": f"PGVector store notice: {str(e)}"}


def both_node(state: AgentState):
    """Runs SQL + RAG collection in one node so synthesis executes exactly once."""
    sql_output = sql_node(state)
    rag_output = rag_node(state)
    return {**sql_output, **rag_output}


def synthesizer_node(state: AgentState):
    """Combines live reconciliation metrics, DuckDB SQL results, and RAG document context into a final executive answer."""
    print("--- SYNTHESIZING FINAL ANSWER ---")

    sql_data = state.get("sql_result", "")
    rag_data = state.get("rag_context", "")
    reconciliation_context = state.get("reconciliation_context", "")
    question = state["question"]

    groq_api_key = os.getenv("GROQ_API_KEY", "").strip()

    if groq_api_key:
        try:
            llm = ChatGroq(model="openai/gpt-oss-120b", temperature=0.1, groq_api_key=groq_api_key)
            system_prompt = """You are an intelligent AI Finance Controller for the Razorpay Financial Reconciliation Engine.
Your goal is to provide precise, professional, and mathematically accurate answers regarding live reconciliation metrics, faulty exceptions, merchant references, unreconciled totals, and forward cash flow forecasting.

CRITICAL RULES:
1. ALWAYS format monetary amounts using the Indian Rupee symbol (₹) (e.g. ₹54,272.43).
2. Answer questions about reconciliation results precisely using the LIVE RECONCILIATION DATA provided.
3. If asked about a specific transaction reference (e.g., REF1004), cite its exact reference ID, amount, date, exception type, severity, and recommended resolution action.
4. If asked for unreconciled totals or threshold filters (e.g., exceptions above ₹1,000), calculate or list the matching transactions directly from the data.
5. If asked about projected settlement inflow or cash forecasting, state the projected settlement totals for upcoming clearance windows.
6. Do not invent or hallucinate transaction IDs not present in the data.
7. Format responses using clean Markdown (bold text, bullet points, or small markdown tables).
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
            return {"final_answer": response.content}
        except Exception as e:
            print(f"Synthesizer LLM warning: {e}")

    # Fallback response formatting if GROQ_API_KEY is not configured
    return {"final_answer": f"### AI Finance Controller Audit Response\n\n**Question:** {question}\n\n**Live Reconciliation Data:**\n\n{reconciliation_context}"}


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