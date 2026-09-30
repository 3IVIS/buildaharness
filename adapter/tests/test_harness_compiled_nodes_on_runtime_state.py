"""Canvas node compilers (generated code) must keep working on the TS-shaped state the runtime builds."""

from __future__ import annotations

from typing import Any

from harness.node_compilers import HARNESS_NODE_COMPILERS
from harness.runtime import HarnessRunOptions, HarnessRuntime, initialize_harness_state


def _run(code: str, ns: dict[str, Any]) -> None:
    exec(compile(code, "<generated>", "exec"), ns)


def _namespace() -> dict[str, Any]:
    init = initialize_harness_state("obj", success_criteria=["a", "b"])
    return {
        "world_model": init.world_model,
        "evidence_store": init.evidence_store,
        "diagnostics": init.diagnostics,
        "hypothesis_set": init.hypothesis_set,
        "task_graph": init.task_graph,
        "strategy_state": init.strategy_state,
        "tool_manifest": None,
        "success_criteria": ["a"],
        "assumptions": [],
        "task_risk": "LOW",
        "tool_output": "hello",
        "state": {},
    }


def test_evidence_pipeline_nodes_exec_on_ts_state() -> None:
    ns = _namespace()
    ns["evidence_store"].tool_availability_manifest.clear()
    _run(HARNESS_NODE_COMPILERS["gather_evidence"]({"harness_config": {"source_tool": "t"}}, "evidence_store"), ns)
    ev = ns["evidence_store"].observations[0]
    assert isinstance(ev.freshness, str) and "T" in ev.freshness  # ISO, as in TS
    _run(HARNESS_NODE_COMPILERS["apply_tool_reliability"]({}, "evidence_store", "diagnostics"), ns)
    _run(HARNESS_NODE_COMPILERS["update_world_model"]({}, "world_model", "evidence_store"), ns)
    assert [o.content for o in ns["world_model"].observations] == ["hello"]


def test_state_nodes_exec_on_ts_state() -> None:
    ns = _namespace()
    for name, args in [
        ("hypothesis_set", ("world_model", "evidence_store")),
        ("control_state", ("diagnostics", "world_model")),
        ("task_graph_node", ("task_graph",)),
        ("recovery_node", ()),
        ("world_model", ("world_model",)),
        ("reviewer_pass", ()),
    ]:
        key = {"task_graph_node": "task_graph_node", "recovery_node": "recovery_node"}.get(name, name)
        _run(HARNESS_NODE_COMPILERS[key]({}, *args), ns)
    assert ns["control_state"].permission in {"ALLOW", "DENY"}
    assert ns["reviewer_result"].reopened_task_ids == []


def test_verification_gate_output_feeds_the_runtime_gate() -> None:
    ns = _namespace()
    ns["result"] = {"completed": True}
    _run(HARNESS_NODE_COMPILERS["verification_gate"]({}, "result", "tool_manifest"), ns)
    assert ns["verify_result"].has_critical_failure is False


def test_runtime_state_round_trips_through_node_output_shapes() -> None:
    result = HarnessRuntime().run("obj", ["a"], HarnessRunOptions(skip_reviewer_pass=True))
    ns = _namespace()
    ns["world_model"] = result.context.world_model
    _run(HARNESS_NODE_COMPILERS["world_model"]({}, "world_model"), ns)
    assert ns["wm_snapshot"]["generation_id"] == result.context.world_model.generation_id
