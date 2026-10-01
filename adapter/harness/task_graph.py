"""
Task graph — P4.1, P4.2 and P4.4.

Twin of packages/harness/src/state/task-graph.ts and nodes/{update-task-graph,select-task,apply-task-outcome}.ts.

Six statuses (PENDING / RUNNING / COMPLETE / FAILED / BLOCKED / HUMAN_REQUIRED). COMPLETE is terminal and FAILED may
only be set by the execution layer. The graph also carries the per-domain-pair conflict-probability cache that
update_task_graph() seeds and select_task() reads to decide whether two ready tasks may run concurrently.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from .lexical_off import harness_lexical_active
from .lexical_patterns import get_granularity_markers

TaskStatus = Literal["PENDING", "RUNNING", "COMPLETE", "FAILED", "BLOCKED", "HUMAN_REQUIRED"]
TaskRisk = Literal["LOW", "MEDIUM", "HIGH"]
TaskNodeKind = Literal["task", "goal_hypothesis"]
SiblingRelation = Literal["alternative", "concurrent"]

_RISK_ORDER: dict[str, int] = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}

PESSIMISTIC_THRESHOLD = 0.5


class GraphCycleError(Exception):
    """A dependency cycle in the task graph (TS GraphCycleError)."""


@dataclass
class Task:
    id: str
    description: str
    status: TaskStatus = "PENDING"
    depends_on: list[str] = field(default_factory=list)
    risk_level: TaskRisk = "LOW"
    assigned_strategy: str | None = None
    parallel_write_domains: list[str] = field(default_factory=list)
    abstraction_level: int = 0
    block_reason: str | None = None
    completed_evidence: list[str] = field(default_factory=list)
    # Goal-hypothesis graph fields (TS Task.node_kind / goal_id / hypothesis_ids / relation_to_siblings).
    node_kind: TaskNodeKind | None = None
    goal_id: str | None = None
    hypothesis_ids: list[str] | None = None
    relation_to_siblings: SiblingRelation | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "description": self.description,
            "status": self.status,
            "depends_on": list(self.depends_on),
            "risk_level": self.risk_level,
            "assigned_strategy": self.assigned_strategy,
            "parallel_write_domains": list(self.parallel_write_domains),
            "abstraction_level": self.abstraction_level,
        }
        if self.block_reason is not None:
            d["block_reason"] = self.block_reason
        if self.node_kind is not None:
            d["node_kind"] = self.node_kind
        if self.goal_id is not None:
            d["goal_id"] = self.goal_id
        if self.hypothesis_ids is not None:
            d["hypothesis_ids"] = list(self.hypothesis_ids)
        if self.relation_to_siblings is not None:
            d["relation_to_siblings"] = self.relation_to_siblings
        return d

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
            node_kind=d.get("node_kind"),
            goal_id=d.get("goal_id"),
            hypothesis_ids=d.get("hypothesis_ids"),
            relation_to_siblings=d.get("relation_to_siblings"),
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


def make_conflict_key(domain_a: str, domain_b: str) -> str:
    """Order-independent key for a pair of write domains (`a::b`, sorted)."""
    return "::".join(sorted([domain_a, domain_b]))


@dataclass
class TaskGraph:
    tasks: list[Task] = field(default_factory=list)
    conflict_probability_cache: dict[str, float] = field(default_factory=dict)
    changed: bool = False

    def get_task(self, task_id: str) -> Task | None:
        for t in self.tasks:
            if t.id == task_id:
                return t
        return None

    def set_status(self, task_id: str, new_status: TaskStatus, from_execution_layer: bool = False) -> None:
        """Move a task to `new_status` (TS TaskGraph.setStatus).

        Raises ValueError for an unknown task, for any transition out of COMPLETE (terminal), and for FAILED unless
        `from_execution_layer` (only the execution layer may declare a task failed).
        """
        task = self.get_task(task_id)
        if task is None:
            raise ValueError(f'TaskGraph: task "{task_id}" not found')
        if task.status == "COMPLETE":
            raise ValueError(
                f'TaskGraph: task "{task_id}" is in terminal status COMPLETE; no further transitions allowed'
            )
        if new_status == "FAILED" and not from_execution_layer:
            raise ValueError("TaskGraph: status FAILED can only be set by the execution layer")
        task.status = new_status
        self.changed = True

    def select_unblocked_leaf(self) -> Task | None:
        return select_unblocked_leaf(self)

    def set_conflict_probability(self, domain_a: str, domain_b: str, probability: float) -> None:
        self.conflict_probability_cache[make_conflict_key(domain_a, domain_b)] = probability

    def get_conflict_probability(self, domain_a: str, domain_b: str) -> float:
        return self.conflict_probability_cache.get(make_conflict_key(domain_a, domain_b), 0)

    def to_dict(self) -> dict[str, Any]:
        return {
            "tasks": [t.to_dict() for t in self.tasks],
            "conflict_probability_cache": dict(self.conflict_probability_cache),
            "changed": self.changed,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> TaskGraph:
        return cls(
            tasks=[Task.from_dict(t) for t in d.get("tasks", [])],
            conflict_probability_cache=dict(d.get("conflict_probability_cache", {})),
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


# ── apply_task_outcome ────────────────────────────────────────────────────────


@dataclass
class TaskOutcome:
    """What the executor observed for a task — the Effect-feedback primitive (TS TaskOutcome).

    apply_task_outcome() is the one State-write path callers use to report it; direct TaskGraph.set_status() calls
    from outside this module are the seam Phase H closes (INV-17 grep-gates it — see test_harness_h.py).
    """

    status: TaskStatus
    from_execution_layer: bool = False
    continue_: bool = False
    # Python extras (not in TS): evidence ids stamped on a COMPLETE task and a block reason for BLOCKED.
    evidence_ids: list[str] = field(default_factory=list)
    block_reason: str | None = None


def apply_task_outcome(task_graph: TaskGraph, task_id: str, outcome: TaskOutcome) -> None:
    """Apply a TaskOutcome to task_graph — the single writer for task-status transitions."""
    task_graph.set_status(task_id, outcome.status, from_execution_layer=outcome.from_execution_layer)
    task = task_graph.get_task(task_id)
    if task is None:
        return
    if outcome.block_reason is not None:
        task.block_reason = outcome.block_reason
    if outcome.status == "COMPLETE" and outcome.evidence_ids:
        task.completed_evidence = list(outcome.evidence_ids)


# ── validation, cycle detection, conflict probabilities (TS updateTaskGraph) ──


def validate_task_graph(task_graph: TaskGraph) -> list[str]:
    """Orphaned-dependency errors (TS validateTaskGraph): every `depends_on` must name a task in the graph.
    Cycles are reported separately by update_task_graph() as GraphCycleError."""
    ids = {t.id for t in task_graph.tasks}
    return [
        f'Task "{t.id}" depends on unknown task "{dep}"'
        for t in task_graph.tasks
        for dep in t.depends_on
        if dep not in ids
    ]


def _detect_cycles(task_graph: TaskGraph) -> None:
    white, gray, black = 0, 1, 2
    color: dict[str, int] = {t.id: white for t in task_graph.tasks}
    task_map = {t.id: t for t in task_graph.tasks}

    def dfs(task_id: str) -> None:
        color[task_id] = gray
        task = task_map.get(task_id)
        for dep_id in task.depends_on if task is not None else []:
            c = color.get(dep_id, white)
            if c == gray:
                raise GraphCycleError(f'Cycle detected in task graph: "{dep_id}" is part of a cycle')
            if c == white:
                dfs(dep_id)
        color[task_id] = black

    for t in task_graph.tasks:
        if color.get(t.id, white) == white:
            dfs(t.id)


def _update_conflict_probabilities(task_graph: TaskGraph) -> None:
    tasks = task_graph.tasks
    if len(tasks) < 2:
        return

    domains = sorted({d for t in tasks for d in t.parallel_write_domains})
    for i, dom_a in enumerate(domains):
        for dom_b in domains[i + 1 :]:
            if task_graph.get_conflict_probability(dom_a, dom_b) == 0:
                count_a = sum(1 for t in tasks if dom_a in t.parallel_write_domains)
                count_b = sum(1 for t in tasks if dom_b in t.parallel_write_domains)
                if count_a > 0 and count_b > 0:
                    task_graph.set_conflict_probability(dom_a, dom_b, min(1, (count_a + count_b) / (2 * len(tasks))))
        if task_graph.get_conflict_probability(dom_a, dom_a) == 0:
            count_a = sum(1 for t in tasks if dom_a in t.parallel_write_domains)
            if count_a >= 2:
                task_graph.set_conflict_probability(dom_a, dom_a, min(1, count_a / len(tasks)))


def update_task_graph(
    objective: str | None = None,
    world_model: Any = None,
    hypothesis_set: Any = None,
    task_graph: TaskGraph | None = None,
) -> None:
    """Check the graph is acyclic (raises GraphCycleError) and seed missing conflict probabilities."""
    assert task_graph is not None
    _detect_cycles(task_graph)
    _update_conflict_probabilities(task_graph)


# ── task selection (TS selectTask / TaskGraph.selectUnblockedLeaf) ────────────


def _eligible_tasks(task_graph: TaskGraph) -> list[Task]:
    task_by_id = {t.id: t for t in task_graph.tasks}
    return [
        t
        for t in task_graph.tasks
        if t.status == "PENDING"
        and all(task_by_id.get(dep) is not None and task_by_id[dep].status == "COMPLETE" for dep in t.depends_on)
    ]


def select_unblocked_leaf(task_graph: TaskGraph) -> Task | None:
    """Highest-risk PENDING task whose dependencies are all COMPLETE (insertion order within a risk level)."""
    eligible = _eligible_tasks(task_graph)
    if not eligible:
        return None
    eligible.sort(key=lambda t: _RISK_ORDER[t.risk_level])
    return eligible[0]


@dataclass
class SelectTaskResult:
    task: Task | None
    concurrent_task: Task | None
    escalate: bool


def select_task(task_graph: TaskGraph, control_state: Any) -> SelectTaskResult:
    """Pick the next task and, when safe, a second one to run concurrently (TS selectTask).

    HUMAN_REQUIRED escalates. The second-ranked ready task runs concurrently unless its write domains overlap the
    primary's and the recorded conflict probability between them exceeds PESSIMISTIC_THRESHOLD (0.5).
    """
    if getattr(control_state, "escalation_reason", None) == "HUMAN_REQUIRED":
        return SelectTaskResult(None, None, True)

    eligible = _eligible_tasks(task_graph)
    if not eligible:
        return SelectTaskResult(None, None, False)

    ranked = sorted(eligible, key=lambda t: _RISK_ORDER.get(t.risk_level, 1))
    primary = ranked[0]
    if len(ranked) < 2:
        return SelectTaskResult(primary, None, False)

    secondary = ranked[1]
    primary_domains = set(primary.parallel_write_domains)
    if not any(d in primary_domains for d in secondary.parallel_write_domains):
        return SelectTaskResult(primary, secondary, False)

    conflict_prob = max(
        [
            0,
            *(
                task_graph.get_conflict_probability(da, db)
                for da in primary.parallel_write_domains
                for db in secondary.parallel_write_domains
            ),
        ]
    )
    if conflict_prob > PESSIMISTIC_THRESHOLD:
        return SelectTaskResult(primary, None, False)
    return SelectTaskResult(primary, secondary, False)


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

    # Was a locally-hardcoded list, narrower than and drifted from contradiction.py's own
    # line_level_keywords (a different check with substantially overlapping vocabulary) — both
    # now read the same granularity-markers.json (see get_granularity_markers()'s doc comment).
    statement_markers, function_markers = get_granularity_markers()

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
    # HARNESS_LEXICAL granularity-markers: the granularity estimate is a keyword count; with it off the
    # alignment reads neutral (1.0), the value an unchanged graph gets.
    if not harness_lexical_active("granularity-markers"):
        return 1.0

    wm_granularity = estimate_world_model_granularity(world_model)
    total = len(task_graph.tasks)
    if total == 0:
        return 1.0

    mismatched = sum(1 for t in task_graph.tasks if t.abstraction_level > wm_granularity + 1)
    score = 1.0 - (mismatched / total)
    return max(0.0, min(1.0, score))
