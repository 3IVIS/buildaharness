"""
Harness run state persistence — P0.6.

HarnessRunState is a Postgres-backed container holding all 13 harness
state structures per run. It enables pause/resume and cross-phase state
access. Non-harness flows do not use this module.

load() and save() are the only public entry points. Both are async and
accept an SQLAlchemy AsyncSession.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

from .belief_graph import BeliefDepGraph
from .caller_state import CallerState
from .control_state import ControlState
from .diagnostics import Diagnostics
from .evidence import EvidenceStore
from .experience_store import ExperienceStore
from .failure_modes import FailureDiagnostics
from .hypothesis import HypothesisSet
from .memory import MemoryState
from .output_contract import OutputContract
from .recovery import StrategyState
from .task_graph import TaskGraph
from .tool_manifest import ToolAvailabilityManifest
from .world_model import WorldModel


@dataclass
class HarnessRunState:
    """Container for all 13 harness state structures keyed by run_id.

    Fields that haven't been initialised yet default to empty dataclasses.
    Fields for phases not yet implemented (belief_dep_graph, diagnostics, etc.)
    are stored as raw dicts until their typed dataclasses are added in later
    phases.
    """

    run_id: str = ""

    # P0.2 — world model
    world_model: WorldModel = field(default_factory=WorldModel)

    # P0.4 — caller state
    caller_state: CallerState = field(default_factory=CallerState)

    # P0.5 — output contract
    output_contract: OutputContract = field(default_factory=OutputContract)

    # P1.1 — evidence store
    evidence_store: EvidenceStore = field(default_factory=EvidenceStore)

    # P1.3 — tool availability manifest (rebuilt at harness init, not persisted)
    tool_manifest: ToolAvailabilityManifest | None = None

    # P1.6 — hypothesis set
    hypothesis_set: HypothesisSet = field(default_factory=HypothesisSet)

    # P2.2 — typed belief dependency graph
    belief_dep_graph: BeliefDepGraph = field(default_factory=BeliefDepGraph)
    # P3.1 — typed diagnostics
    diagnostics: Diagnostics = field(default_factory=Diagnostics)
    # P3.3 — typed control state
    control_state: ControlState = field(default_factory=ControlState)
    # P4.1 — typed task graph
    task_graph: TaskGraph = field(default_factory=TaskGraph)
    # P6 — typed replacements for the raw-dict fields
    memory_state: MemoryState = field(default_factory=MemoryState)
    strategy_state: StrategyState = field(default_factory=StrategyState)
    failure_diagnostics: FailureDiagnostics = field(default_factory=FailureDiagnostics)
    # P8 — experience store (typed; None when no DB factory is configured)
    experience_store: ExperienceStore | None = None
    # P8 — softmax temperature for adaptive strategy selection (default 1.0)
    temperature: float = 1.0
    # P7 — escalation state
    escalation_pending: bool = False
    pending_escalation: Any | None = None  # SurfaceBlocker | None
    pending_clarification: dict[str, Any] | None = None
    # P-PC — process concept ID that seeded this run's task graph (None for model-driven runs)
    process_concept_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        # Persist a presence marker rather than the store contents — actual
        # experience data lives in its own tables and is not serialised here.
        experience_store_marker = {"configured": True} if self.experience_store is not None else {}
        return {
            "world_model": self.world_model.to_dict(),
            "caller_state": self.caller_state.to_dict(),
            "output_contract": self.output_contract.to_dict(),
            "evidence_store": self.evidence_store.to_dict(),
            "hypothesis_set": self.hypothesis_set.to_dict(),
            "belief_dep_graph": self.belief_dep_graph.to_dict(),
            "diagnostics": self.diagnostics.to_dict(),
            "control_state": self.control_state.to_dict(),
            "task_graph": self.task_graph.to_dict(),
            "memory_state": self.memory_state.to_dict(),
            "strategy_state": self.strategy_state.to_dict(),
            "failure_diagnostics": self.failure_diagnostics.to_dict(),
            "experience_store_ref": experience_store_marker,
            "escalation_pending": self.escalation_pending,
            "pending_escalation": self.pending_escalation.to_dict() if self.pending_escalation is not None else None,
            "pending_clarification": self.pending_clarification,
            "process_concept_id": self.process_concept_id,
        }

    @classmethod
    def from_dict(cls, run_id: str, d: dict[str, Any]) -> HarnessRunState:
        # experience_store cannot be reconstructed from the marker alone —
        # callers must re-attach a session factory after loading.
        return cls(
            run_id=run_id,
            world_model=WorldModel.from_dict(d.get("world_model") or {}),
            caller_state=CallerState.from_dict(d.get("caller_state") or {}),
            output_contract=OutputContract.from_dict(d.get("output_contract") or {}),
            evidence_store=EvidenceStore.from_dict(d.get("evidence_store") or {}),
            hypothesis_set=HypothesisSet.from_dict(d.get("hypothesis_set") or {}),
            # tool_manifest is always None on load — callers must call build_manifest()
            # on resume to reflect the current runtime environment.
            tool_manifest=None,
            belief_dep_graph=BeliefDepGraph.from_dict(d.get("belief_dep_graph") or {}),
            diagnostics=Diagnostics.from_dict(d.get("diagnostics") or {}),
            control_state=ControlState.from_dict(d.get("control_state") or {}),
            task_graph=TaskGraph.from_dict(d.get("task_graph") or {}),
            memory_state=MemoryState.from_dict(d.get("memory_state") or {}),
            strategy_state=StrategyState.from_dict(d.get("strategy_state") or {}),
            failure_diagnostics=FailureDiagnostics.from_dict(d.get("failure_diagnostics") or {}),
            experience_store=None,
            temperature=float(d.get("temperature", 1.0)),
            escalation_pending=d.get("escalation_pending", False),
            pending_escalation=_deserialise_surface_blocker(d.get("pending_escalation")),
            pending_clarification=d.get("pending_clarification"),
            process_concept_id=d.get("process_concept_id"),
        )


async def save(run_id: str, state: HarnessRunState, db: AsyncSession) -> None:
    """Upsert all 13 state structures for run_id into harness_run_state table."""
    from sqlalchemy import text

    data = state.to_dict()
    # Use a raw upsert so this works on both Postgres (production) and
    # SQLite (test suite). On Postgres the columns are JSONB; on SQLite TEXT.
    await db.execute(
        text(
            """
            INSERT INTO harness_run_state (
                run_id, world_model, caller_state, output_contract,
                hypothesis_set, evidence_store, task_graph,
                diagnostics, control_state, memory_state,
                strategy_state, failure_diagnostics, experience_store_ref,
                belief_dep_graph,
                escalation_pending, pending_escalation, pending_clarification
            ) VALUES (
                :run_id, :world_model, :caller_state, :output_contract,
                :hypothesis_set, :evidence_store, :task_graph,
                :diagnostics, :control_state, :memory_state,
                :strategy_state, :failure_diagnostics, :experience_store_ref,
                :belief_dep_graph,
                :escalation_pending, :pending_escalation, :pending_clarification
            )
            ON CONFLICT (run_id) DO UPDATE SET
                world_model            = EXCLUDED.world_model,
                caller_state           = EXCLUDED.caller_state,
                output_contract        = EXCLUDED.output_contract,
                hypothesis_set         = EXCLUDED.hypothesis_set,
                evidence_store         = EXCLUDED.evidence_store,
                task_graph             = EXCLUDED.task_graph,
                diagnostics            = EXCLUDED.diagnostics,
                control_state          = EXCLUDED.control_state,
                memory_state           = EXCLUDED.memory_state,
                strategy_state         = EXCLUDED.strategy_state,
                failure_diagnostics    = EXCLUDED.failure_diagnostics,
                experience_store_ref   = EXCLUDED.experience_store_ref,
                belief_dep_graph       = EXCLUDED.belief_dep_graph,
                escalation_pending     = EXCLUDED.escalation_pending,
                pending_escalation     = EXCLUDED.pending_escalation,
                pending_clarification  = EXCLUDED.pending_clarification,
                updated_at             = CURRENT_TIMESTAMP
            """
        ),
        {
            "run_id": run_id,
            **{k: _serialise(v) for k, v in data.items()},
        },
    )
    # Mark the job as a harness run so the API 404-guard works
    await db.execute(
        text("UPDATE jobs SET is_harness_run = TRUE WHERE id = :run_id"),
        {"run_id": run_id},
    )
    await db.commit()


async def load(run_id: str, db: AsyncSession) -> HarnessRunState | None:
    """Load state for run_id. Returns None if no harness state exists for this run."""
    from sqlalchemy import text

    row = (
        (
            await db.execute(
                text("SELECT * FROM harness_run_state WHERE run_id = :run_id"),
                {"run_id": run_id},
            )
        )
        .mappings()
        .first()
    )

    if row is None:
        return None

    return HarnessRunState.from_dict(run_id, {k: _deserialise(row[k]) for k in row.keys() if k != "run_id"})


def _deserialise_surface_blocker(data: Any) -> Any:
    """Deserialise a persisted SurfaceBlocker dict back to a SurfaceBlocker, or None."""
    if not data:
        return None
    try:
        from .escalation import SurfaceBlocker

        return SurfaceBlocker.from_dict(data)
    except Exception:
        return None


def _serialise(value: Any) -> Any:
    """Convert a value for storage. Postgres JSONB handles dicts natively; SQLite needs JSON strings."""
    import json

    if isinstance(value, dict):
        return json.dumps(value)
    return value


def _deserialise(value: Any) -> Any:
    """Deserialise a stored value. Postgres JSONB returns dicts; SQLite returns JSON strings."""
    import json

    if isinstance(value, str):
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return value
    return value or {}
