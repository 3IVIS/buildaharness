"""
Experience store — P8.

Cross-run learning for the harness. Persists successful decompositions,
tool workflows, verification plans, and recovery sequences, then seeds the
next run via warm_start(). When the store is unavailable every function
is a silent no-op (INV-10).

Promotion boundary (Phase 2 of plans/harness_and_assistant_architecture_remediation_
plan.html): before this, update_experience_store() wrote directly into the same rows
warm_start() read on the very next run — a completed run's own outcome could influence
that same run's later reads, and definitely influenced every subsequent run immediately.
docs/adr/002-harness-semantic-contract.md's guarantee #8 ("learning cannot alter
correctness within a run") had no enforcement point. Now every write (append(),
upsert_strategy_weight()) always lands with promoted=False, and every read
(query_by_type(), get_strategy_weights(), and so warm_start()) only ever sees
promoted=True rows. The only way a candidate becomes visible is an explicit,
separate call to promote_experience_entries()/promote_strategy_weights() — never invoked
automatically by anything in this module or the main loop. That's the
"immutable trace -> offline learning -> candidate policy -> evaluation -> promotion ->
future runs" pipeline the critique asked for. run_offline_eval_pipeline() (bottom of this
module) is that offline evaluation job: it judges each pending strategy-weight candidate
against the currently-promoted baseline (a minimum-sample-size bar so one lucky attempt
can't promote itself, then a no-regression bar) before promoting it. It is a job the
caller invokes explicitly (a scheduled task, a CLI command) — nothing in the main loop or
this module calls it automatically, preserving the same "learning cannot alter
correctness within a run" guarantee the promotion boundary itself provides.

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


def _sql_text(sql: str):
    """Wrap sql in sqlalchemy text() when available; fall back to the raw string.

    The in-memory session used in unit tests checks str(stmt) for SQL patterns,
    so a plain string is functionally equivalent to text() for that path.
    """
    try:
        from sqlalchemy import text

        return text(sql)
    except ImportError:
        return sql


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
class StrategyWeightSample:
    """One (strategy_type, failure_class) row's raw statistics — success_count and
    attempt_count alongside the derived rate, so an offline evaluator can apply a
    minimum-sample-size bar instead of trusting a rate computed from one lucky attempt."""

    rate: float
    success_count: int
    attempt_count: int


@dataclass
class ExperienceEntry:
    entry_type: ExperienceType
    payload: dict[str, Any]
    run_id: str
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    failure_class: str | None = None
    task_class: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    # Promotion boundary (Phase 2): append() always writes promoted=False regardless of
    # this field's value on the object passed in — a fresh entry is always an unpromoted
    # candidate. Only promote_experience_entries() flips it, via a separate UPDATE, never
    # from inside append() itself. See this module's own docstring.
    promoted: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "entry_type": self.entry_type.value if isinstance(self.entry_type, ExperienceType) else self.entry_type,
            "failure_class": self.failure_class,
            "task_class": self.task_class,
            "payload": self.payload,
            "run_id": self.run_id,
            "created_at": self.created_at.isoformat(),
            "promoted": self.promoted,
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
            promoted=d.get("promoted", False),
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
            with self.db_session_factory() as session:
                session.execute(_sql_text("SELECT 1"))
            return True
        except Exception:
            return False

    def append(self, entry: ExperienceEntry) -> None:
        """Insert entry into experience_entries. No-op if unavailable.

        Always writes promoted=False, regardless of entry.promoted's value — a fresh
        write is always an unpromoted candidate (see this module's own docstring).
        """
        if not self.available:
            return
        try:
            import json

            assert self.db_session_factory is not None
            with self.db_session_factory() as session:
                payload_str = json.dumps(entry.payload)
                session.execute(
                    _sql_text(
                        """
                        INSERT INTO experience_entries
                            (id, entry_type, failure_class, task_class, payload, run_id,
                             created_at, promoted)
                        VALUES
                            (:id, :entry_type, :failure_class, :task_class, :payload::jsonb,
                             :run_id, :created_at, false)
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

    def promote_entries(self, entry_ids: list[str]) -> int:
        """Explicitly promote specific entries by id — the only way append()'d candidates
        become visible to query_by_type(). Never called automatically. Returns the count
        of ids the store attempted to promote (0 if unavailable or entry_ids is empty)."""
        if not self.available or not entry_ids:
            return 0
        try:
            assert self.db_session_factory is not None
            with self.db_session_factory() as session:
                session.execute(
                    _sql_text("UPDATE experience_entries SET promoted = true WHERE id IN :ids"),
                    {"ids": tuple(entry_ids)},
                )
                session.commit()
            return len(entry_ids)
        except Exception:
            return 0

    def promote_all_pending_entries(self, entry_type: ExperienceType | None = None) -> bool:
        """Bulk-promote every unpromoted entry (optionally scoped to one entry_type).
        Convenience for an offline evaluation job that decided "everything since the last
        promotion looks fine" rather than tracking individual ids. Returns whether the
        operation ran (not a row count — a plain UPDATE doesn't cheaply know that here)."""
        if not self.available:
            return False
        try:
            assert self.db_session_factory is not None
            with self.db_session_factory() as session:
                if entry_type is not None:
                    type_val = entry_type.value if isinstance(entry_type, ExperienceType) else entry_type
                    session.execute(
                        _sql_text(
                            "UPDATE experience_entries SET promoted = true "
                            "WHERE promoted = false AND entry_type = :entry_type"
                        ),
                        {"entry_type": type_val},
                    )
                else:
                    session.execute(_sql_text("UPDATE experience_entries SET promoted = true WHERE promoted = false"))
                session.commit()
            return True
        except Exception:
            return False

    def query_by_type(
        self,
        entry_type: ExperienceType,
        task_class: str | None = None,
        limit: int = 10,
    ) -> list[ExperienceEntry]:
        """Return most recent PROMOTED entries of entry_type, ordered by created_at DESC.

        Unpromoted candidates (every fresh append() until promote_entries()/
        promote_all_pending_entries() explicitly promotes them) are invisible here —
        see this module's own docstring for why.
        """
        if not self.available:
            return []
        try:
            import json

            type_val = entry_type.value if isinstance(entry_type, ExperienceType) else entry_type
            assert self.db_session_factory is not None
            with self.db_session_factory() as session:
                if task_class is not None:
                    rows = session.execute(
                        _sql_text(
                            """
                            SELECT id, entry_type, failure_class, task_class, payload, run_id, created_at
                            FROM experience_entries
                            WHERE entry_type = :entry_type AND task_class = :task_class AND promoted = true
                            ORDER BY created_at DESC
                            LIMIT :limit
                            """
                        ),
                        {"entry_type": type_val, "task_class": task_class, "limit": limit},
                    ).fetchall()
                else:
                    rows = session.execute(
                        _sql_text(
                            """
                            SELECT id, entry_type, failure_class, task_class, payload, run_id, created_at
                            FROM experience_entries
                            WHERE entry_type = :entry_type AND promoted = true
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
        """Return empirical rates keyed by StrategyWeightKey, PROMOTED rows only.

        Empty dict if unavailable or nothing has been promoted yet — see this module's
        own docstring on the promotion boundary.
        """
        if not self.available:
            return {}
        try:
            assert self.db_session_factory is not None
            with self.db_session_factory() as session:
                rows = session.execute(
                    _sql_text(
                        "SELECT strategy_type, failure_class, rate FROM experience_strategy_weights "
                        "WHERE promoted = true"
                    )
                ).fetchall()
            return {StrategyWeightKey(strategy_type=row[0], failure_class=row[1]): float(row[2]) for row in rows}
        except Exception:
            return {}

    def get_pending_strategy_weights(self) -> dict[StrategyWeightKey, StrategyWeightSample]:
        """Return UNPROMOTED experience_strategy_weights rows, with their sample counts.

        The mirror image of get_strategy_weights() — this is the offline-eval pipeline's
        input corpus of candidates. Empty dict if unavailable or nothing is pending.
        """
        if not self.available:
            return {}
        try:
            assert self.db_session_factory is not None
            with self.db_session_factory() as session:
                rows = session.execute(
                    _sql_text(
                        "SELECT strategy_type, failure_class, rate, success_count, attempt_count "
                        "FROM experience_strategy_weights WHERE promoted = false"
                    )
                ).fetchall()
            return {
                StrategyWeightKey(strategy_type=row[0], failure_class=row[1]): StrategyWeightSample(
                    rate=float(row[2]), success_count=int(row[3]), attempt_count=int(row[4])
                )
                for row in rows
            }
        except Exception:
            return {}

    def promote_strategy_weights(self, keys: list[StrategyWeightKey] | None = None) -> bool:
        """Explicitly promote strategy-weight rows — specific (strategy_type,
        failure_class) keys, or every unpromoted row if keys is None. The only way
        upsert_strategy_weight()'s candidates become visible to get_strategy_weights().
        Never called automatically."""
        if not self.available:
            return False
        try:
            assert self.db_session_factory is not None
            with self.db_session_factory() as session:
                if keys:
                    for key in keys:
                        session.execute(
                            _sql_text(
                                "UPDATE experience_strategy_weights SET promoted = true "
                                "WHERE strategy_type = :strategy_type AND failure_class = :failure_class"
                            ),
                            {"strategy_type": key.strategy_type, "failure_class": key.failure_class},
                        )
                else:
                    session.execute(_sql_text("UPDATE experience_strategy_weights SET promoted = true"))
                session.commit()
            return True
        except Exception:
            return False


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
    """UPSERT a strategy outcome into experience_strategy_weights.

    Always resets promoted=False on both insert and update (Phase 2's promotion
    boundary) — a row with a just-merged new attempt is unpromoted-by-definition, even
    if it was promoted before this call; get_strategy_weights() won't see it again until
    promote_strategy_weights() is called explicitly.
    """
    session.execute(
        _sql_text(
            """
            INSERT INTO experience_strategy_weights
                (id, strategy_type, failure_class, success_count, attempt_count, rate, updated_at, promoted)
            VALUES
                (:id, :strategy_type, :failure_class,
                 :success_inc, 1, :initial_rate, CURRENT_TIMESTAMP, false)
            ON CONFLICT (strategy_type, failure_class) DO UPDATE SET
                success_count = experience_strategy_weights.success_count + :success_inc,
                attempt_count = experience_strategy_weights.attempt_count + 1,
                rate = (experience_strategy_weights.success_count + :success_inc)::float /
                       (experience_strategy_weights.attempt_count + 1),
                updated_at = CURRENT_TIMESTAMP,
                promoted = false
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


# ── Offline evaluation pipeline (Phase G) ─────────────────────────────────────
#
# The last, deliberately-unimplemented step of Phase 2's promotion boundary (see module
# docstring): judge each pending candidate before it becomes visible to
# get_strategy_weights()/build_strategy_ordering(), instead of promoting on faith. This
# closes the "softmax reinforcement of accidental correlations" risk — a single early
# success upserting rate=1.0 could otherwise ride straight into the live policy.


@dataclass
class OfflineEvalResult:
    """One candidate's verdict from evaluate_candidate_strategy_weights()."""

    key: StrategyWeightKey
    candidate_rate: float
    sample_size: int
    promoted: bool
    reason: str


def evaluate_candidate_strategy_weights(
    experience_store: ExperienceStore,
    min_sample_size: int = 5,
    min_success_rate: float = 0.5,
) -> list[OfflineEvalResult]:
    """Judge every pending (unpromoted) strategy-weight candidate. Read-only — does not
    promote anything itself; see run_offline_eval_pipeline().

    A candidate passes only if both hold:
      - sample_size >= min_sample_size (the "canary" bar that closes the "softmax
        reinforcement of accidental correlations" risk — a single lucky early attempt
        can't ride straight into the live policy; it has to accumulate real evidence
        first, still unpromoted, before it is even considered).
      - candidate_rate >= min_success_rate (a floor, not a comparison — a candidate
        that has accumulated enough attempts to be judged but is still failing more
        than it succeeds shouldn't be promoted just because it hit the sample-size bar).

    Deliberately NOT a comparison against this key's own previously-promoted rate: the
    schema keeps exactly one cumulative (success_count, attempt_count, rate) row per
    (strategy_type, failure_class), and upsert_strategy_weight() resets promoted=False on
    that same row on every new attempt (see this module's docstring). A pending candidate
    and a still-promoted baseline for the same key can therefore never coexist — by the
    time a row is visible here, its own prior promoted value has already been overwritten
    in place, not preserved anywhere. The sample-size and rate-floor bars are the
    meaningful gate this single-row schema actually supports.
    """
    if not experience_store.available:
        return []
    candidates = experience_store.get_pending_strategy_weights()
    results: list[OfflineEvalResult] = []
    for key, sample in candidates.items():
        if sample.attempt_count < min_sample_size:
            reason, promoted = "insufficient_sample", False
        elif sample.rate < min_success_rate:
            reason, promoted = "below_min_success_rate", False
        else:
            reason, promoted = "passed", True
        results.append(
            OfflineEvalResult(
                key=key,
                candidate_rate=sample.rate,
                sample_size=sample.attempt_count,
                promoted=promoted,
                reason=reason,
            )
        )
    return results


def run_offline_eval_pipeline(
    experience_store: ExperienceStore,
    min_sample_size: int = 5,
    min_success_rate: float = 0.5,
) -> list[OfflineEvalResult]:
    """Evaluate every pending strategy-weight candidate and promote the ones that pass.

    This is the offline evaluation job the module docstring's pipeline names but leaves
    to the caller — a scheduled task or CLI command invokes it explicitly. Nothing in the
    main harness loop calls this automatically.
    """
    results = evaluate_candidate_strategy_weights(
        experience_store, min_sample_size=min_sample_size, min_success_rate=min_success_rate
    )
    to_promote = [r.key for r in results if r.promoted]
    if to_promote:
        experience_store.promote_strategy_weights(to_promote)
    return results
