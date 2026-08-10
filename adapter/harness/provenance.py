"""
Versioned identity model — Phase 1a of plans/harness_and_assistant_architecture_remediation_plan.html.

Answers the critique's "who is authoritative for what" / "stale state should be a graph
property, not a counter convention" concerns without changing WorldModel.generation_id's
underlying representation (still a plain monotonically-increasing int — see that field's
own docstring for why changing its type wasn't necessary to satisfy this).

Instead, PlanVersion/ExecutionVersion/VerificationVersion are new, additive types that each
*pin* the WorldModel generation_id they were computed against — "Plan P7 requires WorldModel
W12", "Execution E9 executed Plan P7", "Verification V4 verified Execution E9", using the
critique's own example. Each exposes a `generation_id` property so the existing
`staleness_check()`/`assert_generation_fresh()` in staleness.py work against them unchanged —
the same staleness predicate already used for ControlState now applies uniformly to plans,
executions, and verifications.

ExecutionVersion additionally carries execution_id/step_id/attempt_id/effect_id so a retried
or duplicated attempt is idempotently attributable — consumed by Phase 1b's execution boundary
and Phase 2's recovery budget, not fully threaded through the harness yet in this phase.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

# WorldModelVersion is documentation, not a distinct runtime type: every
# WorldModel.generation_id value already *is* a WorldModelVersion. Introducing a
# wrapper class here would mean changing WorldModel's field type and, with it, every
# direct int increment/comparison across staleness.py/control_state.py/loop.py/
# langfuse_tracing.py — none of which need to change to satisfy the actual ask (a
# queryable Plan/Execution/Verification → WorldModel version relationship).
WorldModelVersion = int


def generate_id(prefix: str) -> str:
    """A short, prefixed unique id — `f"{prefix}-{uuid4().hex[:12]}"` — used for every
    id field below. Prefixed so a bare log line or trace attribute is self-describing
    (e.g. "exec-3f9a2b1c4d5e" vs "attempt-3f9a2b1c4d5e") without needing to carry its
    field name alongside it."""
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


@dataclass(frozen=True)
class PlanVersion:
    """Pins a plan to the WorldModel generation it was computed against."""

    plan_id: str
    world_model_version: WorldModelVersion

    @property
    def generation_id(self) -> int:
        """Alias so staleness_check()/assert_generation_fresh() accept a PlanVersion
        exactly like a ControlState — both simply expose `.generation_id`."""
        return self.world_model_version

    def to_dict(self) -> dict[str, Any]:
        return {"plan_id": self.plan_id, "world_model_version": self.world_model_version}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> PlanVersion:
        return cls(plan_id=d["plan_id"], world_model_version=d["world_model_version"])


@dataclass(frozen=True)
class ExecutionVersion:
    """Pins one execution attempt to the WorldModel generation and (optional) plan it
    executed against, with an idempotent identity: two ExecutionVersions sharing the same
    effect_id represent the same externally-visible side effect, even across retries."""

    execution_id: str
    step_id: str
    attempt_id: str
    effect_id: str
    world_model_version: WorldModelVersion
    plan_id: str | None = None

    @property
    def generation_id(self) -> int:
        return self.world_model_version

    def to_dict(self) -> dict[str, Any]:
        return {
            "execution_id": self.execution_id,
            "step_id": self.step_id,
            "attempt_id": self.attempt_id,
            "effect_id": self.effect_id,
            "world_model_version": self.world_model_version,
            "plan_id": self.plan_id,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ExecutionVersion:
        return cls(
            execution_id=d["execution_id"],
            step_id=d["step_id"],
            attempt_id=d["attempt_id"],
            effect_id=d["effect_id"],
            world_model_version=d["world_model_version"],
            plan_id=d.get("plan_id"),
        )


@dataclass(frozen=True)
class VerificationVersion:
    """Pins a verification result to the execution it verified and the WorldModel
    generation current at verification time (which may have advanced past the
    execution's own world_model_version — that drift is exactly what staleness_check()
    against this object detects)."""

    verification_id: str
    execution_id: str
    world_model_version: WorldModelVersion

    @property
    def generation_id(self) -> int:
        return self.world_model_version

    def to_dict(self) -> dict[str, Any]:
        return {
            "verification_id": self.verification_id,
            "execution_id": self.execution_id,
            "world_model_version": self.world_model_version,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> VerificationVersion:
        return cls(
            verification_id=d["verification_id"],
            execution_id=d["execution_id"],
            world_model_version=d["world_model_version"],
        )


def new_plan_version(world_model: Any, plan_id: str | None = None) -> PlanVersion:
    return PlanVersion(
        plan_id=plan_id or generate_id("plan"),
        world_model_version=world_model.generation_id,
    )


def new_execution_version(
    world_model: Any,
    plan_id: str | None = None,
    step_id: str | None = None,
    attempt_id: str | None = None,
    effect_id: str | None = None,
) -> ExecutionVersion:
    """attempt_id/effect_id default to fresh ids (a first attempt at a new effect). A
    retry of the same step passes the prior call's effect_id back in so the two
    ExecutionVersions share it — that shared effect_id is the idempotency key Phase 1b's
    execution boundary uses to recognize "this side effect already happened once"."""
    return ExecutionVersion(
        execution_id=generate_id("exec"),
        step_id=step_id or generate_id("step"),
        attempt_id=attempt_id or generate_id("attempt"),
        effect_id=effect_id or generate_id("effect"),
        world_model_version=world_model.generation_id,
        plan_id=plan_id,
    )


def new_verification_version(world_model: Any, execution_id: str) -> VerificationVersion:
    return VerificationVersion(
        verification_id=generate_id("verify"),
        execution_id=execution_id,
        world_model_version=world_model.generation_id,
    )
