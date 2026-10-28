import { describe, it, expect } from 'vitest'
import { OPT_IN_FLAG } from '@buildaharness/harness'
import { LAYER_SETTINGS, applyLayerSettings, effectiveState, withLayerChoice, unmetRequirements, layerWarnings, sanitizeLayerChoices, formatLayerListing, findLayer, LayerSettingError } from './layer-settings.js'
import { ESCALATION_ENV } from './layer-policy-wiring.js'
import { semanticHypothesesEnabled } from './semantic-hypotheses.js'
import { decompositionEnabled } from './turn-interpreter.js'
import { controlStateGateEnabled, controlStateToolPolicyEnabled } from './tool-control-plane.js'
import { verificationEnabled, retrySystemErrorsEnabled, retryFailedTaskEnabled } from './harness-bridge.js'
import { resolveSupervisorEnabled } from './supervisor-flag.js'
import { semanticConstraintCheckEnabled } from './constraint-check.js'
import { semanticGroundingEnabled } from './grounding-check.js'
import { episodicDigestEnabled } from './episodic-digest.js'
import { recallToolEnabled } from './recall-tool.js'
import { memoryAuditLogEnabled, memoryWriteGateEnabled } from './memory-service.js'
import { memoryConsolidationEnabled } from './memory-consolidation.js'
import { semanticTaskCompletionEnabled } from './task-completion-check.js'
import { codePlanTemplatesEnabled } from './code-plan-templates.js'
import { semanticContradictionSeverityEnabled } from './contradiction-checker.js'
import { planStepPromptEnabled } from './plan-step-prompt.js'
import { decomposedAnswerOnceEnabled } from './decomposed-answer.js'
import { stuckPlanResumeEnabled } from './plan-question.js'
import { memoryBudgetedRenderEnabled } from './memory-service.js'

describe('registry', () => {
  it('uses the same flags as the harness opt-in table and the escalation env table', () => {
    for (const [layer, flag] of Object.entries(OPT_IN_FLAG)) expect(findLayer(layer)?.flag).toBe(flag)
    for (const [layer, flag] of Object.entries(ESCALATION_ENV)) expect(findLayer(layer)?.flag).toBe(flag)
  })
  it('has unique ids and flags, and every layer is switchable, follows one, or is approval staging', () => {
    expect(new Set(LAYER_SETTINGS.map((l) => l.id)).size).toBe(LAYER_SETTINGS.length)
    const flags = LAYER_SETTINGS.flatMap((l) => (l.flag ? [l.flag] : []))
    expect(new Set(flags).size).toBe(flags.length)
    const locked = LAYER_SETTINGS.filter((l) => !l.flag && !l.followsLayer).map((l) => l.id)
    expect(locked).toEqual(['approval_staging'])
    for (const l of LAYER_SETTINGS.filter((x) => x.followsLayer)) expect(findLayer(l.followsLayer!)?.flag).toBeDefined()
    for (const l of LAYER_SETTINGS.filter((x) => x.group === 'floor' && x.flag)) expect(l.caution).toBeTruthy()
  })
})

describe('requirements', () => {
  it('only names real layers, and none is a layer that follows another or is locked', () => {
    for (const l of LAYER_SETTINGS.filter((x) => x.requires)) for (const r of l.requires!) expect(findLayer(r)?.flag).toBeDefined()
  })
  it('reports a switched-on layer whose requirement is off, and nothing when it is off itself or the need is met', () => {
    const rec = findLayer('memory_consolidation')!
    expect(unmetRequirements(rec, { memory_consolidation: true }, new Set(), {}).map((l) => l.id)).toEqual(['memory_audit_log'])
    expect(unmetRequirements(rec, { memory_consolidation: true, memory_audit_log: true }, new Set(), {})).toEqual([])
    expect(unmetRequirements(rec, {}, new Set(), {})).toEqual([])
  })
  it('catches the default-on layer whose requirement the user switched off', () => {
    expect(layerWarnings({ mandatory_verification: false }, new Set(), {})).toEqual(['"semantic_grounding" is on but does nothing while "mandatory_verification" is off.'])
    expect(layerWarnings({}, new Set(), {})).toEqual([])
  })
  it('uses the pinned env value for a requirement set outside Settings', () => {
    expect(layerWarnings({}, new Set(['reviewer_adversarial']), { AUDIT_REVIEWER_PASS: '0' }).join()).toBe('')
    expect(layerWarnings({ reviewer_revision: true }, new Set(['reviewer_adversarial']), { AUDIT_REVIEWER_PASS: '0' })).toHaveLength(1)
  })
  it('shows the need in the listing', () => {
    expect(formatLayerListing({ recall_tool: true }, new Set(), {})).toMatch(/needs: episodic_digest \(off\)/)
  })
})

