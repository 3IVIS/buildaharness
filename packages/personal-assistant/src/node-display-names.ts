// Maps internal HarnessRuntime node identifiers (packages/harness/src/*.ts
// `nodeExecutionOrder.push(...)` call sites) to short human-readable status
// copy, so step-progress UI reads as prose instead of a debug log.
const NODE_DISPLAY_NAMES: Record<string, string> = {
  select_task: 'Selecting task',
  gather_evidence: 'Gathering evidence',
  apply_tool_reliability: 'Weighing tool reliability',
  generate_update_hypotheses: 'Generating hypotheses',
  detect_contradictions: 'Checking for contradictions',
  update_world_model_post_exec: 'Updating world model',
  update_diagnostics: 'Updating diagnostics',
  update_diagnostics_post_exec: 'Updating diagnostics',
  resolve_control_state: 'Resolving control state',
  resolve_control_state_b: 'Resolving control state',
  estimate_risk: 'Estimating risk',
  estimate_voi: 'Estimating value of information',
  action_gate: 'Checking action gate',
  execute: 'Executing',
  post_exec_gate: 'Checking post-execution gate',
  verify: 'Verifying result',
  update_task_graph: 'Updating task graph',
  update_task_state: 'Updating task state',
  context_compression: 'Compressing context',
  check_caller_updates: 'Checking for updates',
  rollback_replan: 'Rolling back and replanning',
  review_proposed_change: 'Reviewing proposed change',
  reviewer_pass: 'Running reviewer pass',
  reviewer_pass_2: 'Running second reviewer pass',
  output_validation: 'Validating output',
}

export function nodeDisplayName(node: string | undefined): string | undefined {
  if (!node) return undefined
  return NODE_DISPLAY_NAMES[node] ?? node
}
