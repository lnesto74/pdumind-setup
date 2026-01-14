# Backend Dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    libffi-dev \
    libssl-dev \
    python3-dev \
    snmp \
    iputils-ping \
    netcat-openbsd \
    curl \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create non-root user
RUN useradd -m -u 1000 appuser && \
    mkdir -p /app/data /app/ml/models && \
    chown -R appuser:appuser /app

COPY --chown=appuser:appuser backend/requirements.txt .

# Configure pip for better reliability
RUN pip install --upgrade pip && \
    pip config set global.timeout 180 && \
    pip config set global.retries 10 && \
    pip install -r requirements.txt --no-cache-dir && \
    pip install requests==2.31.0 --no-cache-dir

COPY --chown=appuser:appuser backend .

USER appuser

ENV PYTHONUNBUFFERED=1
EXPOSE 5000

CMD ["python", "app.py"]
