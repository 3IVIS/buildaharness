"""
Experience store — P8.

Cross-run learning for the harness. Persists successful decompositions,
tool workflows, verification plans, and recovery sequences, then seeds the
next run via warm_start(). When the store is unavailable every function
is a silent no-op (INV-10).

Temperature semantics for softmax_strategy_policy():
  - Default 1.0: balanced weighting of empirical rates.
  - < 1.0: concentrates ordering around the highest-rate strategy.
  - > 1.0: more exploratory — spreads probability mass across strategies.
  Cold-start (no entries for a failure_class): always returns the fixed
  default order regardless of temperature.

New deployments use the fixed default order for their first N runs until
empirical data accumulates in experience_strategy_weights.
"""

from __future__ import annotations

import math
import uuid
from collections import namedtuple
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

# Fixed default strategy order — used when experience store is unavailable
# or when no empirical data exists for a given failure_class.
DEFAULT_STRATEGY_ORDER: list[str] = [
    "DIRECT_EDIT",
    "TRACE_EXEC",
    "BROADER_SEARCH",
    "REIMPLEMENT",
    "MINIMAL_FIX",
    "ESCALATE",
]


class ExperienceType(StrEnum):
    DECOMPOSITION = "DECOMPOSITION"
    TOOL_WORKFLOW = "TOOL_WORKFLOW"
    VERIFICATION_PLAN = "VERIFICATION_PLAN"
    RECOVERY_SEQUENCE = "RECOVERY_SEQUENCE"
    FAILURE_PATTERN = "FAILURE_PATTERN"


StrategyWeightKey = namedtuple("StrategyWeightKey", ["strategy_type", "failure_class"])


@dataclass
class ExperienceEntry:
    entry_type: ExperienceType
    payload: dict[str, Any]
    run_id: str
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    failure_class: str | None = None
    task_class: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "entry_type": self.entry_type.value if isinstance(self.entry_type, ExperienceType) else self.entry_type,
            "failure_class": self.failure_class,
            "task_class": self.task_class,
            "payload": self.payload,
            "run_id": self.run_id,
            "created_at": self.created_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ExperienceEntry:
        entry_type = d["entry_type"]
        if isinstance(entry_type, str):
            entry_type = ExperienceType(entry_type)
        created_at = d.get("created_at")
        if isinstance(created_at, str):
            try:
                created_at = datetime.fromisoformat(created_at)
            except ValueError:
                created_at = datetime.now(UTC)
        elif created_at is None:
            created_at = datetime.now(UTC)
        return cls(
            id=d.get("id", str(uuid.uuid4())),
            entry_type=entry_type,
            failure_class=d.get("failure_class"),
            task_class=d.get("task_class"),
            payload=d.get("payload", {}),
            run_id=d.get("run_id", ""),
            created_at=created_at,
        )


@dataclass
class ExecutionContext:
    """Carries task execution artefacts captured during a completed run step."""

    task_class: str = ""
    completed_tool_workflow: list[dict[str, Any]] = field(default_factory=list)
    verification_plan: dict[str, Any] = field(default_factory=dict)
    run_id: str = ""


@dataclass
class WarmStartResult:
    """Log record returned by warm_start() — does not control execution."""

    loaded: bool
    decompositions_seeded: int = 0
    tool_workflows_seeded: int = 0
    verification_plans_seeded: int = 0
    recovery_sequences_seeded: int = 0
    strategy_weights_loaded: bool = False
    class_priors_loaded: bool = False


