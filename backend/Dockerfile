FROM python:3.13-slim

WORKDIR /app

# Install system dependencies required for PostgreSQL connections
RUN apt-get update && apt-get install -y gcc libpq-dev && rm -rf /var/lib/apt/lists/*

# Copy requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code
COPY . .

# Default command for the FastAPI container
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]