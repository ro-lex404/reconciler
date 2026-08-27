import os
from celery import Celery
from langchain_community.document_loaders import CSVLoader
from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_community.vectorstores import PGVector

# ==========================================
# 1. Environment & Connections
# ==========================================
redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
celery_app = Celery(__name__, broker=redis_url, backend=redis_url)

# The Database URL uses the psycopg2 driver for SQLAlchemy
DB_URL = os.getenv("DATABASE_URL", "postgresql+psycopg2://myuser:mypassword@db:5432/hybrid_ai")

# The name of the table pgvector will create to store your chunks
COLLECTION_NAME = "enterprise_documents"

@celery_app.task(name="process_document")
def process_document_task(file_path: str, filename: str):
    """
    Background task to process files using free local embeddings.
    """
    print(f"Starting background processing for: {filename}")

    if not os.path.exists(file_path):
        message = f"File not found for Celery processing: {file_path}"
        print(message)
        return {"status": "Error", "message": message}

    # Compute embeddings once per task, then reuse for PDF/CSV branches.
    embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
    lower_filename = filename.lower()
    
    if lower_filename.endswith(".pdf"):
        try:
            # ==========================================
            # 2. Load the PDF
            # ==========================================
            print("Loading PDF...")
            loader = PyPDFLoader(file_path)
            documents = loader.load()
            
            # ==========================================
            # 3. Chunk the Text with Header Prepending
            # ==========================================
            print("Chunking text with financial boundary preservation...")
            text_splitter = RecursiveCharacterTextSplitter(
                chunk_size=500,
                chunk_overlap=100,
                length_function=len
            )
            chunks = text_splitter.split_documents(documents)
            
            for idx, chunk in enumerate(chunks):
                page_num = chunk.metadata.get("page", 0) + 1
                # Prepend document identity to chunk content for vector grounding
                chunk.page_content = f"Document: {filename} (Page {page_num})\nContent:\n{chunk.page_content}"
                chunk.metadata["source_file"] = filename
                chunk.metadata["page_number"] = page_num
                chunk.metadata["chunk_id"] = f"{filename}_chunk_{idx}"
                chunk.metadata["file_type"] = "pdf"
            
            # ==========================================
            # 4. Local Embeddings & Vector Storage
            # ==========================================
            print(f"Generating embeddings for {len(chunks)} contextual chunks and saving to PGVector...")
            
            PGVector.from_documents(
                embedding=embeddings,
                documents=chunks,
                collection_name=COLLECTION_NAME,
                connection_string=DB_URL,
            )
            
            print(f"Successfully processed and stored {filename}")
            return {"status": "Success", "chunks_inserted": len(chunks)}
            
        except Exception as e:
            print(f"Error processing PDF: {str(e)}")
            return {"status": "Error", "message": str(e)}

    elif lower_filename.endswith(".csv"):
        try:
            print("Loading CSV...")
            loader = CSVLoader(file_path=file_path)
            documents = loader.load()

            print("Chunking CSV rows...")
            text_splitter = RecursiveCharacterTextSplitter(
                chunk_size=800,
                chunk_overlap=100,
                length_function=len,
            )
            chunks = text_splitter.split_documents(documents)

            for chunk in chunks:
                chunk.metadata["source_file"] = filename
                chunk.metadata["source_type"] = "csv"

            print(f"Generating local embeddings for {len(chunks)} CSV chunks and saving to pgvector...")
            PGVector.from_documents(
                embedding=embeddings,
                documents=chunks,
                collection_name=COLLECTION_NAME,
                connection_string=DB_URL,
            )

            print(f"Successfully processed and stored CSV {filename}")
            return {"status": "Success", "chunks_inserted": len(chunks)}

        except Exception as e:
            print(f"Error processing CSV: {str(e)}")
            return {"status": "Error", "message": str(e)}

    else:
        message = f"Unsupported file type for {filename}. Only PDF and CSV are accepted."
        print(message)
        return {"status": "Error", "message": message}