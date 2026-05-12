-- PDUMind Full Persistence Schema
-- Version: 1.0.0

-- =============================================================================
-- COMMISSIONING / CONFIGURATION TABLES
-- =============================================================================

CREATE TABLE IF NOT EXISTS halls (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    description     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hall_configs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    hall_id         INTEGER NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
    config_json     TEXT NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(hall_id, version)
);
CREATE INDEX IF NOT EXISTS idx_hall_configs_hall ON hall_configs(hall_id, version DESC);

CREATE TABLE IF NOT EXISTS racks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    hall_id         INTEGER NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
    rack_code       TEXT NOT NULL,
    row_index       INTEGER NOT NULL,
    position_index  INTEGER NOT NULL,
    x_m             REAL NOT NULL,
    y_m             REAL NOT NULL DEFAULT 0,
    z_m             REAL NOT NULL,
    rotation_deg    REAL DEFAULT 0,
    width_mm        INTEGER NOT NULL,
    depth_mm        INTEGER NOT NULL,
    height_u        INTEGER NOT NULL,
    model           TEXT,
    label           TEXT,
    metadata_json   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(hall_id, rack_code)
);
CREATE INDEX IF NOT EXISTS idx_racks_hall ON racks(hall_id);

CREATE TABLE IF NOT EXISTS pdu_models (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor          TEXT,
    model           TEXT NOT NULL,
    outlets         INTEGER,
    phases          INTEGER,
    rated_current_a REAL,
    specs_json      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(vendor, model)
);

CREATE TABLE IF NOT EXISTS pdus (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    hall_id         INTEGER NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
    rack_id         INTEGER REFERENCES racks(id) ON DELETE SET NULL,
    pdu_model_id    INTEGER REFERENCES pdu_models(id),
    mount_position  TEXT NOT NULL,
    ip_address      TEXT NOT NULL,
    snmp_port       INTEGER DEFAULT 161,
    snmp_version    TEXT DEFAULT '2c',
    snmp_community_ref TEXT,
    mac_address     TEXT,
    hostname        TEXT,
    label           TEXT,
    location        TEXT,
    metadata_json   TEXT,
    is_active       INTEGER DEFAULT 1,
    remote_host     TEXT,
    web_admin_port  INTEGER,
    web_admin_user  TEXT,
    web_admin_pass  TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(hall_id, ip_address)
);
CREATE INDEX IF NOT EXISTS idx_pdus_hall ON pdus(hall_id);
CREATE INDEX IF NOT EXISTS idx_pdus_rack ON pdus(rack_id);
CREATE INDEX IF NOT EXISTS idx_pdus_ip ON pdus(ip_address);

CREATE TABLE IF NOT EXISTS ip_pools (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    hall_id         INTEGER NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
    subnet          TEXT NOT NULL,
    assignment_strategy TEXT DEFAULT 'sequential',
    description     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =============================================================================
-- MIB FILES
-- =============================================================================

CREATE TABLE IF NOT EXISTS hall_mibs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    hall_id         INTEGER NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
    filename        TEXT NOT NULL,
    original_name   TEXT NOT NULL,
    oid_count       INTEGER DEFAULT 0,
    oids_json       TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hall_mibs_hall ON hall_mibs(hall_id);

-- =============================================================================
-- TELEMETRY TABLES
-- =============================================================================

CREATE TABLE IF NOT EXISTS telemetry (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    pdu_id          INTEGER NOT NULL REFERENCES pdus(id) ON DELETE CASCADE,
    ts_utc          TEXT NOT NULL,
    payload_json    TEXT NOT NULL,
    poll_duration_ms INTEGER,
    status          TEXT DEFAULT 'ok',
    error_message   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_telemetry_pdu_ts ON telemetry(pdu_id, ts_utc DESC);

CREATE TABLE IF NOT EXISTS outlets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    pdu_id          INTEGER NOT NULL REFERENCES pdus(id) ON DELETE CASCADE,
    outlet_number   INTEGER NOT NULL,
    name            TEXT,
    phase           INTEGER,
    rated_current_a REAL,
    UNIQUE(pdu_id, outlet_number)
);

CREATE TABLE IF NOT EXISTS outlet_telemetry (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    outlet_id       INTEGER NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    ts_utc          TEXT NOT NULL,
    state           TEXT,
    voltage_v       REAL,
    current_a       REAL,
    power_w         REAL,
    apparent_va     REAL,
    power_factor    REAL,
    energy_kwh      REAL,
    temperature_c   REAL,
    UNIQUE(outlet_id, ts_utc)
);
CREATE INDEX IF NOT EXISTS idx_outlet_telemetry_ts ON outlet_telemetry(outlet_id, ts_utc DESC);

CREATE TABLE IF NOT EXISTS phase_telemetry (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    pdu_id          INTEGER NOT NULL REFERENCES pdus(id) ON DELETE CASCADE,
    phase           INTEGER NOT NULL,
    ts_utc          TEXT NOT NULL,
    voltage_v       REAL,
    current_a       REAL,
    power_w         REAL,
    apparent_va     REAL,
    power_factor    REAL,
    energy_kwh      REAL,
    UNIQUE(pdu_id, phase, ts_utc)
);
CREATE INDEX IF NOT EXISTS idx_phase_telemetry_ts ON phase_telemetry(pdu_id, phase, ts_utc DESC);

CREATE TABLE IF NOT EXISTS env_telemetry (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    pdu_id          INTEGER NOT NULL REFERENCES pdus(id) ON DELETE CASCADE,
    ts_utc          TEXT NOT NULL,
    temperature_c   REAL,
    humidity_pct    REAL,
    dewpoint_c      REAL,
    UNIQUE(pdu_id, ts_utc)
);

-- =============================================================================
-- EVENTS / ALERTS TABLES
-- =============================================================================

CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    hall_id         INTEGER REFERENCES halls(id) ON DELETE CASCADE,
    rack_id         INTEGER REFERENCES racks(id) ON DELETE SET NULL,
    pdu_id          INTEGER REFERENCES pdus(id) ON DELETE SET NULL,
    severity        TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'critical')),
    event_type      TEXT NOT NULL,
    title           TEXT NOT NULL,
    message         TEXT,
    status          TEXT DEFAULT 'active' CHECK(status IN ('active', 'cleared', 'acknowledged')),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    cleared_at      TEXT,
    acknowledged_at TEXT,
    acknowledged_by TEXT,
    metadata_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_pdu ON events(pdu_id, status);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);

CREATE TABLE IF NOT EXISTS outlet_state_changes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    outlet_id       INTEGER NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    ts_utc          TEXT NOT NULL,
    old_state       TEXT,
    new_state       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_state_changes ON outlet_state_changes(outlet_id, ts_utc DESC);

-- =============================================================================
-- USERS / AUTH TABLES
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    display_name    TEXT,
    must_change_pw  INTEGER DEFAULT 0,
    is_active       INTEGER DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS access_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username        TEXT NOT NULL,
    action          TEXT NOT NULL,
    ip_address      TEXT,
    user_agent      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_access_log_created ON access_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_user ON access_log(username, created_at DESC);
