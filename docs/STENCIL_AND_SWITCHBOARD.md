# PDUMind — Stencil & Switchboard Guide

Complete reference for the two halves of the PDUMind coordinator application: **Stencil** (build & configure) and **Switchboard** (operate & monitor).

---

## 1. What are Stencil and Switchboard?

PDUMind is split into two modes inside the main dashboard (`Dashboard2.jsx`):

| Mode | Purpose | Tagline |
|------|---------|---------|
| **Stencil** | Design data halls, commission PDUs, assign them to racks, configure ops teams & integrations | *Layout, commissioning, ops teams, Telegram* |
| **Switchboard** | Live monitoring, alarms, fleet PDU detail, outlet control | *Overview, alarms, fleet* |

Both modes share the same database, hall list, PDU inventory, and 3D canvas. The mode only changes which navigation, panels, and editing capabilities are exposed.

### When do you see Stencil / Switchboard?

The branded **Neural Ops shell** (sidebar with Stencil ↔ Switchboard tabs) appears when:

- **Demo mode** — login as `demo` (`PDUMIND_DEMO_ENABLED=1`), or
- **Production Neural Ops** — coordinator account with `PDUMIND_OPS_ENABLED=1`

If neither flag is active, you get the **classic Infrastructure sidebar** (Data Hall Designer, Assign PDUs, Commission modal) — same underlying features, no Stencil/Switchboard branding.

### Mode persistence

| Setting | localStorage key | Default |
|---------|------------------|---------|
| Stencil vs Switchboard | `pdumind_neural_ops` | `1` = Switchboard, `0` = Stencil |
| Stencil sub-tab | `pdumind_demo_stencil_section` | `designer` |
| Switchboard sub-tab | `pdumind_demo_switchboard_section` | `overview` |
| Alarms sub-tab | `pdumind_demo_alarms_section` | `dispatch` |

**Naming quirk:** the React state `neuralOpsMode === true` means **Switchboard**, not Stencil.

---

## 2. Navigation map

```
Neural Ops Shell (DemoNavSidebar)
│
├── STENCIL
│   ├── Designer        → 3D data hall editor
│   ├── Assign          → 2D PDU-to-rack drag & drop
│   ├── Commission      → PDU discovery & commissioning wizard
│   ├── Teams           → Ops team roster & escalation
│   └── Integrations    → Telegram bot & notifications
│
└── SWITCHBOARD
    ├── Overview        → 3D hall + live ops panel
    ├── Alarms          → Dispatch board, reports, analytics
    └── Fleet           → PDU list + detail (telemetry, outlets, settings)
```

### Sidebar PDU Monitoring (both modes)

When visible, the left sidebar lists all PDUs in the selected hall:

- **Filters:** All / Live / Offline
- **Per PDU:** status dot, label, IP, alarm badge, temp/humidity (when available)
- **Click a PDU** → auto-switches to **Switchboard → Fleet** and opens that PDU's detail view

In **Stencil**, the PDU list is always shown. In **Switchboard**, it is hidden on Overview and Alarms, and shown in Fleet split view.

---

## 3. Stencil — features & workflows

### 3.1 Designer (3D Data Hall)

**Component:** `frontend/src/components/DataHallDesigner/DataHallDesigner.jsx`  
**Config model:** `frontend/src/components/DataHallDesigner/dataHallConfig.js`

The Designer is a Three.js 3D canvas for laying out a data hall.

#### What you configure

| Section | Parameters |
|---------|------------|
| **Hall dimensions** | Length, width, height, floor tile size |
| **Layout** | Number of rows, racks per row, row orientation, aisle width, wall clearance |
| **Rack specs** | Width, depth, height (U), model |
| **PDU config** | PDUs per rack, model ID, mounting (`A/B` or numbered slots) |
| **IP planning** | Subnet, assignment strategy |
| **Scene objects** | Free-placed props (e.g. cage entrance) — drag, rotate, scale |

#### Hall management

