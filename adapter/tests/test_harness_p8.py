"""
Phase 8 acceptance tests — Experience Store & Learning.

Tests T01–T12 as specified in plan/phase_8_plan.html.

Tests T01–T09 require a running Postgres instance (migration 0011 applied).
Tests T10–T12 use mock session factories and run without infrastructure.

Run with: pytest adapter/tests/test_harness_p8.py -v
Set DATABASE_URL env var to enable Postgres-dependent tests (T01–T09).
"""

from __future__ import annotations

import sys
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.belief_graph import DepGraphBudget
from harness.experience_store import (
    DEFAULT_STRATEGY_ORDER,
    ExecutionContext,
    ExperienceEntry,
    ExperienceStore,
    ExperienceType,
    StrategyWeightKey,
    WarmStartResult,
    build_strategy_ordering,
    softmax_strategy_policy,
    update_experience_store,
    warm_start,
)
from harness.recovery import StrategyState
from harness.task_graph import Task, TaskGraph

# ─── Helpers ─────────────────────────────────────────────────────────────────


def _make_failing_factory():
    """Return a session factory that always raises a connection error."""

    def factory():
        raise ConnectionError("DB unavailable")

    return factory


def _make_mock_store(available: bool = True) -> ExperienceStore:
    """Return an ExperienceStore whose available property is mocked."""
    store = ExperienceStore(db_session_factory=None)
    store.__class__ = type(
        "MockedStore",
        (ExperienceStore,),
        {"available": property(lambda self: available)},
    )
    return store


class _InMemorySession:
    """Minimal in-memory session for unit tests that don't need real Postgres."""

    def __init__(self, db: dict[str, list[dict]]):
        self._db = db
        self._pending: list[tuple[str, dict]] = []

    def execute(self, stmt, params=None):
        sql = str(stmt).strip()
        # Handle INSERT into experience_entries
        if "INSERT INTO experience_entries" in sql and params:
            import json

            payload = params.get("payload", "{}")
            if isinstance(payload, str):
                payload = json.loads(payload)
            self._pending.append(
                (
                    "experience_entries",
                    {
                        "id": params.get("id"),
                        "entry_type": params.get("entry_type"),
                        "failure_class": params.get("failure_class"),
                        "task_class": params.get("task_class"),
                        "payload": payload,
                        "run_id": params.get("run_id"),
                        "created_at": params.get("created_at"),
                    },
                )
            )
            return MagicMock()
        # Handle INSERT/UPSERT into experience_strategy_weights
        if "INSERT INTO experience_strategy_weights" in sql and params:
            key = (params.get("strategy_type"), params.get("failure_class"))
            weights = self._db.setdefault("experience_strategy_weights", [])
            existing = next((w for w in weights if (w["strategy_type"], w["failure_class"]) == key), None)
            if existing:
                success_inc = params.get("success_inc", 0)
                existing["attempt_count"] += 1
                existing["success_count"] += success_inc
                existing["rate"] = existing["success_count"] / existing["attempt_count"]
            else:
                success_inc = params.get("success_inc", 0)
                weights.append(
                    {
                        "id": str(uuid.uuid4()),
                        "strategy_type": params.get("strategy_type"),
                        "failure_class": params.get("failure_class"),
                        "success_count": success_inc,
                        "attempt_count": 1,
                        "rate": float(success_inc),
                    }
                )
            return MagicMock()
        # Handle SELECT on experience_entries
        if "SELECT" in sql and "FROM experience_entries" in sql:
            rows = self._db.get("experience_entries", [])
            if params and params.get("entry_type"):
                rows = [r for r in rows if r["entry_type"] == params["entry_type"]]
            if params and params.get("task_class"):
                rows = [r for r in rows if r.get("task_class") == params["task_class"]]
            limit = params.get("limit", 100) if params else 100
            rows = rows[:limit]
            return _FakeResult(
                [
                    (
                        r["id"],
                        r["entry_type"],
                        r.get("failure_class"),
                        r.get("task_class"),
                        r["payload"],
                        r["run_id"],
                        r.get("created_at"),
                    )
                    for r in rows
                ]
            )
        # Handle SELECT on experience_strategy_weights
        if "SELECT" in sql and "FROM experience_strategy_weights" in sql:
            rows = self._db.get("experience_strategy_weights", [])
            return _FakeResult([(r["strategy_type"], r["failure_class"], r["rate"]) for r in rows])
        # SELECT 1 ping
        if sql.strip().upper() == "SELECT 1":
            return _FakeResult([(1,)])
        return MagicMock()

    def commit(self):
        for table, row in self._pending:
            self._db.setdefault(table, []).append(row)
        self._pending.clear()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


class _FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


