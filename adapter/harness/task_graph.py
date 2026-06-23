"""
Task graph with 6-state status, DAG validation, conflict probability cache,
and abstraction fit checking — P4.1, P4.2, P4.4.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

TaskStatus = Literal["PENDING", "ACTIVE", "VERIFYING", "COMPLETE", "FAILED", "BLOCKED"]
TaskRisk = Literal["LOW", "MEDIUM", "HIGH"]

# COMPLETE is terminal — only the P9 reviewer pass may reset to PENDING.
# FAILED tasks may be requeued (PENDING) or blocked.
_VALID_TRANSITIONS: dict[str, set[str]] = {
    "PENDING": {"ACTIVE", "BLOCKED"},
    "ACTIVE": {"VERIFYING", "FAILED", "BLOCKED"},
    "VERIFYING": {"COMPLETE", "FAILED", "BLOCKED"},
    "COMPLETE": set(),
    "FAILED": {"PENDING", "BLOCKED"},
    "BLOCKED": {"PENDING", "ACTIVE"},
}

_RISK_ORDER: dict[str, int] = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}


# ── Task and TaskGraph ────────────────────────────────────────────────────────


@dataclass
class Task:
    id: str
    description: str
    status: TaskStatus = "PENDING"
    depends_on: list[str] = field(default_factory=list)
    risk_level: TaskRisk = "LOW"
    assigned_strategy: str | None = None
    parallel_write_domains: list[str] = field(default_factory=list)
    # 0 = coarsest (module), 1 = function, 2 = statement-level
    abstraction_level: int = 0
    block_reason: str | None = None
    # Belief IDs whose validity was required to conclude this task COMPLETE.
    # Populated by the execution layer; consumed by the P9 reviewer drain.
    completed_evidence: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "description": self.description,
            "status": self.status,
            "depends_on": list(self.depends_on),
            "risk_level": self.risk_level,
            "assigned_strategy": self.assigned_strategy,
            "parallel_write_domains": list(self.parallel_write_domains),
            "abstraction_level": self.abstraction_level,
            "block_reason": self.block_reason,
            "completed_evidence": list(self.completed_evidence),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Task:
        return cls(
            id=d["id"],
            description=d["description"],
            status=d.get("status", "PENDING"),
            depends_on=d.get("depends_on", []),
            risk_level=d.get("risk_level", "LOW"),
            assigned_strategy=d.get("assigned_strategy"),
            parallel_write_domains=d.get("parallel_write_domains", []),
            abstraction_level=d.get("abstraction_level", 0),
            block_reason=d.get("block_reason"),
            completed_evidence=d.get("completed_evidence", []),
        )

    def to_plan_task(self) -> dict[str, Any]:
        """Plan-facing repr — omits completed_evidence and assigned_strategy."""
        return {
            "id": self.id,
            "title": self.description.split(".")[0],
            "description": self.description,
            "depends_on": list(self.depends_on),
            "risk_level": self.risk_level,
            "abstraction_level": self.abstraction_level,
            "parallel_write_domains": list(self.parallel_write_domains),
            "status": self.status,
            "block_reason": self.block_reason,
        }


@dataclass
class TaskGraph:
    tasks: list[Task] = field(default_factory=list)
    # Set True whenever tasks are added/removed/status-changed.
    # Used by check_abstraction_alignment to decide if recomputation is needed.
    changed: bool = False

    def get_task(self, task_id: str) -> Task | None:
        for t in self.tasks:
            if t.id == task_id:
                return t
        return None

    def update_task_status(
        self,
        task_id: str,
        new_status: TaskStatus,
        block_reason: str | None = None,
    ) -> None:
        task = self.get_task(task_id)
        if task is None:
            raise ValueError(f"Task {task_id!r} not found in graph")
        allowed = _VALID_TRANSITIONS.get(task.status, set())
        if new_status not in allowed:
            raise ValueError(f"Invalid task status transition: {task.status} → {new_status} for task {task_id!r}")
        task.status = new_status
        task.block_reason = block_reason
        self.changed = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "tasks": [t.to_dict() for t in self.tasks],
            "changed": self.changed,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> TaskGraph:
        return cls(
            tasks=[Task.from_dict(t) for t in d.get("tasks", [])],
            changed=d.get("changed", False),
        )

    def to_plan(self, base_name: str = "") -> dict[str, Any]:
        """Snapshot-compatible dict. Does NOT touch to_dict() (Postgres path)."""
        tasks = self.tasks
        complete = sum(1 for t in tasks if t.status == "COMPLETE")
        return {
            "name": base_name,
            "completion_pct": round(100 * complete / len(tasks), 1) if tasks else 0.0,
            "task_statuses": [{"id": t.id, "status": t.status, "block_reason": t.block_reason} for t in tasks],
        }


# ── P4.1 — Graph operations ───────────────────────────────────────────────────


def validate_task_graph(task_graph: TaskGraph) -> list[str]:
    """Return a list of error strings (empty = valid).

    Checks: (1) orphaned depends_on references, (2) dependency cycles via
    iterative DFS, (3) COMPLETE tasks must have all deps also COMPLETE.
    Returns all errors found, not just the first.
    """
    errors: list[str] = []
    task_by_id: dict[str, Task] = {t.id: t for t in task_graph.tasks}
    ids = set(task_by_id)

    # (1) Orphaned references
    for t in task_graph.tasks:
        for dep_id in t.depends_on:
            if dep_id not in ids:
                errors.append(f"Task {t.id!r} depends_on unknown task {dep_id!r}")

    # (2) Cycle detection via iterative DFS (WHITE=0, GRAY=1, BLACK=2)
    WHITE, GRAY, BLACK = 0, 1, 2
    colour: dict[str, int] = {tid: WHITE for tid in ids}
    adj: dict[str, list[str]] = {t.id: list(t.depends_on) for t in task_graph.tasks}

    def _dfs(start: str) -> bool:
        stack = [(start, iter(adj.get(start, [])))]
        colour[start] = GRAY
        while stack:
            node, children = stack[-1]
            try:
                child = next(children)
                if child not in colour:
                    continue  # orphaned ref already reported
                if colour[child] == GRAY:
                    return True
                if colour[child] == WHITE:
                    colour[child] = GRAY
                    stack.append((child, iter(adj.get(child, []))))
            except StopIteration:
                colour[node] = BLACK
                stack.pop()
        return False

    cycle_reported: set[str] = set()
    for tid in list(ids):
        if colour[tid] == WHITE:
            if _dfs(tid):
                if tid not in cycle_reported:
                    errors.append(f"Dependency cycle detected involving task {tid!r}")
                    cycle_reported.add(tid)

    # (3) Consistent dependency status
    for t in task_graph.tasks:
        if t.status == "COMPLETE":
            for dep_id in t.depends_on:
                dep = task_by_id.get(dep_id)
                if dep is not None and dep.status != "COMPLETE":
                    errors.append(
                        f"COMPLETE task {t.id!r} has non-COMPLETE dependency {dep_id!r} (status={dep.status!r})"
                    )

    return errors


def select_unblocked_leaf(task_graph: TaskGraph) -> Task | None:
    """Return the highest-priority PENDING task whose all depends_on are COMPLETE.

    Priority: HIGH risk first, MEDIUM second, LOW last; insertion order within
    the same risk level.
    Returns None when no such task exists.
    """
    task_by_id: dict[str, Task] = {t.id: t for t in task_graph.tasks}
    candidates: list[Task] = []

    for t in task_graph.tasks:
        if t.status != "PENDING":
            continue
        all_done = all(
            task_by_id.get(dep_id) is not None and task_by_id[dep_id].status == "COMPLETE" for dep_id in t.depends_on
        )
        if all_done:
            candidates.append(t)

    if not candidates:
        return None

    candidates.sort(key=lambda t: _RISK_ORDER[t.risk_level])
    return candidates[0]


# ── P4.2 — Conflict probability cache ────────────────────────────────────────


@dataclass
class ConflictProbabilityCache:
    # Keyed by sorted domain-pair string "da::db" (sorted to ensure determinism).
    probabilities: dict[str, float] = field(default_factory=dict)
    pessimistic_threshold: float = 0.5
    # Rolling observation counts for Bayesian updates.
    observation_counts: dict[str, int] = field(default_factory=dict)

    def _key(self, domain_a: str, domain_b: str) -> str:
        pair = sorted([domain_a, domain_b])
        return f"{pair[0]}::{pair[1]}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "probabilities": dict(self.probabilities),
            "pessimistic_threshold": self.pessimistic_threshold,
            "observation_counts": dict(self.observation_counts),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ConflictProbabilityCache:
        return cls(
            probabilities=d.get("probabilities", {}),
            pessimistic_threshold=d.get("pessimistic_threshold", 0.5),
            observation_counts=d.get("observation_counts", {}),
        )


def compute_initial_conflict_probabilities(
    task_graph: TaskGraph,
) -> ConflictProbabilityCache:
    """Compute per-domain-pair conflict probabilities from task write-domain structure.

    For each pair of parallel-eligible PENDING tasks (no dependency between them):
    - identical domain sets   → probability 1.0 for shared domain pairs
    - disjoint domain sets    → probability 0.0 for cross-domain pairs
    - partial overlap         → overlap_count / max(len_a, len_b) for each pair
    """
    cache = ConflictProbabilityCache()
    pending = [t for t in task_graph.tasks if t.status == "PENDING"]
    dep_sets: dict[str, set[str]] = {t.id: set(t.depends_on) for t in pending}

    for i, ta in enumerate(pending):
        for tb in pending[i + 1 :]:
            # Skip tasks with a direct dependency on each other
            if tb.id in dep_sets.get(ta.id, set()):
                continue
            if ta.id in dep_sets.get(tb.id, set()):
                continue

            domains_a = set(ta.parallel_write_domains)
            domains_b = set(tb.parallel_write_domains)

            if not domains_a or not domains_b:
                continue

            overlap = domains_a & domains_b
            max_len = max(len(domains_a), len(domains_b))

            if domains_a == domains_b:
                pair_prob = 1.0
            elif not overlap:
                pair_prob = 0.0
            else:
                pair_prob = len(overlap) / max_len

            # Store per-domain-pair, taking the max when multiple task pairs
            # contribute to the same domain pair.
            for da in ta.parallel_write_domains:
                for db in tb.parallel_write_domains:
                    key = cache._key(da, db)
                    cache.probabilities[key] = max(cache.probabilities.get(key, 0.0), pair_prob)

    return cache


def update_from_experience_store(
    cache: ConflictProbabilityCache,
    experience_store: Any,
) -> None:
    """Blend cached structural estimates with historical conflict rates.

    experience_store.write_conflict_history maps domain-pair key → {"conflicts": int, "total_runs": int}.
    Bayesian blend: new_prob = (structural_prob × N_prior + empirical_rate × N_obs) / (N_prior + N_obs)
    with N_prior = 5.
    """
    if experience_store is None:
        return
    history: dict[str, Any] = getattr(experience_store, "write_conflict_history", {})
    N_prior = 5
    for key, stats in history.items():
        if not isinstance(stats, dict):
            continue
        total = stats.get("total_runs", 0)
        if total == 0:
            continue
        conflicts = stats.get("conflicts", 0)
        empirical_rate = conflicts / total
        structural_prob = cache.probabilities.get(key, 0.0)
        new_prob = (structural_prob * N_prior + empirical_rate * total) / (N_prior + total)
        cache.probabilities[key] = max(0.0, min(1.0, new_prob))


def should_use_pessimistic_blocking(
    cache: ConflictProbabilityCache,
    domain_a: str,
    domain_b: str,
) -> bool:
    """Return True when the conflict probability exceeds the pessimistic threshold.

    Unknown pairs default to False (optimistic) — fail open to avoid excessive blocking
    on first-time domain pairs that haven't accumulated empirical data yet.
    """
    key = cache._key(domain_a, domain_b)
    prob = cache.probabilities.get(key)
    if prob is None:
        return False
    return prob > cache.pessimistic_threshold


def record_actual_overlap(
    cache: ConflictProbabilityCache,
    domain_a: str,
    domain_b: str,
    conflict_observed: bool,
) -> None:
    """Update the conflict probability cache with one empirical observation.

    Uses a rolling Bayesian update treating the existing probability as the
    result of (N_prior + existing_obs_count) prior observations:
        new_prob = (current_prob × total_prior_weight + observation) / (total_prior_weight + 1)
    """
    N_prior = 5
    key = cache._key(domain_a, domain_b)
    n = cache.observation_counts.get(key, 0)
    current_prob = cache.probabilities.get(key, 0.0)

    total_prior_weight = N_prior + n
    observation = 1.0 if conflict_observed else 0.0
    new_prob = (current_prob * total_prior_weight + observation) / (total_prior_weight + 1)

    cache.probabilities[key] = max(0.0, min(1.0, new_prob))
    cache.observation_counts[key] = n + 1


# ── P4.4 — Abstraction fit checking ──────────────────────────────────────────


def estimate_world_model_granularity(world_model: Any) -> int:
    """Estimate the granularity level implied by the world model's current beliefs.

    0 = module level  (default; beliefs discuss whole modules/packages)
    1 = function level (beliefs reference function or method names)
    2 = statement level (beliefs reference line numbers or specific expressions)
    """
    beliefs = getattr(world_model, "beliefs", [])
    if not beliefs:
        return 0

    total = len(beliefs)
    statement_count = 0
    function_count = 0

    statement_markers = ("line ", "line:", "statement", "expression", "lineno")
    function_markers = ("function", "method", "def ", "procedure", "()")

    for b in beliefs:
        stmt = getattr(b, "statement", "").lower()
        if any(marker in stmt for marker in statement_markers):
            statement_count += 1
        elif any(marker in stmt for marker in function_markers):
            function_count += 1

    if statement_count / total > 0.5:
        return 2
    if function_count / total > 0.5:
        return 1
    return 0


def check_abstraction_alignment(
    task_graph: TaskGraph,
    world_model: Any,
    force: bool = False,
) -> float:
    """Return an alignment score in [0, 1] for task granularity vs world model depth.

    1.0 = perfect alignment; lower values indicate tasks that are much finer-grained
    (abstraction_level > world_model_granularity + 1) than the world model can support.

    Skips computation and returns 1.0 when task_graph.changed is False and force is False —
    the score hasn't changed since the last computation in that case.
    """
    if not force and not task_graph.changed:
        return 1.0

    wm_granularity = estimate_world_model_granularity(world_model)
    total = len(task_graph.tasks)
    if total == 0:
        return 1.0

    mismatched = sum(1 for t in task_graph.tasks if t.abstraction_level > wm_granularity + 1)
    score = 1.0 - (mismatched / total)
    return max(0.0, min(1.0, score))