describe('applyLayerSettings', () => {
  it('writes choices to the flags the layers read, so the real gates follow', () => {
    const env: Record<string, string | undefined> = {}
    expect(semanticHypothesesEnabled(env)).toBe(false)
    expect(decompositionEnabled(env)).toBe(true)
    applyLayerSettings({ semantic_hypotheses: true, decomposition_reframe: false }, env)
    expect(semanticHypothesesEnabled(env)).toBe(true)
    expect(decompositionEnabled(env)).toBe(false)
  })
  it('restores a flag it wrote when the choice is removed', () => {
    const env: Record<string, string | undefined> = {}
    applyLayerSettings({ semantic_hypotheses: true }, env)
    applyLayerSettings({}, env)
    expect(env.AUDIT_SEMANTIC_HYPOTHESES).toBeUndefined()
  })
  it('never overrides a flag the operator set, and reports it pinned', () => {
    const env: Record<string, string | undefined> = { AUDIT_DECOMPOSITION: '1' }
    const { pinned } = applyLayerSettings({ decomposition_reframe: false }, env)
    expect(env.AUDIT_DECOMPOSITION).toBe('1')
    expect(pinned.has('decomposition_reframe')).toBe(true)
    // still pinned on a re-apply, and an operator value that equals ours is not mistaken for ours
    expect(applyLayerSettings({}, env).pinned.has('decomposition_reframe')).toBe(true)
    expect(env.AUDIT_DECOMPOSITION).toBe('1')
  })
  it('switches the floor and behaviour gates the real code reads', () => {
    const env: Record<string, string | undefined> = {}
    expect(controlStateGateEnabled(env) && controlStateToolPolicyEnabled(env) && verificationEnabled(env)).toBe(true)
    expect(resolveSupervisorEnabled(env) && semanticConstraintCheckEnabled(env) && semanticGroundingEnabled(env) && retrySystemErrorsEnabled(env)).toBe(true)
    applyLayerSettings({ control_state: false, tool_policy: false, mandatory_verification: false, supervisor: false, constraint_check: false, semantic_grounding: false, retry_system_errors: false }, env)
    expect(controlStateGateEnabled(env)).toBe(false)
    expect(controlStateToolPolicyEnabled(env)).toBe(false)
    expect(verificationEnabled(env)).toBe(false)
    expect(resolveSupervisorEnabled(env)).toBe(false)
    expect(semanticConstraintCheckEnabled(env)).toBe(false)
    expect(semanticGroundingEnabled(env)).toBe(false)
    expect(retrySystemErrorsEnabled(env)).toBe(false)
  })
  it('switches the plan and memory-render behaviours the real code reads', () => {
    const env: Record<string, string | undefined> = {}
    expect(planStepPromptEnabled(env) && decomposedAnswerOnceEnabled(env) && stuckPlanResumeEnabled(env) && memoryBudgetedRenderEnabled(env)).toBe(true)
    applyLayerSettings({ plan_step_prompt: false, decomposed_answer_once: false, stuck_plan_resume: false, memory_budgeted_render: false }, env)
    expect(planStepPromptEnabled(env)).toBe(false)
    expect(decomposedAnswerOnceEnabled(env)).toBe(false)
    expect(stuckPlanResumeEnabled(env)).toBe(false)
    expect(memoryBudgetedRenderEnabled(env)).toBe(false)
  })
  it('turns on the default-off memory and plan flags', () => {
    const env: Record<string, string | undefined> = {}
    applyLayerSettings({ episodic_digest: true, recall_tool: true, memory_audit_log: true, memory_write_gate: true, memory_consolidation: true, semantic_task_completion: true, code_plan_templates: true, contradiction_severity: true, retry_failed_task: true }, env)
    expect(episodicDigestEnabled(env) && recallToolEnabled(env) && memoryAuditLogEnabled(env) && memoryWriteGateEnabled(env) && memoryConsolidationEnabled(env)).toBe(true)
    expect(semanticTaskCompletionEnabled(env) && codePlanTemplatesEnabled(env) && semanticContradictionSeverityEnabled(env) && retryFailedTaskEnabled(env)).toBe(true)
  })
  it('diagnostics and hypothesis follow control_state, and have no switch of their own', () => {
    const diag = findLayer('diagnostics')!
    expect(effectiveState(diag, undefined, new Set(), {})).toBe(true)
    expect(effectiveState(diag, { control_state: false }, new Set(), {})).toBe(false)
    expect(() => withLayerChoice({}, 'diagnostics', false)).toThrow(/follows "control_state"/)
  })
  it('ignores unknown and locked ids', () => {
    const env: Record<string, string | undefined> = {}
    applyLayerSettings({ approval_staging: false, nope: true }, env)
    expect(Object.keys(env)).toEqual([])
  })
})

describe('choices', () => {
  it('rejects locked and unknown layers with a readable error', () => {
    expect(() => withLayerChoice({}, 'approval_staging', false)).toThrow(LayerSettingError)
    expect(() => withLayerChoice({}, 'typo', true)).toThrow(/Unknown layer/)
  })
  it('sets and clears one choice without touching the others', () => {
    const a = withLayerChoice({ failure_match: false }, 'semantic_hypotheses', true)
    expect(a).toEqual({ failure_match: false, semantic_hypotheses: true })
    expect(withLayerChoice(a, 'failure_match', undefined)).toEqual({ semantic_hypotheses: true })
  })
  it('sanitizes a hand-edited persisted value', () => {
    expect(sanitizeLayerChoices({ failure_match: false, approval_staging: false, x: true, change_review: 'yes' })).toEqual({ failure_match: false })
    expect(sanitizeLayerChoices('junk')).toEqual({})
  })
  it('reports effective state: saved choice, else default, else the pinned env value', () => {
    const hyp = findLayer('semantic_hypotheses')!
    expect(effectiveState(hyp, undefined, new Set(), {})).toBe(false)
    expect(effectiveState(hyp, { semantic_hypotheses: true }, new Set(), {})).toBe(true)
    expect(effectiveState(hyp, { semantic_hypotheses: true }, new Set(['semantic_hypotheses']), { AUDIT_SEMANTIC_HYPOTHESES: '0' })).toBe(false)
  })
  it('lists every layer, marks approval staging locked and shows cautions', () => {
    const text = formatLayerListing({ semantic_hypotheses: true }, new Set(), {})
    for (const l of LAYER_SETTINGS) expect(text).toContain(l.id)
    expect(text).toMatch(/approval_staging\s+locked/)
    expect(text).toMatch(/control_state\s+on\s/)
    expect(text).toMatch(/caution: Off: the harness never blocks/)
    expect(text).toMatch(/semantic_hypotheses\s+on\s.*\(changed\)/)
  })
})
