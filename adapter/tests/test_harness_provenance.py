"""
Tests for provenance.py — versioned identity model (Phase 1a of
plans/harness_and_assistant_architecture_remediation_plan.html).

Covers PlanVersion/ExecutionVersion/VerificationVersion's world_model_version pinning,
their staleness_check()/is_stale() compatibility (via the shared `.generation_id`
property), round-trip serialization, and ExecutionVersion's idempotent effect_id sharing
across retries.

Run with: pytest adapter/tests/test_harness_provenance.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.provenance import (
    ExecutionVersion,
    PlanVersion,
    VerificationVersion,
    generate_id,
    new_execution_version,
    new_plan_version,
    new_verification_version,
)
from harness.staleness import increment_generation_id, is_stale, staleness_check
from harness.world_model import WorldModel


def _wm(generation_id: int = 0) -> WorldModel:
    return WorldModel(generation_id=generation_id)


# ── generate_id ─────────────────────────────────────────────────────────────────


def test_generate_id_is_prefixed_and_unique():
    a = generate_id("exec")
    b = generate_id("exec")
    assert a.startswith("exec-")
    assert b.startswith("exec-")
    assert a != b


# ── PlanVersion ──────────────────────────────────────────────────────────────────


def test_new_plan_version_pins_current_world_model_generation():
    wm = _wm(generation_id=5)
    plan = new_plan_version(wm)
    assert plan.world_model_version == 5
    assert plan.generation_id == 5  # alias
    assert plan.plan_id.startswith("plan-")


def test_new_plan_version_accepts_explicit_plan_id():
    wm = _wm()
    plan = new_plan_version(wm, plan_id="my-plan")
    assert plan.plan_id == "my-plan"


def test_plan_version_round_trips():
    plan = PlanVersion(plan_id="p1", world_model_version=3)
    restored = PlanVersion.from_dict(plan.to_dict())
    assert restored == plan


def test_plan_version_staleness_via_generation_id_alias():
    wm = _wm(generation_id=2)
    plan = new_plan_version(wm)
    assert staleness_check(plan, wm) is False
    increment_generation_id(wm)
    assert staleness_check(plan, wm) is True


# ── ExecutionVersion ─────────────────────────────────────────────────────────────


def test_new_execution_version_pins_current_generation_and_has_all_four_ids():
    wm = _wm(generation_id=7)
    ev = new_execution_version(wm, plan_id="p1")
    assert ev.world_model_version == 7
    assert ev.plan_id == "p1"
    for attr in ("execution_id", "step_id", "attempt_id", "effect_id"):
        value = getattr(ev, attr)
        assert isinstance(value, str) and value


def test_execution_version_defaults_produce_fresh_ids_each_call():
    wm = _wm()
    ev1 = new_execution_version(wm)
    ev2 = new_execution_version(wm)
    assert ev1.execution_id != ev2.execution_id
    assert ev1.attempt_id != ev2.attempt_id
    assert ev1.effect_id != ev2.effect_id


def test_execution_version_retry_shares_effect_id_for_idempotent_attribution():
    """A retry of the same step passes the prior effect_id back in — that's the
    idempotency key Phase 1b's execution boundary uses to recognize a repeated attempt
    as the same externally-visible side effect, not a new one."""
    wm = _wm()
    first_attempt = new_execution_version(wm, step_id="step-1")
    retry = new_execution_version(wm, step_id=first_attempt.step_id, effect_id=first_attempt.effect_id)

    assert retry.effect_id == first_attempt.effect_id
    assert retry.step_id == first_attempt.step_id
    assert retry.attempt_id != first_attempt.attempt_id  # distinct attempt...
    assert retry.execution_id != first_attempt.execution_id  # ...of the same effect


def test_execution_version_round_trips():
    ev = ExecutionVersion(
        execution_id="exec-1",
        step_id="step-1",
        attempt_id="attempt-1",
        effect_id="effect-1",
        world_model_version=4,
        plan_id="p1",
    )
    restored = ExecutionVersion.from_dict(ev.to_dict())
    assert restored == ev


def test_execution_version_staleness_via_is_stale():
    wm = _wm(generation_id=1)
    ev = new_execution_version(wm)
    assert is_stale(ev, wm) is False
    increment_generation_id(wm)
    assert is_stale(ev, wm) is True


# ── VerificationVersion ──────────────────────────────────────────────────────────


def test_new_verification_version_pins_current_generation_and_execution_id():
    wm = _wm(generation_id=9)
    verify = new_verification_version(wm, execution_id="exec-1")
    assert verify.world_model_version == 9
    assert verify.execution_id == "exec-1"
    assert verify.verification_id.startswith("verify-")


def test_verification_version_round_trips():
    v = VerificationVersion(verification_id="verify-1", execution_id="exec-1", world_model_version=2)
    restored = VerificationVersion.from_dict(v.to_dict())
    assert restored == v


def test_verification_version_can_be_pinned_later_than_its_execution():
    """A verification's world_model_version may have advanced past the execution's own —
    that drift is exactly what is_stale() against the VerificationVersion detects."""
    wm = _wm(generation_id=1)
    ev = new_execution_version(wm)
    increment_generation_id(wm)  # world model moves on before verification runs
    verify = new_verification_version(wm, execution_id=ev.execution_id)

    assert verify.world_model_version == 2
    assert is_stale(ev, wm) is True  # the execution's own pin is now stale...
    assert is_stale(verify, wm) is False  # ...but the verification, pinned fresh, is not
