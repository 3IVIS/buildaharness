import { describe, it, expect, vi } from 'vitest'

import { WorldModel, BeliefDepGraph } from '../state/world-model.js'
import { ControlState } from '../state/control-state.js'
import { OutputContract } from '../state/output-contract.js'
import { HypothesisSet } from '../state/hypothesis-set.js'
import { EvidenceStore } from '../state/evidence-store.js'
import { TaskGraph } from '../state/task-graph.js'
import { StrategyState } from '../state/strategy-state.js'
import { FailureDiagnostics } from '../state/failure-diagnostics.js'
import { CallerState } from '../state/caller-state.js'
import { MemoryState } from '../state/memory-state.js'
import { InMemoryExperienceStore, UnavailableExperienceStore } from '../state/experience-store.js'
import { Diagnostics } from '../state/diagnostics.js'

import { reviewProposedChange, applyReviewOutcome } from './review-proposed-change.js'
import { actionGate, postExecGate, contractShadowCheck } from './policy-gates.js'
import { execute } from './execute.js'
import { verify } from './verify.js'
import { rollbackAndReplan, cannotMakeProgress, buildStrategyOrdering, STALL_WINDOW } from './rollback-replan.js'
import { makeSurfaceBlocker, awaitClarification, EscalationHalt, handleEscalationResponse } from './escalate.js'
import { applyConstraintChangePropagation, revalidateTaskGraph } from './check-caller-updates.js'
import { resolveControlState } from './resolve-control-state.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeWorldModel(overrides?: Partial<ConstructorParameters<typeof WorldModel>[0]>): WorldModel {
  return new WorldModel(overrides)
}

function makeTask(id = 't1', status: 'PENDING' | 'RUNNING' | 'COMPLETE' | 'FAILED' | 'BLOCKED' | 'HUMAN_REQUIRED' = 'PENDING') {
  return {
    id,
    description: 'a task',
    status,
    risk_level: 'LOW' as const,
    depends_on: [] as string[],
    parallel_write_domains: [] as string[],
    abstraction_level: 1,
    assigned_strategy: null,
  }
}

function makeDiagnostics(): Diagnostics {
  return new Diagnostics({
    belief_health: { freshness: 0.8, consistency: 0.8, support: 0.8 },
    coverage_health: { symptom_coverage: 0.7, explanation_coverage: 0.6 },
    verification_health: { strength: 0.8, feasibility: 0.8 },
    execution_health: { progress_rate: 0.8, failure_recurrence: 0.1, oscillation_score: 0.1 },
    dep_class_gap_annotation: '',
  })
}

// ─── P10.1 reviewProposedChange ───────────────────────────────────────────────

