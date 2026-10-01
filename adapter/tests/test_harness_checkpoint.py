"""Checkpoints / pause / resume (TS harness-checkpoint.ts + HarnessRuntime.resume)."""

from __future__ import annotations

import json
import warnings
from typing import Any

import pytest

from harness.checkpoint import (
    CHECKPOINT_SCHEMA_VERSION,
    CheckpointSchemaError,
    assert_checkpoint_schema_current,
    checkpoint_key,
    delete_harness_checkpoint,
    load_harness_checkpoint,
    save_harness_checkpoint,
)
from harness.runtime import HarnessRunOptions, HarnessRuntime
from tests.ts_state_schemas import check

STATE_KEYS = {
    "worldModel": "world_model",
    "callerState": "caller_state",
    "controlState": "control_state",
    "diagnostics": "diagnostics",
    "taskGraph": "task_graph",
    "outputContract": "output_contract",
    "evidenceStore": "evidence_store",
    "hypothesisSet": "hypothesis_set",
    "memoryState": "memory_state",
    "strategyState": "strategy_state",
    "failureDiagnostics": "failure_diagnostics",
    "beliefDepGraph": "belief_dep_graph",
}


def _collect(**kw: Any) -> tuple[list[dict[str, Any]], Any]:
    seen: list[dict[str, Any]] = []
    opts = HarnessRunOptions(on_checkpoint=seen.append, skip_reviewer_pass=True, **kw)
    return seen, HarnessRuntime().run("do it", ["one", "two"], opts)


def test_checkpoints_are_yielded_at_each_suspend_point_and_at_the_end() -> None:
    seen, result = _collect()
    kinds = [(c["progress"]["pendingProposal"] or {}).get("kind") for c in seen]
    assert kinds[0] == "proposal"
    assert None in kinds  # end-of-iteration checkpoints carry no pending proposal
    assert seen[-1]["progress"]["stepsUsed"] == result.steps_used
    assert seen[-1]["progress"]["pendingProposal"] is None


def test_checkpoint_has_the_ts_wire_shape() -> None:
    seen, _ = _collect()
    cp = seen[-1]
    assert set(cp) == {"runId", "runState", "runConfig", "progress", "schemaVersion"}
    assert cp["schemaVersion"] == CHECKPOINT_SCHEMA_VERSION == 2
    assert set(cp["runConfig"]) == {"objective", "successCriteria", "maxSteps", "depGraphBudget", "processConceptId"}
    assert set(cp["progress"]) == {
        "stepsUsed",
        "nodeExecutionOrder",
        "finalResult",
        "consecutiveReviewFailures",
        "propagationQueue",
        "pendingProposal",
        "pendingReviewerVerdict",
        "supervisorAskUserCount",
    }
    assert set(cp["runState"]) == {*STATE_KEYS, "experienceStore"}
    for ts_key, name in STATE_KEYS.items():
        assert check(name, cp["runState"][ts_key]) == [], ts_key
    assert cp["runState"]["experienceStore"]["schemaVersion"] >= 1
    json.dumps(cp)  # JSON-serialisable


@pytest.mark.parametrize("pause_kind", ["proposal", "iteration"])
def test_pause_then_resume_matches_an_uninterrupted_run(pause_kind: str) -> None:
    def pause(cp: dict[str, Any]) -> bool:
        pending = cp["progress"]["pendingProposal"]
        if pause_kind == "proposal":
            return pending is not None and pending["kind"] == "proposal"
        return pending is None and cp["progress"]["stepsUsed"] == 1

    baseline = HarnessRuntime().run("do it", ["one"], HarnessRunOptions(skip_reviewer_pass=True))
    first = HarnessRuntime().start("do it", ["one"], HarnessRunOptions(should_pause=pause, skip_reviewer_pass=True))
    assert first.status == "paused" and first.result is None and first.checkpoint is not None
    wire = json.loads(json.dumps(first.checkpoint))  # survives a real serialisation round trip
    resumed = HarnessRuntime().resume(wire, HarnessRunOptions(skip_reviewer_pass=True))
    assert resumed.status == "complete" and resumed.result is not None
    assert resumed.result.final_result == baseline.final_result
    assert resumed.result.context.task_graph.tasks[0].status == "COMPLETE"
    if pause_kind == "proposal":
        assert "action_gate_replay" in resumed.result.node_execution_order
        assert resumed.result.node_execution_order.count("select_task") == 1  # Sub-step A was not re-run


def test_pause_on_a_continuation_then_resume_finishes_the_task() -> None:
    calls = {"n": 0}

    def step() -> dict[str, object]:
        calls["n"] += 1
        return {"__harnessExecutionStatus": "continue"} if calls["n"] < 3 else {"completed": True}

    def pause(cp: dict[str, Any]) -> bool:
        pending = cp["progress"]["pendingProposal"]
        return pending is not None and pending["kind"] == "continuation"

    opts = HarnessRunOptions(tool_executors={"default": step}, should_pause=pause, skip_reviewer_pass=True)
    paused = HarnessRuntime().start("do it", ["one"], opts)
    assert paused.status == "paused" and calls["n"] == 1
    done = HarnessRuntime().resume(
        json.loads(json.dumps(paused.checkpoint)),
        HarnessRunOptions(tool_executors={"default": step}, skip_reviewer_pass=True),
    )
    assert done.result is not None and calls["n"] == 3
    assert "action_gate_replay_continuation" in done.result.node_execution_order
    assert done.result.context.task_graph.tasks[0].status == "COMPLETE"


def test_run_refuses_to_hide_a_pause() -> None:
    with pytest.raises(RuntimeError, match="paused"):
        HarnessRuntime().run("x", ["a"], HarnessRunOptions(should_pause=lambda _c: True))


def test_v1_checkpoint_is_migrated_and_a_newer_one_is_rejected() -> None:
    seen, _ = _collect()
    v2 = seen[0]
    v1 = json.loads(json.dumps(v2))
    v1.pop("schemaVersion")
    v1["progress"]["pendingProposal"] = {k: v for k, v in v2["progress"]["pendingProposal"].items() if k != "kind"}
    migrated = assert_checkpoint_schema_current(v1)
    assert migrated["schemaVersion"] == 2 and migrated["progress"]["pendingProposal"]["kind"] == "proposal"
    with pytest.raises(CheckpointSchemaError, match="newer"):
        assert_checkpoint_schema_current({**v2, "schemaVersion": 99})
    with pytest.raises(CheckpointSchemaError, match="no migration path"):
        assert_checkpoint_schema_current({**v2, "schemaVersion": 0})


class _Store:
    def __init__(self) -> None:
        self.data: dict[str, Any] = {}

    def get(self, key: str) -> Any:
        return self.data.get(key)

    def set(self, key: str, value: Any) -> None:
        self.data[key] = value

    def delete(self, key: str) -> None:
        self.data.pop(key, None)


def test_store_round_trip_and_unreadable_checkpoints_are_discarded() -> None:
    seen, _ = _collect()
    store = _Store()
    cp = seen[0]
    save_harness_checkpoint(store, cp)
    assert load_harness_checkpoint(store, cp["runId"]) == cp
    delete_harness_checkpoint(store, cp["runId"])
    assert load_harness_checkpoint(store, cp["runId"]) is None

    store.set(checkpoint_key("r2"), {**cp, "runId": "r2", "schemaVersion": 99})
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        assert load_harness_checkpoint(store, "r2") is None
    assert caught and "discarding unreadable checkpoint" in str(caught[0].message)
    assert store.get(checkpoint_key("r2")) is None
