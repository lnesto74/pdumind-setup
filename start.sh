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

# Detect LAN IP for viewer share URL (Mac/Linux)
HUB_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "$HUB_IP" ]; then
  if [ -f .env ]; then
    grep -v '^HUB_LAN_IP=' .env | grep -v '^HUB_PORT=' > .env.tmp || true
    mv .env.tmp .env
  else
    touch .env
  fi
  echo "HUB_LAN_IP=$HUB_IP" >> .env
  echo "HUB_PORT=3000" >> .env
  echo "📡 Hub LAN IP: $HUB_IP"
fi

# Start containers
echo "🚀 Starting containers..."
docker compose up -d --build

# Wait for services to be healthy
echo "⏳ Waiting for services..."
sleep 3

# Check status
echo ""
echo "✅ PDUMind is running!"
echo ""
echo "   Frontend:  http://localhost:3000"
echo "   Viewer:    http://localhost:3000/view"
if [ -n "$HUB_IP" ]; then
  echo "   Share URL: http://${HUB_IP}:3000/view"
fi
echo "   Backend:   http://localhost:5002"
echo ""
echo "   To stop:   docker compose down"
echo "   Logs:      docker compose logs -f"
