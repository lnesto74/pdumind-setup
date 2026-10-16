"""Cache, failed login, outlet patches and reachability must not renew a sample."""
from telemetry_freshness import (
    annotate_power_units, commit_poll, embedded_power_unit, live_payload,
    note_sample, sample_clock, stamp_entries,
)

store = {}
measured = "2026-10-14T07:00:00Z"
results = {
    "total_active_power": {"name": "total_active_power", "value": "0.720kW"},
    "MasterPowerP1": {"name": "MasterPowerP1", "value": "0.360kW"},
    "l1_voltage": {"name": "l1_voltage", "value": "230.1"},
}
stamp_entries(results, measured)
annotate_power_units(results)
assert results["total_active_power"]["unit"] == "kW"
assert results["MasterPowerP1"]["unit"] == "kW"
assert results["l1_voltage"].get("unit") is None
assert embedded_power_unit("720") is None

bare = {"l1_active_power": {"name": "l1_active_power", "value": "360"}}
annotate_power_units(bare, default_unit="W")
assert bare["l1_active_power"]["unit"] == "W"
ambiguous = {"l1_active_power": {"name": "l1_active_power", "value": "360"}}
annotate_power_units(ambiguous)
assert "unit" not in ambiguous["l1_active_power"]

note_sample(store, "10.0.0.1", kind="full", measured_at=measured, last_attempt_at=measured,
            last_success_at=measured, authentication="ok", reachability="online", stale=False)
kept, errors, snapshot = commit_poll({}, {}, store["10.0.0.1"], results, {})
assert snapshot is True and kept["total_active_power"]["measured_at"] == measured

attempt = "2026-10-14T07:01:00Z"
note_sample(store, "10.0.0.1", kind="auth_failed", last_attempt_at=attempt,
            authentication="failed", reachability="online", stale=True, error="PDU login failed after 5 retries")
assert store["10.0.0.1"]["measured_at"] == measured
assert store["10.0.0.1"]["last_success_at"] == measured
failed_errors = {"_remote": {"name": "_remote", "error": "PDU login failed after 5 retries"}}
kept, errors, snapshot = commit_poll(results, {}, store["10.0.0.1"], results, failed_errors)
assert snapshot is False and kept["total_active_power"]["measured_at"] == measured
payload = live_payload("10.0.0.1", kept, errors, store["10.0.0.1"], source="web_admin")
assert payload["status"] == "partial" and payload["stale"] is True
assert payload["measured_at"] == measured and payload["authentication"] == "failed"
assert payload["last_attempt_at"] == attempt

note_sample(store, "10.0.0.1", kind="unreachable", last_attempt_at="2026-10-14T07:02:00Z",
            reachability="offline", stale=True, error="unreachable")
assert store["10.0.0.1"]["measured_at"] == measured
assert store["10.0.0.1"]["authentication"] == "failed"
offline = live_payload("10.0.0.1", results, {"_unreachable": {"name": "_unreachable", "error": "unreachable"}}, store["10.0.0.1"])
assert offline["stale"] is True and offline["reachability"] == "offline"
assert offline["measured_at"] == measured

before = results["total_active_power"]["measured_at"]
outlet_at = "2026-10-14T07:03:00Z"
results["Output1Status"] = {"name": "Output1Status", "value": "on", "measured_at": measured}
stamp_entries(results, outlet_at, only=["Output1Status"])
note_sample(store, "10.0.0.1", outlet_patched_at=outlet_at)
assert results["total_active_power"]["measured_at"] == before
assert results["Output1Status"]["measured_at"] == outlet_at
assert store["10.0.0.1"]["measured_at"] == measured
assert store["10.0.0.1"].get("kind") != "full" or store["10.0.0.1"]["measured_at"] == measured

note_sample(store, "10.0.0.1", kind="skipped")
kept, errors, snapshot = commit_poll(results, failed_errors, store["10.0.0.1"], {}, {})
assert snapshot is False and kept is results and errors is failed_errors
assert store["10.0.0.1"]["measured_at"] == measured

recovered = sample_clock(1_760_428_800)
note_sample(store, "10.0.0.1", kind="full", measured_at=recovered, last_attempt_at=recovered,
            last_success_at=recovered, authentication="ok", reachability="online", stale=False, error=None)
fresh = live_payload("10.0.0.1", results, {}, store["10.0.0.1"])
assert fresh["stale"] is False and fresh["authentication"] == "ok" and fresh["measured_at"] == recovered

legacy = live_payload("10.0.0.2", results, {}, {})
assert legacy["stale"] is True and legacy["measured_at"] is None
print("PASS: stale cache, failed login, outlet patch, skip, recovery and legacy cache.")
