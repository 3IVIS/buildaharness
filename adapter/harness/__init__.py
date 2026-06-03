"""
Its Harness — reasoning and control architecture modules.

Phase 0 exports: core data structures and staleness infrastructure.
Phase 1 exports: evidence data model, tool reliability envelopes,
                 tool availability manifest, hypothesis generation and
                 elimination, canvas node compilers.
"""

from .caller_state import CallerState, inject_clarification, reset_constraints_changed
from .evidence import Evidence, EvidenceStore, EvidenceType, ReliabilityClass
from .gates import StalenessError, action_gate, decomposition_gate, post_exec_gate
from .hypothesis import (
    EliminationPolicy,
    EliminationRecord,
    Hypothesis,
    HypothesisSet,
    analogy_based_generation,
    check_contradicting_evidence,
    check_posterior_floor,
    check_prediction_failure,
    compute_diversity_score,
    counterfactual_reasoning,
    eliminate,
    enforce_diversity,
    failure_mode_library_contribution,
    generate_hypotheses,
    symptom_inference,
)
from .output_contract import (
    ContractCheckResult,
    OutputContract,
    contract_shadow_check,
    validate_output_contract,
)
from .staleness import assert_generation_fresh, increment_generation_id, staleness_check
from .state_store import HarnessRunState
from .tool_manifest import (
    FrozenManifestError,
    ToolAvailabilityManifest,
    ToolEntry,
    build_manifest,
)
from .tool_reliability import (
    TOOL_RELIABILITY_ENVELOPES,
    ToolEnvelope,
    apply_tool_reliability_envelope,
    get_envelope,
)
from .world_model import Belief, Contradiction, Observation, WorldModel

__all__ = [
    # P0
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
    # P1.1
    "Evidence",
    "EvidenceStore",
    "EvidenceType",
    "ReliabilityClass",
    # P1.2
    "TOOL_RELIABILITY_ENVELOPES",
    "ToolEnvelope",
    "apply_tool_reliability_envelope",
    "get_envelope",
    # P1.3
    "FrozenManifestError",
    "ToolAvailabilityManifest",
    "ToolEntry",
    "build_manifest",
    # P1.6 + P1.7
    "EliminationPolicy",
    "EliminationRecord",
    "Hypothesis",
    "HypothesisSet",
    "analogy_based_generation",
    "check_contradicting_evidence",
    "check_posterior_floor",
    "check_prediction_failure",
    "compute_diversity_score",
    "counterfactual_reasoning",
    "eliminate",
    "enforce_diversity",
    "failure_mode_library_contribution",
    "generate_hypotheses",
    "symptom_inference",
]
