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
    "Belief",
    "CallerState",
    "ContractCheckResult",
    "Contradiction",
    "HarnessRunState",
    "Observation",
    "OutputContract",
    "StalenessError",
    "WorldModel",
    "action_gate",
    "assert_generation_fresh",
    "contract_shadow_check",
    "decomposition_gate",
    "increment_generation_id",
    "inject_clarification",
    "post_exec_gate",
    "reset_constraints_changed",
    "staleness_check",
    "validate_output_contract",
]
