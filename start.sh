#!/bin/bash
# PDUMind Telemetry - Start Script
# Usage: ./start.sh

set -e

cd "$(dirname "$0")"

echo "🔌 Starting PDUMind Telemetry..."

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "⏳ Docker not running. Starting Docker Desktop..."
    open -a Docker
    
    # Wait for Docker to be ready (max 60 seconds)
    echo "   Waiting for Docker to start..."
    for i in {1..60}; do
        if docker info > /dev/null 2>&1; then
            echo "   Docker is ready!"
            break
        fi
        sleep 1
    done
    
    if ! docker info > /dev/null 2>&1; then
        echo "❌ Docker failed to start. Please start Docker manually."
        exit 1
    fi
fi

# Start containers
echo "🚀 Starting containers..."
docker compose up -d

# Wait for services to be healthy
echo "⏳ Waiting for services..."
sleep 3

# Check status
echo ""
echo "✅ PDUMind is running!"
echo ""
echo "   Frontend:  http://localhost:3000"
echo "   Backend:   http://localhost:5002"
echo ""
echo "   To stop:   docker compose down"
echo "   Logs:      docker compose logs -f"
