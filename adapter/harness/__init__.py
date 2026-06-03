"""
Its Harness — reasoning and control architecture modules.

Phase 0 exports: core data structures and staleness infrastructure.
Subsequent phases add diagnostic, control-state, and execution modules.
"""

from .caller_state import CallerState, inject_clarification, reset_constraints_changed
from .gates import StalenessError, action_gate, decomposition_gate, post_exec_gate
from .output_contract import (
    ContractCheckResult,
    OutputContract,
    contract_shadow_check,
    validate_output_contract,
)
from .staleness import assert_generation_fresh, increment_generation_id, staleness_check
from .state_store import HarnessRunState
from .world_model import Belief, Contradiction, Observation, WorldModel

__all__ = [
    "Observation",
    "Belief",
    "Contradiction",
    "WorldModel",
    "increment_generation_id",
    "staleness_check",
    "assert_generation_fresh",
    "StalenessError",
    "decomposition_gate",
    "action_gate",
    "post_exec_gate",
    "CallerState",
    "inject_clarification",
    "reset_constraints_changed",
    "OutputContract",
    "ContractCheckResult",
    "validate_output_contract",
    "contract_shadow_check",
    "HarnessRunState",
]
