#!/bin/bash
# Mac-only demo setup — enables simulated PDU cage for presentations.
# NOT for Agoda/customer deployment. Requires PDUMIND_DEMO_ENABLED=1 in .env.
set -e
cd "$(dirname "$0")/.."

echo "🎭 PDUMind Demo Setup (Mac local only)"
echo ""

# Enable demo mode in local .env (gitignored — never pushed)
ENV_FILE=".env"
touch "$ENV_FILE"
grep -v '^PDUMIND_DEMO_ENABLED=' "$ENV_FILE" 2>/dev/null | grep -v '^DEMO_USERNAME=' | grep -v '^DEMO_PASSWORD=' > "$ENV_FILE.tmp" || true
cat >> "$ENV_FILE.tmp" <<EOF
PDUMIND_DEMO_ENABLED=1
DEMO_USERNAME=demo
DEMO_PASSWORD=demo
EOF
mv "$ENV_FILE.tmp" "$ENV_FILE"

# LAN IP for share URL
HUB_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")
if [ -n "$HUB_IP" ]; then
  grep -v '^HUB_LAN_IP=' "$ENV_FILE" | grep -v '^HUB_PORT=' > "$ENV_FILE.tmp2" || true
  echo "HUB_LAN_IP=$HUB_IP" >> "$ENV_FILE.tmp2"
  echo "HUB_PORT=3000" >> "$ENV_FILE.tmp2"
  mv "$ENV_FILE.tmp2" "$ENV_FILE"
fi

echo "✓ Demo mode enabled in .env (local only)"
echo ""
echo "Building and starting..."
docker compose up -d --build

echo ""
echo "Waiting for backend..."
sleep 6

docker compose exec -T backend python -c "
from demo.seed import setup_demo_environment
setup_demo_environment(force_seed=True)
print('Demo environment ready')
"

echo ""
echo "============================================"
echo "  DEMO READY"
echo "============================================"
echo ""
echo "  Login:     demo / demo"
echo "  App:       http://localhost:3000"
echo "  Viewer:    http://localhost:3000/view"
if [ -n "$HUB_IP" ]; then
  echo "  Share URL: http://${HUB_IP}:3000/view"
fi
echo ""
echo "  DEMO FLOW:"
echo "  1. Login as demo"
echo "  2. Commission PDU → Batch tab"
echo "  3. Scan subnet: 10.99.1.0/28  (finds 8 simulated PDUs)"
echo "  4. Configure template → Preview → Deploy"
echo "  5. Open /view for Fleet Command Center"
echo ""
echo "  To disable demo: remove PDUMIND_DEMO_ENABLED from .env and restart"
echo "  Admin login (admin) uses your REAL database — unaffected"
echo ""