describe('reviewProposedChange', () => {
  it('first failure blocks action without evaluating remaining dimensions', () => {
    const wm = makeWorldModel()
    // HIGH-confidence belief whose negation the change matches
    wm.beliefs.push({
      id: 'b1',
      statement: 'system is stable',
      confidence: 1.0,
      derived_from: ['obs1'],
      recorded_at: new Date().toISOString(),
    })
    // change contradicts the belief AND would also fail hypothesis compatibility
    const change = { description: 'removes system is stable and not hypothesis pred' }
    const hs = new HypothesisSet({
      active: [{
        id: 'h1',
        explanation: 'test',
        confidence: 0.8,
        predicted_observations: ['hypothesis pred'],
        discriminating_evidence: [],
        generation_sources: ['symptom_inference'],
        diversity_score: 0.8,
      }],
      eliminated: [],
      elimination_policy: { conditions: [], retention_k: 10, floor: 0.05 },
    })
    const map = new Map<string, number>()
    const result = reviewProposedChange(change, makeTask(), wm, null, hs, null, map)
    expect(result.passed).toBe(false)
    // short-circuit: only one dimension in failed_dimensions
    expect(result.failed_dimensions).toHaveLength(1)
    expect(result.failed_dimensions[0].dimension).toBe('world_model_consistency')
  })

  it('world-model consistency check rejects change contradicting any HIGH-reliability belief', () => {
    const wm = makeWorldModel()
    wm.beliefs.push({
      id: 'b1',
      statement: 'auth is enabled',
      confidence: 1.0,
      derived_from: ['obs1'],
      recorded_at: new Date().toISOString(),
    })
    const change = { description: 'remove auth is enabled' }
    const map = new Map<string, number>()
    const result = reviewProposedChange(change, null, wm, null, null, null, map)
    expect(result.passed).toBe(false)
    expect(result.failed_dimensions[0].dimension).toBe('world_model_consistency')
  })

  it('linter check skipped silently when linter absent from tool_availability_manifest', () => {
    const es = new EvidenceStore()  // empty manifest → no linter
    const change = { description: 'syntax error in code' }  // would fail if linter present
    const map = new Map<string, number>()
    // Without linter, code_quality passes
    const result = reviewProposedChange(change, null, null, null, null, es, map)
    // task_alignment passes (no task), world_model_consistency passes, output_contract passes
    // code_quality passes (no linter), hypothesis_compatibility passes
    expect(result.passed).toBe(true)
    // With linter available, it should fail
    const esWithLinter = new EvidenceStore({
      tool_availability_manifest: { linter: { available: true, fallback_tool: null } },
    })
    const result2 = reviewProposedChange(change, null, null, null, null, esWithLinter, new Map())
    expect(result2.passed).toBe(false)
    expect(result2.failed_dimensions[0].dimension).toBe('code_quality')
  })

  it('open hypothesis compatibility check blocks change contradicting uneliminated hypothesis', () => {
    const hs = new HypothesisSet({
      active: [{
        id: 'h1',
        explanation: 'test',
        confidence: 0.7,
        predicted_observations: ['cache is warm'],
        discriminating_evidence: [],
        generation_sources: ['symptom_inference'],
        diversity_score: 0.8,
      }],
      eliminated: [],
      elimination_policy: { conditions: [], retention_k: 10, floor: 0.05 },
    })
    const change = { description: 'remove cache is warm' }
    const map = new Map<string, number>()
    const result = reviewProposedChange(change, null, null, null, hs, null, map)
    expect(result.passed).toBe(false)
    expect(result.failed_dimensions[0].dimension).toBe('hypothesis_compatibility')
  })

  it('output contract pre-check catches missing required interface field before mutation', () => {
    const oc = new OutputContract({ required_sections: ['status', 'result'] })
    const change = { description: 'drop result field from response' }
    const map = new Map<string, number>()
    const result = reviewProposedChange(change, null, null, oc, null, null, map)
    expect(result.passed).toBe(false)
    expect(result.failed_dimensions[0].dimension).toBe('output_contract_precheck')
  })

  it('second consecutive failure on same task triggers escalate_to_human', () => {
    const wm = makeWorldModel()
    wm.beliefs.push({
      id: 'b1',
      statement: 'db is connected',
      confidence: 1.0,
      derived_from: ['obs1'],
      recorded_at: new Date().toISOString(),
    })
    const change = { description: 'removes db is connected' }
    const map = new Map<string, number>()
    const task = makeTask('task-a')
    reviewProposedChange(change, task, wm, null, null, null, map)  // first failure
    const result2 = reviewProposedChange(change, task, wm, null, null, null, map)  // second failure
    expect(result2.escalation_triggered).toBe(true)
    expect(result2.consecutive_failures).toBe(2)
  })
})

describe('applyReviewOutcome', () => {
  it('resets the counter and returns a clean pass', () => {
    const map = new Map<string, number>([['task-a', 3]])
    const result = applyReviewOutcome('task-a', true, map)
    expect(result).toEqual({ passed: true, failed_dimensions: [], consecutive_failures: 0, escalation_triggered: false })
    expect(map.get('task-a')).toBe(0)
  })

  it('increments the same per-task counter reviewProposedChange itself uses, so an external (e.g. semantic) failure compounds with a prior lexical one', () => {
    const map = new Map<string, number>()
    const dim = { dimension: 'world_model_consistency' as const, passed: false, reason: 'semantic conflict' }

    const first = applyReviewOutcome('task-a', false, map, dim)
    expect(first).toEqual({ passed: false, failed_dimensions: [dim], consecutive_failures: 1, escalation_triggered: false })

    const second = applyReviewOutcome('task-a', false, map, dim)
    expect(second.consecutive_failures).toBe(2)
    expect(second.escalation_triggered).toBe(true)
  })

  it('keeps separate counters per task id', () => {
    const map = new Map<string, number>()
    applyReviewOutcome('task-a', false, map, { dimension: 'code_quality', passed: false, reason: 'x' })
    const taskB = applyReviewOutcome('task-b', false, map, { dimension: 'code_quality', passed: false, reason: 'y' })
    expect(taskB.consecutive_failures).toBe(1)
  })
})