- **Create** a new data hall (`POST /api/halls`)
- **Select** from dropdown (Parameters panel or landing picker)
- **Rename / delete** halls
- **Auto-save** — layout changes debounce to `POST /api/halls/{id}/state` (config + racks; PDUs managed separately)

#### 3D interactions

- **Hover rack** → telemetry overlay tooltip (live current, voltage, power, PF, sparkline)
- **Click rack** → rack details panel (dimensions, PDU list, alerts)
- **Rack coloring** — normal / warning / critical based on PDU alarms
- **PDU status dots** — online/offline on each rack
- **Lighting panel** — adjust scene lighting
- **Labels toggle** — show/hide rack IDs

#### Telemetry overlay (hover tooltip)

Fetches per PDU every 5 seconds:

- `GET /api/pdus/by-ip/{ip}/live` — current values
- `GET /api/pdus/by-ip/{ip}/telemetry/chart?period=day` — sparkline history

Shows: current (A), voltage (V), power (kW), power factor, 24h load sparkline.

> **Replay note:** In demo replay mode, live numbers loop through recorded frames; the sparkline is a static snapshot of what was recorded (does not scroll).

#### Landing screen

On first load or when no hall is selected, a "Select your Data Hall" screen appears with hall cards and a **+ New Data Hall** button.

---

### 3.2 Assign (PDU → Rack placement)

**Component:** `frontend/src/components/AssignPdusPanel.jsx`

Two-stage 2D UX (no 3D):

1. **Stage A — Top-down map:** rows of rack cards; click a rack to select it
2. **Stage B — Frontal elevation:** drag PDUs from the unassigned tray into slots

#### Slot labels

Derived from hall config:

- Mounting `A/B` → slots **A, B, C, D…** (up to `pdusPerRack`)
- Other mounting → slots **1, 2, 3, 4…**

#### Assignment API

```
POST /api/halls/{id}/pdus/bulk-rack-assign
Body: { assignments: [{ pdu_id, rack_id, mount_position }] }
```

Set `rack_id: null` to unassign a PDU.

---

### 3.3 Commission (PDU discovery & onboarding)

**Component:** `frontend/src/components/CommissioningWizard.jsx`

**Neural shell:** full-page wizard embedded in Stencil tab.  
**Classic mode:** modal overlay from legacy sidebar.

#### Single-PDU flow

1. **Detect** — find PDU on network
2. **Configure** — set IP, SNMP, web-admin credentials
3. **Assign Rack** — pick rack + mount position
4. **Confirm** — add to hall database

#### Scan modes

| Mode | Description | API |
|------|-------------|-----|
| **Factory** | Scan factory-default IP | `POST /api/network/scan/factory-default` |
| **Manual** | Single IP probe | `POST /api/network/scan/ip` |
| **Subnet** | SNMP subnet scan | `POST /api/network/scan` |
| **Remote** | Web-admin remote PDU | `POST /api/pdu-admin/connect` |
| **Batch** | Multi-PDU batch (demo default) | `POST /api/batch/commission` |
| **Inventory** | Excel-guided commissioning | `POST /api/commission/inventory/parse` |
| **Repair** | Fix web credentials for hall PDUs | `POST /api/halls/{id}/pdus/repair-web-access` |

#### Batch sub-flow

Scan → template → deploy → report → rack-assign

Progress polled via `GET /api/batch/commission/{job_id}`.

#### Demo-specific defaults

- Subnet: `10.99.1.206-213`
- Factory IP: `192.168.0.163`
- Reset: `POST /api/demo/reset` (factory vs pre-loaded cage)

---

### 3.4 Teams (ops roster)

**Component:** `frontend/src/components/demo/DemoTeamsPanel.jsx`

Configure who gets dispatched when alarms fire:

- Discipline pools (electrical, mechanical, etc.)
- Round-robin order
- Escalation policy
- Invite links for mobile responders

**API prefix:** `/api/demo` (demo) or `/api/ops` (production ops)

---

### 3.5 Integrations (Telegram)

