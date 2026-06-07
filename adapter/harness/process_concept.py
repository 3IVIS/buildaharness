"""
Process concept data model and task-graph seeding — P-PC.1, P-PC.2.

A ProcessConcept is a human-authored canonical decomposition for a task class.
It seeds the TaskGraph at harness initialisation and is a strong prior, not
a constraint (INV-PC-01). The model-driven replanning path remains intact.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Module-level mtime cache: path (str) → (mtime: float, concept: ProcessConcept)
_FILE_CACHE: dict[str, tuple[float, "ProcessConcept"]] = {}


# ── Errors ────────────────────────────────────────────────────────────────────


class ProcessConceptValidationError(ValueError):
    """Raised when a concept file fails structural validation."""


class ProcessConceptNotFoundError(KeyError):
    """Raised when a requested concept ID is not registered."""


# ── Abstraction level mapping ─────────────────────────────────────────────────

_ABSTRACTION_MAP: dict[str, int] = {
    "module": 0,
    "goal": 0,
    "subgoal": 1,
    "function": 1,
    "leaf": 2,
    "statement": 2,
}

_VALID_RISK_LEVELS = {"LOW", "MEDIUM", "HIGH"}
_VALID_ABSTRACTION_LEVELS = set(_ABSTRACTION_MAP.keys())


# ── Data model ────────────────────────────────────────────────────────────────


@dataclass
class ProcessConceptStep:
    id: str
    description: str
    depends_on: list[str] = field(default_factory=list)
    risk_level: str = "LOW"
    abstraction_level: str = "module"
    expected_tools: list[str] = field(default_factory=list)
    success_criteria: list[str] = field(default_factory=list)
    strategy_hint: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "description": self.description,
            "depends_on": list(self.depends_on),
            "risk_level": self.risk_level,
            "abstraction_level": self.abstraction_level,
            "expected_tools": list(self.expected_tools),
            "success_criteria": list(self.success_criteria),
            "strategy_hint": self.strategy_hint,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ProcessConceptStep:
        return cls(
            id=d["id"],
            description=d["description"],
            depends_on=d.get("depends_on", []),
            risk_level=d.get("risk_level", "LOW"),
            abstraction_level=d.get("abstraction_level", "module"),
            expected_tools=d.get("expected_tools", []),
            success_criteria=d.get("success_criteria", []),
            strategy_hint=d.get("strategy_hint"),
        )


@dataclass
class ProcessConcept:
    id: str
    name: str
    description: str
    success_criteria: list[str] = field(default_factory=list)
    schema_version: str = "1"
    steps: list[ProcessConceptStep] = field(default_factory=list)

    # ── Serialisation ──────────────────────────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "success_criteria": list(self.success_criteria),
            "steps": [s.to_dict() for s in self.steps],
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ProcessConcept:
        return cls(
            id=d["id"],
            name=d.get("name", d["id"]),
            description=d.get("description", ""),
            success_criteria=d.get("success_criteria", []),
            schema_version=d.get("schema_version", "1"),
            steps=[ProcessConceptStep.from_dict(s) for s in d.get("steps", [])],
        )

    @classmethod
    def from_file(cls, path: str | Path) -> ProcessConcept:
        """Load a ProcessConcept from a JSON file, with mtime-keyed caching.

        Re-reads the file only when the mtime has changed since the last load.
        Raises ProcessConceptNotFoundError when the file does not exist.
        Raises ProcessConceptValidationError for invalid content.
        """
        path = Path(path)
        if not path.exists():
            raise ProcessConceptNotFoundError(str(path))

        mtime = path.stat().st_mtime
        cached = _FILE_CACHE.get(str(path))
        if cached is not None and cached[0] == mtime:
            return cached[1]

        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ProcessConceptValidationError(f"Invalid JSON in {path}: {exc}") from exc

        try:
            concept = cls.from_dict(raw)
        except (KeyError, TypeError) as exc:
            raise ProcessConceptValidationError(f"Malformed concept in {path}: {exc}") from exc

        errors = concept.validate()
        if errors:
            raise ProcessConceptValidationError(
                f"Concept {path} failed validation: " + "; ".join(errors)
            )

        _FILE_CACHE[str(path)] = (mtime, concept)
        return concept

    # ── Validation ────────────────────────────────────────────────────────────

    def validate(self) -> list[str]:
        """Return validation errors (empty list = valid).

        Checks: (1) non-empty concept ID, (2) step ID uniqueness,
        (3) depends_on references only known step IDs,
        (4) valid risk_level and abstraction_level values,
        (5) dependency cycle detection.
        """
        errors: list[str] = []

        if not self.id or not self.id.strip():
            errors.append("Concept 'id' must be a non-empty string")

        step_ids: list[str] = []
        seen: set[str] = set()
        for step in self.steps:
            if not step.id or not step.id.strip():
                errors.append("Each step must have a non-empty 'id'")
                continue
            if step.id in seen:
                errors.append(f"Duplicate step id {step.id!r}")
            else:
                seen.add(step.id)
                step_ids.append(step.id)

            if step.risk_level not in _VALID_RISK_LEVELS:
                errors.append(
                    f"Step {step.id!r}: risk_level {step.risk_level!r} must be one of {sorted(_VALID_RISK_LEVELS)}"
                )
            if step.abstraction_level not in _VALID_ABSTRACTION_LEVELS:
                errors.append(
                    f"Step {step.id!r}: abstraction_level {step.abstraction_level!r} "
                    f"must be one of {sorted(_VALID_ABSTRACTION_LEVELS)}"
                )

        id_set = set(step_ids)
        for step in self.steps:
            for dep in step.depends_on:
                if dep not in id_set:
                    errors.append(
                        f"Step {step.id!r} depends_on unknown step {dep!r}"
                    )

        # Cycle detection (iterative DFS)
        adj: dict[str, list[str]] = {s.id: list(s.depends_on) for s in self.steps}
        WHITE, GRAY, BLACK = 0, 1, 2
        colour: dict[str, int] = {sid: WHITE for sid in id_set}
        cycle_reported: set[str] = set()

        def _dfs(start: str) -> bool:
            stack = [(start, iter(adj.get(start, [])))]
            colour[start] = GRAY
            while stack:
                node, children = stack[-1]
                try:
                    child = next(children)
                    if child not in colour:
                        continue
                    if colour[child] == GRAY:
                        return True
                    if colour[child] == WHITE:
                        colour[child] = GRAY
                        stack.append((child, iter(adj.get(child, []))))
                except StopIteration:
                    colour[node] = BLACK
                    stack.pop()
            return False

        for sid in list(id_set):
            if colour[sid] == WHITE:
                if _dfs(sid):
                    if sid not in cycle_reported:
                        errors.append(f"Dependency cycle detected involving step {sid!r}")
                        cycle_reported.add(sid)

        return errors

    # ── TaskGraph seeding ─────────────────────────────────────────────────────

    def seed_task_graph(self, task_graph: Any) -> None:
        """Append concept steps as Task objects to task_graph in-place.

        Task IDs are namespaced as ``{concept_id}:{step_id}`` to avoid
        collisions with model-generated tasks. depends_on references are
        also namespaced. abstraction_level strings are mapped to ints:
        "module"/"goal"→0, "subgoal"/"function"→1, "leaf"/"statement"→2.
        """
        from .task_graph import Task

        for step in self.steps:
            namespaced_id = f"{self.id}:{step.id}"
            namespaced_deps = [f"{self.id}:{dep}" for dep in step.depends_on]
            abs_level = _ABSTRACTION_MAP.get(step.abstraction_level, 0)

            task = Task(
                id=namespaced_id,
                description=step.description,
                status="PENDING",
                depends_on=namespaced_deps,
                risk_level=step.risk_level,  # type: ignore[arg-type]
                assigned_strategy=step.strategy_hint,
                parallel_write_domains=[],
                abstraction_level=abs_level,
                block_reason=None,
                completed_evidence=[],
            )
            task_graph.tasks.append(task)

        task_graph.changed = True