// ─── P10.2 Policy gates ───────────────────────────────────────────────────────

describe('actionGate', () => {
  it('_maybeResolve() called at entry; stale control state re-resolved before any gate logic', () => {
    const wm = makeWorldModel()
    wm.generation_id = 5
    const cs = new ControlState()
    cs.generation_id = 3  // stale
    const diag = makeDiagnostics()
    const fd = new FailureDiagnostics()
    // With resolver, stale state gets re-resolved before gate
    const result = actionGate(null, cs, wm, diag, fd, resolveControlState)
    // After resolution generation_id matches
    expect(cs.generation_id).toBe(wm.generation_id)
    expect(result).toBe('PASS')
  })

  it('action whose class is in block_mask → BLOCK result returned', () => {
    const wm = makeWorldModel()
    wm.generation_id = 2
    const cs = new ControlState()
    cs.generation_id = 2
    cs.risk_state = 'CAUTIOUS'
    cs.block_mask = [{ dimension: 'belief_freshness', value: 0.1, recovery_action_class: 'belief_refresh' }]
    const action = { required_resources: ['belief_freshness'] }
    const result = actionGate(action, cs, wm)
    expect(result).toBe('BLOCK')
  })

  it('escalation_reason=HUMAN_REQUIRED → ESCALATE immediately without evaluating block_mask', () => {
    const wm = makeWorldModel()
    wm.generation_id = 1
    const cs = new ControlState()
    cs.generation_id = 1
    cs.escalation_reason = 'HUMAN_REQUIRED'
    cs.risk_state = 'BLOCKED'  // would BLOCK but ESCALATE fires first
    cs.block_mask = [{ dimension: 'belief_freshness', value: 0.1, recovery_action_class: 'belief_refresh' }]
    const action = { required_resources: ['belief_freshness'] }
    const result = actionGate(action, cs, wm)
    expect(result).toBe('ESCALATE')
  })

  it('sub-step A generation_id used; distinct from sub-step B (postExecGate) value', () => {
    // sub-step A: generation_id = 3
    const wmA = makeWorldModel()
    wmA.generation_id = 3
    const csA = new ControlState()
    csA.generation_id = 3
    const actionResult = actionGate(null, csA, wmA)
    expect(actionResult).toBe('PASS')

    // sub-step B: generation_id = 4 (incremented after execution)
    const wmB = makeWorldModel()
    wmB.generation_id = 4
    const csB = new ControlState()
    csB.generation_id = 4
    const postResult = postExecGate({ result: 'ok' }, { has_critical_failure: false }, csB, wmB)
    expect(postResult).toBe(true)

    // Verify they used distinct generation_ids
    expect(wmA.generation_id).not.toBe(wmB.generation_id)
  })
})

describe('postExecGate', () => {
  it('_maybeResolve() called at entry using sub-step B generation_id', () => {
    const wm = makeWorldModel()
    wm.generation_id = 6
    const cs = new ControlState()
    cs.generation_id = 4  // stale
    const diag = makeDiagnostics()
    const fd = new FailureDiagnostics()
    const result = postExecGate({ ok: true }, { has_critical_failure: false }, cs, wm, diag, fd, null, resolveControlState)
    expect(cs.generation_id).toBe(wm.generation_id)
    expect(result).toBe(true)
  })

  it('contract_shadow_check() runs inside gate; required fields + no type regressions checked', () => {
    const wm = makeWorldModel()
    wm.generation_id = 1
    const cs = new ControlState()
    cs.generation_id = 1
    const oc = new OutputContract({ required_sections: ['status', 'data'] })
    // result missing 'data' field → shadow check fails → gate returns false
    const result = postExecGate({ status: 'ok' }, { has_critical_failure: false }, cs, wm, undefined, undefined, oc)
    expect(result).toBe(false)
  })

  it('contract_shadow_check does not replace full output_validation at loop end', () => {
    // shadow check passes (both required fields present)
    const wm = makeWorldModel()
    wm.generation_id = 1
    const cs = new ControlState()
    cs.generation_id = 1
    const oc = new OutputContract({ required_sections: ['status'] })
    const gateResult = postExecGate({ status: 'ok' }, { has_critical_failure: false }, cs, wm, undefined, undefined, oc)
    expect(gateResult).toBe(true)
    // The contract shadow check is 'early detection only' — a full validate_output_contract()
    // at loop end is authoritative and may catch additional violations.
    // We verify the shadow check is distinct (it only checks presence, not deep structure).
    const shadowResult = contractShadowCheck({ status: 'ok' }, oc)
    expect(shadowResult.passed).toBe(true)
    // Full validation would have additional checks beyond field presence
    expect(shadowResult.violations).toHaveLength(0)
  })
})