def _make_in_memory_store() -> ExperienceStore:
    """Return an ExperienceStore backed by an in-memory dict (no real Postgres)."""
    db: dict[str, list[dict]] = {}

    @contextmanager
    def factory():
        yield _InMemorySession(db)

    store = ExperienceStore(db_session_factory=factory)
    return store


# ─── T01: available returns False on connection error ────────────────────────


def test_t01_available_false_on_connection_error():
    """T01: experience_store.available returns False when DB raises — no exception."""
    store = ExperienceStore(db_session_factory=_make_failing_factory())
    result = store.available
    assert result is False


# ─── T02: append + query_by_type round-trip ──────────────────────────────────


def test_t02_append_query_round_trip():
    """T02: append() then query_by_type() returns the stored entry with identical payload."""
    store = _make_in_memory_store()
    entry = ExperienceEntry(
        entry_type=ExperienceType.DECOMPOSITION,
        payload={"tasks": [{"id": "t1", "description": "Refactor module"}]},
        run_id=str(uuid.uuid4()),
        task_class="refactor",
    )
    store.append(entry)
    results = store.query_by_type(ExperienceType.DECOMPOSITION)
    assert len(results) == 1
    assert results[0].payload == entry.payload
    assert results[0].entry_type == ExperienceType.DECOMPOSITION
    assert results[0].task_class == "refactor"


# ─── T03: get_strategy_weights returns StrategyWeightKey tuples ──────────────


def test_t03_get_strategy_weights_returns_named_tuple_keys():
    """T03: get_strategy_weights() keys are StrategyWeightKey namedtuples with float values."""
    store = _make_in_memory_store()
    # Seed directly into the in-memory dict — no sqlalchemy needed in unit tests.
    with store.db_session_factory() as session:
        session._db.setdefault("experience_strategy_weights", []).append(
            {
                "strategy_type": "DIRECT_EDIT",
                "failure_class": "type_error",
                "success_count": 1,
                "attempt_count": 1,
                "rate": 1.0,
            }
        )

    weights = store.get_strategy_weights()
    assert isinstance(weights, dict)
    # Keys must be StrategyWeightKey namedtuples
    for key, val in weights.items():
        assert isinstance(key, tuple)
        assert hasattr(key, "strategy_type")
        assert hasattr(key, "failure_class")
        assert isinstance(val, float)
        assert 0.0 <= val <= 1.0


def test_t03_get_strategy_weights_empty_store():
    """T03: empty store returns {} without raising."""
    store = _make_in_memory_store()
    result = store.get_strategy_weights()
    assert result == {}


# ─── T04: warm_start with unavailable store is a no-op ───────────────────────


def test_t04_warm_start_unavailable_returns_not_loaded():
    """T04: warm_start with unavailable store returns WarmStartResult(loaded=False) — no state mutation."""
    store = ExperienceStore(db_session_factory=None)
    strategy_state = StrategyState()
    original_weights = dict(strategy_state.prior_strategy_weights)
    task_graph = TaskGraph()
    original_task_count = len(task_graph.tasks)
    dep_budget = DepGraphBudget()
    original_decay = dep_budget.confidence_decay_rate

    result = warm_start(
        experience_store=store,
        strategy_state=strategy_state,
        failure_diagnostics=None,
        task_graph=task_graph,
        task_class="refactor",
        dep_graph_budget=dep_budget,
    )

    assert isinstance(result, WarmStartResult)
    assert result.loaded is False
    assert result.decompositions_seeded == 0
    assert result.strategy_weights_loaded is False
    # State must be unchanged
    assert strategy_state.prior_strategy_weights == original_weights
    assert len(task_graph.tasks) == original_task_count
    assert dep_budget.confidence_decay_rate == original_decay


def test_t04_warm_start_none_store_returns_not_loaded():
    """T04 variant: None experience_store also returns WarmStartResult(loaded=False)."""
    result = warm_start(
        experience_store=None,
        strategy_state=StrategyState(),
        failure_diagnostics=None,
        task_graph=TaskGraph(),
        task_class=None,
        dep_graph_budget=None,
    )
    assert result.loaded is False


# ─── T05: warm_start seeds task_graph from stored decomposition ───────────────