@dataclass
class ExperienceStore:
    """Postgres-backed experience store with a safe availability check.

    db_session_factory must be a zero-argument callable returning a context
    manager that yields a SQLAlchemy Session (sync). When None or when the
    DB connection fails, available returns False and all methods are no-ops.
    """

    db_session_factory: Callable[[], Any] | None = None
    _cache: dict[str, Any] = field(default_factory=dict)

    @property
    def available(self) -> bool:
        """Return True only when the DB is reachable. Never raises."""
        if self.db_session_factory is None:
            return False
        try:
            from sqlalchemy import text

            with self.db_session_factory() as session:
                session.execute(text("SELECT 1"))
            return True
        except Exception:
            return False

    def append(self, entry: ExperienceEntry) -> None:
        """Insert entry into experience_entries. No-op if unavailable."""
        if not self.available:
            return
        try:
            import json

            from sqlalchemy import text

            with self.db_session_factory() as session:
                payload_str = json.dumps(entry.payload)
                session.execute(
                    text(
                        """
                        INSERT INTO experience_entries
                            (id, entry_type, failure_class, task_class, payload, run_id, created_at)
                        VALUES
                            (:id, :entry_type, :failure_class, :task_class, :payload::jsonb, :run_id, :created_at)
                        """
                    ),
                    {
                        "id": entry.id,
                        "entry_type": (
                            entry.entry_type.value if isinstance(entry.entry_type, ExperienceType) else entry.entry_type
                        ),
                        "failure_class": entry.failure_class,
                        "task_class": entry.task_class,
                        "payload": payload_str,
                        "run_id": entry.run_id,
                        "created_at": entry.created_at,
                    },
                )
                session.commit()
        except Exception:
            pass

    def query_by_type(
        self,
        entry_type: ExperienceType,
        task_class: str | None = None,
        limit: int = 10,
    ) -> list[ExperienceEntry]:
        """Return most recent entries of entry_type, ordered by created_at DESC."""
        if not self.available:
            return []
        try:
            import json

            from sqlalchemy import text

            type_val = entry_type.value if isinstance(entry_type, ExperienceType) else entry_type
            with self.db_session_factory() as session:
                if task_class is not None:
                    rows = session.execute(
                        text(
                            """
                            SELECT id, entry_type, failure_class, task_class, payload, run_id, created_at
                            FROM experience_entries
                            WHERE entry_type = :entry_type AND task_class = :task_class
                            ORDER BY created_at DESC
                            LIMIT :limit
                            """
                        ),
                        {"entry_type": type_val, "task_class": task_class, "limit": limit},
                    ).fetchall()
                else:
                    rows = session.execute(
                        text(
                            """
                            SELECT id, entry_type, failure_class, task_class, payload, run_id, created_at
                            FROM experience_entries
                            WHERE entry_type = :entry_type
                            ORDER BY created_at DESC
                            LIMIT :limit
                            """
                        ),
                        {"entry_type": type_val, "limit": limit},
                    ).fetchall()

            entries = []
            for row in rows:
                payload = row[4]
                if isinstance(payload, str):
                    payload = json.loads(payload)
                entries.append(
                    ExperienceEntry(
                        id=str(row[0]),
                        entry_type=ExperienceType(row[1]),
                        failure_class=row[2],
                        task_class=row[3],
                        payload=payload,
                        run_id=str(row[5]),
                        created_at=row[6] if isinstance(row[6], datetime) else datetime.now(UTC),
                    )
                )
            return entries
        except Exception:
            return []

    def get_strategy_weights(self) -> dict[StrategyWeightKey, float]:
        """Return empirical rates keyed by StrategyWeightKey. Empty dict if unavailable."""
        if not self.available:
            return {}
        try:
            from sqlalchemy import text

            with self.db_session_factory() as session:
                rows = session.execute(
                    text("SELECT strategy_type, failure_class, rate FROM experience_strategy_weights")
                ).fetchall()
            return {StrategyWeightKey(strategy_type=row[0], failure_class=row[1]): float(row[2]) for row in rows}
        except Exception:
            return {}


# ── warm_start() helpers ──────────────────────────────────────────────────────


def load_strategy_priors(
    experience_store: ExperienceStore,
    strategy_state: Any,
) -> bool:
    """Load empirical strategy weights into strategy_state.prior_strategy_weights.

    Returns True if any weights were loaded.
    """
    if not experience_store.available:
        return False
    weights = experience_store.get_strategy_weights()
    if not weights:
        return False
    flat: dict[str, float] = {}
    for key, rate in weights.items():
        flat[f"{key.strategy_type}:{key.failure_class}"] = rate
    strategy_state.prior_strategy_weights = flat

    failure_entries = experience_store.query_by_type(ExperienceType.FAILURE_PATTERN, limit=50)
    if failure_entries:
        class_counts: dict[str, int] = {}
        for e in failure_entries:
            fc = e.failure_class or "unknown"
            class_counts[fc] = class_counts.get(fc, 0) + 1
        total = sum(class_counts.values())
        if hasattr(strategy_state, "class_priors"):
            strategy_state.class_priors = {k: v / total for k, v in class_counts.items()}
    return True


def load_structural_decompositions(
    experience_store: ExperienceStore,
    task_graph: Any,
    task_class: str | None,
) -> int:
    """Seed task_graph with PENDING tasks from the highest-confidence prior decomposition.

    Returns the count of tasks seeded (0 if none found).
    """
    if not experience_store.available:
        return 0
    entries = experience_store.query_by_type(ExperienceType.DECOMPOSITION, task_class=task_class, limit=3)
    if not entries:
        return 0
    best = entries[0]
    tasks_data = best.payload.get("tasks", [])
    if not tasks_data:
        return 0
    try:
        from .task_graph import Task

        count = 0
        for td in tasks_data:
            task = Task(
                id=td.get("id", str(uuid.uuid4())),
                description=td.get("description", ""),
                status="PENDING",
            )
            if hasattr(task_graph, "tasks"):
                task_graph.tasks.append(task)
                count += 1
        return count
    except Exception:
        return 0