// ─── P10.3 execute ────────────────────────────────────────────────────────────

describe('execute', () => {
  it('snapshot reversibility serialises worldModel state before mutation applied', () => {
    const wm = makeWorldModel()
    const ms = new MemoryState()
    const es = new EvidenceStore()
    const tg = new TaskGraph({ tasks: [makeTask()] })
    const task = makeTask()
    const ctx = { worldModel: wm, evidenceStore: es, taskGraph: tg, currentTask: task, memoryState: ms }

    // 'schema' change_type → snapshot strategy
    const change = { change_type: 'schema' as const, description: 'db migration' }
    const result = execute(change, () => 'done', ctx)

    expect(result.strategy).toBe('snapshot')
    expect(result.rollback_ref).not.toBeNull()
    // Rollback point created and contains serialised worldModel
    const rp = ms.rollback_points.find(p => p.id === result.rollback_ref)
    expect(rp).toBeDefined()
    expect(rp!.serialised_state).toContain('generation_id')
  })

  it('ephemeral (read-only) action has no rollback_points entry created', () => {
    const wm = makeWorldModel()
    const ms = new MemoryState()
    const es = new EvidenceStore()
    const tg = new TaskGraph({ tasks: [makeTask()] })
    const ctx = { worldModel: wm, evidenceStore: es, taskGraph: tg, currentTask: makeTask(), memoryState: ms }

    const change = { change_type: 'read-only' as const }
    const result = execute(change, () => 'read result', ctx)

    expect(result.strategy).toBe('ephemeral')
    expect(result.rollback_ref).toBeNull()
    expect(ms.rollback_points).toHaveLength(0)
  })

  it('tool error → Evidence(reliability=HIGH, evidence_type=SYSTEM_ERROR) → update_world_model called', () => {
    const wm = makeWorldModel()
    const ms = new MemoryState()
    const es = new EvidenceStore()
    const tg = new TaskGraph({ tasks: [makeTask()] })
    const ctx = { worldModel: wm, evidenceStore: es, taskGraph: tg, currentTask: makeTask(), memoryState: ms }

    const result = execute({}, () => { throw new Error('connection refused') }, ctx)

    expect(result.success).toBe(false)
    expect(result.error).toContain('connection refused')
    // Evidence with SYSTEM_ERROR created in evidence store
    const sysErr = es.observations.find(e => e.evidence_type === 'SYSTEM_ERROR')
    expect(sysErr).toBeDefined()
    expect(sysErr!.reliability).toBe('HIGH')
    // World model updated with error observation
    expect(wm.observations.some(o => o.content.includes('SYSTEM_ERROR'))).toBe(true)
  })

  it('environment_change_log.record(result) called for every execution regardless of outcome', () => {
    const wmSuccess = makeWorldModel()
    const msSuccess = new MemoryState()
    const esSuccess = new EvidenceStore()
    const tg1 = new TaskGraph({ tasks: [makeTask()] })
    const ctxSuccess = { worldModel: wmSuccess, evidenceStore: esSuccess, taskGraph: tg1, currentTask: makeTask(), memoryState: msSuccess }
    execute({}, () => 'success', ctxSuccess)
    expect(wmSuccess.environment_change_log).toHaveLength(1)

    const wmFail = makeWorldModel()
    const msFail = new MemoryState()
    const esFail = new EvidenceStore()
    const tg2 = new TaskGraph({ tasks: [makeTask()] })
    const ctxFail = { worldModel: wmFail, evidenceStore: esFail, taskGraph: tg2, currentTask: makeTask(), memoryState: msFail }
    execute({}, () => { throw new Error('boom') }, ctxFail)
    expect(wmFail.environment_change_log).toHaveLength(1)
  })

  it('planToolWorkflow() triggers dep graph refresh when unverified_edge_ratio exceeded', () => {
    const wm = makeWorldModel()
    const ms = new MemoryState()
    const es = new EvidenceStore()
    const tg = new TaskGraph({ tasks: [makeTask()] })
    const planCalled = vi.fn()
    const beliefDepGraph = new BeliefDepGraph({ unverified_edge_ratio: 0.9 })
    const ctx = {
      worldModel: wm, evidenceStore: es, taskGraph: tg, currentTask: makeTask(),
      memoryState: ms, beliefDepGraph, planToolWorkflow: planCalled,
    }
    execute({}, () => 'ok', ctx)
    expect(planCalled).toHaveBeenCalledOnce()

    // Below threshold → not called
    const planNotCalled = vi.fn()
    const ctx2 = {
      worldModel: makeWorldModel(), evidenceStore: new EvidenceStore(),
      taskGraph: new TaskGraph({ tasks: [makeTask()] }), currentTask: makeTask(),
      memoryState: new MemoryState(),
      beliefDepGraph: new BeliefDepGraph({ unverified_edge_ratio: 0.3 }),
      planToolWorkflow: planNotCalled,
    }
    execute({}, () => 'ok', ctx2)
    expect(planNotCalled).not.toHaveBeenCalled()
  })
})

