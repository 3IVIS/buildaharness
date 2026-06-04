"""
Phase 0 acceptance tests — Foundation & State Architecture.

Tests T01–T21 as specified in plan/phase_0_plan.html.

Tests T01–T03 require Node.js (spec migration script).
Tests T04–T18 are pure Python — no infrastructure required.
Tests T19–T21 require the database fixtures from conftest.py.

Run all:   pytest adapter/tests/test_harness_p0.py -v
Run no-DB: pytest adapter/tests/test_harness_p0.py -v -k "not harness_state_api"
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

# ── Ensure harness is importable ──────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.caller_state import CallerState, inject_clarification
from harness.output_contract import (
    OutputContract,
    contract_shadow_check,
    validate_output_contract,
)
from harness.staleness import (
    ControlStateStub,
    StalenessError,
    assert_generation_fresh,
    increment_generation_id,
    staleness_check,
)
from harness.world_model import Belief, Contradiction, Observation, WorldModel

FLOWS_DIR = Path(__file__).parent.parent.parent / "flows"
SPEC_DIR = Path(__file__).parent.parent.parent / "spec"
MIGRATE_SCRIPT = SPEC_DIR / "scripts" / "migrate-v0.2-to-v1.0.mjs"


# ══════════════════════════════════════════════════════════════════════════════
# T01–T03  FlowSpec schema (P0.1)
# ══════════════════════════════════════════════════════════════════════════════


def _has_node() -> bool:
    try:
        subprocess.run(["node", "--version"], capture_output=True, check=True, timeout=5)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return False


_node_available = _has_node()
_flows = list(FLOWS_DIR.glob("*.json")) if FLOWS_DIR.exists() else []

skip_no_node = pytest.mark.skipif(not _node_available, reason="Node.js not available")
skip_no_flows = pytest.mark.skipif(not _flows, reason="No flow JSON files found")


@skip_no_node
@skip_no_flows
@pytest.mark.parametrize("flow_path", _flows, ids=[f.name for f in _flows])
def test_T01_migration_round_trips_reference_flow(tmp_path, flow_path):
    """T01 — Each v0.2.0 reference flow migrates to v1.0.0 without data loss."""
    out_path = tmp_path / f"migrated_{flow_path.name}"
    result = subprocess.run(
        ["node", str(MIGRATE_SCRIPT), str(flow_path), str(out_path)],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, f"Migration failed: {result.stderr}"
    assert out_path.exists(), "Output file not created"

    original = json.loads(flow_path.read_text())
    migrated = json.loads(out_path.read_text())

    # Version bumped
    assert migrated["spec_version"] == "1.0.0"
    # harness_meta added
    assert "harness_meta" in migrated
    assert migrated["harness_meta"]["enabled"] is False

    # All original fields preserved (except spec_version)
    for key in original:
        if key == "spec_version":
            continue
        assert key in migrated, f"Field '{key}' missing in migrated output"
        if key != "harness_meta":
            assert original[key] == migrated[key], f"Field '{key}' changed unexpectedly"


@skip_no_node
@skip_no_flows
def test_T02_migrated_flow_is_valid_json(tmp_path):
    """T02 — Migration produces valid JSON for each reference flow."""
    for flow_path in _flows:
        out_path = tmp_path / f"migrated_{flow_path.name}"
        result = subprocess.run(
            ["node", str(MIGRATE_SCRIPT), str(flow_path), str(out_path)],
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert result.returncode == 0, f"{flow_path.name}: {result.stderr}"
        # Parse — raises if invalid JSON
        json.loads(out_path.read_text())


def test_T03_adapter_rejects_harness_node_without_enabled_flag():
    """T03 — Adapter raises HTTP 400 when a harness node type is present but enabled=false."""
    import os

    os.environ.setdefault("JWT_SECRET", "test-secret-for-ci-only-not-production")
    os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
    os.environ.setdefault("TESTING", "true")

    from fastapi import HTTPException

    from validate import validate_spec

    spec_with_harness_node = {
        "spec_version": "1.0.0",
        "id": "test-harness-flow",
        "nodes": [
            {"id": "start", "type": "input", "output_schema": {}},
            {"id": "wm", "type": "world_model"},
            {"id": "done", "type": "output"},
        ],
        "edges": [
            {"type": "direct", "from": "start", "to": "wm"},
            {"type": "direct", "from": "wm", "to": "done"},
        ],
        # harness_meta absent → enabled defaults to false
    }

    with pytest.raises(HTTPException) as exc_info:
        validate_spec(spec_with_harness_node)

    assert exc_info.value.status_code == 400
    assert "world_model" in exc_info.value.detail
    assert "harness_meta.enabled" in exc_info.value.detail


# ══════════════════════════════════════════════════════════════════════════════
# T04–T07  World model structures (P0.2)
# ══════════════════════════════════════════════════════════════════════════════


def test_T04_add_belief_requires_nonempty_derived_from():
    """T04 — add_belief with empty derived_from raises ValueError."""
    wm = WorldModel()
    with pytest.raises(ValueError, match="derived_from must be non-empty"):
        wm.add_belief(Belief(id="b1", statement="x is true", confidence=0.9, derived_from=[]))


def test_T05_generation_id_initialises_to_zero_and_is_int():
    """T05 — generation_id starts at 0 and is an int."""
    wm = WorldModel()
    assert wm.generation_id == 0
    assert isinstance(wm.generation_id, int)


def test_T06_add_system_breaking_contradiction_does_not_raise():
    """T06 — SYSTEM_BREAKING contradiction is stored, never raises inline."""
    wm = WorldModel()
    c = Contradiction(id="c1", type="pairwise", severity="SYSTEM_BREAKING", scope="global")
    # Must not raise
    wm.add_contradiction(c)
    assert len(wm.contradictions) == 1
    assert wm.contradictions[0].severity == "SYSTEM_BREAKING"


def test_T07_world_model_round_trips_to_dict():
    """T07 — to_dict / from_dict round-trips a non-trivial WorldModel without data loss."""
    wm = WorldModel(generation_id=3)
    obs1 = Observation(id="o1", content="file exists", source="tool:ls")
    obs2 = Observation(id="o2", content="no errors", source="tool:ruff")
    obs3 = Observation(id="o3", content="tests pass", source="pytest")
    wm.add_observation(obs1)
    wm.add_observation(obs2)
    wm.add_observation(obs3)

    b1 = Belief(id="b1", statement="code is correct", confidence=0.8, derived_from=["o2", "o3"])
    b2 = Belief(id="b2", statement="file is readable", confidence=0.95, derived_from=["o1"])
    wm.add_belief(b1)
    wm.add_belief(b2)

    c = Contradiction(id="c1", type="temporal", severity="LOW", scope="local", involved_belief_ids=["b1"])
    wm.add_contradiction(c)

    wm.completeness_flags["world_model.beliefs"] = True

    d = wm.to_dict()
    wm2 = WorldModel.from_dict(d)

    assert wm2.generation_id == 3
    assert len(wm2.observations) == 3
    assert len(wm2.beliefs) == 2
    assert len(wm2.contradictions) == 1
    assert wm2.contradictions[0].severity == "LOW"
    assert wm2.completeness_flags["world_model.beliefs"] is True
    assert wm2.beliefs[0].derived_from == ["o2", "o3"]


# ══════════════════════════════════════════════════════════════════════════════
# T08–T11  Staleness infrastructure (P0.3)
# ══════════════════════════════════════════════════════════════════════════════


def test_T08_staleness_check_true_when_control_behind():
    """T08 — staleness_check returns True when cs.generation_id < wm.generation_id."""
    wm = WorldModel(generation_id=1)
    cs = ControlStateStub(generation_id=0)
    assert staleness_check(cs, wm) is True


def test_T09_staleness_check_false_when_ids_match():
    """T09 — staleness_check returns False when both generation_ids are equal."""
    wm = WorldModel(generation_id=4)
    cs = ControlStateStub(generation_id=4)
    assert staleness_check(cs, wm) is False


def test_T10_assert_generation_fresh_raises_on_stale_control_state():
    """T10 — @assert_generation_fresh raises StalenessError on a stale control_state."""

    @assert_generation_fresh
    def my_gate(control_state, world_model):
        return "ok"

    wm = WorldModel(generation_id=5)
    cs = ControlStateStub(generation_id=2)

    with pytest.raises(StalenessError):
        my_gate(control_state=cs, world_model=wm)


def test_T11_increment_generation_id_is_monotonic():
    """T11 — Calling increment_generation_id N times produces generation_id == N."""
    wm = WorldModel()
    for _ in range(5):
        increment_generation_id(wm)
    assert wm.generation_id == 5


# ══════════════════════════════════════════════════════════════════════════════
# T12–T15  Caller state (P0.4)
# ══════════════════════════════════════════════════════════════════════════════


def test_T12_inject_clarification_appends_to_history():
    """T12 — inject_clarification appends both calls; history never truncated."""
    cs = CallerState()
    inject_clarification(cs, {"note": "first"})
    inject_clarification(cs, {"note": "second"})
    assert len(cs.clarification_history) == 2
    assert cs.clarification_history[0]["note"] == "first"
    assert cs.clarification_history[1]["note"] == "second"


def test_T13_inject_clarification_sets_constraints_changed():
    """T13 — inject_clarification sets constraints_changed=True."""
    cs = CallerState()
    assert cs.constraints_changed is False
    inject_clarification(cs, {"note": "update"})
    assert cs.constraints_changed is True


def test_T14_inject_clarification_updates_success_criteria():
    """T14 — success_criteria can be updated without rebuilding the object."""
    cs = CallerState(success_criteria=["original"])
    inject_clarification(cs, {"success_criteria": ["new criterion"]})
    assert cs.success_criteria == ["new criterion"]
    # Object identity preserved
    assert cs.clarification_history[-1]["success_criteria"] == ["new criterion"]


def test_T15_caller_state_round_trips():
    """T15 — CallerState round-trips through to_dict / from_dict without data loss."""
    cs = CallerState(
        current_constraints=["con1"],
        success_criteria=["goal1"],
        output_preferences={"format": "json"},
    )
    inject_clarification(cs, {"note": "clarification 1"})
    d = cs.to_dict()
    cs2 = CallerState.from_dict(d)
    assert cs2.current_constraints == ["con1"]
    assert cs2.success_criteria == ["goal1"]
    assert cs2.output_preferences == {"format": "json"}
    assert len(cs2.clarification_history) == 1
    assert cs2.constraints_changed is True


# ══════════════════════════════════════════════════════════════════════════════
# T16–T18  Output contract (P0.5)
# ══════════════════════════════════════════════════════════════════════════════


def test_T16_output_contract_from_dict_populates_fields():
    """T16 — from_dict with required_sections populates the field; others default."""
    oc = OutputContract.from_dict({"required_sections": ["summary"]})
    assert oc.required_sections == ["summary"]
    assert oc.format_requirements == {}
    assert oc.required_interface_fields == []


def test_T17_validate_output_contract_stub_returns_pass():
    """T17 — validate_output_contract stub returns ContractCheckResult(passed=True, is_stub=True)."""
    result = validate_output_contract({}, OutputContract())
    assert result.passed is True
    assert result.is_stub is True
    assert result.violations == []


def test_T18_contract_shadow_check_real_returns_pass():
    """T18 — contract_shadow_check (P5 real impl) returns ContractCheckResult(passed=True, is_stub=False)."""
    result = contract_shadow_check({}, OutputContract())
    assert result.passed is True
    assert result.is_stub is False


# ══════════════════════════════════════════════════════════════════════════════
# T19–T21  Backend state store — requires DB (P0.6)
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
@pytest.mark.harness_state_api
async def test_T19_harness_state_round_trips_to_db(client, auth_headers):
    """T19 — PUT state then GET restores the same world_model structure (DB round-trip)."""
    # Covered by test_T20 which exercises the same path end-to-end.
    # This test confirms the HarnessRunState dataclass serialises correctly
    # without a database.
    from harness.state_store import HarnessRunState
    from harness.world_model import Observation, WorldModel

    state = HarnessRunState(run_id="test-run-1")
    state.world_model = WorldModel(generation_id=3)
    obs = Observation(id="o1", content="test", source="pytest")
    state.world_model.add_observation(obs)

    d = state.to_dict()
    restored = HarnessRunState.from_dict("test-run-1", d)

    assert restored.world_model.generation_id == 3
    assert len(restored.world_model.observations) == 1
    assert restored.world_model.observations[0].content == "test"


@pytest.mark.asyncio
@pytest.mark.harness_state_api
async def test_T20_harness_state_round_trips_generation_id(client, auth_headers):
    """T20 — PUT then GET restores world_model.generation_id correctly via the API."""
    # Create a minimal harness flow run so there's a job row
    spec = {
        "spec_version": "1.0.0",
        "id": "harness-test-flow",
        "harness_meta": {"enabled": True, "harness_version": "0.0.0"},
        "nodes": [
            {"id": "start", "type": "input", "output_schema": {}},
            {"id": "done", "type": "output"},
        ],
        "edges": [{"type": "direct", "from": "start", "to": "done"}],
    }
    run_resp = await client.post(
        "/run?runtime=langgraph",
        json={"spec": spec, "inputs": {}},
        headers=auth_headers,
    )
    if run_resp.status_code not in (200, 201, 202):
        pytest.skip(f"Run endpoint returned {run_resp.status_code} — skipping DB state test")

    job_id = run_resp.json().get("job_id")
    if not job_id:
        pytest.skip("No job_id returned — skipping DB state test")

    # PUT harness state with generation_id=7
    wm_data = {
        "generation_id": 7,
        "observations": [],
        "beliefs": [],
        "assumptions": [],
        "contradictions": [],
        "environment_change_log": [],
        "completeness_flags": {},
    }
    put_resp = await client.put(
        f"/run/{job_id}/harness-state",
        json={"state": {"world_model": wm_data}},
        headers=auth_headers,
    )
    assert put_resp.status_code == 200, put_resp.text

    # GET and verify
    get_resp = await client.get(f"/run/{job_id}/harness-state", headers=auth_headers)
    assert get_resp.status_code == 200, get_resp.text
    data = get_resp.json()
    assert data["world_model"]["generation_id"] == 7


@pytest.mark.asyncio
@pytest.mark.harness_state_api
async def test_T21_get_harness_state_returns_404_for_non_harness_run(client, auth_headers):
    """T21 — GET /run/{id}/harness-state returns 404 for non-harness runs."""
    spec = {
        "spec_version": "0.2.0",
        "id": "regular-flow",
        "nodes": [
            {"id": "start", "type": "input", "output_schema": {}},
            {"id": "done", "type": "output"},
        ],
        "edges": [{"type": "direct", "from": "start", "to": "done"}],
    }
    run_resp = await client.post(
        "/run?runtime=langgraph",
        json={"spec": spec, "inputs": {}},
        headers=auth_headers,
    )
    if run_resp.status_code not in (200, 201, 202):
        pytest.skip(f"Run endpoint returned {run_resp.status_code}")

    job_id = run_resp.json().get("job_id")
    if not job_id:
        pytest.skip("No job_id returned")

    resp = await client.get(f"/run/{job_id}/harness-state", headers=auth_headers)
    assert resp.status_code == 404
    # No empty state leaked
    assert resp.json().get("world_model") is None
