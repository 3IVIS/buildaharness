"""
DO NOT EDIT — generated from spec/harness-core.json by spec/gen-harness-core.mjs.
Run `node spec/gen-harness-core.mjs` after editing the source. CI fails if this file is stale.
See ADR-004 (shared semantic core, Phase C1).
"""

from __future__ import annotations

CRITICAL_THRESHOLD: float = 0.2
CAUTION_THRESHOLD: float = 0.4

RECOVERY_ACTION_DEPENDENCIES: dict[str, set[str]] = {
    "dep_graph_refresh": {"verification_strength"},
    "verification_pass": {"dep_graph_quality"},
    "belief_refresh": {"verification_feasibility"},
    "coverage_expand": {"verification_strength"},
    "execution_retry": {"dep_graph_quality"},
    "oscillation_stabilise": {"belief_freshness"},
    "failure_recovery": {"dep_graph_quality"},
    "consistency_repair": {"verification_strength"},
    "support_augment": {"belief_freshness"},
    "feasibility_check": {"dep_graph_quality"},
    "explanation_expand": {"belief_freshness"},
}

DIMENSION_RECOVERY: dict[str, str] = {
    "belief_freshness": "belief_refresh",
    "belief_consistency": "consistency_repair",
    "belief_support": "support_augment",
    "symptom_coverage": "coverage_expand",
    "explanation_coverage": "explanation_expand",
    "verification_strength": "verification_pass",
    "verification_feasibility": "feasibility_check",
    "progress_rate": "execution_retry",
    "failure_recurrence": "failure_recovery",
    "oscillation_score": "oscillation_stabilise",
    "dep_graph_quality": "dep_graph_refresh",
    "world_model_integrity": "consistency_repair",
}

SUB_DIMENSION_ORDER: tuple[str, ...] = (
    "belief_freshness",
    "belief_consistency",
    "belief_support",
    "symptom_coverage",
    "explanation_coverage",
    "verification_strength",
    "verification_feasibility",
    "progress_rate",
    "failure_recurrence",
    "oscillation_score",
)

CONFIDENCE_DIMENSIONS: frozenset[str] = frozenset(
    {"belief_freshness", "belief_consistency", "belief_support", "symptom_coverage", "explanation_coverage"}
)
RISK_DIMENSIONS: frozenset[str] = frozenset(
    {"verification_strength", "verification_feasibility", "progress_rate", "failure_recurrence", "oscillation_score"}
)

LAYER_TIER: dict[str, str] = {
    "syntax": "mechanical",
    "unit": "mechanical",
    "integration": "mechanical",
    "consistency": "mechanical",
    "requirements": "environmental",
    "assumptions": "environmental",
    "goal_correctness": "model",
    "evidence_sufficiency": "environmental",
    "output_contract_partial": "mechanical",
}

DEP_CLASS_GAP_NOTE_PREFIX: str = "dep_class_gap: "

MODEL_PROVENANCE_NOTE_PREFIX: str = "provenance: uncalibrated model-derived value drove block on "

RECOVERY_CLASSIFICATION_TABLE: dict[str, dict[str, str]] = {
    "timeout": {"policy": "retry_with_backoff", "action": "execution_retry"},
    "transient_tool_error": {"policy": "retry_with_backoff", "action": "execution_retry"},
    "missing_evidence": {"policy": "gather_evidence", "action": "coverage_expand"},
    "insufficient_context": {"policy": "gather_evidence", "action": "belief_refresh"},
    "permission_denied": {"policy": "surface_to_human", "action": "escalate"},
    "approval_required": {"policy": "surface_to_human", "action": "escalate"},
    "unsafe_state": {"policy": "terminate_objective", "action": "escalation_halt"},
    "system_breaking": {"policy": "terminate_objective", "action": "escalation_halt"},
    "tool_unreliable": {"policy": "switch_method", "action": "dep_graph_refresh"},
    "contradiction": {"policy": "refresh_beliefs", "action": "consistency_repair"},
    "stall": {"policy": "replan", "action": "replan"},
    "no_progress": {"policy": "replan", "action": "replan"},
}