def test_t05_warm_start_seeds_task_graph():
    """T05: after storing a DECOMPOSITION, warm_start seeds PENDING tasks into task_graph."""
    store = _make_in_memory_store()
    run_id = str(uuid.uuid4())
    tasks_payload = {
        "tasks": [
            {"id": "t1", "description": "Step one"},
            {"id": "t2", "description": "Step two"},
        ]
    }
    store.append(
        ExperienceEntry(
            entry_type=ExperienceType.DECOMPOSITION,
            payload=tasks_payload,
            run_id=run_id,
            task_class="refactor",
        )
    )

    task_graph = TaskGraph()
    result = warm_start(
        experience_store=store,
        strategy_state=StrategyState(),
        failure_diagnostics=None,
        task_graph=task_graph,
        task_class="refactor",
        dep_graph_budget=None,
    )

    assert result.loaded is True
    assert result.decompositions_seeded == 2
    assert len(task_graph.tasks) == 2
    descriptions = [t.description for t in task_graph.tasks]
    assert "Step one" in descriptions
    assert "Step two" in descriptions
    for t in task_graph.tasks:
        assert t.status == "PENDING"


# ─── T06: warm_start loads non-flat strategy weights ─────────────────────────


def test_t06_warm_start_loads_non_flat_weights():
    """T06: prior_strategy_weights after warm_start differ from default 0.5 when data exists."""
    store = _make_in_memory_store()

    # Insert a weight with non-default rate
    with store.db_session_factory() as session:
        session.execute(
            MagicMock(),  # bypassed — insert directly into db
            {},
        )
        # Insert via direct db manipulation in the in-memory session
        session._db.setdefault("experience_strategy_weights", []).append(
            {
                "strategy_type": "DIRECT_EDIT",
                "failure_class": "syntax_error",
                "success_count": 4,
                "attempt_count": 5,
                "rate": 0.8,
            }
        )

    strategy_state = StrategyState()
    result = warm_start(
        experience_store=store,
        strategy_state=strategy_state,
        failure_diagnostics=None,
        task_graph=TaskGraph(),
        task_class=None,
        dep_graph_budget=None,
    )

    assert result.loaded is True
    assert result.strategy_weights_loaded is True
    # At least one weight differs from 0.5
    weights = strategy_state.prior_strategy_weights
    assert any(abs(v - 0.5) > 0.01 for v in weights.values())


# ─── T07: update_experience_store updates strategy weight after success ───────


def test_t07_strategy_weight_updated_after_success():
    """T07: after update_experience_store with DIRECT_EDIT / syntax_error, rate > 0.5."""
    store = _make_in_memory_store()
    strategy_state = StrategyState(
        current_strategy="DIRECT_EDIT",
        last_failure_class="syntax_error",
        recovery_was_used=False,
    )
    context = ExecutionContext(
        task_class="fix_syntax",
        run_id=str(uuid.uuid4()),
    )
    task = Task(id="t1", description="Fix syntax", status="COMPLETE")

    update_experience_store(
        completed_task=task,
        strategy_state=strategy_state,
        execution_context=context,
        experience_store=store,
    )

    weights = store.get_strategy_weights()
    key = StrategyWeightKey("DIRECT_EDIT", "syntax_error")
    assert key in weights
    # First successful attempt → rate = 1/1 = 1.0 (> 0.5)
    assert weights[key] > 0.5


# ─── T08: recovery sequence stored when recovery_was_used ────────────────────


def test_t08_recovery_sequence_stored_on_recovery():
    """T08: when recovery_was_used=True, RECOVERY_SEQUENCE entry is stored with correct payload."""
    store = _make_in_memory_store()
    strategy_state = StrategyState(
        current_strategy="TRACE_EXEC",
        last_failure_class="import_error",
        recovery_was_used=True,
        switch_triggers=["stall_detected"],
    )
    context = ExecutionContext(
        task_class="fix_import",
        run_id=str(uuid.uuid4()),
    )
    task = Task(id="t1", description="Fix import", status="COMPLETE")

    update_experience_store(
        completed_task=task,
        strategy_state=strategy_state,
        execution_context=context,
        experience_store=store,
    )

    entries = store.query_by_type(ExperienceType.RECOVERY_SEQUENCE)
    assert len(entries) >= 1
    payload = entries[0].payload
    assert "TRACE_EXEC" in payload.get("strategy", "")
    assert payload.get("failure_class") == "import_error"


# ─── T09: update_experience_store is no-op when store unavailable ─────────────


def test_t09_update_experience_store_no_op_when_unavailable():
    """T09: update_experience_store with unavailable store makes no calls and raises nothing."""
    store = ExperienceStore(db_session_factory=None)
    strategy_state = StrategyState(current_strategy="DIRECT_EDIT")
    original_strategy = strategy_state.current_strategy

    # Must not raise
    update_experience_store(
        completed_task=Task(id="t1", description="test", status="COMPLETE"),
        strategy_state=strategy_state,
        execution_context=ExecutionContext(task_class="test", run_id="r1"),
        experience_store=store,
    )

    # strategy_state unmodified
    assert strategy_state.current_strategy == original_strategy


# ─── T10: softmax_strategy_policy ranks TRACE_EXEC first after 5 failures ────


