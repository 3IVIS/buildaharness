"""
Memory management — P6.5 and P6.6.

Twin of packages/harness/src/state/memory-state.ts, state/budget.ts and nodes/context-compression.ts.

Context compression (P6.5) is triggered by token pressure — `token_budget.used / token_budget.total >= 0.9` — which
the *caller* keeps up to date (the TS harness never estimates it either). Compression trims recorded structures and
records what it dropped; it never rewrites beliefs or observations. The journal (P6.6) keeps every failure verbatim,
the last `max_passing_verbatim` passing entries verbatim and compresses older passing ones.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

COMPRESSION_THRESHOLD = 0.9
MAX_COMPRESSED_STRUCTURES = 10
BUDGET_WARNING_FLOOR = 0.5  # feasibility ceiling once 80% of max_steps is used (TS BUDGET_WARNING_FLOOR)

# Default retention constants — tunable per deployment
_DEFAULT_MAX_PASSING_VERBATIM = 20


@dataclass
class Structure:
    id: str
    description: str = ""
    token_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "description": self.description, "token_count": self.token_count}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Structure:
        return cls(id=d["id"], description=d.get("description", ""), token_count=d.get("token_count", 0))


@dataclass
class PrunedRegion:
    id: str
    description: str = ""
    token_count: int = 0
    pruned_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "description": self.description,
            "token_count": self.token_count,
            "pruned_at": self.pruned_at,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> PrunedRegion:
        return cls(
            id=d["id"],
            description=d.get("description", ""),
            token_count=d.get("token_count", 0),
            pruned_at=d.get("pruned_at", ""),
        )


@dataclass
class CompressionRisk:
    compressed_structures: list[Structure] = field(default_factory=list)
    pruned_regions: list[PrunedRegion] = field(default_factory=list)
    dependent_tasks: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "compressed_structures": [s.to_dict() for s in self.compressed_structures],
            "pruned_regions": [r.to_dict() for r in self.pruned_regions],
            "dependent_tasks": list(self.dependent_tasks),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> CompressionRisk:
        raw_structures = d.get("compressed_structures", [])
        raw_regions = d.get("pruned_regions", [])
        structures = [Structure.from_dict(s) if isinstance(s, dict) else Structure(id=s) for s in raw_structures]
        regions = [PrunedRegion.from_dict(r) if isinstance(r, dict) else PrunedRegion(id=r) for r in raw_regions]
        return cls(
            compressed_structures=structures,
            pruned_regions=regions,
            dependent_tasks=list(d.get("dependent_tasks", [])),
        )


@dataclass
class TokenBudget:
    total: int = 200_000
    used: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {"total": self.total, "used": self.used}

    @classmethod
    def from_dict(cls, d: dict[str, Any] | int) -> TokenBudget:
        if isinstance(d, int):  # legacy shape: a bare token total
            return cls(total=d, used=0)
        return cls(total=d.get("total", 200_000), used=d.get("used", 0))


@dataclass
class JournalEntry:
    step: int
    action_class: str
    outcome: str
    success: bool
    verbatim: str | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "step": self.step,
            "action_class": self.action_class,
            "outcome": self.outcome,
            "success": self.success,
        }
        if self.verbatim is not None:
            d["verbatim"] = self.verbatim
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> JournalEntry:
        return cls(
            step=d.get("step", 0),
            action_class=d.get("action_class", d.get("event", "unknown")),
            outcome=d.get("outcome", ""),
            success=bool(d["success"]) if "success" in d else d.get("outcome") != "fail",
            verbatim=d.get("verbatim"),
        )


@dataclass
class JournalRetentionPolicy:
    retain_failures_permanently: bool = True
    max_passing_verbatim: int = _DEFAULT_MAX_PASSING_VERBATIM
    compress_older_passing: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "retain_failures_permanently": self.retain_failures_permanently,
            "max_passing_verbatim": self.max_passing_verbatim,
            "compress_older_passing": self.compress_older_passing,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> JournalRetentionPolicy:
        return cls(
            retain_failures_permanently=d.get("retain_failures_permanently", True),
            max_passing_verbatim=d.get("max_passing_verbatim", _DEFAULT_MAX_PASSING_VERBATIM),
            compress_older_passing=d.get("compress_older_passing", True),
        )


@dataclass
class RollbackPoint:
    id: str
    step: int
    description: str
    serialised_state: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "step": self.step,
            "description": self.description,
            "serialised_state": self.serialised_state,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> RollbackPoint:
        if isinstance(d, str):  # legacy shape: a bare rollback ref
            return cls(id=d, step=0, description=d)
        return cls(
            id=d["id"],
            step=d.get("step", 0),
            description=d.get("description", ""),
            serialised_state=d.get("serialised_state", ""),
        )


@dataclass
class MemoryState:
    token_budget: TokenBudget = field(default_factory=TokenBudget)
    compression_risk: CompressionRisk = field(default_factory=CompressionRisk)
    journal: list[JournalEntry] = field(default_factory=list)
    journal_retention_policy: JournalRetentionPolicy = field(default_factory=JournalRetentionPolicy)
    rollback_points: list[RollbackPoint] = field(default_factory=list)
    max_steps: int = 100

    @property
    def compressed_structures(self) -> list[Structure]:
        """Direct accessor for action_dep_overlap() compatibility."""
        return self.compression_risk.compressed_structures

    @property
    def pruned_regions(self) -> list[PrunedRegion]:
        """Direct accessor for action_dep_overlap() compatibility."""
        return self.compression_risk.pruned_regions

    def action_dep_overlap(self, action_write_domains: list[str]) -> bool:
        """True when any of the action's write domains names a compressed structure or pruned region."""
        structure_ids = {s.id for s in self.compression_risk.compressed_structures}
        pruned_ids = {r.id for r in self.compression_risk.pruned_regions}
        return any(d in structure_ids or d in pruned_ids for d in action_write_domains)

    def to_dict(self) -> dict[str, Any]:
        return {
            "token_budget": self.token_budget.to_dict(),
            "compression_risk": self.compression_risk.to_dict(),
            "journal": [e.to_dict() for e in self.journal],
            "journal_retention_policy": self.journal_retention_policy.to_dict(),
            "rollback_points": [r.to_dict() for r in self.rollback_points],
            "max_steps": self.max_steps,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> MemoryState:
        return cls(
            token_budget=TokenBudget.from_dict(d.get("token_budget", {})),
            compression_risk=CompressionRisk.from_dict(d.get("compression_risk", {})),
            journal=[JournalEntry.from_dict(e) for e in d.get("journal", [])],
            journal_retention_policy=JournalRetentionPolicy.from_dict(d.get("journal_retention_policy", {})),
            rollback_points=[RollbackPoint.from_dict(r) for r in d.get("rollback_points", [])],
            max_steps=d.get("max_steps", 100),
        )


# ── P6.5 — Context compression ────────────────────────────────────────────────


def assess_context_pressure(memory_state: MemoryState) -> float:
    """`used / total` of the token budget (1.0 for a zero-sized budget)."""
    total = memory_state.token_budget.total
    if total == 0:
        return 1.0
    return memory_state.token_budget.used / total


def should_compress(memory_state: MemoryState) -> bool:
    """True once context pressure reaches COMPRESSION_THRESHOLD (0.9)."""
    return assess_context_pressure(memory_state) >= COMPRESSION_THRESHOLD


@dataclass
class CompressionResult:
    dropped: list[Structure] = field(default_factory=list)
    pruned: list[PrunedRegion] = field(default_factory=list)


def compress_memory(memory_state: MemoryState, preserve_set: list[str] | None = None) -> CompressionResult:
    """Trim recorded structures (TS compressMemory): keep at most MAX_COMPRESSED_STRUCTURES, dropping the oldest,
    and stamp every pruned region not in `preserve_set`. Does not touch beliefs or observations."""
    preserve = preserve_set or []
    dropped: list[Structure] = []
    pruned: list[PrunedRegion] = []
    now = datetime.now(UTC).isoformat()

    structures = memory_state.compression_risk.compressed_structures
    excess = len(structures) - MAX_COMPRESSED_STRUCTURES
    if excess > 0:
        dropped.extend(structures[:excess])
        del structures[:excess]

    for region in memory_state.compression_risk.pruned_regions:
        if region.id not in preserve:
            pruned.append(PrunedRegion(region.id, region.description, region.token_count, now))

    return CompressionResult(dropped=dropped, pruned=pruned)


# ── P6.6 — Journal retention + max_steps ─────────────────────────────────────


def apply_retention_policy(memory_state: MemoryState) -> None:
    """Compact memory_state.journal per its retention policy (TS applyJournalRetentionPolicy).

    Result order: retained failures, compressed older passing entries, recent passing entries verbatim. A failure is
    dropped when `retain_failures_permanently` is off.
    """
    policy = memory_state.journal_retention_policy
    failures: list[JournalEntry] = []
    passing: list[JournalEntry] = []
    for entry in memory_state.journal:
        if not entry.success and policy.retain_failures_permanently:
            failures.append(entry)
        elif entry.success:
            passing.append(entry)

    keep = policy.max_passing_verbatim
    recent = passing[-keep:] if keep > 0 else []
    compressed_older: list[JournalEntry] = []
    if policy.compress_older_passing and len(passing) > keep:
        older = passing[:-keep] if keep > 0 else passing
        compressed_older = [JournalEntry(e.step, e.action_class, e.outcome, e.success) for e in older]

    memory_state.journal = [*failures, *compressed_older, *recent]


def context_compression(
    memory_state: MemoryState,
    world_model: Any,
    belief_dep_graph: Any,
    dep_graph_budget: Any,
    hypothesis_set: Any = None,
    task_graph: Any = None,
    diagnostics: Any = None,
    control_state: Any = None,
    caller_state: Any = None,
) -> None:
    """Per-iteration memory upkeep (TS contextCompression): compress under pressure, sweep stale beliefs,
    decay dependency-graph edges, apply the journal retention policy."""
    from .belief_graph import apply_decay
    from .staleness import staleness_sweep

    if should_compress(memory_state):
        preserve = [
            "worldModel",
            "beliefDepGraph",
            "hypothesisSet",
            "taskGraph",
            "diagnostics",
            "controlState",
            "callerState",
        ]
        result = compress_memory(memory_state, preserve)
        memory_state.compression_risk.compressed_structures.extend(result.dropped)
        memory_state.compression_risk.pruned_regions.extend(result.pruned)

    staleness_sweep(world_model, world_model.environment_change_log)
    apply_decay(belief_dep_graph, dep_graph_budget)
    apply_retention_policy(memory_state)


def check_max_steps(
    step_count: int,
    memory_state: MemoryState,
    diagnostics: Any,
) -> Literal["ok", "warn", "escalate"]:
    """Budget status. From `floor(0.8 * max_steps)` steps on, verification_health.feasibility is capped at
    BUDGET_WARNING_FLOOR (TS harness-runtime). Callers must escalate on 'escalate'."""
    max_steps = memory_state.max_steps

    if step_count >= max_steps:
        return "escalate"

    if step_count >= int(0.8 * max_steps):
        vh = getattr(diagnostics, "verification_health", None)
        if vh is not None:
            vh.feasibility = min(vh.feasibility, BUDGET_WARNING_FLOOR)
        return "warn"

    return "ok"
