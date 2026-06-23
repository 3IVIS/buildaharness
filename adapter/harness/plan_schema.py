"""Pydantic models for plan-first agent templates and snapshots.

Zero imports from any other harness module — safe to import standalone
from canvas, CLI tooling, or tests without pulling in the full harness chain.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel


class PlanTask(BaseModel):
    id: str
    title: str
    description: str
    depends_on: list[str] = []
    risk_level: Literal["LOW", "MEDIUM", "HIGH"] = "MEDIUM"
    abstraction_level: int = 0
    parallel_write_domains: list[str] = []


class PlanTemplate(BaseModel):
    name: str
    version: str = "1.0.0"
    success_criteria: str
    tags: list[str] = []
    tasks: list[PlanTask]
    metadata: dict[str, Any] = {}


class TaskStatusOverride(BaseModel):
    id: str
    status: str  # PENDING/ACTIVE/VERIFYING/COMPLETE/FAILED/BLOCKED
    block_reason: str | None = None


class PlanSnapshot(PlanTemplate):
    run_id: str
    turn: int
    exported_at: str  # UTC ISO-8601
    completion_pct: float  # 0.0 – 100.0
    task_statuses: list[TaskStatusOverride] = []


def validate_template(template: PlanTemplate) -> list[str]:
    """Validate a PlanTemplate DAG. Returns a list of error strings (empty = valid).

    Checks: (1) orphaned depends_on IDs, (2) cycle detection via iterative DFS,
    (3) COMPLETE dependencies covered (n/a at load time — all tasks start PENDING).
    """
    errors: list[str] = []
    ids = {t.id for t in template.tasks}

    # (1) Orphaned references
    for task in template.tasks:
        for dep_id in task.depends_on:
            if dep_id not in ids:
                errors.append(f"Task {task.id!r} depends_on unknown task {dep_id!r}")

    # (2) Cycle detection via iterative DFS (WHITE=0, GRAY=1, BLACK=2)
    WHITE, GRAY, BLACK = 0, 1, 2
    colour: dict[str, int] = {tid: WHITE for tid in ids}
    adj: dict[str, list[str]] = {t.id: list(t.depends_on) for t in template.tasks}

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

    for tid in ids:
        if colour[tid] == WHITE and _dfs(tid):
            errors.append(f"Cycle detected involving task {tid!r}")

    return errors
