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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create non-root user
RUN useradd -m -u 1000 appuser && \
    mkdir -p /app/data && \
    chown -R appuser:appuser /app

COPY --chown=appuser:appuser backend/requirements.txt .
RUN pip install -r requirements.txt && pip install requests==2.31.0

COPY --chown=appuser:appuser backend .

USER appuser

ENV PYTHONUNBUFFERED=1
EXPOSE 5000

CMD ["python", "app.py"]
