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

from .caller_state import CallerState
from .evidence import EvidenceStore
from .hypothesis import HypothesisSet
from .output_contract import OutputContract
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

    # Phases P2–P9 — stored as raw dicts until typed dataclasses are added
    task_graph: dict[str, Any] = field(default_factory=dict)
    diagnostics: dict[str, Any] = field(default_factory=dict)
    control_state: dict[str, Any] = field(default_factory=dict)
    memory_state: dict[str, Any] = field(default_factory=dict)
    strategy_state: dict[str, Any] = field(default_factory=dict)
    failure_diagnostics: dict[str, Any] = field(default_factory=dict)
    experience_store_ref: dict[str, Any] = field(default_factory=dict)
    belief_dep_graph: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "world_model": self.world_model.to_dict(),
            "caller_state": self.caller_state.to_dict(),
            "output_contract": self.output_contract.to_dict(),
            "evidence_store": self.evidence_store.to_dict(),
            "hypothesis_set": self.hypothesis_set.to_dict(),
            "task_graph": self.task_graph,
            "diagnostics": self.diagnostics,
            "control_state": self.control_state,
            "memory_state": self.memory_state,
            "strategy_state": self.strategy_state,
            "failure_diagnostics": self.failure_diagnostics,
            "experience_store_ref": self.experience_store_ref,
            "belief_dep_graph": self.belief_dep_graph,
        }

    @classmethod
    def from_dict(cls, run_id: str, d: dict[str, Any]) -> HarnessRunState:
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
            task_graph=d.get("task_graph") or {},
            diagnostics=d.get("diagnostics") or {},
            control_state=d.get("control_state") or {},
            memory_state=d.get("memory_state") or {},
            strategy_state=d.get("strategy_state") or {},
            failure_diagnostics=d.get("failure_diagnostics") or {},
            experience_store_ref=d.get("experience_store_ref") or {},
            belief_dep_graph=d.get("belief_dep_graph") or {},
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
                belief_dep_graph
            ) VALUES (
                :run_id, :world_model, :caller_state, :output_contract,
                :hypothesis_set, :evidence_store, :task_graph,
                :diagnostics, :control_state, :memory_state,
                :strategy_state, :failure_diagnostics, :experience_store_ref,
                :belief_dep_graph
            )
            ON CONFLICT (run_id) DO UPDATE SET
                world_model          = EXCLUDED.world_model,
                caller_state         = EXCLUDED.caller_state,
                output_contract      = EXCLUDED.output_contract,
                hypothesis_set       = EXCLUDED.hypothesis_set,
                evidence_store       = EXCLUDED.evidence_store,
                task_graph           = EXCLUDED.task_graph,
                diagnostics          = EXCLUDED.diagnostics,
                control_state        = EXCLUDED.control_state,
                memory_state         = EXCLUDED.memory_state,
                strategy_state       = EXCLUDED.strategy_state,
                failure_diagnostics  = EXCLUDED.failure_diagnostics,
                experience_store_ref = EXCLUDED.experience_store_ref,
                belief_dep_graph     = EXCLUDED.belief_dep_graph,
                updated_at           = CURRENT_TIMESTAMP
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
