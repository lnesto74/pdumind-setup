# PDUMind Deployment Guide

Deploy PDUMind telemetry application on any server or laptop with Docker.

## Prerequisites

- **Docker** (v20.10+) and **Docker Compose** (v2.0+)
- Network access to your PDUs (SNMP)
- Minimum 2GB RAM, 2 CPU cores

## Quick Start (New Installation)

### 1. Transfer Project Files

Copy these files/folders to your target machine:

```
PDUMind/
├── backend/              # Backend source code
├── frontend/             # Frontend source code
├── data/                 # Database & config (optional - for migration)
│   ├── pdumind.db        # Hall/rack configuration
│   ├── telemetry.db      # Historical telemetry
│   └── config.json       # Saved configurations
├── docker-compose.yml    # Docker orchestration
├── .env                  # Environment variables (create new or copy)
└── start.sh              # Startup script
```

**Option A - Using rsync (recommended):**
```bash
rsync -avz --exclude 'node_modules' --exclude '__pycache__' --exclude '.git' \
  /path/to/PDUMind user@target-server:/opt/
```

**Option B - Using scp:**
```bash
scp -r /path/to/PDUMind user@target-server:/opt/
```

**Option C - Create archive:**
```bash
cd /path/to/PDUMind
tar --exclude='node_modules' --exclude='__pycache__' --exclude='.git' \
    -czvf pdumind-deploy.tar.gz .
# Transfer pdumind-deploy.tar.gz to target and extract
```

### 2. Configure Environment

On the target machine, create/edit `.env` file:

```bash
cd /opt/PDUMind
nano .env
```

Add your configuration:
```env
# Optional: For AI agent features (can be left blank)
OPENAI_API_KEY=your-openai-api-key-here
```

### 3. Start the Application

```bash
cd /opt/PDUMind
chmod +x start.sh
./start.sh
```

Or manually with Docker Compose:
```bash
docker compose up -d --build
```

### 4. Access the Application

- **Frontend Dashboard:** http://your-server-ip:3000
- **Backend API:** http://your-server-ip:5002

## Detailed Configuration

### Port Configuration

Edit `docker-compose.yml` to change ports:

```yaml
services:
  backend:
    ports:
      - "5002:5000"    # Change 5002 to your desired port
  frontend:
    ports:
      - "3000:3000"    # Change first 3000 to your desired port
```

### Data Persistence

Data is stored in the `./data` directory:
- `pdumind.db` - Data hall configurations, racks, PDU assignments
- `telemetry.db` - Historical telemetry data
- `config.json` - Application settings

**To migrate existing data:** Copy the entire `data/` folder from your source machine.

### Network Configuration

Ensure the server can reach your PDUs via SNMP (port 161/UDP):
```bash
# Test SNMP connectivity
snmpwalk -v2c -c public <PDU_IP> 1.3.6.1.2.1.1.1.0
```

## Management Commands

```bash
# Start services
docker compose up -d

# Stop services
docker compose down

# View logs
docker compose logs -f

# View specific service logs
docker compose logs -f backend
docker compose logs -f frontend

# Rebuild after code changes
docker compose up -d --build

# Restart services
docker compose restart

# Check status
docker compose ps
```

## Troubleshooting

### Container won't start
```bash
# Check logs
docker compose logs backend
docker compose logs frontend

# Rebuild from scratch
docker compose down
docker compose build --no-cache
docker compose up -d
```

### Cannot connect to PDUs
1. Verify network connectivity: `ping <PDU_IP>`
2. Check SNMP: `snmpwalk -v2c -c public <PDU_IP> 1.3.6.1.2.1.1.1.0`
3. Ensure firewall allows UDP 161

### Frontend shows no data
1. Check backend is running: `curl http://localhost:5002/api/health`
2. Verify PDU polling: `docker compose logs backend | grep -i poll`

### Reset to fresh install
```bash
docker compose down -v
rm -rf data/*.db
docker compose up -d --build
```

## System Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 2 cores | 4 cores |
| RAM | 2 GB | 4 GB |
| Storage | 5 GB | 20 GB |
| Docker | 20.10+ | Latest |

## Security Notes

- Change default ports in production
- Use a reverse proxy (nginx/traefik) with SSL
- Restrict network access to the dashboard
- Keep `.env` file secure (chmod 600)
