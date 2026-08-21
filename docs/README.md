# PDUMind Application Documentation

PDUMind is a data-center PDU monitoring and provisioning tool. The coordinator UI is organized around two primary modes when **Neural Ops** is enabled:

| Mode | Purpose |
|------|---------|
| **[Stencil](./STENCIL.md)** | Build the hall, commission PDUs, assign them to racks, configure ops teams and integrations |
| **[Switchboard](./SWITCHBOARD.md)** | Monitor live telemetry, respond to alarms, control outlets, inspect fleet health |

Without Neural Ops (classic production coordinator), the same features exist under a legacy **Infrastructure** sidebar without Stencil/Switchboard branding.

## Quick links

- [Stencil — full guide](./STENCIL.md)
- [Switchboard — full guide](./SWITCHBOARD.md)
- [Existing functionality overview](../PDUMind_FUNCTIONALITY.md) — backend architecture, polling, AI agent
- [Setup](../SETUP.md) · [Deployment](../DEPLOYMENT.md)

## Access modes

| Login | Shell | Database | Telemetry source |
|-------|-------|----------|-------------------|
| `admin` (production) | Classic or Ops | `data/pdumind.db` | Real SNMP / web-admin poller |
| `demo` / `demo` | Neural Ops (demo) | `data/pdumind_demo.db` | Simulator or **recorded replay** |
| Ops-enabled production user | Neural Ops (ops) | `data/pdumind.db` | Real poller + `/api/ops/*` incidents |

## Services

| Service | Port | Role |
|---------|------|------|
| Backend (Flask) | **5002** | REST API, SNMP polling, persistence |
| Frontend (Vite) | **3000** | React UI, proxies `/api` to backend |

```bash
cd /Users/lnesto/CascadeProjects/PDUMind
docker compose up -d      # start
docker compose down       # stop
docker compose build      # rebuild after code changes
```

## Mental model

```
Login → Dashboard2
          ├── Stencil     → Designer · Assign · Commission · Teams · Integrations
          └── Switchboard → Overview · Alarms · Fleet (PDU detail)
```

**Stencil = configure.** **Switchboard = operate.**

Both modes share the same hall database, PDU inventory, and 3D canvas. Mode only changes which navigation, panels, and editing capabilities are exposed.
