"""
Phase 10 acceptance tests — Canvas Node Types & UI.

Tests T01–T30 as specified in plan/phase_10_plan.html.
All tests are infrastructure-free (no Postgres required).

Run with: pytest adapter/tests/test_harness_p10.py -v
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.control_state import ControlState
from harness.diagnostics import Diagnostics
from harness.evidence import Evidence, EvidenceStore
from harness.hypothesis import Hypothesis, HypothesisSet
from harness.recovery import StrategyState
from harness.task_graph import Task, TaskGraph
from harness.world_model import Belief, Observation, WorldModel

# ─── Helpers / fixtures ──────────────────────────────────────────────────────


def _make_world_model() -> WorldModel:
    wm = WorldModel()
    wm.add_observation(Observation(id="obs-1", content="error in module X", source="linter"))
    wm.add_belief(Belief(id="b-1", statement="module X has error", confidence=0.8, derived_from=["obs-1"]))
    return wm


def _make_evidence_store() -> EvidenceStore:
    store = EvidenceStore()
    store.append(
        Evidence(
            id=str(uuid.uuid4()),
            obs="obs1",
            reliability="HIGH",
            source="linter",
            evidence_type="OBSERVATION",
            freshness=1.0,
        )
    )
    return store


def _make_hypothesis_set() -> HypothesisSet:
    return HypothesisSet(
        active=[
            Hypothesis(
                id=f"h-{i}",
                explanation=f"hyp {i}",
                confidence=0.5,
                predicted_observations=[],
                discriminating_evidence=[],
                generation_sources=["symptom_inference"],
            )
            for i in range(4)
        ],
        eliminated=[],
    )


def _make_task_graph() -> TaskGraph:
    tg = TaskGraph(
        tasks=[
            Task(id="t1", description="task 1", status="PENDING", completed_evidence=[], abstraction_level=0),
            Task(id="t2", description="task 2", status="COMPLETE", completed_evidence=["ev1"], abstraction_level=0),
        ]
    )
    return tg


def _make_harness_spec(node: dict) -> dict:
    return {
        "spec_version": "1.0.0",
        "id": "test-flow",
        "name": "Test",
        "harness_meta": {"harness_version": "1.0", "enabled": True},
        "nodes": [
            {"id": "in", "type": "input", "position": {"x": 0, "y": 0}, "output_schema": {}},
            node,
            {"id": "out", "type": "output", "position": {"x": 300, "y": 0}},
        ],
        "edges": [
            {"id": "e1", "type": "direct", "from": "in", "to": node["id"]},
            {"id": "e2", "type": "direct", "from": node["id"], "to": "out"},
        ],
    }


def _validate(spec: dict) -> None:
    """Thin wrapper that calls validate_spec and converts HTTPException to plain exception."""
    import sys

    sys.path.insert(0, str(Path(__file__).parent.parent.parent / "adapter"))
    from adapter.validate import validate_spec

    validate_spec(spec)


def _validate_spec(spec: dict) -> None:
    """Call adapter.validate.validate_spec and let HTTPException propagate."""
    from validate import validate_spec

    validate_spec(spec)


# ══════════════════════════════════════════════════════════════════════════════
# P10.1 — World Model node (T01–T03)
# ══════════════════════════════════════════════════════════════════════════════


def test_t01_world_model_node_validates():
    """T01 · validate_spec accepts world_model node with display_mode=summary, max_beliefs_shown=10."""
    from validate import validate_spec

    node = {
        "id": "wm-1",
        "type": "world_model",
        "position": {"x": 150, "y": 0},
        "harness_config": {"display_mode": "summary", "max_beliefs_shown": 10},
    }
    validate_spec(_make_harness_spec(node))  # must not raise


def test_t02_world_model_invalid_display_mode_rejected():
    """T02 · validate_spec rejects world_model node with display_mode="invalid"."""
    from validate import HTTPException, validate_spec

    node = {
        "id": "wm-1",
        "type": "world_model",
        "position": {"x": 150, "y": 0},
        "harness_config": {"display_mode": "invalid"},
    }
    with pytest.raises(HTTPException) as exc_info:
        validate_spec(_make_harness_spec(node))
    assert exc_info.value.status_code == 400
    assert "display_mode" in exc_info.value.detail


def test_t03_compile_world_model_node_snapshot():
    """T03 · compile_world_model_node() emits code producing generation_id and belief/obs/contradiction counts."""
    from harness.node_compilers import compile_world_model_node

    node = {"harness_config": {"max_beliefs_shown": 5}}
    code = compile_world_model_node(node, "world_model", output_var="snapshot")

    wm = _make_world_model()
    ns: dict = {"world_model": wm}
    exec(code, ns)

    snapshot = ns["snapshot"]
    assert isinstance(snapshot, dict)
    assert snapshot["generation_id"] == wm.generation_id
    assert snapshot["belief_count"] == len(wm.beliefs)
    assert snapshot["observation_count"] == len(wm.observations)
    assert snapshot["contradiction_count"] == len(wm.contradictions)
    assert len(snapshot["beliefs"]) <= 5


# ══════════════════════════════════════════════════════════════════════════════
# P10.2 — Hypothesis Set node (T04–T06)
# ══════════════════════════════════════════════════════════════════════════════


def test_t04_hypothesis_set_node_validates():
    """T04 · validate_spec accepts hypothesis_set node with max_hypotheses_shown=5."""
    from validate import validate_spec

    node = {
        "id": "hs-1",
        "type": "hypothesis_set",
        "position": {"x": 150, "y": 0},
        "harness_config": {"max_hypotheses_shown": 5},
    }
    validate_spec(_make_harness_spec(node))


def test_t05_hypothesis_set_max_zero_rejected():
    """T05 · validate_spec rejects hypothesis_set with max_hypotheses_shown=0."""
    from validate import HTTPException, validate_spec

    node = {
        "id": "hs-1",
        "type": "hypothesis_set",
        "position": {"x": 150, "y": 0},
        "harness_config": {"max_hypotheses_shown": 0},
    }
    with pytest.raises(HTTPException) as exc_info:
        validate_spec(_make_harness_spec(node))
    assert exc_info.value.status_code == 400
    assert "max_hypotheses_shown" in exc_info.value.detail


def test_t06_compile_hypothesis_set_node():
    """T06 · compile_hypothesis_set_node() emits code that calls generate_hypotheses() and populates result."""
    from harness.node_compilers import compile_hypothesis_set_node

    node = {"harness_config": {"max_hypotheses_shown": 3}}
    code = compile_hypothesis_set_node(
        node,
        "world_model",
        "evidence_store",
        hypothesis_set_var="hypothesis_set",
        output_var="hs_result",
    )

    wm = _make_world_model()
    store = _make_evidence_store()
    ns: dict = {"world_model": wm, "evidence_store": store, "hypothesis_set": None}
    exec(code, ns)

    hs_result = ns["hs_result"]
    assert isinstance(hs_result, dict)
    assert "active_count" in hs_result
    assert "diversity_score" in hs_result
    assert isinstance(hs_result["active_count"], int)
    assert len(hs_result["top_hypotheses"]) <= 3


# ══════════════════════════════════════════════════════════════════════════════
# P10.3 — Control State node (T07–T09)
# ══════════════════════════════════════════════════════════════════════════════


def test_t07_control_state_node_validates():
    """T07 · validate_spec accepts control_state node with no harness_config required."""
    from validate import validate_spec

    node = {
        "id": "cs-1",
        "type": "control_state",
        "position": {"x": 150, "y": 0},
    }
    validate_spec(_make_harness_spec(node))


def test_t08_control_state_rejected_without_harness_enabled():
    """T08 · validate_spec rejects control_state node when harness_meta.enabled is absent."""
    from validate import HTTPException, validate_spec

    spec = {
        "spec_version": "1.0.0",
        "id": "test-flow",
        "name": "Test",
        "nodes": [
            {"id": "in", "type": "input", "position": {"x": 0, "y": 0}, "output_schema": {}},
            {"id": "cs-1", "type": "control_state", "position": {"x": 150, "y": 0}},
            {"id": "out", "type": "output", "position": {"x": 300, "y": 0}},
        ],
        "edges": [
            {"id": "e1", "type": "direct", "from": "in", "to": "cs-1"},
            {"id": "e2", "type": "direct", "from": "cs-1", "to": "out"},
        ],
    }
    with pytest.raises(HTTPException) as exc_info:
        validate_spec(spec)
    assert exc_info.value.status_code == 400
    assert "harness_meta.enabled" in exc_info.value.detail


def test_t09_compile_control_state_node():
    """T09 · compile_control_state_node() emits code that calls resolve_control_state()."""
    from harness.node_compilers import compile_control_state_node

    node = {}
    code = compile_control_state_node(node, "diagnostics", "world_model", control_state_var="control_state")

    wm = _make_world_model()
    diag = Diagnostics()
    ns: dict = {"diagnostics": diag, "world_model": wm, "control_state": None}
    exec(code, ns)

    cs = ns["control_state"]
    assert isinstance(cs, ControlState)
    assert cs.risk_state in {"NORMAL", "CAUTIOUS", "BLOCKED"}


# ══════════════════════════════════════════════════════════════════════════════
# P10.4 — Task Graph node (T10–T12)
# ══════════════════════════════════════════════════════════════════════════════


def test_t10_task_graph_node_validates():
    """T10 · validate_spec accepts task_graph_node with max_tasks_shown=20."""
    from validate import validate_spec

    node = {
        "id": "tg-1",
        "type": "task_graph_node",
        "position": {"x": 150, "y": 0},
        "harness_config": {"max_tasks_shown": 20},
    }
    validate_spec(_make_harness_spec(node))


def test_t11_task_graph_max_zero_rejected():
    """T11 · validate_spec rejects task_graph_node with max_tasks_shown=0."""
    from validate import HTTPException, validate_spec

    node = {
        "id": "tg-1",
        "type": "task_graph_node",
        "position": {"x": 150, "y": 0},
        "harness_config": {"max_tasks_shown": 0},
    }
    with pytest.raises(HTTPException) as exc_info:
        validate_spec(_make_harness_spec(node))
    assert exc_info.value.status_code == 400
    assert "max_tasks_shown" in exc_info.value.detail


def test_t12_compile_task_graph_node():
    """T12 · compile_task_graph_node() emits code that calls validate_task_graph() and select_unblocked_leaf()."""
    from harness.node_compilers import compile_task_graph_node

    node = {}
    code = compile_task_graph_node(node, "task_graph", output_var="tg_result")

    tg = _make_task_graph()
    ns: dict = {"task_graph": tg}
    exec(code, ns)

    tg_result = ns["tg_result"]
    assert isinstance(tg_result, dict)
    assert "validation_errors" in tg_result
    assert "next_task" in tg_result
    assert isinstance(tg_result["validation_errors"], list)


# ══════════════════════════════════════════════════════════════════════════════
# P10.5 — Verification Gate node (T13–T15)
# ══════════════════════════════════════════════════════════════════════════════


def test_t13_verification_gate_unknown_layer_rejected():
    """T13 · validate_spec rejects verification_gate with unknown enabled_layer."""
    from validate import HTTPException, validate_spec

    node = {
        "id": "vg-1",
        "type": "verification_gate",
        "position": {"x": 150, "y": 0},
        "harness_config": {"enabled_layers": ["syntax", "not_a_real_layer"]},
    }
    with pytest.raises(HTTPException) as exc_info:
        validate_spec(_make_harness_spec(node))
    assert exc_info.value.status_code == 400
    assert "not_a_real_layer" in exc_info.value.detail


def test_t14_verification_gate_valid_layers_accepted():
    """T14 · validate_spec accepts verification_gate with enabled_layers=["syntax","unit"]."""
    from validate import validate_spec

    node = {
        "id": "vg-1",
        "type": "verification_gate",
        "position": {"x": 150, "y": 0},
        "harness_config": {"enabled_layers": ["syntax", "unit"]},
    }
    validate_spec(_make_harness_spec(node))


def test_t15_compile_verification_gate_filters_enabled_layers():
    """T15 · compile_verification_gate_node() with enabled_layers=["syntax","unit"]
    produces VerificationResult with only those layers."""
    from harness.node_compilers import compile_verification_gate_node
    from harness.verification import VerificationResult

    node = {"harness_config": {"enabled_layers": ["syntax", "unit"]}}
    code = compile_verification_gate_node(
        node,
        "result",
        "tool_manifest",
        success_criteria_var="success_criteria",
        assumptions_var="assumptions",
        task_risk_var="task_risk",
        output_var="verify_result",
    )

    ns: dict = {
        "result": None,
        "tool_manifest": None,
        "success_criteria": None,
        "assumptions": None,
        "task_risk": "LOW",
    }
    exec(code, ns)

    vr = ns["verify_result"]
    assert isinstance(vr, VerificationResult)
    layers_in_result = {lr.layer for lr in vr.layer_results}
    assert layers_in_result == {"syntax", "unit"}


# ══════════════════════════════════════════════════════════════════════════════
# P10.6 — Recovery node (T16–T18)
# ══════════════════════════════════════════════════════════════════════════════


def test_t16_recovery_node_validates():
    """T16 · validate_spec accepts recovery_node with strategy_order_override=["MINIMAL_FIX","ESCALATE"]."""
    from validate import validate_spec

    node = {
        "id": "rn-1",
        "type": "recovery_node",
        "position": {"x": 150, "y": 0},
        "harness_config": {"strategy_order_override": ["MINIMAL_FIX", "ESCALATE"]},
    }
    validate_spec(_make_harness_spec(node))


def test_t17_recovery_node_unknown_strategy_rejected():
    """T17 · validate_spec rejects recovery_node with unknown strategy in strategy_order_override."""
    from validate import HTTPException, validate_spec

    node = {
        "id": "rn-1",
        "type": "recovery_node",
        "position": {"x": 150, "y": 0},
        "harness_config": {"strategy_order_override": ["MINIMAL_FIX", "NOT_A_STRATEGY"]},
    }
    with pytest.raises(HTTPException) as exc_info:
        validate_spec(_make_harness_spec(node))
    assert exc_info.value.status_code == 400
    assert "NOT_A_STRATEGY" in exc_info.value.detail


def test_t18_compile_recovery_node_strategy_override():
    """T18 · compile_recovery_node() with strategy_order_override=["MINIMAL_FIX","DIRECT_EDIT","ESCALATE"]
    initialises StrategyState with MINIMAL_FIX."""
    from harness.node_compilers import compile_recovery_node

    node = {"harness_config": {"strategy_order_override": ["MINIMAL_FIX", "DIRECT_EDIT", "ESCALATE"]}}
    code = compile_recovery_node(node, strategy_state_var="strategy_state")

    ns: dict = {"strategy_state": None, "state": {}}
    exec(code, ns)

    ss = ns["strategy_state"]
    assert isinstance(ss, StrategyState)
    assert ss.current_strategy == "MINIMAL_FIX"


# ══════════════════════════════════════════════════════════════════════════════
# P10.7 — Evidence Store node (T19–T21)
# ══════════════════════════════════════════════════════════════════════════════


def test_t19_evidence_store_node_validates():
    """T19 · validate_spec accepts evidence_store_node with max_evidence_shown=20."""
    from validate import validate_spec

    node = {
        "id": "es-1",
        "type": "evidence_store_node",
        "position": {"x": 150, "y": 0},
        "harness_config": {"max_evidence_shown": 20},
    }
    validate_spec(_make_harness_spec(node))


def test_t20_evidence_store_max_zero_rejected():
    """T20 · validate_spec rejects evidence_store_node with max_evidence_shown=0."""
    from validate import HTTPException, validate_spec

    node = {
        "id": "es-1",
        "type": "evidence_store_node",
        "position": {"x": 150, "y": 0},
        "harness_config": {"max_evidence_shown": 0},
    }
    with pytest.raises(HTTPException) as exc_info:
        validate_spec(_make_harness_spec(node))
    assert exc_info.value.status_code == 400
    assert "max_evidence_shown" in exc_info.value.detail


def test_t21_compile_evidence_store_node_initialises():
    """T21 · compile_evidence_store_node() emits code that initialises EvidenceStore when None."""
    from harness.node_compilers import compile_evidence_store_node

    node = {}
    code = compile_evidence_store_node(node, "evidence_store", "tool_manifest")

    ns: dict = {"evidence_store": None, "tool_manifest": None}
    exec(code, ns)

    from harness.evidence import EvidenceStore

    assert isinstance(ns["evidence_store"], EvidenceStore)
    assert ns["tool_manifest"] is not None


# ══════════════════════════════════════════════════════════════════════════════
# P10.8 — Experience Store node (T22–T24)
# ══════════════════════════════════════════════════════════════════════════════


def test_t22_experience_store_node_validates():
    """T22 · validate_spec accepts experience_store_node with no required harness_config."""
    from validate import validate_spec

    node = {
        "id": "xp-1",
        "type": "experience_store_node",
        "position": {"x": 150, "y": 0},
    }
    validate_spec(_make_harness_spec(node))


def test_t23_compile_experience_store_inv10_guard_present():
    """T23 · compile_experience_store_node() emits code with an INV-10 availability guard."""
    from harness.node_compilers import compile_experience_store_node

    node = {}
    code = compile_experience_store_node(node, "experience_store", "strategy_state")

    assert "available" in code, "compiled code must include an availability check (INV-10)"
    assert "WarmStartResult" in code or "warm_start" in code


def test_t24_compile_experience_store_unavailable_noop():
    """T24 · Compiled experience_store code runs without error when experience_store.available=False (INV-10)."""
    from harness.experience_store import ExperienceStore, WarmStartResult
    from harness.node_compilers import compile_experience_store_node

    node = {}
    code = compile_experience_store_node(node, "experience_store", "strategy_state", warm_start_output_var="ws_result")

    exp_store = ExperienceStore(db_session_factory=None)  # available=False when factory is None
    ns: dict = {"experience_store": exp_store, "strategy_state": None}
    exec(code, ns)  # must not raise

    ws_result = ns["ws_result"]
    assert isinstance(ws_result, WarmStartResult)
    assert ws_result.loaded is False


# ══════════════════════════════════════════════════════════════════════════════
# P10.9 — Reviewer Pass node (T25–T27)
# ══════════════════════════════════════════════════════════════════════════════


def test_t25_reviewer_pass_node_validates():
    """T25 · validate_spec accepts reviewer_pass node."""
    from validate import validate_spec

    node = {
        "id": "rp-1",
        "type": "reviewer_pass",
        "position": {"x": 150, "y": 0},
    }
    validate_spec(_make_harness_spec(node))


def test_t26_compile_reviewer_pass_emits_reviewer_pass_call():
    """T26 · compile_reviewer_pass_node() emits code that references reviewer_pass()."""
    from harness.node_compilers import compile_reviewer_pass_node

    node = {}
    code = compile_reviewer_pass_node(node)

    assert "reviewer_pass" in code
    assert "world_model" in code
    assert "task_graph" in code


def test_t27_compile_reviewer_pass_runs_in_namespace():
    """T27 · Compiled reviewer_pass code runs successfully with a minimal fixture and returns ReviewPassResult."""
    from harness.node_compilers import compile_reviewer_pass_node
    from harness.reviewer import ReviewPassResult

    node = {}
    code = compile_reviewer_pass_node(node, "world_model", "task_graph", "hypothesis_set", output_var="rev_result")

    wm = _make_world_model()
    tg = _make_task_graph()
    hs = _make_hypothesis_set()
    ns: dict = {"world_model": wm, "task_graph": tg, "hypothesis_set": hs}
    exec(code, ns)

    rev_result = ns["rev_result"]
    assert isinstance(rev_result, ReviewPassResult)


# ══════════════════════════════════════════════════════════════════════════════
# P10.10 — Integration / dispatch table (T28–T30)
# ══════════════════════════════════════════════════════════════════════════════


def test_t28_harness_node_compilers_has_all_p10_keys():
    """T28 · HARNESS_NODE_COMPILERS dispatch table contains all 13 expected keys (3 P1 + 9 P10 + 1 PC)."""
    from harness.node_compilers import HARNESS_NODE_COMPILERS

    expected = {
        # Phase 1
        "gather_evidence",
        "apply_tool_reliability",
        "update_world_model",
        # Phase 10
        "world_model",
        "hypothesis_set",
        "control_state",
        "task_graph_node",
        "verification_gate",
        "recovery_node",
        "evidence_store_node",
        "experience_store_node",
        "reviewer_pass",
        # Process concept (PC)
        "process_concept",
    }
    assert set(HARNESS_NODE_COMPILERS.keys()) == expected


def test_t29_all_p10_validators_accept_valid_configs():
    """T29 · All 9 P10 validate_harness_configs branches run without error for valid configs."""
    from validate import validate_spec

    p10_nodes = [
        {
            "id": "wm-1",
            "type": "world_model",
            "position": {"x": 0, "y": 0},
            "harness_config": {"display_mode": "summary", "max_beliefs_shown": 5},
        },
        {
            "id": "hs-1",
            "type": "hypothesis_set",
            "position": {"x": 0, "y": 0},
            "harness_config": {"max_hypotheses_shown": 3},
        },
        {"id": "cs-1", "type": "control_state", "position": {"x": 0, "y": 0}},
        {
            "id": "tg-1",
            "type": "task_graph_node",
            "position": {"x": 0, "y": 0},
            "harness_config": {"max_tasks_shown": 10},
        },
        {
            "id": "vg-1",
            "type": "verification_gate",
            "position": {"x": 0, "y": 0},
            "harness_config": {"enabled_layers": ["syntax", "unit", "integration"]},
        },
        {
            "id": "rn-1",
            "type": "recovery_node",
            "position": {"x": 0, "y": 0},
            "harness_config": {"strategy_order_override": ["DIRECT_EDIT", "ESCALATE"]},
        },
        {
            "id": "es-1",
            "type": "evidence_store_node",
            "position": {"x": 0, "y": 0},
            "harness_config": {"max_evidence_shown": 15},
        },
        {"id": "xp-1", "type": "experience_store_node", "position": {"x": 0, "y": 0}},
        {"id": "rp-1", "type": "reviewer_pass", "position": {"x": 0, "y": 0}},
    ]

    for node in p10_nodes:
        validate_spec(_make_harness_spec(node))  # must not raise


def test_t30_harness_nodes_without_enabled_rejected():
    """T30 · validate_spec rejects a spec with harness nodes when harness_meta.enabled is false (regression)."""
    from validate import HTTPException, validate_spec

    spec = {
        "spec_version": "1.0.0",
        "id": "test-flow",
        "name": "Test",
        "harness_meta": {"harness_version": "1.0", "enabled": False},
        "nodes": [
            {"id": "in", "type": "input", "position": {"x": 0, "y": 0}, "output_schema": {}},
            {"id": "wm-1", "type": "world_model", "position": {"x": 150, "y": 0}},
            {"id": "out", "type": "output", "position": {"x": 300, "y": 0}},
        ],
        "edges": [
            {"id": "e1", "type": "direct", "from": "in", "to": "wm-1"},
            {"id": "e2", "type": "direct", "from": "wm-1", "to": "out"},
        ],
    }
    with pytest.raises(HTTPException) as exc_info:
        validate_spec(spec)
    assert exc_info.value.status_code == 400
    assert "harness_meta.enabled" in exc_info.value.detail