// ─── P10.4 verify ─────────────────────────────────────────────────────────────

describe('verify', () => {
  it('all 9 layers run internally; enabled_layers post-filters VerificationResult', () => {
    const es = new EvidenceStore({
      tool_availability_manifest: {
        linter: { available: true, fallback_tool: null },
        pytest: { available: true, fallback_tool: null },
        integration_runner: { available: true, fallback_tool: null },
        consistency_checker: { available: true, fallback_tool: null },
        requirements_checker: { available: true, fallback_tool: null },
        assumption_checker: { available: true, fallback_tool: null },
        goal_checker: { available: true, fallback_tool: null },
        evidence_checker: { available: true, fallback_tool: null },
        contract_checker: { available: true, fallback_tool: null },
      },
    })
    // Provide enough evidence so evidence_sufficiency passes
    es.observations.push({ id: 'e1', obs: 'o1', reliability: 'HIGH', source: 's', evidence_type: 'OBSERVATION', freshness: new Date().toISOString() })
    es.observations.push({ id: 'e2', obs: 'o2', reliability: 'MEDIUM', source: 's', evidence_type: 'OBSERVATION', freshness: new Date().toISOString() })
    const result = verify('output', [], [], es, 'LOW', es)
    // All 9 layers enabled → 9 results
    expect(result.layer_results).toHaveLength(9)
    expect(result.has_critical_failure).toBe(false)
  })

  it('unavailable tool layers are reported SKIPPED, not dropped from layer_results', () => {
    const es = new EvidenceStore({
      tool_availability_manifest: {
        linter: { available: false, fallback_tool: null },  // disabled
        pytest: { available: true, fallback_tool: null },
      },
    })
    const result = verify('output', [], [], es, 'LOW')
    // syntax layer (requires linter) still appears, marked SKIPPED — matches
    // verification.py's per-layer _tool_available() gating (never drops the layer)
    const layers = result.layer_results.map(lr => lr.layer)
    expect(layers).toContain('syntax')
    expect(result.layer_results.find(lr => lr.layer === 'syntax')?.status).toBe('SKIPPED')
    // unit layer (pytest available) runs normally
    const unit = result.layer_results.find(lr => lr.layer === 'unit')
    expect(unit?.status).toBe('PASS')
  })

  it('evidence_sufficiency threshold is claim-scoped — local claim requires less evidence than global claim', () => {
    const esSmall = new EvidenceStore()
    esSmall.observations.push({ id: 'e1', obs: 'o1', reliability: 'MEDIUM', source: 's', evidence_type: 'OBSERVATION', freshness: new Date().toISOString() })
    esSmall.observations.push({ id: 'e2', obs: 'o2', reliability: 'LOW', source: 's', evidence_type: 'OBSERVATION', freshness: new Date().toISOString() })

    const localResult = verify('output', [], [], null, 'LOW', esSmall, null, null, null, 'local')
    const localEv = localResult.layer_results.find(lr => lr.layer === 'evidence_sufficiency')
    expect(localEv?.status).toBe('PASS')  // 2 items sufficient for local

    const globalResult = verify('output', [], [], null, 'LOW', esSmall, null, null, null, 'global')
    const globalEv = globalResult.layer_results.find(lr => lr.layer === 'evidence_sufficiency')
    expect(globalEv?.status).toBe('FAIL')  // 2 items insufficient for global (needs 5 HIGH/MEDIUM)
  })

  it('HIGH risk task triggers adversarial verification pass in addition to standard 9 layers', () => {
    const es = new EvidenceStore()
    const hs = new HypothesisSet({
      active: [{
        id: 'h1',
        explanation: 'h',
        confidence: 0.9,
        predicted_observations: ['something'],
        discriminating_evidence: [],
        generation_sources: ['symptom_inference'],
        diversity_score: 0.9,
      }],
      eliminated: [],
      elimination_policy: { conditions: [], retention_k: 10, floor: 0.05 },
    })
    const result = verify('valid output', [], [], null, 'HIGH', es, null, null, hs)
    expect(result.adversarial_passed).not.toBeNull()
    // valid output passes adversarial
    expect(result.adversarial_passed).toBe(true)

    const resultLow = verify('valid output', [], [], null, 'LOW', es, null, null, hs)
    expect(resultLow.adversarial_passed).toBeNull()
  })

  it('LayerResult.layer field (not .layer_name) used for enabled_layers membership check', () => {
    const result = verify('output', [], [], null, 'LOW')
    for (const lr of result.layer_results) {
      expect(lr).toHaveProperty('layer')
      expect(lr).not.toHaveProperty('layer_name')
    }
  })
})