def test_t10_softmax_ranks_trace_exec_first_after_failures():
    """T10: 5 failed DIRECT_EDIT + 5 successful TRACE_EXEC → TRACE_EXEC ranked first."""
    weights = {
        StrategyWeightKey("DIRECT_EDIT", "import_error"): 0.0,
        StrategyWeightKey("TRACE_EXEC", "import_error"): 1.0,
        StrategyWeightKey("BROADER_SEARCH", "import_error"): 0.5,
        StrategyWeightKey("REIMPLEMENT", "import_error"): 0.5,
        StrategyWeightKey("MINIMAL_FIX", "import_error"): 0.5,
        StrategyWeightKey("ESCALATE", "import_error"): 0.5,
    }

    ordering = softmax_strategy_policy(weights, "import_error", temperature=1.0)

    assert ordering[0] == "TRACE_EXEC"
    # DIRECT_EDIT (rate 0.0) should be near the bottom
    direct_idx = ordering.index("DIRECT_EDIT")
    trace_idx = ordering.index("TRACE_EXEC")
    assert trace_idx < direct_idx


# ─── T11: build_strategy_ordering returns default when store unavailable ──────


def test_t11_build_strategy_ordering_default_when_unavailable():
    """T11: build_strategy_ordering with unavailable store returns DEFAULT_STRATEGY_ORDER."""
    store = ExperienceStore(db_session_factory=None)
    result = build_strategy_ordering("any_class", store)
    assert result == DEFAULT_STRATEGY_ORDER


def test_t11_build_strategy_ordering_default_when_none():
    """T11 variant: None store also returns DEFAULT_STRATEGY_ORDER."""
    result = build_strategy_ordering("any_class", None)
    assert result == DEFAULT_STRATEGY_ORDER


# ─── T12: build_strategy_ordering differs between empty and populated store ───


def test_t12_build_strategy_ordering_changes_with_empirical_data():
    """T12: ordering on run 1 (empty) and run 10 (populated) differ for the same failure_class."""
    store_empty = _make_in_memory_store()

    ordering_run1 = build_strategy_ordering("import_error", store_empty, temperature=1.0)
    assert ordering_run1 == DEFAULT_STRATEGY_ORDER

    # Populate the store with 10 outcomes: TRACE_EXEC always succeeds
    store_populated = _make_in_memory_store()
    for _ in range(10):
        with store_populated.db_session_factory() as session:
            session._db.setdefault("experience_strategy_weights", [])
            existing = next(
                (
                    w
                    for w in session._db["experience_strategy_weights"]
                    if w["strategy_type"] == "TRACE_EXEC" and w["failure_class"] == "import_error"
                ),
                None,
            )
            if existing:
                existing["success_count"] += 1
                existing["attempt_count"] += 1
                existing["rate"] = existing["success_count"] / existing["attempt_count"]
            else:
                session._db["experience_strategy_weights"].append(
                    {
                        "strategy_type": "TRACE_EXEC",
                        "failure_class": "import_error",
                        "success_count": 1,
                        "attempt_count": 1,
                        "rate": 1.0,
                    }
                )
            # DIRECT_EDIT always fails
            existing_de = next(
                (
                    w
                    for w in session._db["experience_strategy_weights"]
                    if w["strategy_type"] == "DIRECT_EDIT" and w["failure_class"] == "import_error"
                ),
                None,
            )
            if existing_de:
                existing_de["attempt_count"] += 1
                existing_de["rate"] = existing_de["success_count"] / existing_de["attempt_count"]
            else:
                session._db["experience_strategy_weights"].append(
                    {
                        "strategy_type": "DIRECT_EDIT",
                        "failure_class": "import_error",
                        "success_count": 0,
                        "attempt_count": 1,
                        "rate": 0.0,
                    }
                )

    ordering_run10 = build_strategy_ordering("import_error", store_populated, temperature=1.0)

    # Populated store must produce a different ordering
    assert ordering_run10 != DEFAULT_STRATEGY_ORDER
    assert ordering_run10[0] == "TRACE_EXEC"


# ─── Additional: INV-10 structural identity check ────────────────────────────


def test_inv10_warm_start_absent_vs_present_identical_strategy_state():
    """INV-10: strategy_state after warm_start(absent) equals initial strategy_state."""
    initial = StrategyState()
    store_none = ExperienceStore(db_session_factory=None)

    result = warm_start(
        experience_store=store_none,
        strategy_state=initial,
        failure_diagnostics=None,
        task_graph=TaskGraph(),
        task_class=None,
        dep_graph_budget=None,
    )

    assert result.loaded is False
    assert initial.current_strategy == "DIRECT_EDIT"
    assert initial.prior_strategy_weights == {}
    assert initial.recovery_was_used is False
