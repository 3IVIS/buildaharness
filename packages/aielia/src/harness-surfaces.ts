/**
 * The advisor's surface registry and the public part of the kernel list (plan section 4a/4b). A surface is something a
 * suggestion may change; the kernel is everything a suggestion can never reach. Floor layers are not representable:
 * `AdvisorLayerId` excludes them, and the registry is derived from `LAYER_SETTINGS` groups `escalation`, `behaviour`
 * and `opt_in` only. The private part of the kernel (graders, judge, corpus, partition code) lives in
 * `eval/advisor/kernel-eval.json`; eval paths never appear in this file.
 */
import { LAYER_SETTINGS } from './layer-settings.js'

/** Layers a suggestion may name. The floor layers (control_state, tool_policy, mandatory_verification, approval_staging, diagnostics, hypothesis) are deliberately absent. */
export const ADVISOR_LAYER_IDS = [
  'semantic_contradiction', 'failure_match', 'criterion_coverage', 'change_review', 'injection_detection', 'decomposition_reframe', 'model_inferred_facts', 'reviewer_adversarial',
  'supervisor', 'constraint_check', 'semantic_grounding', 'retry_system_errors', 'plan_step_prompt', 'decomposed_answer_once', 'stuck_plan_resume', 'memory_budgeted_render',
  'semantic_hypotheses', 'source_reliability', 'reviewer_revision', 'experience_learning', 'semantic_compaction', 'semantic_task_completion', 'contradiction_severity', 'code_plan_templates',
  'retry_failed_task', 'memory_write_gate', 'memory_audit_log', 'episodic_digest', 'recall_tool', 'memory_consolidation', 'memory_reviewer',
] as const
export type AdvisorLayerId = (typeof ADVISOR_LAYER_IDS)[number]

/** I: data or configuration the assistant reads. E: executable (a code patch). */
export type SurfaceClass = 'I' | 'E'

export interface SurfaceBeacon {
  /** What counts as the change having taken effect on a run. */
  kind: 'layer_fired' | 'slot_read'
  layerId?: AdvisorLayerId
}

export interface SurfaceValueSchema {
  kind: 'boolean' | 'number' | 'string' | 'enum'
  values?: readonly string[]
  min?: number
  max?: number
}

export interface SurfaceSpec {
  id: string
  class: SurfaceClass
  /** The config key or env flag the surface is carried by. */
  slot?: string
  /** A repository path, for surfaces that are files. Must not match the kernel. */
  path?: string
  /** Which parts of state the surface may write. */
  scope: readonly string[]
  valueSchema: SurfaceValueSchema
  beacon: SurfaceBeacon
  safetyRelevant: boolean
  feedsCorrectionSignal: boolean
  layerId?: AdvisorLayerId
}

/** Layers whose output a safety property leans on; a reduction there is flagged. */
const SAFETY_RELEVANT: ReadonlySet<string> = new Set(['injection_detection', 'semantic_grounding', 'constraint_check', 'memory_write_gate', 'supervisor'])
/** Layers whose output feeds the control state or recovery choice. */
const FEEDS_CORRECTION: ReadonlySet<string> = new Set(['semantic_contradiction', 'failure_match', 'criterion_coverage', 'change_review', 'reviewer_adversarial', 'supervisor', 'contradiction_severity'])

const ADVISOR_LAYER_SET: ReadonlySet<string> = new Set(ADVISOR_LAYER_IDS)

export function isAdvisorLayerId(id: string): id is AdvisorLayerId {
  return ADVISOR_LAYER_SET.has(id)
}

/** Surfaces for the layer on/off flags, derived from `LAYER_SETTINGS`. Floor and flagless layers are skipped. */
export function layerSurfaces(): SurfaceSpec[] {
  return LAYER_SETTINGS.flatMap((l): SurfaceSpec[] => {
    if (l.group === 'floor' || !l.flag || !isAdvisorLayerId(l.id)) return []
    return [{
      id: `layer:${l.id}`,
      class: 'I',
      slot: l.flag,
      scope: ['layer_flag'],
      valueSchema: { kind: 'boolean' },
      beacon: { kind: 'layer_fired', layerId: l.id },
      safetyRelevant: SAFETY_RELEVANT.has(l.id),
      feedsCorrectionSignal: FEEDS_CORRECTION.has(l.id),
      layerId: l.id,
    }]
  })
}