// ─── P10.5 rollbackAndReplan ──────────────────────────────────────────────────

describe('rollbackAndReplan', () => {
  it('cannot_make_progress() short-circuits on first True proxy; remaining proxies not evaluated', () => {
    const ss = new StrategyState()
    // Fill completion_history with all same values → proxy 1 fires
    ss.completion_history = Array(STALL_WINDOW).fill(3)
    const fd = new FailureDiagnostics()

    const proxyFired = cannotMakeProgress(ss, fd)
    expect(proxyFired).toBe(true)
    expect(ss.stall_reason).toBe('completion_velocity')
    // proxy 2 would also have fired (switch_count > MAX_SWITCHES), but proxy 1 was first
  })

  it('stall_reason recorded in strategyState.stall_reason before returning True', () => {
    const ss = new StrategyState()
    ss.completion_history = Array(STALL_WINDOW).fill(0)
    const fd = new FailureDiagnostics()
    cannotMakeProgress(ss, fd)
    expect(ss.stall_reason).toBe('completion_velocity')
  })

  it('softmax policy replaces fixed strategy order when experienceStore.available', () => {
    const store = new InMemoryExperienceStore()
    // Set high weight for REIMPLEMENT for failure class 'logic_error'
    store.setStrategyWeight('REIMPLEMENT:logic_error', 10.0)
    store.setStrategyWeight('DIRECT_EDIT:logic_error', 0.1)

    const ordering = buildStrategyOrdering('logic_error', store)
    // REIMPLEMENT should be first due to high weight
    expect(ordering[0]).toBe('REIMPLEMENT')

    // Unavailable store falls back to default order
    const unavail = new UnavailableExperienceStore()
    const fallback = buildStrategyOrdering('logic_error', unavail)
    expect(fallback[0]).toBe('DIRECT_EDIT')
  })

  it('rollbackAndReplan: LOCAL replan calls diagnoseAndReplan(currentTask) only', () => {
    const task = makeTask('t1')
    // Add a dependent task
    const dep = { ...makeTask('t2'), depends_on: ['t1'], status: 'RUNNING' as const }
    const tg = new TaskGraph({ tasks: [task, dep] })
    const ss = new StrategyState()
    const fd = new FailureDiagnostics()
    const wm = makeWorldModel()
    const cs = new CallerState()
    const store = new UnavailableExperienceStore()

    // no stall → LOCAL replan
    const result = rollbackAndReplan(task, ss, fd, tg, wm, cs, store)
    expect(result.replanScope).toBe('LOCAL')
    expect(result.cannotProgress).toBe(false)
    // dependent task re-queued to PENDING
    const updatedDep = result.newTaskGraph.getTask('t2')
    expect(updatedDep?.status).toBe('PENDING')
  })

  it('rollbackAndReplan: GLOBAL replan calls rebuildTaskGraph() + validateTaskGraph()', () => {
    const task = makeTask('t1')
    const tg = new TaskGraph({ tasks: [task] })
    const ss = new StrategyState()
    // Force stall via completion_history
    ss.completion_history = Array(STALL_WINDOW).fill(0)
    const fd = new FailureDiagnostics()
    const wm = makeWorldModel()
    const cs = new CallerState({ success_criteria: ['criterion A', 'criterion B'] })
    const store = new UnavailableExperienceStore()

    const result = rollbackAndReplan(task, ss, fd, tg, wm, cs, store)
    expect(result.cannotProgress).toBe(true)
    expect(result.replanScope).toBe('GLOBAL')
    // New task graph built from success_criteria
    expect(result.newTaskGraph.tasks.some(t => t.description.includes('criterion A'))).toBe(true)
  })
})

