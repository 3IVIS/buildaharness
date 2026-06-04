"""
Its Harness — reasoning and control architecture modules.

Phase 0 exports: core data structures and staleness infrastructure.
Phase 1 exports: evidence data model, tool reliability envelopes,
                 tool availability manifest, hypothesis generation and
                 elimination, canvas node compilers.
Phase 2 exports: belief dependency graph, belief propagation, contradiction
                 detection and resolution, staleness sweep, world model ops.
Phase 3 exports: diagnostic health vectors, normalisation contract,
                 ControlState, resolve_control_state, deadlock detection,
                 full gate implementations, main loop skeleton.
Phase 4 exports: task graph (P4.1), conflict probability cache (P4.2),
                 parallel branch merge (P4.3), abstraction fit check (P4.4).
"""

from .belief_graph import (
    BeliefDepGraph,
    BeliefEdge,
    DepGraphBudget,
    apply_decay,
    compute_dep_graph_quality,
    propagate_beliefs,
    propagate_single_update,
)
from .caller_state import CallerState, inject_clarification, reset_constraints_changed
from .contradiction import (
    apply_resolution_policy,
    assign_system_breaking_severity,
    detect_abstraction_contradictions,
    detect_contradictions,
    detect_pairwise_contradictions,
    detect_set_level_contradictions,
    detect_temporal_contradictions,
)
from .control_state import (
    BlockEntry,
    ControlState,
    RiskState,
    compute_elevation_factor,
    detect_deadlock,
    resolve_control_state,
)
from .diagnostics import (
    BeliefHealth,
    CoverageHealth,
    Diagnostics,
    DimensionType,
    ExecutionHealth,
    NormalisationError,
    VerificationHealth,
    assert_normalised,
    normalise,
    normalise_entropy,
    update_diagnostics,
)
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
from .loop import run_one_iteration, select_best_action
from .output_contract import (
    ContractCheckResult,
    OutputContract,
    contract_shadow_check,
    validate_output_contract,
)
from .parallel_merge import merge_world_models, reconcile_parallel_branches
from .staleness import assert_generation_fresh, increment_generation_id, staleness_check, staleness_sweep
from .state_store import HarnessRunState
from .task_graph import (
    ConflictProbabilityCache,
    Task,
    TaskGraph,
    TaskRisk,
    TaskStatus,
    check_abstraction_alignment,
    compute_initial_conflict_probabilities,
    record_actual_overlap,
    select_unblocked_leaf,
    should_use_pessimistic_blocking,
    update_from_experience_store,
    validate_task_graph,
)
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
from .world_model_ops import integrate_evidence, recompute_belief_health

__all__ = [
    "TOOL_RELIABILITY_ENVELOPES",
    "Belief",
    "BeliefDepGraph",
    "BeliefEdge",
    "BeliefHealth",
    "BlockEntry",
    "CallerState",
    "ConflictProbabilityCache",
    "ContractCheckResult",
    "Contradiction",
    "ControlState",
    "CoverageHealth",
    "DepGraphBudget",
    "Diagnostics",
    "DimensionType",
    "EliminationPolicy",
    "EliminationRecord",
    "Evidence",
    "EvidenceStore",
    "EvidenceType",
    "ExecutionHealth",
    "FrozenManifestError",
    "HarnessRunState",
    "Hypothesis",
    "HypothesisSet",
    "NormalisationError",
    "Observation",
    "OutputContract",
    "ReliabilityClass",
    "RiskState",
    "StalenessError",
    "Task",
    "TaskGraph",
    "TaskRisk",
    "TaskStatus",
    "ToolAvailabilityManifest",
    "ToolEntry",
    "ToolEnvelope",
    "VerificationHealth",
    "WorldModel",
    "action_gate",
    "analogy_based_generation",
    "apply_decay",
    "apply_resolution_policy",
    "apply_tool_reliability_envelope",
    "assert_generation_fresh",
    "assert_normalised",
    "assign_system_breaking_severity",
    "build_manifest",
    "check_abstraction_alignment",
    "check_contradicting_evidence",
    "check_posterior_floor",
    "check_prediction_failure",
    "compute_dep_graph_quality",
    "compute_diversity_score",
    "compute_elevation_factor",
    "compute_initial_conflict_probabilities",
    "contract_shadow_check",
    "counterfactual_reasoning",
    "decomposition_gate",
    "detect_abstraction_contradictions",
    "detect_contradictions",
    "detect_deadlock",
    "detect_pairwise_contradictions",
    "detect_set_level_contradictions",
    "detect_temporal_contradictions",
    "eliminate",
    "enforce_diversity",
    "failure_mode_library_contribution",
    "generate_hypotheses",
    "get_envelope",
    "increment_generation_id",
    "inject_clarification",
    "integrate_evidence",
    "merge_world_models",
    "normalise",
    "normalise_entropy",
    "post_exec_gate",
    "propagate_beliefs",
    "propagate_single_update",
    "recompute_belief_health",
    "reconcile_parallel_branches",
    "record_actual_overlap",
    "reset_constraints_changed",
    "resolve_control_state",
    "run_one_iteration",
    "select_best_action",
    "select_unblocked_leaf",
    "should_use_pessimistic_blocking",
    "staleness_check",
    "staleness_sweep",
    "symptom_inference",
    "update_diagnostics",
    "update_from_experience_store",
    "validate_output_contract",
    "validate_task_graph",
]
