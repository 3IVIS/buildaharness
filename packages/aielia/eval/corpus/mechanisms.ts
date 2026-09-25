/**
 * Layer-mechanism registry (AL1a of plans/adaptive_layer_selection_plan.html).
 *
 * One entry per layer / escalation the adaptive-selection plan reasons about, in the order
 * `docs/layer_mechanisms.md` documents them. `corpus.test.ts` asserts the doc has a section for
 * every id here with a hypothesised regime and a target metric — a layer with none is a spec defect.
 * A stress task's `mechanism` field must be one of these ids.
 */
export const LAYER_CLASSES = ['floor', 'escalation', 'event', 'presentation', 'verification_sublayer', 'supervisor_directive'] as const
export type LayerClass = (typeof LAYER_CLASSES)[number]

export const MECHANISMS = [
  // Floor (always on — the spec still says when each *matters*, for the corpus)
  { id: 'control_state', cls: 'floor' },
  { id: 'approval_staging', cls: 'floor' },
  { id: 'tool_policy', cls: 'floor' },
  { id: 'diagnostics', cls: 'floor' },
  { id: 'hypothesis', cls: 'floor' },
  { id: 'verification', cls: 'floor' },
  // Escalations (policy-controlled, LLM-backed) + memory
  { id: 'memory_recall', cls: 'escalation' },
  { id: 'model_inferred_facts', cls: 'escalation' },
  { id: 'semantic_contradiction', cls: 'escalation' },
  { id: 'failure_match', cls: 'escalation' },
  { id: 'criterion_coverage', cls: 'escalation' },
  { id: 'change_review', cls: 'escalation' },
  { id: 'injection_detection', cls: 'escalation' },
  { id: 'decomposition_reframe', cls: 'escalation' },
  { id: 'reviewer_adversarial_lens', cls: 'escalation' },
  // Event-triggered
  { id: 'supervisor', cls: 'event' },
  // Presentation
  { id: 'next_step_options', cls: 'presentation' },
  { id: 'goal_graph', cls: 'presentation' },
  { id: 'steering', cls: 'presentation' },
  // Verification's nine sub-layers
  { id: 'verification_syntax', cls: 'verification_sublayer' },
  { id: 'verification_unit', cls: 'verification_sublayer' },
  { id: 'verification_integration', cls: 'verification_sublayer' },
  { id: 'verification_consistency', cls: 'verification_sublayer' },
  { id: 'verification_requirements', cls: 'verification_sublayer' },
  { id: 'verification_assumptions', cls: 'verification_sublayer' },
  { id: 'verification_goal_correctness', cls: 'verification_sublayer' },
  { id: 'verification_evidence_sufficiency', cls: 'verification_sublayer' },
  { id: 'verification_output_contract_partial', cls: 'verification_sublayer' },
  // Each non-default supervisor directive (CONTINUE is the fail-safe default, not a mechanism)
  { id: 'supervisor_redirect_strategy', cls: 'supervisor_directive' },
  { id: 'supervisor_reframe_plan', cls: 'supervisor_directive' },
  { id: 'supervisor_gather_evidence', cls: 'supervisor_directive' },
  { id: 'supervisor_ask_user', cls: 'supervisor_directive' },
  { id: 'supervisor_abort', cls: 'supervisor_directive' },
] as const

export type MechanismId = (typeof MECHANISMS)[number]['id']
export const MECHANISM_IDS = MECHANISMS.map((m) => m.id) as unknown as readonly [MechanismId, ...MechanismId[]]

/**
 * The layer each feature-audit slice targets. `AUDIT_SLICES` entries map to their mechanism so a
 * slice-tagged task without an explicit `mechanism` still resolves to one.
 */
export const AUDIT_SLICE_MECHANISM: Record<string, MechanismId> = {
  audit_contradiction_semantic: 'semantic_contradiction',
  audit_injection_llm: 'injection_detection',
  audit_failure_match_semantic: 'failure_match',
  audit_contradiction_multiturn: 'semantic_contradiction',
  audit_criterion_coverage: 'criterion_coverage',
  audit_change_review: 'change_review',
  audit_model_inferred_facts: 'model_inferred_facts',
  audit_decomposition: 'decomposition_reframe',
  audit_decomposition_multistep: 'decomposition_reframe',
  audit_verification: 'verification',
  audit_reviewer_pass: 'reviewer_adversarial_lens',
  probe_contradiction: 'semantic_contradiction',
  probe_belief_trail: 'semantic_contradiction',
  probe_change_review: 'change_review',
  probe_model_inferred_facts: 'model_inferred_facts',
  probe_verification: 'verification',
  probe_reviewer: 'reviewer_adversarial_lens',
  probe_criterion_coverage: 'criterion_coverage',
  probe_decomposition: 'decomposition_reframe',
  probe_failure_match: 'failure_match',
  probe_supervisor: 'supervisor',
  probe_injection: 'injection_detection',
  probe_evidence: 'verification_evidence_sufficiency',
}