**Component:** `frontend/src/components/DemoIntegrationsPanel.jsx`

- Telegram bot token & chat ID
- Notify on alarm toggle
- Test message
- Activity log

Green dot on Integrations tab when Telegram is configured and enabled.

---

### 3.6 Record / Replay (hall snapshots)

**Component:** `frontend/src/components/RecordReplayControls.jsx`  
**Engine:** `backend/demo/replay.py`  
**Storage:** `data/snapshots/*.json`

| Who | What | How |
|-----|------|-----|
| **Admin (production)** | Record a live hall | Sidebar button **"Record hall for demo"** → `POST /api/halls/{id}/snapshot` |
| **Demo user** | Replay a recording | Sidebar **"Recorded halls"** → play → `POST /api/demo/replay/load` |

#### What gets captured

- Hall config (dimensions, layout, PDU settings, scene objects)
- All racks and PDUs
- Telemetry history (default: last 24h, capped at 3000 points per PDU)

#### What replay does

1. Restores hall into the **demo database** as e.g. `NTT (recorded)`
2. Writes recorded telemetry rows (timestamps shifted so recording ends "now")
3. Arms an in-memory loop engine — `/live` and `/api/demo/telemetry` serve recorded frames cycling over the capture window

#### Your NTT recording

```
data/snapshots/ntt-20260605-122541.json
```

- 34 PDUs, 170 samples, ~4.4 minutes of real cage telemetry
- Captured 2026-06-05 12:25 UTC

#### Step-by-step: customer demo with NTT recording

1. Log in as **demo** / **demo**
2. **Stencil** → expand **Recorded halls** at bottom of sidebar
3. Click **play** on the NTT entry
4. Open **Designer** for 3D layout, **Switchboard → Fleet** for PDU detail
5. Click **stop** in Recorded halls to end replay

> Replay only works in **demo** session. Production shows real (often offline) PDUs.

---

### 3.7 Stencil user flows (summary)

| Flow | Steps |
|------|-------|
| **New hall** | Stencil → Designer → create hall → configure layout → auto-save |
| **Commission PDUs** | Stencil → Commission → scan/detect → configure → assign rack |
| **Assign PDUs to racks** | Stencil → Assign → pick rack → drag PDUs to slots |
| **Configure dispatch** | Stencil → Teams + Integrations |
| **Record for demo** | Admin → Stencil → select hall → Record hall for demo |
| **Monitor a PDU** | Stencil sidebar → click PDU → jumps to Switchboard Fleet |

---

## 4. Switchboard — features & workflows

### 4.1 Overview (3D + ops panel)

**Components:**
- `DataHallDesigner` — `neuralMode={true}`, read-only scene editing, full-bleed canvas
- `NeuralOpsPanel` — right rail with live ops summary

#### NeuralOpsPanel shows

- Fleet stats: online / critical / warning counts
- Environment strip: avg temperature, humidity, open doors
- Alert stream (from `buildRackAlerts()`)
- Attention queue (PDUs needing action)
- **Click any item** → navigates to Fleet + selects that PDU

**Utilities:** `frontend/src/utils/neuralOpsAlerts.js`

---

### 4.2 Alarms

**Sub-nav:** Dispatch | Reports | Analytics

| Sub-tab | Component | What it does |
|---------|-----------|--------------|
| **Dispatch** | `DemoLiveDispatchPanel` | Live dispatch board, open incidents, responder status. Polls every 2s. |
| **Reports** | `DemoStoneReportPanel` | Incident stone reports / post-mortems |
| **Analytics** | `DemoIncidentAnalytics` | Incident trends and analytics |

Also shows the **Global Alarm Ledger** (PDU alarm aggregation) under Reports.

Open incident count appears as a badge on the Alarms tab in the sidebar.

**API:** `/api/demo/dispatch/live` or `/api/ops/dispatch/live`

---

### 4.3 Fleet (PDU monitoring & control)

**Component:** `frontend/src/components/demo/DemoFleetPanel.jsx`