def load_tool_workflow_seeds(experience_store: ExperienceStore) -> list[dict[str, Any]]:
    """Return tool workflow payload dicts from recent successful runs."""
    if not experience_store.available:
        return []
    entries = experience_store.query_by_type(ExperienceType.TOOL_WORKFLOW, limit=5)
    return [e.payload for e in entries]


def load_verification_plan_seeds(experience_store: ExperienceStore) -> list[dict[str, Any]]:
    """Return verification plan payload dicts from recent successful runs."""
    if not experience_store.available:
        return []
    entries = experience_store.query_by_type(ExperienceType.VERIFICATION_PLAN, limit=5)
    return [e.payload for e in entries]


def warm_start(
    experience_store: ExperienceStore | None,
    strategy_state: Any,
    failure_diagnostics: Any,
    task_graph: Any,
    task_class: str | None,
    dep_graph_budget: Any,
) -> WarmStartResult:
    """Seed harness structures from prior experience. Must be called once per run.

    When experience_store is unavailable, returns WarmStartResult(loaded=False)
    immediately without mutating any state (INV-10).
    """
    if experience_store is None or not experience_store.available:
        return WarmStartResult(loaded=False)

    weights_loaded = load_strategy_priors(experience_store, strategy_state)
    decompositions_seeded = load_structural_decompositions(experience_store, task_graph, task_class)
    tool_workflows = load_tool_workflow_seeds(experience_store)
    verification_plans = load_verification_plan_seeds(experience_store)

    # Update dep_graph_budget decay rate from median successful run decay
    if dep_graph_budget is not None:
        decay_entries = experience_store.query_by_type(ExperienceType.DECOMPOSITION, limit=20)
        decay_rates = [
            e.payload.get("confidence_decay_rate")
            for e in decay_entries
            if e.payload.get("confidence_decay_rate") is not None
        ]
        if decay_rates:
            decay_rates.sort()
            median_decay = decay_rates[len(decay_rates) // 2]
            dep_graph_budget.confidence_decay_rate = median_decay

    # Load failure-class priors into failure_diagnostics.failure_mode_library if available
    class_priors_loaded = False
    if failure_diagnostics is not None:
        failure_entries = experience_store.query_by_type(ExperienceType.FAILURE_PATTERN, limit=50)
        if failure_entries:
            class_counts: dict[str, int] = {}
            for e in failure_entries:
                fc = e.failure_class or "unknown"
                class_counts[fc] = class_counts.get(fc, 0) + 1
            total = sum(class_counts.values())
            priors = {k: v / total for k, v in class_counts.items()}
            lib = getattr(failure_diagnostics, "failure_mode_library", None)
            if lib is not None and hasattr(lib, "class_priors"):
                lib.class_priors = priors
                class_priors_loaded = True

    return WarmStartResult(
        loaded=True,
        decompositions_seeded=decompositions_seeded,
        tool_workflows_seeded=len(tool_workflows),
        verification_plans_seeded=len(verification_plans),
        recovery_sequences_seeded=0,
        strategy_weights_loaded=weights_loaded,
        class_priors_loaded=class_priors_loaded,
    )


# ── update_experience_store() ─────────────────────────────────────────────────


def upsert_strategy_weight(
    strategy_type: str,
    failure_class: str,
    success: bool,
    session: Any,
) -> None:
    """UPSERT a strategy outcome into experience_strategy_weights."""
    from sqlalchemy import text

    session.execute(
        text(
            """
            INSERT INTO experience_strategy_weights
                (id, strategy_type, failure_class, success_count, attempt_count, rate, updated_at)
            VALUES
                (:id, :strategy_type, :failure_class,
                 :success_inc, 1, :initial_rate, CURRENT_TIMESTAMP)
            ON CONFLICT (strategy_type, failure_class) DO UPDATE SET
                success_count = experience_strategy_weights.success_count + :success_inc,
                attempt_count = experience_strategy_weights.attempt_count + 1,
                rate = (experience_strategy_weights.success_count + :success_inc)::float /
                       (experience_strategy_weights.attempt_count + 1),
                updated_at = CURRENT_TIMESTAMP
            """
        ),
        {
            "id": str(uuid.uuid4()),
            "strategy_type": strategy_type,
            "failure_class": failure_class,
            "success_inc": 1 if success else 0,
            "initial_rate": 1.0 if success else 0.0,
        },
    )


def update_experience_store(
    completed_task: Any,
    strategy_state: Any,
    execution_context: ExecutionContext | None,
    experience_store: ExperienceStore | None,
) -> None:
    """Capture artefacts from a completed task into the experience store.

    No-op if experience_store is unavailable (INV-10).
    """
    if experience_store is None or not experience_store.available:
        return

    run_id = ""
    task_class = ""
    if execution_context is not None:
        run_id = execution_context.run_id
        task_class = execution_context.task_class

    # Store decomposition contribution
    task_payload: dict[str, Any] = {}
    if completed_task is not None:
        task_payload = {
            "tasks": [
                {
                    "id": getattr(completed_task, "id", ""),
                    "description": getattr(completed_task, "description", ""),
                    "status": getattr(completed_task, "status", "COMPLETE"),
                }
            ]
        }
    experience_store.append(
        ExperienceEntry(
            entry_type=ExperienceType.DECOMPOSITION,
            payload=task_payload,
            run_id=run_id,
            task_class=task_class or None,
        )
    )

    # Capture tool workflow
    if execution_context is not None and execution_context.completed_tool_workflow:
        experience_store.append(
            ExperienceEntry(
                entry_type=ExperienceType.TOOL_WORKFLOW,
                payload={"workflow": execution_context.completed_tool_workflow},
                run_id=run_id,
                task_class=task_class or None,
            )
        )

    # Capture verification plan
    if execution_context is not None and execution_context.verification_plan:
        experience_store.append(
            ExperienceEntry(
                entry_type=ExperienceType.VERIFICATION_PLAN,
                payload=execution_context.verification_plan,
                run_id=run_id,
                task_class=task_class or None,
            )
        )

    # Capture recovery sequence if one was used
    recovery_was_used = getattr(strategy_state, "recovery_was_used", False)
    if recovery_was_used and strategy_state is not None:
        failure_class = getattr(strategy_state, "last_failure_class", "")
        current_strategy = getattr(strategy_state, "current_strategy", "")
        experience_store.append(
            ExperienceEntry(
                entry_type=ExperienceType.RECOVERY_SEQUENCE,
                payload={
                    "strategy": current_strategy,
                    "failure_class": failure_class,
                    "switch_triggers": list(getattr(strategy_state, "switch_triggers", [])),
                },
                run_id=run_id,
                failure_class=failure_class or None,
                task_class=task_class or None,
            )
        )

    # Re-normalise strategy weights
    if experience_store.db_session_factory is not None:
        try:
            current_strategy = getattr(strategy_state, "current_strategy", "DIRECT_EDIT")
            failure_class = getattr(strategy_state, "last_failure_class", "") or "unknown"
            with experience_store.db_session_factory() as session:
                upsert_strategy_weight(
                    strategy_type=current_strategy,
                    failure_class=failure_class,
                    success=True,
                    session=session,
                )
                session.commit()
        except Exception:
            pass


# ── Adaptive strategy policy (P8.4) ──────────────────────────────────────────


def softmax_strategy_policy(
    strategy_weights: dict[StrategyWeightKey, float],
    failure_class: str,
    temperature: float = 1.0,
) -> list[str]:
    """Return strategies sorted by descending softmax score for failure_class.

    Falls back to DEFAULT_STRATEGY_ORDER when no data exists for failure_class.
    Temperature controls exploration: lower → concentrate on top strategy;
    higher → more uniform distribution across strategies.
    """
    class_weights = {
        key.strategy_type: rate for key, rate in strategy_weights.items() if key.failure_class == failure_class
    }
    if not class_weights:
        return list(DEFAULT_STRATEGY_ORDER)

    temp = max(temperature, 1e-6)
    max_rate = max(class_weights.values())
    exps = {s: math.exp((class_weights.get(s, 0.0) - max_rate) / temp) for s in DEFAULT_STRATEGY_ORDER}
    total = sum(exps.values())
    probs = {s: e / total for s, e in exps.items()}
    return sorted(DEFAULT_STRATEGY_ORDER, key=lambda s: probs[s], reverse=True)


def build_strategy_ordering(
    failure_class: str,
    experience_store: ExperienceStore | None,
    temperature: float = 1.0,
) -> list[str]:
    """Return the effective strategy ordering for failure_class.

    Uses softmax over empirical data when available; returns DEFAULT_STRATEGY_ORDER
    when experience_store is unavailable or when no data exists for failure_class.
    Callers must use this function rather than reading strategy_state.current_strategy
    directly when the experience store is available (INV-10).
    """
    if experience_store is None or not experience_store.available:
        return list(DEFAULT_STRATEGY_ORDER)
    weights = experience_store.get_strategy_weights()
    return softmax_strategy_policy(weights, failure_class, temperature=temperature)
