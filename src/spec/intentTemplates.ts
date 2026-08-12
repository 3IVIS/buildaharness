import type { AnyNodeType } from './schema'

/**
 * Phase 8 — "Intent mode" prototype. A small set of high-level templates
 * that expand into a full node subgraph when picked from the sidebar,
 * alongside today's "Expert mode" (the full node palette).
 *
 * Each step becomes one canvas node. Steps default to `process_concept`
 * (the critique's own praised abstraction for "a named phase of work") so
 * expansion doesn't require inventing a new template/macro node type —
 * per-step `harness_config.concept_id` is set from `conceptId`. A step may
 * instead name a concrete existing node type (e.g. `hitl_breakpoint` for a
 * human-approval gate) when a purpose-built node already exists for it.
 */
export interface IntentStep {
  label: string
  type: Extract<AnyNodeType, 'process_concept' | 'hitl_breakpoint' | 'reviewer_pass'>
  /** Required when type === 'process_concept'; ignored otherwise. */
  conceptId?: string
}

export interface IntentTemplate {
  id: string
  label: string
  description: string
  steps: IntentStep[]
}

export const INTENT_TEMPLATES: IntentTemplate[] = [
  {
    id: 'research-verify-draft-approve-publish',
    label: 'Research → verify sources → draft → human approval → publish',
    description: 'Research a topic, verify its sources, draft the output, get a human sign-off, then publish.',
    steps: [
      { label: 'Research',       type: 'process_concept', conceptId: 'research' },
      { label: 'Verify sources', type: 'process_concept', conceptId: 'verify_sources' },
      { label: 'Draft',          type: 'process_concept', conceptId: 'draft' },
      { label: 'Human approval', type: 'hitl_breakpoint' },
      { label: 'Publish',        type: 'process_concept', conceptId: 'publish' },
    ],
  },
  {
    id: 'triage-diagnose-fix-verify',
    label: 'Triage → diagnose → fix → verify',
    description: 'Triage an incoming issue, diagnose the root cause, apply a fix, then verify it resolved.',
    steps: [
      { label: 'Triage',   type: 'process_concept', conceptId: 'triage' },
      { label: 'Diagnose', type: 'process_concept', conceptId: 'diagnose' },
      { label: 'Fix',      type: 'process_concept', conceptId: 'apply_fix' },
      { label: 'Verify',   type: 'process_concept', conceptId: 'verify_fix' },
    ],
  },
  {
    id: 'plan-execute-review',
    label: 'Plan → execute → review',
    description: 'Decompose a goal into a plan, execute it, then run a reviewer pass before finishing.',
    steps: [
      { label: 'Plan',    type: 'process_concept', conceptId: 'plan' },
      { label: 'Execute', type: 'process_concept', conceptId: 'execute' },
      { label: 'Review',  type: 'reviewer_pass' },
    ],
  },
]
