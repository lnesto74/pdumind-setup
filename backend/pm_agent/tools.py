"""LangChain tools wrapping database & ML helpers for the maintenance agent."""
from __future__ import annotations
import os, sqlite3, json, re, time
from functools import lru_cache
from langchain.agents import tool
import pandas as pd  # lightweight import; used in multiple tools
from typing import Dict, Any

# Cache for SNMP failures to avoid repeated timeouts
SNMP_FAILURE_CACHE: Dict[str, Any] = {}
SNMP_FAILURE_THRESHOLD = 3  # Number of failures before backing off
SNMP_BACKOFF_DURATION = 300  # 5 minutes backoff

def should_skip_snmp(oid: str) -> bool:
    """Check if we should skip SNMP polling for this OID due to recent failures"""
    now = time.time()
    if oid in SNMP_FAILURE_CACHE:
        failures, last_failure = SNMP_FAILURE_CACHE[oid]
        if failures >= SNMP_FAILURE_THRESHOLD:
            if now - last_failure < SNMP_BACKOFF_DURATION:
                return True
            else:
                # Reset after backoff period
                SNMP_FAILURE_CACHE.pop(oid)
    return False

def record_snmp_failure(oid: str) -> None:
    """Record an SNMP failure for the OID"""
    now = time.time()
    if oid in SNMP_FAILURE_CACHE:
        failures, _ = SNMP_FAILURE_CACHE[oid]
        SNMP_FAILURE_CACHE[oid] = (failures + 1, now)
    else:
        SNMP_FAILURE_CACHE[oid] = (1, now)

DB_PATH = os.path.join(os.getenv("DATA_DIR", "data"), "telemetry.db")

@tool("query_sql")
def query_sql(query: str) -> str:
    """Run a read-only SQL query against telemetry.db and return up to 40 rows formatted as a markdown table.

    Behaviour:
    • Trailing semicolons are stripped.
    • For SELECT/CTE queries without an explicit LIMIT clause, a `LIMIT 40` is appended automatically.
    • Non-SELECT statements (e.g. PRAGMA, UPDATE) are executed as-is.
    • If the statement returns no rows (e.g. INSERT) a confirmation message is returned instead of a table.
    """
    try:
        sql = query.strip().rstrip(";")
        # Append LIMIT 40 only for plain SELECT/CTE queries that don't already contain a limit
        if re.match(r"^(SELECT|WITH)\b", sql, re.IGNORECASE) and " limit " not in sql.lower():
            sql = f"{sql} LIMIT 40"

        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.execute(sql)
            if cursor.description is None:
                # Non-result query executed successfully
                return "Query executed successfully."

            columns = [desc[0] for desc in cursor.description]
            rows = cursor.fetchall()

        if not rows:
            return "No data found"

        # Build markdown table
        header = "| " + " | ".join(columns) + " |"
        divider = "| " + " | ".join(["---"] * len(columns)) + " |"
        body = ["| " + " | ".join("" if v is None else str(v) for v in row) + " |" for row in rows]
        return "\n".join([header, divider, *body])
    except Exception as e:
        return f"SQL error: {e}"

@tool("feature_frame")
def feature_frame(outlet_id: int, window_h: int = 24) -> str:
    """Return rolling 2-hour statistics (mean, std, max, min) of current for an outlet over the last `window_h` hours as markdown table."""
    with sqlite3.connect(DB_PATH) as conn:
        df = pd.read_sql(
            f"""
            SELECT ts_utc, current_a FROM outlet_telemetry
            WHERE outlet_id = {outlet_id}
              AND ts_utc >= datetime('now', '-{window_h} hours')
              AND current_a IS NOT NULL
            ORDER BY ts_utc
            """,
            conn,
            parse_dates=["ts_utc"],
        )
    if df.empty:
        return "No data for the requested period."
    feat = (
        df.set_index("ts_utc")
          .current_a
          .rolling("2h")
          .agg(["mean", "std", "max", "min"])
          .dropna()
          .tail(10)
    )
    # Convert to markdown for easier LLM digestion
    return feat.to_markdown()

