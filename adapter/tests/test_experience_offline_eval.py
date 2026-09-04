"""
Phase G acceptance tests — experience offline-eval pipeline.

Covers the "evaluation" step of the promotion pipeline described in
harness/experience_store.py's module docstring: a candidate strategy-weight row must be
judged against the currently-promoted baseline (minimum sample size, then no-regression)
before run_offline_eval_pipeline() will promote it — closing the "softmax reinforcement
of accidental correlations" risk named in
plans/harness_consolidation_and_control_plane_plan.html Phase G.

Run with: pytest adapter/tests/test_experience_offline_eval.py -v --noconftest
"""

from __future__ import annotations

import sys
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.experience_store import (
    ExperienceStore,
    StrategyWeightKey,
    evaluate_candidate_strategy_weights,
    run_offline_eval_pipeline,
    upsert_strategy_weight,
)

# ─── Helpers — minimal in-memory session, mirroring test_harness_p8.py's pattern but
# also handling the "promoted = false" SELECT that get_pending_strategy_weights() issues.


class _FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class _InMemorySession:
    def __init__(self, db: dict[str, list[dict]]):
        self._db = db

    def execute(self, stmt, params=None):
        sql = str(stmt).strip()
        if "INSERT INTO experience_strategy_weights" in sql and params:
            key = (params.get("strategy_type"), params.get("failure_class"))
            weights = self._db.setdefault("experience_strategy_weights", [])
            existing = next((w for w in weights if (w["strategy_type"], w["failure_class"]) == key), None)
            success_inc = params.get("success_inc", 0)
            if existing:
                existing["attempt_count"] += 1
                existing["success_count"] += success_inc
                existing["rate"] = existing["success_count"] / existing["attempt_count"]
                existing["promoted"] = False
            else:
                weights.append(
                    {
                        "id": str(uuid.uuid4()),
                        "strategy_type": params.get("strategy_type"),
                        "failure_class": params.get("failure_class"),
                        "success_count": success_inc,
                        "attempt_count": 1,
                        "rate": float(success_inc),
                        "promoted": False,
                    }
                )
            return MagicMock()
        if "UPDATE experience_strategy_weights SET promoted = true" in sql:
            rows = self._db.setdefault("experience_strategy_weights", [])
            if params and params.get("strategy_type") is not None:
                for r in rows:
                    if r["strategy_type"] == params["strategy_type"] and r["failure_class"] == params["failure_class"]:
                        r["promoted"] = True
            else:
                for r in rows:
                    r["promoted"] = True
            return MagicMock()
        if "WHERE promoted = false" in sql and "experience_strategy_weights" in sql:
            rows = [r for r in self._db.get("experience_strategy_weights", []) if not r.get("promoted")]
            return _FakeResult(
                [
                    (r["strategy_type"], r["failure_class"], r["rate"], r["success_count"], r["attempt_count"])
                    for r in rows
                ]
            )
        if "SELECT" in sql and "FROM experience_strategy_weights" in sql:
            rows = [r for r in self._db.get("experience_strategy_weights", []) if r.get("promoted")]
            return _FakeResult([(r["strategy_type"], r["failure_class"], r["rate"]) for r in rows])
        if sql.strip().upper() == "SELECT 1":
            return _FakeResult([(1,)])
        return MagicMock()

    def commit(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


def _make_in_memory_store() -> ExperienceStore:
    db: dict[str, list[dict]] = {}

    @contextmanager
    def factory():
        yield _InMemorySession(db)

    return ExperienceStore(db_session_factory=factory)


def _record_attempts(store: ExperienceStore, strategy_type: str, failure_class: str, outcomes: list[bool]) -> None:
    with store.db_session_factory() as session:
        for success in outcomes:
            upsert_strategy_weight(strategy_type, failure_class, success, session)
        session.commit()


# ─── evaluate_candidate_strategy_weights ──────────────────────────────────────


def test_candidate_below_min_sample_size_is_not_promoted():
    store = _make_in_memory_store()
    _record_attempts(store, "DIRECT_EDIT", "syntax_error", [True, True])  # only 2 attempts

    results = evaluate_candidate_strategy_weights(store, min_sample_size=5)

    assert len(results) == 1
    assert results[0].promoted is False
    assert results[0].reason == "insufficient_sample"
    assert results[0].sample_size == 2


def test_candidate_below_min_success_rate_is_not_promoted():
    store = _make_in_memory_store()
    # Enough attempts to clear the sample-size bar, but mostly failing.
    _record_attempts(store, "DIRECT_EDIT", "syntax_error", [False, False, False, True, False])  # rate 0.2, n=5

    results = evaluate_candidate_strategy_weights(store, min_sample_size=5, min_success_rate=0.5)

    assert len(results) == 1
    assert results[0].reason == "below_min_success_rate"
    assert results[0].promoted is False
    assert results[0].candidate_rate == 0.2


def test_candidate_meeting_both_bars_passes():
    store = _make_in_memory_store()
    _record_attempts(store, "TRACE_EXEC", "import_error", [True, True, True, False, True])  # rate 0.8, n=5

    results = evaluate_candidate_strategy_weights(store, min_sample_size=5, min_success_rate=0.5)

    assert len(results) == 1
    assert results[0].reason == "passed"
    assert results[0].promoted is True
    assert results[0].sample_size == 5


def test_evaluate_is_read_only():
    """evaluate_candidate_strategy_weights() must not itself change promotion state —
    only run_offline_eval_pipeline() promotes."""
    store = _make_in_memory_store()
    _record_attempts(store, "TRACE_EXEC", "import_error", [True] * 5)

    evaluate_candidate_strategy_weights(store, min_sample_size=5)

    assert store.get_strategy_weights() == {}


def test_evaluate_unavailable_store_returns_empty():
    store = ExperienceStore(db_session_factory=None)
    assert evaluate_candidate_strategy_weights(store) == []


# ─── run_offline_eval_pipeline ────────────────────────────────────────────────


def test_pipeline_promotes_passing_candidates_and_leaves_failing_ones_pending():
    store = _make_in_memory_store()
    passing_key = StrategyWeightKey("TRACE_EXEC", "import_error")
    _record_attempts(store, "TRACE_EXEC", "import_error", [True] * 5)  # passes: n=5, rate=1.0
    _record_attempts(store, "DIRECT_EDIT", "syntax_error", [True, True])  # insufficient sample, n=2

    results = run_offline_eval_pipeline(store, min_sample_size=5)

    reasons = {r.key: r.reason for r in results}
    assert reasons[passing_key] == "passed"
    assert reasons[StrategyWeightKey("DIRECT_EDIT", "syntax_error")] == "insufficient_sample"

    weights = store.get_strategy_weights()
    assert passing_key in weights
    assert StrategyWeightKey("DIRECT_EDIT", "syntax_error") not in weights


def test_pipeline_never_promotes_a_candidate_below_the_rate_floor():
    store = _make_in_memory_store()
    key = StrategyWeightKey("DIRECT_EDIT", "syntax_error")
    _record_attempts(store, "DIRECT_EDIT", "syntax_error", [False, False, False, True, False])  # rate 0.2, n=5

    run_offline_eval_pipeline(store, min_sample_size=5, min_success_rate=0.5)

    assert key not in store.get_strategy_weights()


def test_pipeline_with_no_pending_candidates_is_a_no_op():
    store = _make_in_memory_store()
    assert run_offline_eval_pipeline(store) == []
    assert store.get_strategy_weights() == {}


def test_pipeline_unavailable_store_returns_empty_and_does_not_raise():
    store = ExperienceStore(db_session_factory=None)
    assert run_offline_eval_pipeline(store) == []