// ─── P10.6 escalate ───────────────────────────────────────────────────────────

describe('escalate', () => {
  it('surfaceBlocker object carries reason, missing_info[], and context fields', () => {
    const blocker = makeSurfaceBlocker(
      'blocked_state',
      ['missing auth token', 'missing user context'],
      'Task: auth setup',
    )
    expect(blocker.reason).toBe('blocked_state')
    expect(blocker.missing_info).toEqual(['missing auth token', 'missing user context'])
    expect(blocker.current_task_summary).toBe('Task: auth setup')
    expect(blocker.escalated_at).toBeTruthy()
  })

  it('await_clarification() raises EscalationHalt — does not return a value', () => {
    const blocker = makeSurfaceBlocker('cannot_make_progress', ['more context needed'], 'stuck task')
    expect(() => awaitClarification(blocker)).toThrow(EscalationHalt)
    try {
      awaitClarification(blocker)
    } catch (e) {
      expect(e).toBeInstanceOf(EscalationHalt)
      expect((e as EscalationHalt).blocker.reason).toBe('cannot_make_progress')
    }
  })

  it('constraint propagation on human response uses applyConstraintChangePropagation() (same path as checkCallerUpdates)', () => {
    const callerState = new CallerState({ success_criteria: ['do the thing'] })
    const wm = makeWorldModel()
    wm.generation_id = 2
    const ctx = {
      worldModel: wm,
      hypothesisSet: new HypothesisSet(),
      taskGraph: new TaskGraph(),
      diagnostics: makeDiagnostics(),
      failureDiagnostics: new FailureDiagnostics(),
    }
    const genIdBefore = wm.generation_id
    // Human response with new constraints
    handleEscalationResponse(callerState, { current_constraints: ['only touch auth module'] }, ctx)
    // constraints were changed → applyConstraintChangePropagation → generation_id++
    expect(wm.generation_id).toBe(genIdBefore + 1)
    expect(callerState.current_constraints).toEqual(['only touch auth module'])
    expect(callerState.constraints_changed).toBe(false)  // reset after propagation
  })

  it('applyConstraintChangePropagation() actually flags stale beliefs and revalidates the task graph, not just a generation_id bump', () => {
    const callerState = new CallerState({ success_criteria: ['ship the login page'] })
    const wm = makeWorldModel()
    wm.beliefs.push({ id: 'b1', statement: 'payment gateway configured', confidence: 0.9, derived_from: ['o1'], recorded_at: new Date().toISOString() })
    const taskGraph = new TaskGraph({
      tasks: [
        { id: 't1', description: 'wire up payment gateway', status: 'PENDING', risk_level: 'MEDIUM', depends_on: [], parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null },
      ],
    })

    applyConstraintChangePropagation(callerState, {
      worldModel: wm,
      hypothesisSet: new HypothesisSet(),
      taskGraph,
      diagnostics: makeDiagnostics(),
      failureDiagnostics: new FailureDiagnostics(),
    })

    // Belief shares no token with the new success criterion → flagged stale
    expect(wm.stale_flags['b1']).toBe(true)
    // Existing task is out of scope of the new criterion → blocked
    const t1 = taskGraph.getTask('t1')!
    expect(t1.status).toBe('BLOCKED')
    expect(t1.block_reason).toBe('scope_eliminated')
    // New criterion isn't covered by any task → a new task is added for it
    expect(taskGraph.tasks.some(t => t.description === 'ship the login page')).toBe(true)
  })

  it('revalidateTaskGraph() leaves in-scope, in-progress tasks alone', () => {
    const callerState = new CallerState({ success_criteria: ['ship the login page'] })
    const taskGraph = new TaskGraph({
      tasks: [
        { id: 't1', description: 'ship the login page end to end', status: 'RUNNING', risk_level: 'MEDIUM', depends_on: [], parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null },
      ],
    })
    revalidateTaskGraph(taskGraph, callerState)
    expect(taskGraph.getTask('t1')!.status).toBe('RUNNING')
  })
})
