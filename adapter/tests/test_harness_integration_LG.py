"""
Phase 11 — LangGraph adapter harness integration tests (P11.1).

Tests:
  IG-LG-01  compile_langgraph accepts a harness-enabled FlowSpec without error
  IG-LG-02  Generated code contains HarnessRunState initialisation
  IG-LG-03  Harness node types produce node functions (not stubs)
  IG-LG-04  Non-harness path is unaffected when harness_meta.enabled is False/absent
  IG-LG-05  harness_meta.enabled=True with all 12 harness node types compiles cleanly

Run with: pytest adapter/tests/test_harness_integration_LG.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from langgraph_adapter import compile_langgraph

HARNESS_NODE_TYPES = [
    "gather_evidence",
    "apply_tool_reliability",
    "update_world_model",
    "world_model",
    "hypothesis_set",
    "control_state",
    "task_graph_node",
    "verification_gate",
    "recovery_node",
    "evidence_store_node",
    "experience_store_node",
    "reviewer_pass",
]


def _harness_spec(extra_nodes: list[dict] | None = None) -> dict:
    nodes = [
        {"id": "in", "type": "input", "position": {"x": 0, "y": 0}, "output_schema": {}},
    ]
    if extra_nodes:
        nodes.extend(extra_nodes)
    nodes.append({"id": "out", "type": "output", "position": {"x": 600, "y": 0}})
    edges = []
    prev = "in"
    for n in (extra_nodes or []):
        edges.append({"id": f"e-{prev}-{n['id']}", "type": "direct", "from": prev, "to": n["id"]})
        prev = n["id"]
    edges.append({"id": "e-out", "type": "direct", "from": prev, "to": "out"})
    return {
        "spec_version": "1.0.0",
        "id": "harness-test-flow",
        "name": "Harness Test Flow",
        "harness_meta": {"harness_version": "1.0.0", "enabled": True},
        "nodes": nodes,
        "edges": edges,
        "state_schema": {"properties": {"tool_output": {"type": "string"}, "result": {"type": "object"}}},
    }


def _plain_spec() -> dict:
    return {
        "spec_version": "1.0.0",
        "id": "plain-flow",
        "name": "Plain Flow",
        "nodes": [
            {"id": "in", "type": "input", "position": {"x": 0, "y": 0}, "output_schema": {}},
            {"id": "out", "type": "output", "position": {"x": 200, "y": 0}},
        ],
        "edges": [{"id": "e1", "type": "direct", "from": "in", "to": "out"}],
        "state_schema": {"properties": {"input": {"type": "string"}}},
    }


# ── IG-LG-01 ─────────────────────────────────────────────────────────────────

def test_ig_lg_01_harness_spec_compiles():
    """IG-LG-01: compile_langgraph accepts a harness-enabled FlowSpec without error."""
    spec = _harness_spec([{
        "id": "ev-1", "type": "gather_evidence", "position": {"x": 100, "y": 0},
        "harness_config": {"source_tool": "linter", "evidence_type": "OBSERVATION"},
    }])
    code, _warnings = compile_langgraph(spec)
    assert isinstance(code, str)
    assert len(code) > 0


# ── IG-LG-02 ─────────────────────────────────────────────────────────────────

def test_ig_lg_02_harness_preamble_in_generated_code():
    """IG-LG-02: Generated code contains HarnessRunState initialisation."""
    spec = _harness_spec([{
        "id": "ev-1", "type": "gather_evidence", "position": {"x": 100, "y": 0},
        "harness_config": {"source_tool": "linter", "evidence_type": "OBSERVATION"},
    }])
    code, _ = compile_langgraph(spec)
    assert "_HarnessRunState" in code or "HarnessRunState" in code
    assert "_harness_state" in code


# ── IG-LG-03 ─────────────────────────────────────────────────────────────────

def test_ig_lg_03_harness_nodes_produce_node_functions():
    """IG-LG-03: Harness node types produce node functions, not stubs."""
    spec = _harness_spec([{
        "id": "wm-1", "type": "world_model", "position": {"x": 100, "y": 0},
        "harness_config": {"display_mode": "summary", "max_beliefs_shown": 10},
    }])
    code, _ = compile_langgraph(spec)
    assert "node_wm_1" in code
    assert "harness" in code.lower()


# ── IG-LG-04 ─────────────────────────────────────────────────────────────────

def test_ig_lg_04_non_harness_path_unaffected():
    """IG-LG-04: Non-harness path is unaffected when harness_meta is absent."""
    spec = _plain_spec()
    code, _warnings = compile_langgraph(spec)
    assert isinstance(code, str)
    assert "_harness_state" not in code
    assert "HarnessRunState" not in code


# ── IG-LG-05 ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("ntype,harness_config", [
    ("gather_evidence", {"source_tool": "linter", "evidence_type": "OBSERVATION"}),
    ("apply_tool_reliability", {"apply_to": "inferences_only"}),
    ("update_world_model", {"reliability_threshold": "HIGH"}),
    ("world_model", {"display_mode": "summary", "max_beliefs_shown": 10}),
    ("hypothesis_set", {"max_hypotheses_shown": 5}),
    ("control_state", {}),
    ("task_graph_node", {}),
    ("verification_gate", {}),
    ("recovery_node", {}),
    ("evidence_store_node", {}),
    ("experience_store_node", {}),
    ("reviewer_pass", {}),
])
def test_ig_lg_05_all_harness_node_types_compile(ntype: str, harness_config: dict):
    """IG-LG-05: All 12 harness node types compile without error in LangGraph adapter."""
    spec = _harness_spec([{
        "id": f"node-{ntype}", "type": ntype, "position": {"x": 100, "y": 0},
        "harness_config": harness_config,
    }])
    code, _ = compile_langgraph(spec)
    assert isinstance(code, str)
    assert len(code) > 0
