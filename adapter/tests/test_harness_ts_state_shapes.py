"""Every state structure's `to_dict()` must validate against the TS zod schema it is checkpointed with."""

from __future__ import annotations

import pytest

from harness.runtime import HarnessRunOptions, HarnessRuntime, initialize_harness_state
from tests.ts_state_schemas import check

NAMES = [
    "world_model",
    "belief_dep_graph",
    "dep_graph_budget",
    "caller_state",
    "control_state",
    "diagnostics",
    "task_graph",
    "output_contract",
    "evidence_store",
    "hypothesis_set",
    "memory_state",
    "strategy_state",
    "failure_diagnostics",
]


def _flaky(_ctx: object = None) -> dict[str, bool]:
    raise RuntimeError("boom")


def _populated_context():  # type: ignore[no-untyped-def]
    opts = HarnessRunOptions(
        tool_executors={"task-1": _flaky},
        fact_extractor=lambda _o: [{"statement": "the sky is blue"}],
        experience_learning=True,
        caller_constraints=["be brief"],
    )
    return HarnessRuntime().run("obj", ["a", "b", "c"], opts).context


def _obj(ctx, name: str):  # type: ignore[no-untyped-def]
    return getattr(ctx, name, None) or getattr(ctx.init, name)


@pytest.mark.parametrize("name", NAMES)
def test_fresh_state_matches_ts_schema(name: str) -> None:
    init = initialize_harness_state("o", success_criteria=["a"])
    assert check(name, getattr(init, name).to_dict()) == []


@pytest.mark.parametrize("name", NAMES)
def test_populated_state_matches_ts_schema(name: str) -> None:
    ctx = _populated_context()
    assert check(name, _obj(ctx, name).to_dict()) == []


@pytest.mark.parametrize("name", NAMES)
def test_round_trip_is_stable_and_still_ts_shaped(name: str) -> None:
    ctx = _populated_context()
    obj = _obj(ctx, name)
    data = obj.to_dict()
    again = type(obj).from_dict(data).to_dict()
    assert again == data
    assert check(name, again) == []