Split layout:

- **Left:** filterable PDU list (All / Live / Offline)
- **Right:** selected PDU detail with tabs

#### PDU detail tabs

| Tab | Content |
|-----|---------|
| **Telemetry** | Live metrics, real-time sparkline (60 samples), historical chart (day/week/month), environmental sensors |
| **Warnings** | Active alarm flags, env readings |
| **Outlets** | 24-outlet grid with on/off toggles |
| **Settings** | Full PDU web-admin settings panel |

---

### 4.4 Live telemetry

#### How data is fetched

| Context | Mechanism | Interval |
|---------|-----------|----------|
| **Selected PDU detail** | `GET /api/pdus/by-ip/{ip}/live` | 1s (local SNMP) / 10s (remote web-admin) |
| **Fleet status (production)** | Parallel `GET /api/polling/device/{ip}` then `/live` for online PDUs | 10s |
| **Fleet status (demo)** | `GET /api/demo/telemetry` (bulk simulated/replay bundle) | 10s |
| **Historical charts** | `GET /api/pdus/by-ip/{ip}/telemetry/chart?period=day\|week\|month` | On demand |

#### Metrics displayed

Voltage, current, power, power factor, energy, L2/L3 phase values, temperature, humidity, door status.

#### Backend data sources

- **Production:** `MULTI_PDU_RESULTS` background poller cache (SNMP + web-admin)
- **Demo:** `demo/simulator.py` synthetic data
- **Replay:** `demo/replay.py` looped recorded frames

#### Reachability probes

`GET /api/polling/device/{ip}` returns online/offline. For remote PDUs this uses a cached TCP probe (non-blocking, background refresh) so fleet sweeps do not stall the UI.

---

### 4.5 Outlet control

**Component:** inline `OutletCard` in `Dashboard2.jsx`

```
PUT /api/outlet/{number}/status
Body: { state: "on" | "off", ip: "..." }
```

- Optimistic UI toggle with 35s timeout fallback
- SNMP PDUs: HTTP `setcontrol` or SNMP priority poll
- Web-admin/NPDU: cache patch after toggle
- Web-admin PDUs with breaker-only labels: read-only (no toggle)

---

### 4.6 PDU Settings

**Component:** `frontend/src/components/PDUSettingsPanel.jsx`

Available in Fleet → Settings tab (requires `pdu.dbId` and web-admin credentials).

| Tab | Backend |
|-----|---------|
| Network | `GET/POST /api/pdu-admin/{host}/settings/network` |
| SNMP | `.../settings/snmp` |
| Time | `.../settings/time` |
| System | `.../settings/system` |
| Alarms | `.../alarm-thresholds` |
| Live Telemetry | `GET /api/pdu-admin/{host}/telemetry` |
| Event Logs | `GET /api/pdu-admin/{host}/logs` |

Session hold/release (`POST /api/pdu-admin/{host}/session/hold|release`) pauses background poller while editing.

Single PDU reboot: `POST /api/pdu-admin/{host}/reboot`

---

### 4.7 Bulk PDU reboot (legacy sidebar only)

**Component:** `frontend/src/components/PduBulkRebootModal.jsx`

Not in Switchboard nav — triggered from classic Infrastructure sidebar **"Reboot PDUs"**.

```
POST /api/halls/{hallId}/pdus/bulk-reboot
Body: { pdu_ids: [...], wait: true }
```

Sequential reboot via web-admin `reboot.cgi`.

---

### 4.8 Switchboard user flows (summary)

| Flow | Steps |
|------|-------|
| **Morning check** | Switchboard → Overview → scan NeuralOpsPanel stats & alerts |
| **Investigate alarm** | Overview → click alert **or** Alarms → Dispatch → open incident |
| **PDU deep-dive** | Fleet → select PDU → Telemetry / Warnings tabs |
| **Toggle outlet** | Fleet → Outlets → click outlet card |
| **Historical review** | Fleet → Telemetry → Historical → day/week/month |
| **From Stencil** | Click PDU in sidebar → auto-opens Fleet for that PDU |

