import type { LayerActivityEvent } from '@buildaharness/harness'

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

/**
 * The 11 harness layer slugs, in the fixed order CLAUDE.md's architecture table lists them —
 * used by both the CLI's `/layers` and chat-ui's layer grid to render a stable 2-3 letter
 * code per layer (Phase 3.3 of the harness layer activation plan). Matches the `layer` field
 * on the `layer_activity` TraceEvent (see trace-events.ts) and HarnessRunOptions'
 * LayerActivityEvent (see @buildaharness/harness).
 */
export const LAYER_ORDER = [
  'world_model', 'evidence_reasoning', 'hypothesis', 'contradiction', 'diagnostics',
  'control_state', 'planning', 'execution', 'verification', 'recovery', 'reviewer_pass',
] as const

export type LayerSlug = (typeof LAYER_ORDER)[number]

export const LAYER_DISPLAY_NAME: Record<LayerSlug, string> = {
  world_model: 'World Model',
  evidence_reasoning: 'Evidence & Reasoning',
  hypothesis: 'Hypothesis',
  contradiction: 'Contradiction',
  diagnostics: 'Diagnostics',
  control_state: 'Control State',
  planning: 'Planning',
  execution: 'Execution',
  verification: 'Verification',
  recovery: 'Recovery',
  reviewer_pass: 'Reviewer Pass',
}

export const LAYER_SHORT_CODE: Record<LayerSlug, string> = {
  world_model: 'WM',
  evidence_reasoning: 'EV',
  hypothesis: 'HY',
  contradiction: 'CT',
  diagnostics: 'DG',
  control_state: 'CS',
  planning: 'PL',
  execution: 'EX',
  verification: 'VF',
  recovery: 'RC',
  reviewer_pass: 'RV',
}

/**
 * Collapses the harness's ~25 individual node ids down to the 11 layers from CLAUDE.md's
 * architecture table — `context_compression`, `check_caller_updates`, `update_task_state`, and
 * `output_validation` are loop scaffolding, not one of the 11, and deliberately map to nothing.
 */
const NODE_TO_LAYER: Record<string, LayerSlug> = {
  update_world_model_post_exec: 'world_model',
  gather_evidence: 'evidence_reasoning',
  apply_tool_reliability: 'evidence_reasoning',
  generate_update_hypotheses: 'hypothesis',
  detect_contradictions: 'contradiction',
  update_diagnostics: 'diagnostics',
  update_diagnostics_post_exec: 'diagnostics',
  resolve_control_state: 'control_state',
  resolve_control_state_b: 'control_state',
  update_task_graph: 'planning',
  select_task: 'planning',
  estimate_risk: 'execution',
  estimate_voi: 'execution',
  review_proposed_change: 'execution',
  action_gate: 'execution',
  execute: 'execution',
  verify: 'verification',
  post_exec_gate: 'verification',
  rollback_replan: 'recovery',
  reviewer_pass: 'reviewer_pass',
  reviewer_pass_2: 'reviewer_pass',
}

export function nodeToLayer(node: string | undefined): LayerSlug | undefined {
  if (!node) return undefined
  return NODE_TO_LAYER[node]
}

export interface WhyChainItem {
  layer: LayerSlug
  reason: string
}

/**
 * Collapses a turn's raw layerActivity (one event per layer per main-loop iteration — see
 * harness-runtime.ts's onLayerActivity doc comment) down to just the layers that fired, in the
 * order they fired, merging consecutive re-fires of the same layer (back-to-back loop
 * iterations) into a single link. Shared by the CLI's `/why` and chat-ui's "Why?" panel so both
 * surfaces summarize a turn identically instead of drifting apart.
 */
export function buildWhyChain(layerActivity: LayerActivityEvent[]): WhyChainItem[] {
  const chain: WhyChainItem[] = []
  for (const event of layerActivity) {
    if (!event.fired) continue
    if (chain.at(-1)?.layer === event.layer) continue
    chain.push({ layer: event.layer, reason: event.reason })
  }
  return chain
}
