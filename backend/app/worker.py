import os

try:
    from celery import Celery
    HAS_CELERY = True
except ImportError:
    HAS_CELERY = False
    Celery = None

try:
    from langchain_community.document_loaders import CSVLoader, PyPDFLoader
    from langchain_text_splitters import RecursiveCharacterTextSplitter
    HAS_LOADERS = True
except ImportError:
    HAS_LOADERS = False

try:
    from langchain_huggingface import HuggingFaceEmbeddings
except Exception:
    try:
        from langchain_community.embeddings import HuggingFaceEmbeddings
    except Exception:
        HuggingFaceEmbeddings = None

try:
    from langchain_community.vectorstores import PGVector
except Exception:
    PGVector = None

# ==========================================
# 1. Environment & Connections
# ==========================================
redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
celery_app = Celery(__name__, broker=redis_url, backend=redis_url) if HAS_CELERY else None

# The Database URL uses the psycopg2 driver for SQLAlchemy
DB_URL = os.getenv("DATABASE_URL", "postgresql+psycopg2://myuser:mypassword@db:5432/hybrid_ai")

# The name of the table pgvector will create to store your chunks
COLLECTION_NAME = "enterprise_documents"

if HAS_CELERY:
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

        # Compute embeddings once per task with CPU SIMD batching for fast vectorization
        if HuggingFaceEmbeddings:
            try:
                embeddings = HuggingFaceEmbeddings(
                    model_name="all-MiniLM-L6-v2",
                    encode_kwargs={"batch_size": 32}
                )
            except Exception:
                embeddings = HuggingFaceEmbeddings(size=384) if hasattr(HuggingFaceEmbeddings, 'size') else None
        else:
            embeddings = None

        lower_filename = filename.lower()
        
        if lower_filename.endswith(".pdf"):
            try:
                # ==========================================
                # 2. Load the PDF
                # ==========================================
                print("Loading PDF...")
                if HAS_LOADERS:
                    loader = PyPDFLoader(file_path)
                    documents = loader.load()
                    
                    # ==========================================
                    # 3. Chunk the Text with Header Prepending
                    # ==========================================
                    print("Chunking text with financial boundary preservation...")
                    text_splitter = RecursiveCharacterTextSplitter(
                        chunk_size=1200,
                        chunk_overlap=200,
                        length_function=len
                    )
                    chunks = text_splitter.split_documents(documents)
                    
                    for chunk in chunks:
                        chunk.page_content = f"Document: {filename}\nType: Invoices & Receipts\n\n" + chunk.page_content
                        chunk.metadata["filename"] = filename
                        chunk.metadata["type"] = "invoice_pdf"
                        
                    # ==========================================
                    # 4. Save Embeddings in PGVector
                    # ==========================================
                    if PGVector and embeddings:
                        print("Saving PDF vectors to PGVector database...")
                        PGVector.from_documents(
                            documents=chunks,
                            embedding=embeddings,
                            collection_name=COLLECTION_NAME,
                            connection_string=DB_URL,
                            pre_delete_collection=False
                        )
                        print("PDF vectors committed successfully!")
                return {"status": "Success", "filename": filename, "type": "pdf"}
            except Exception as e:
                print(f"Error during PDF processing: {e}")
                return {"status": "Error", "message": str(e)}
                
        elif lower_filename.endswith(".csv"):
            try:
                print("Loading CSV...")
                if HAS_LOADERS:
                    loader = CSVLoader(file_path=file_path)
                    documents = loader.load()
                    
                    # Add financial context header to CSV chunks
                    for doc in documents:
                        doc.page_content = f"Source CSV: {filename}\nLedger Context: Razorpay Settlement & Bank Record\n" + doc.page_content
                        doc.metadata["filename"] = filename
                        doc.metadata["type"] = "tabular_csv"
                        
                    if PGVector and embeddings:
                        print("Saving CSV vectors to PGVector database...")
                        PGVector.from_documents(
                            documents=documents,
                            embedding=embeddings,
                            collection_name=COLLECTION_NAME,
                            connection_string=DB_URL,
                            pre_delete_collection=False
                        )
                        print("CSV vectors committed successfully!")
                return {"status": "Success", "filename": filename, "type": "csv"}
            except Exception as e:
                print(f"Error during CSV processing: {e}")
                return {"status": "Error", "message": str(e)}
        else:
            print(f"Unsupported file format for embeddings: {filename}")
            return {"status": "Skipped", "message": "Unsupported file format"}

else:
    class _DummyTask:
        def delay(self, *args, **kwargs):
            print(f"Celery not installed; skipping background vector task: {args}")
        def __call__(self, *args, **kwargs):
            return self.delay(*args, **kwargs)
    process_document_task = _DummyTask()