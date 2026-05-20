# PDUMind Functionality Overview

## 1. High-Level Architecture
- **Backend API**: Flask service exposing telemetry, polling, maintenance agent, events, and hall state persistence APIs.
- **Frontend**: React + Vite UI talking to `/api/*` endpoints via the configured proxy, rendering dashboards and a 3D data hall designer.
- **Data Flow**: Adaptive polling (or legacy multipdu thread) writes SNMP/telemetry snapshots into SQLite; frontend fetches cached telemetry and live data via REST.
- **AI Assistant**: LangChain-powered maintenance agent (`/api/maintenance/ask`) sits on top of telemetry DB tools (`query_sql`, `feature_frame`, `get_pdu_status`, `state_change_count`, `rank_anomalies`).

## 2. Backend Capabilities
### Telemetry & Adaptive Polling
- `AdaptivePoller` continuously polls PDUs, adjusts intervals based on device state (offline, idle, active, alarm), and stores payloads via `TelemetryRepo` and `store_poll_snapshot`.
- Legacy multi‑PDU poller still available; endpoints like `/api/pdus/by-ip/<ip>/live` aggregate passing results and errors.
- SNMP helpers (`snmp_walk`, per-outlet OIDs, failure backoff) support both batch and targeted interrogations.

### Persistence & Configuration
- `HallRepo`, `RackRepo`, `PDURepo`, `EventRepo`, `TelemetryRepo` manage hall config, rack layout, PDU inventory, events, and telemetry data in `data/pdumind.db`.
- `/api/halls`, `/api/halls/<id>/state` persist and reload complete hall layouts, racks, and PDUs (used by the Data Hall Designer).
- `HallStatePersistence` also surfaces saved PDUs to the frontend so 3D racks show real IPs for telemetry overlays.

### Monitoring & Events
- `/api/events`, `/api/events/active`, `/api/events/<id>/clear`, `/api/events/<id>/acknowledge` let clients list, acknowledge, and clear detected events.
- `/api/polling/*` endpoints expose adaptive poller statistics, per-device status, and manual trigger capability.
- `/api/polling/device/<ip>` and charts (`/api/pdus/by-ip/<ip>/telemetry/chart`) support frontend visualizations and tooltip sparklines.

### Intelligent Assistance
- `/api/maintenance/ask` proxies natural language questions to `PDUMind-AI` (LangChain agent) which leverages telemetry DB tools for SQL, histogram, anomaly, and inference queries.
- Tools include SQL execution with auto-LIMIT, rolling feature stats, anomaly scoring via IsolationForest, and pre-scripted alert rules.

### Operational Utilities
- `/api/test` validates SNMP reachability across versions/community strings.
- `/api/maintenance/alerts` streams stored maintenance alerts from `maintenance_alert` table.
- Environment variables control SNMP threads/batch size, adaptive poller toggles, OpenAI key, and backend behavior.

## 3. Frontend Functionality
### Sidebar & PDU List
- Persistent Sidebar (`Sidebar.jsx`) lists PDUs, lets users add new ones, and highlights the currently active device.
- Dashboards switch telemetry data based on selection; badge counts for Live/Offline PDUs refresh with backend data.

### Dashboard Views
- `Dashboard.jsx` renders `SystemHeader`, `OutletGrid`, live `TelemetryCharts`, `LoadTrends`, `DesignSpecsCard`, and `EnvironmentalMetrics` from the fetched PDU data blob.
- `Dashboard2.jsx` contains the full PDU monitoring experience: filters (All/Live/Offline), expandable PDU cards showing label, status dot, IP, location, and navigation buttons (Telemetry, Outlets, Activity Ledger, Specs, AI Insights).
- Telemetry overlays include sparkline, current/voltage/power cards, and header tags showing rack/pdu IDs.

### Data Hall Designer
- `DataHallDesigner.jsx` renders a Three.js canvas with racks, hover interactions, telemetry tooltip, and telemetry fetching per rack/PDU via `/api/pdus/by-ip/<ip>/telemetry/latest` and `/chart` endpoints.
- Layout is generated from `dataHallConfig.js` (rack counts, dimensions, PDU placement), merged with stored PDUs to display real IPs and statuses.
- Provides parameter panel (dimensions, PDUs per rack, rack orientation), controls for lighting, rack labels, and network scanning modal for discovering devices.
- Hovering a rack highlights corresponding PDU in the monitoring list; expanding a PDU in the sidebar syncs with the 3D view.

### Maintenance Assistant
- `MaintenanceChat.jsx` offers a conversational UI that POSTs to `/api/maintenance/ask` using suggested prompts; renders chat bubbles, typing states, and auto-scroll behavior.
- Interface surfaced on a dedicated page for AI-driven insights (anomalies, consumption trends, overloaded circuits).

### Network Scanner & Tools
- `NetworkScanner.jsx` discovers PDUs (via backend scanning jobs) and feeds results back into the designer to add new devices to aisles.
- `OutletGrid.jsx`, `PowerTelemetry.jsx`, and `LoadTrends.jsx` break down outlet states, phase-specific metrics, and rolling averages for deeper analysis.

### UX Enhancements
- Progressive shimmer/typing animations for chat, cards with gradients, and responsive layout using Tailwind-like utilities.
- Telemetry overlays and metric cards use small-font monospace data, color-coded status chips, and tooltips for sparkline data.

## 4. Developer & Operational Notes
- **Docker Compose** defines `backend` (bind-mounting local code + data) and `frontend` builds from `frontend/Dockerfile`. Frontend Dockerfile runs `npm install` and `npm run build`, then serves via Vite dev command.
- **Local dev flow**: run `npm run dev -- --port 3001 --host 0.0.0.0`, point Vite proxy to backend (`VITE_API_URL` via `.env`), and use `npm run dev` for instant hot reload instead of rebuilding the slow Docker frontend.
- **API proxy**: Vite config proxies `/api` to the backend (`http://127.0.0.1:5002` for local dev, `host.docker.internal` when inside Docker).
- **Persistence**: data stored under `data/pdumind.db`; backend scripts (persistence layer + SQL helpers) manage schema, telemetry, alerts, events, racks, and hall config.
- **Edge deployment**: backend can be run on an "edge server" within the PDU LAN while frontend hits it over VPN/Tailscale for remote development.

## 5. Summary
PDUMind unifies SNMP-based telemetry ingestion, adaptive polling, persistence, AI-driven maintenance assistance, and a visually rich React experience (3D data hall, telemetry dashboards, chat, scanner) to monitor and operate PDUs remotely. The stack is optimized for rapid local development (Vite hot reload, proxy) yet production-ready with Dockerized services, database-backed history, and configurable adaptive polling.