@tool("get_pdu_status")
def get_pdu_status() -> str:
    """Get the current status of all PDU outlets including their state (on/off), current draw, and energy consumption."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            # Create index if it doesn't exist for better query performance
            conn.execute('CREATE INDEX IF NOT EXISTS idx_outlet_telemetry_ts ON outlet_telemetry(ts_utc)')
            conn.execute('CREATE INDEX IF NOT EXISTS idx_outlet_telemetry_outlet ON outlet_telemetry(outlet_id)')
            
            # Get latest telemetry for each outlet using window function for better performance
            result = conn.execute('''
                WITH ranked_readings AS (
                    SELECT outlet_id,
                           state,
                           current_a,
                           energy_kwh,
                           ROW_NUMBER() OVER (PARTITION BY outlet_id ORDER BY ts_utc DESC) as rn
                    FROM outlet_telemetry
                    WHERE ts_utc >= datetime('now', '-5 minutes')
                )
                SELECT o.outlet_number,
                       COALESCE(r.state, 'unknown') as state,
                       COALESCE(r.current_a, 0.0) as current_a,
                       COALESCE(r.energy_kwh, 0.0) as energy_kwh
                FROM outlet o
                LEFT JOIN ranked_readings r
                    ON o.id = r.outlet_id
                    AND r.rn = 1
                ORDER BY o.outlet_number
            ''').fetchall()
            
            if not result:
                return "No PDU data available"
                
            status = []
            for row in result:
                outlet_number, state, current, energy = row
                status.append(
                    f"Outlet {outlet_number}: {state or 'unknown'}, drawing {current or 0:.2f}A, total energy {energy or 0:.1f}kWh"
                )
            
            return "\n".join(status)
    except Exception as e:
        return f"Error getting PDU status: {e}"

@tool("inference")
def inference(outlet_id: int) -> str:
    """Run a saved IsolationForest model on recent outlet current stats; returns JSON with anomaly_score."""
    import joblib, numpy as np
    model_path = "/app/ml/models/iso_forest.joblib"
    if not os.path.exists(model_path):
        return "{}"  # model not present yet
    model = joblib.load(model_path)
    with sqlite3.connect(DB_PATH) as conn:
        df = pd.read_sql(
            f"SELECT current_a FROM outlet_telemetry WHERE outlet_id={outlet_id} ORDER BY ts_utc DESC LIMIT 120",
            conn,
        )
    if df.empty:
        return "{}"
    vec = np.array([[df.current_a.mean(), df.current_a.std() or 0.0]])
    score = float(model.decision_function(vec)[0])
    return json.dumps({"anomaly_score": score})

# ------------------------------------------------------------
# Additional helper tool
# ------------------------------------------------------------

@tool("state_change_count")
def state_change_count(outlet_id: int, hours: int = 24) -> str:
    """Return the number of ON/OFF state transitions for a given outlet in the last `hours` hours."""
    with sqlite3.connect(DB_PATH) as conn:
        df = pd.read_sql(
            f"""
            SELECT state, ts_utc FROM outlet_telemetry
            WHERE outlet_id = {outlet_id}
              AND ts_utc >= datetime('now', '-{hours} hours')
              AND state IS NOT NULL
            ORDER BY ts_utc
            """,
            conn,
            parse_dates=["ts_utc"],
        )
    if df.empty:
        return "0"
    # Count transitions (state != previous state)
    transitions = int((df.state != df.state.shift()).sum() - 1)
    return str(max(transitions, 0))

# ------------------------------------------------------------
# Anomaly ranking across all outlets
# ------------------------------------------------------------

@tool("rank_anomalies")
def rank_anomalies(hours: int = 24, top_n: int = 3) -> str:
    """Return a markdown table of the top `top_n` outlets with the worst anomaly scores (IsolationForest) over the last `hours` hours."""
    import joblib, numpy as np
    print("[DEBUG] rank_anomalies called with hours={}, top_n={}".format(hours, top_n))
    model_path = "/app/ml/models/iso_forest.joblib"

    # Fetch current stats for each outlet in the window
    with sqlite3.connect(DB_PATH) as conn:
        df = pd.read_sql(
            f"""
            SELECT outlet_id, current_a FROM outlet_telemetry
            WHERE ts_utc >= datetime('now', '-{hours} hours')
              AND current_a IS NOT NULL
            """,
            conn,
        )

    if df.empty:
        return "No data for the requested period."

    features = (
        df.groupby("outlet_id")
          .current_a
          .agg(["mean", "std"])
          .fillna(0.0)
    )

    if os.path.exists(model_path):
        print("[DEBUG] Loading model from {}".format(model_path))
        model = joblib.load(model_path)
        scores = model.decision_function(features[["mean", "std"]].values)
        features["score"] = scores
        # Lower (more negative) score => more anomalous
        ranked = features.sort_values("score").head(top_n)
        print("[DEBUG] Found {} anomalous outlets".format(len(ranked)))
    else:
        print("[DEBUG] Model not found at {}, using fallback".format(model_path))
        # Fallback ranking by highest std deviation
        features["score"] = -features["std"]  # negative for consistency
        ranked = features.sort_values("score").head(top_n)

    ranked.index.name = "outlet_id"
    ranked.rename(columns={"mean": "mean_current_A"}, inplace=True)
    result = ranked[["mean_current_A", "std", "score"]].to_markdown()
    print("[DEBUG] Returning table:\n{}".format(result))
    return result
