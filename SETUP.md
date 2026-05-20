# PDUMind Setup Guide

## Architecture Overview

PDUMind uses a **hybrid architecture** on macOS:

```
┌─────────────────────────────────────────────────────────┐
│  Browser → http://localhost:3000                        │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│  Docker: Frontend (Vite + React)                        │
│  - Serves UI on port 3000                               │
│  - Proxies /api/* to host.docker.internal:5002          │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│  Host Machine: Backend (Flask + Python venv)            │
│  - Runs on port 5002                                    │
│  - Direct access to local network for SNMP polling      │
│  - SQLite database at data/pdumind.db                   │
└─────────────────────┬───────────────────────────────────┘
                      │ SNMP (UDP 161)
┌─────────────────────▼───────────────────────────────────┐
│  PDUs on Local Network (192.168.x.x)                    │
└─────────────────────────────────────────────────────────┘
```

**Why not full Docker?** Docker on macOS runs in a VM that cannot easily reach devices on your local network. The backend needs direct LAN access for SNMP polling.

---

## Prerequisites

- **Docker Desktop** (for frontend)
- **Python 3.10+** (for backend)
- **Node.js 18+** (optional, for local frontend dev)

---

## Quick Start

### 1. Start the Backend (Host Machine)

```bash
cd /Users/lnesto/CascadeProjects/PDUMind/backend

# Create virtual environment (first time only)
python3 -m venv venv

# Activate virtual environment
source venv/bin/activate

# Install dependencies (first time only)
pip install -r requirements.txt

# Start backend on port 5002
PORT=5002 python app.py
```

The backend will:
- Initialize SQLite database at `data/pdumind.db`
- Start adaptive SNMP polling for configured PDUs
- Listen on `http://localhost:5002`

### 2. Start the Frontend (Docker)

```bash
cd /Users/lnesto/CascadeProjects/PDUMind

# Build and start frontend container
docker-compose up -d frontend
```

The frontend will:
- Start Vite dev server on port 3000
- Proxy API requests to `host.docker.internal:5002`

### 3. Access the Application

Open **http://localhost:3000** in your browser.

---

## Configuration

### Frontend API Proxy

The frontend proxies API calls to the backend. Configuration is in:

**`frontend/vite.config.js`**
```javascript
proxy: {
  '/api': {
    target: 'http://host.docker.internal:5002',  // Points to host backend
    changeOrigin: true,
  }
}
```

### Backend Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 5000 | HTTP server port |
| `SNMP_COMMUNITY` | private | SNMP community string |
| `MAX_POLL_WORKERS` | 30 | Parallel SNMP poll threads |

Example:
```bash
PORT=5002 SNMP_COMMUNITY=public python app.py
```

### Database

SQLite database location: `data/pdumind.db`

---

## Stopping Services

### Stop Backend
Press `Ctrl+C` in the terminal running the backend.

### Stop Frontend
```bash
docker-compose down frontend
```

---

## Troubleshooting

### "No PDUs showing"
1. Check backend is running: `curl http://localhost:5002/api/halls`
2. If empty response, start the backend (see Quick Start)

### "Telemetry not updating"
1. Verify PDU is reachable: `snmpget -v2c -c private 192.168.10.149 .1.3.6.1.2.1.1.3.0`
2. Check backend logs for SNMP errors
3. Trigger a poll: `curl -X POST http://localhost:5002/api/polling/device/192.168.10.149/trigger`

### "Frontend can't reach backend"
1. Ensure backend is on port 5002: `lsof -i :5002`
2. Check `vite.config.js` has `host.docker.internal:5002`
3. Rebuild frontend: `docker-compose up -d --build frontend`

### Port 5000 already in use
macOS AirPlay Receiver uses port 5000. Use port 5002 instead:
```bash
PORT=5002 python app.py
```

---

## Development Workflow

### Backend Changes
Backend auto-reloads on file changes (Flask debug mode).

### Frontend Changes
Frontend hot-reloads via Vite. For structural changes:
```bash
docker-compose up -d --build frontend
```

---

## Full Restart

```bash
# Terminal 1: Backend
cd /Users/lnesto/CascadeProjects/PDUMind/backend
source venv/bin/activate
PORT=5002 python app.py

# Terminal 2: Frontend
cd /Users/lnesto/CascadeProjects/PDUMind
docker-compose up -d frontend
```

Then open http://localhost:3000