---

## 5. Fleet Command Center (external viewer)

**Route:** `http://{host}:3000/view` (no login required)  
**Component:** `frontend/src/components/FleetCommandCenter.jsx`

Read-only fleet dashboard for sharing with coordinators:

- Fleet stats bar, attention list
- 3D heatmap (`DataHallDesigner` with `readOnly`)
- Polls `GET /api/halls/{id}/fleet-snapshot` every 30s

**Not** the in-app Switchboard — no outlet control, no PDU detail tabs, no sub-navigation.

---

## 6. Demo vs production vs classic

| Aspect | Demo (`demo` user) | Production Neural Ops | Classic (no neural shell) |
|--------|-------------------|----------------------|---------------------------|
| **Shell** | Neural Ops sidebar | Neural Ops sidebar | Infrastructure sidebar |
| **API prefix (ops features)** | `/api/demo` | `/api/ops` | N/A |
| **Database** | Demo DB (`pdumind_demo.db`) | Main DB (`pdumind.db`) | Main DB |
| **Fleet telemetry** | `/api/demo/telemetry` (simulated or replay) | Real poller per PDU | Real poller per PDU |
| **Commission UI** | Full-page in Stencil | Full-page in Stencil | Modal wizard |
| **Record hall** | N/A (admin records) | Admin can record | Admin can record |
| **Replay** | Recorded halls picker | N/A | N/A |
| **Teams / Integrations** | Demo seed data | Real ops config | Not in sidebar |
| **Dispatch / incidents** | Simulated alarms | Real poller alarms | N/A |

Demo takes precedence when both demo and ops flags could apply.

---

## 7. API reference (quick)

### Halls & layout

| Method | Endpoint | Used by |
|--------|----------|---------|
| GET | `/api/halls` | Hall list |
| POST | `/api/halls` | Create hall |
| PUT | `/api/halls/{id}` | Rename |
| DELETE | `/api/halls/{id}` | Delete |
| GET | `/api/halls/{id}/state` | Load config, racks, PDUs |
| POST | `/api/halls/{id}/state` | Save layout |
| POST | `/api/halls/{id}/pdus/bulk-rack-assign` | Assign PDUs |
| POST | `/api/halls/{id}/snapshot` | Record hall for demo |
| GET | `/api/halls/{id}/fleet-snapshot` | Fleet Command Center |

