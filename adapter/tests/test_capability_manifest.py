"""Tests for Phase 7's capability manifest (adapter/capability_manifest.py)."""

from capability_manifest import (
    CAPABILITIES,
    RUNTIME_CAPABILITIES,
    missing_capabilities,
    partial_capability_warnings,
    required_capabilities,
)


def _spec(**flow_config_and_nodes):
    nodes = flow_config_and_nodes.pop("nodes", [{"type": "input"}, {"type": "output"}])
    return {"flow_config": flow_config_and_nodes, "nodes": nodes}


def test_plain_spec_requires_nothing():
    spec = {"nodes": [{"type": "input"}, {"type": "output"}]}
    assert required_capabilities(spec) == set()
    for runtime in RUNTIME_CAPABILITIES:
        assert missing_capabilities(spec, runtime) == []
        assert partial_capability_warnings(spec, runtime) == []


def test_checkpoint_enabled_requires_durable_checkpoint():
    spec = _spec(checkpoint={"enabled": True})
    assert required_capabilities(spec) == {"durable_checkpoint"}


def test_checkpoint_disabled_requires_nothing():
    spec = _spec(checkpoint={"enabled": False})
    assert required_capabilities(spec) == set()


def test_streaming_tokens_mode_requires_streaming_tokens():
    spec = _spec(streaming={"enabled": True, "mode": "tokens"})
    assert required_capabilities(spec) == {"streaming_tokens"}


def test_streaming_updates_mode_does_not_require_streaming_tokens():
    spec = _spec(streaming={"enabled": True, "mode": "updates"})
    assert required_capabilities(spec) == set()


def test_hitl_breakpoint_node_requires_human_interrupt():
    spec = {"nodes": [{"type": "input"}, {"type": "hitl_breakpoint"}, {"type": "output"}]}
    assert required_capabilities(spec) == {"human_interrupt"}


def test_tool_approval_human_requires_human_interrupt():
    spec = {
        "nodes": [
            {"type": "input"},
            {"type": "agent_role", "config": {"tool_approval": "human"}},
            {"type": "output"},
        ]
    }
    assert required_capabilities(spec) == {"human_interrupt"}


def test_tool_approval_auto_requires_nothing():
    spec = {
        "nodes": [
            {"type": "input"},
            {"type": "agent_role", "config": {"tool_approval": "auto"}},
            {"type": "output"},
        ]
    }
    assert required_capabilities(spec) == set()


def test_parallel_join_node_requires_parallel_join():
    spec = {"nodes": [{"type": "input"}, {"type": "parallel_join"}, {"type": "output"}]}
    assert required_capabilities(spec) == {"parallel_join"}


def test_durable_checkpoint_missing_on_mastra_fails_fast():
    spec = _spec(checkpoint={"enabled": True})
    assert missing_capabilities(spec, "mastra") == ["durable_checkpoint"]


def test_durable_checkpoint_partial_on_langgraph_warns_not_fails():
    spec = _spec(checkpoint={"enabled": True})
    assert missing_capabilities(spec, "langgraph") == []
    warnings = partial_capability_warnings(spec, "langgraph")
    assert len(warnings) == 1
    assert "durable_checkpoint" in warnings[0]


def test_human_interrupt_and_parallel_join_are_full_everywhere():
    for runtime, support in RUNTIME_CAPABILITIES.items():
        assert support["human_interrupt"] == "full", runtime
        assert support["parallel_join"] == "full", runtime


def test_transactional_tool_never_required_no_schema_producer_yet():
    # No ToolDef field exists to declare transactional semantics, so no spec shape can
    # request this capability today — confirms the manifest doesn't fabricate a requirement.
    spec = {
        "nodes": [{"type": "input"}, {"type": "output"}],
        "tools": {"t1": {"source": "local", "tool_ref": "./x:fn", "transactional": True}},
    }
    assert "transactional_tool" not in required_capabilities(spec)


def test_every_runtime_declares_every_capability():
    for runtime, support in RUNTIME_CAPABILITIES.items():
        assert set(support.keys()) == set(CAPABILITIES), runtime