export const SURFACE_REGISTRY: readonly SurfaceSpec[] = layerSurfaces()

export function findSurface(id: string, registry: readonly SurfaceSpec[] = SURFACE_REGISTRY): SurfaceSpec | undefined {
  return registry.find((s) => s.id === id)
}

/** Layers a suggestion may never propose to reduce. Empty by default (decision D13); fire counts are shown instead. */
export const protectedLayers: ReadonlySet<AdvisorLayerId> = new Set<AdvisorLayerId>()

/**
 * The public kernel list (plan section 4b). A pattern ending in `/` is a directory prefix, one starting with `*` is a
 * suffix match, anything else is an exact path. No regular expressions.
 */
export const KERNEL_PATHS: readonly string[] = [
  // Action and risk control
  'packages/aielia/src/tool-policy.ts', 'packages/aielia/src/tool-control-plane.ts', 'packages/aielia/src/action-approval-service.ts',
  'packages/aielia/src/plan-approval-service.ts', 'packages/aielia/src/risk-classifier.ts', 'packages/aielia/src/turn-intent-classifier.ts',
  // Memory protection (the write gate; the durable-write and audit path lives in memory-service.ts, kept whole)
  'packages/aielia/src/memory-governance.ts', 'packages/aielia/src/memory-service.ts',
  // Answer judges and checks
  'packages/aielia/src/grounding-check.ts', 'packages/aielia/src/constraint-check.ts', 'packages/aielia/src/answer-claim.ts', 'packages/aielia/src/reply-audit.ts',
  // Floor layers and the main loop
  'packages/harness/src/nodes/resolve-control-state.ts', 'packages/harness/src/nodes/policy-gates.ts', 'packages/harness/src/nodes/verify.ts',
  'packages/harness/src/nodes/output-validation.ts', 'packages/harness/src/nodes/estimate-risk.ts', 'packages/harness/src/nodes/update-diagnostics.ts',
  'packages/harness/src/nodes/generate-update-hypotheses.ts', 'packages/harness/src/layer-policy.ts', 'packages/harness/src/harness-runtime.ts',
  // Python twin and the CI gate
  'adapter/harness/control_state.py', 'adapter/harness/execution_boundary.py', 'adapter/harness/review_gate.py', 'adapter/harness/risk.py',
  'adapter/harness/verification.py', 'adapter/harness/contradiction.py', 'adapter/tests/test_harness_invariants.py',
  // The advisor itself
  'packages/aielia/src/harness-surfaces.ts', 'packages/aielia/src/admission-gate.ts', 'packages/aielia/src/advisor-consent.ts', 'packages/aielia/src/advisor-send.ts',
  // Always frozen
  '*.test.ts', '.github/workflows/', 'scripts/check-schema-sync.mjs', 'packages/proxy/',
]

function matchesPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith('/')) return path.startsWith(pattern)
  if (pattern.startsWith('*')) return path.endsWith(pattern.slice(1))
  return path === pattern
}

/** True when `path` (repo-relative, forward slashes) is on the kernel list, optionally extended by the private list. */
export function isKernelPath(path: string, extra: readonly string[] = []): boolean {
  const p = path.replace(/^\.\//, '')
  return KERNEL_PATHS.some((k) => matchesPattern(p, k)) || extra.some((k) => matchesPattern(p, k))
}

/** The registered surfaces whose path is a kernel path; the registry test expects none. */
export function kernelOverlaps(registry: readonly SurfaceSpec[] = SURFACE_REGISTRY, extra: readonly string[] = []): SurfaceSpec[] {
  return registry.filter((s) => s.path !== undefined && isKernelPath(s.path, extra))
}