### Telemetry & polling

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/pdus/by-ip/{ip}/live` | Live PDU metrics |
| GET | `/api/pdus/by-ip/{ip}/telemetry/chart` | Historical charts |
| GET | `/api/polling/device/{ip}` | Online/offline status |
| GET | `/api/demo/telemetry` | Demo fleet bulk status |

### Outlets & admin

| Method | Endpoint | Purpose |
|--------|----------|---------|
| PUT | `/api/outlet/{n}/status` | Toggle outlet |
| GET/POST | `/api/pdu-admin/{host}/settings/*` | PDU configuration |
| POST | `/api/pdu-admin/{host}/reboot` | Reboot single PDU |
| POST | `/api/halls/{id}/pdus/bulk-reboot` | Bulk reboot |

### Commissioning

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/network/scan/factory-default` | Factory IP detect |
| POST | `/api/network/scan` | Subnet SNMP scan |
| POST | `/api/batch/commission` | Batch commissioning |
| POST | `/api/halls/{id}/pdus/add` | Add single PDU |

### Demo / ops

| Endpoint | Purpose |
|----------|---------|
| `/api/demo/status` | Enable demo shell |
| `/api/demo/snapshots` | List recordings |
| `/api/demo/replay/load` | Start replay |
| `/api/demo/replay/stop` | Stop replay |
| `/api/demo/dispatch/live` | Dispatch board |
| `/api/demo/teams/*` | Ops teams |
| `/api/demo/integrations` | Telegram config |
| `/api/ops/*` | Production equivalent of all demo ops endpoints |

---

## 8. Architecture diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Coordinator App                          │
│                     (Dashboard2.jsx)                         │
│                                                             │
│  ┌──────────────┐              ┌──────────────────────┐   │
│  │   STENCIL    │              │    SWITCHBOARD        │   │
│  │              │              │                       │   │
│  │  Designer    │              │  Overview (3D+Ops)    │   │
│  │  Assign      │   shared     │  Alarms (Dispatch)    │   │
│  │  Commission  │◄────────────►│  Fleet (PDU detail)   │   │
│  │  Teams       │  hall DB     │                       │   │
│  │  Integrations│  PDU list    │  Telemetry/Outlets    │   │
│  │  Record      │  3D canvas   │  Settings             │   │
│  └──────────────┘              └──────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │ REST /api/*
┌────────────────────────────▼────────────────────────────────┐
│                     Flask Backend (app.py)                    │
│                                                             │
│  HallRepo / RackRepo / PDURepo / TelemetryRepo / EventRepo  │
│  Multi-PDU Poller (SNMP + web-admin cache)                   │
│  Adaptive Poller                                             │
│  Demo Simulator + Replay Engine                              │
│  Ops Incidents / Dispatch / Teams / Integrations             │
└────────────────────────────┬────────────────────────────────┘
                             │
                    data/pdumind.db
                    data/pdumind_demo.db
                    data/snapshots/*.json
```

---

## 9. Key source files

| Role | Path |
|------|------|
| Main shell & routing | `frontend/src/components/Dashboard2.jsx` |
| Stencil/Switchboard sidebar | `frontend/src/components/demo/DemoNavSidebar.jsx` |
| 3D designer | `frontend/src/components/DataHallDesigner/DataHallDesigner.jsx` |
| Hall config model | `frontend/src/components/DataHallDesigner/dataHallConfig.js` |
| PDU assignment | `frontend/src/components/AssignPdusPanel.jsx` |
| Commissioning | `frontend/src/components/CommissioningWizard.jsx` |
| Record/replay UI | `frontend/src/components/RecordReplayControls.jsx` |
| Fleet split view | `frontend/src/components/demo/DemoFleetPanel.jsx` |
| Ops overview panel | `frontend/src/components/NeuralOpsPanel.jsx` |
| Dispatch board | `frontend/src/components/demo/DemoLiveDispatchPanel.jsx` |
| PDU settings | `frontend/src/components/PDUSettingsPanel.jsx` |
| External viewer | `frontend/src/components/FleetCommandCenter.jsx` |
| Alert builders | `frontend/src/utils/neuralOpsAlerts.js` |
| Flask API | `backend/app.py` |
| Demo APIs | `backend/demo/routes.py` |
| Ops APIs | `backend/ops_routes.py` |
| Replay engine | `backend/demo/replay.py` |
| Demo simulator | `backend/demo/simulator.py` |
| Fleet snapshot | `backend/hub.py` |

---

## 10. Running the application

```bash
cd /Users/lnesto/CascadeProjects/PDUMind
docker compose up -d        # start
docker compose down         # stop
docker compose build        # rebuild after code changes
```

| Service | Port | Role |
|---------|------|------|
| Backend | 5002 | Flask API, SNMP polling, persistence |
| Frontend | 3000 | React UI (production bundle via `vite preview`) |
| Database | — | SQLite in `data/pdumind.db` (+ `data/pdumind_demo.db` for demo) |

**Login accounts:**

| User | Password | Mode |
|------|----------|------|
| `admin` | (your password) | Production — record halls, real PDUs |
| `demo` | `demo` | Demo — replay recordings, simulated cage |

**Environment flags** (`.env`):

```
PDUMIND_DEMO_ENABLED=1    # enable demo user & demo DB routing
PDUMIND_OPS_ENABLED=1     # enable production Neural Ops (/api/ops)
DEMO_USERNAME=demo
DEMO_PASSWORD=demo
```

---

*Last updated: June 2026*
