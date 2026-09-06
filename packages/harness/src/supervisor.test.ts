// S0 of plans/harness_trajectory_supervisor_plan.html — TS twin of
// adapter/tests/test_harness_supervisor_s0.py. Layer 1 (deterministic):
// round-trip identity, enum + payload safety, digest boundedness, digest
// coherence from each stall proxy.

import { describe, it, expect } from 'vitest'
import {
  SUPERVISOR_ACTIONS,
  SupervisorDirective,
  InvestigationRequest,
  UserQuestion,
  supervisorEnabled,
  coerceForWiredActions,
  resolveSupervisorDirective,
} from './supervisor.js'
import { TrajectoryDigest, buildDigest } from './trajectory-digest.js'
import { StrategyState, DEFAULT_STRATEGY_ORDER } from './state/strategy-state.js'
import { FailureDiagnostics, type FailureRecord } from './state/failure-diagnostics.js'
import { TaskGraph, type Task } from './state/task-graph.js'
import { WorldModel, type Contradiction } from './state/world-model.js'
import { resolveControlState } from './nodes/resolve-control-state.js'

const failure = (failure_class: string, step: number): FailureRecord => ({
  id: `f${step}`,
  description: '',
  timestamp: '',
  failure_class,
  context: {},
})

const failedTask = (i: number): Task => ({
  id: `t${i}`,
  description: 'd'.repeat(400),
  status: 'FAILED',
  depends_on: [],
  risk_level: 'LOW',
  parallel_write_domains: [],
  abstraction_level: 0,
  assigned_strategy: null,
})

const contradiction = (id: string, severity: Contradiction['severity'], description: string): Contradiction => ({
  id,
  type: 'pairwise',
  severity,
  scope: 'local',
  description,
  involved_belief_ids: [],
})

describe('supervisorEnabled', () => {
  it('defaults off', () => {
    expect(supervisorEnabled({})).toBe(false)
  })
  it.each(['1', 'true', 'TRUE', 'yes', 'on', 'enabled'])('is true for %s', v => {
    expect(supervisorEnabled({ HARNESS_TRAJECTORY_SUPERVISOR: v })).toBe(true)
  })
  it.each(['', '0', 'false', 'off', 'nope'])('is false for %s', v => {
    expect(supervisorEnabled({ HARNESS_TRAJECTORY_SUPERVISOR: v })).toBe(false)
  })
})

const directives = (): SupervisorDirective[] => [
  SupervisorDirective.cont('nothing to do'),
  new SupervisorDirective({ action: 'REDIRECT_STRATEGY', rationale: 'pivot', strategy_hint: 'TRACE_EXEC' }),
  new SupervisorDirective({ action: 'REFRAME_PLAN', rationale: 'wrong frame', plan_note: 'split the auth task' }),
  new SupervisorDirective({
    action: 'GATHER_EVIDENCE',
    rationale: 'need a fact',
    investigation: new InvestigationRequest({ question: 'which port?', suggested_tools: ['read_file'], budget: 3 }),
  }),
  new SupervisorDirective({
    action: 'ASK_USER',
    rationale: 'ambiguous',
    question: new UserQuestion({ question: 'which env?', options: ['staging', 'prod'] }),
  }),
  new SupervisorDirective({ action: 'ABORT', rationale: 'unrecoverable' }),
]

describe('SupervisorDirective round-trip', () => {
  it.each(directives())('is identity through JSON for $action', d => {
    expect(SupervisorDirective.fromJSON(d.toJSON())).toEqual(d)
  })

  it('enum matches the Python literal', () => {
    expect(new Set(SUPERVISOR_ACTIONS)).toEqual(
      new Set(['CONTINUE', 'REDIRECT_STRATEGY', 'REFRAME_PLAN', 'GATHER_EVIDENCE', 'ASK_USER', 'ABORT']),
    )
  })
})

describe('SupervisorDirective enum + payload safety', () => {
  it('unknown action → CONTINUE, rationale preserved', () => {
    const d = SupervisorDirective.fromJSON({ action: 'SELF_DESTRUCT', rationale: 'hi' })
    expect(d.action).toBe('CONTINUE')
    expect(d.rationale).toBe('hi')
  })

  it('non-object → CONTINUE', () => {
    expect(SupervisorDirective.fromJSON(null).action).toBe('CONTINUE')
    expect(SupervisorDirective.fromJSON('ABORT').action).toBe('CONTINUE')
    expect(SupervisorDirective.fromJSON(['ABORT']).action).toBe('CONTINUE')
  })

  it('REDIRECT_STRATEGY without hint → CONTINUE', () => {
    expect(SupervisorDirective.fromJSON({ action: 'REDIRECT_STRATEGY' }).action).toBe('CONTINUE')
  })
  it('REFRAME_PLAN without note → CONTINUE', () => {
    expect(SupervisorDirective.fromJSON({ action: 'REFRAME_PLAN' }).action).toBe('CONTINUE')
  })
  it('GATHER_EVIDENCE without question → CONTINUE', () => {
    expect(SupervisorDirective.fromJSON({ action: 'GATHER_EVIDENCE' }).action).toBe('CONTINUE')
    expect(
      SupervisorDirective.fromJSON({ action: 'GATHER_EVIDENCE', investigation: { question: '  ' } }).action,
    ).toBe('CONTINUE')
  })
  it('ASK_USER without question → CONTINUE', () => {
    expect(SupervisorDirective.fromJSON({ action: 'ASK_USER' }).action).toBe('CONTINUE')
    expect(SupervisorDirective.fromJSON({ action: 'ASK_USER', question: { options: ['a'] } }).action).toBe('CONTINUE')
  })
  it('payload for a mismatched action is stripped', () => {
    const d = SupervisorDirective.fromJSON({ action: 'ABORT', rationale: 'done', investigation: { question: 'x' } })
    expect(d.action).toBe('ABORT')
    expect(d.investigation).toBeNull()
    expect(d.question).toBeNull()
  })
  it('rationale is length-capped', () => {
    const d = SupervisorDirective.fromJSON({ action: 'ABORT', rationale: 'x'.repeat(5000) })
    expect(d.rationale.length).toBeLessThanOrEqual(600)
  })
})

describe('payload types', () => {
  it('InvestigationRequest round-trip + null', () => {
    const r = new InvestigationRequest({ question: 'q', suggested_tools: ['read_file', 'web_search'], budget: 4 })
    expect(InvestigationRequest.fromJSON(r.toJSON())).toEqual(r)
    expect(InvestigationRequest.fromJSON(null)).toBeNull()
    expect(InvestigationRequest.fromJSON('nope')).toBeNull()
  })
  it('InvestigationRequest budget clamped', () => {
    expect(InvestigationRequest.fromJSON({ question: 'q', budget: -5 })!.budget).toBe(0)
    expect(InvestigationRequest.fromJSON({ question: 'q', budget: 9999 })!.budget).toBe(50)
    expect(InvestigationRequest.fromJSON({ question: 'q', budget: 'abc' })!.budget).toBe(5)
  })
  it('InvestigationRequest tool list capped at 8', () => {
    const r = InvestigationRequest.fromJSON({
      question: 'q',
      suggested_tools: Array.from({ length: 50 }, (_, i) => `t${i}`),
    })!
    expect(r.suggested_tools.length).toBeLessThanOrEqual(8)
  })
  it('UserQuestion round-trip + null', () => {
    const q = new UserQuestion({ question: 'which?', options: ['a', 'b'] })
    expect(UserQuestion.fromJSON(q.toJSON())).toEqual(q)
    expect(UserQuestion.fromJSON(null)).toBeNull()
  })
})

describe('TrajectoryDigest', () => {
  it('round-trip identity', () => {
    const d = new TrajectoryDigest({
      goal: ['ship the feature'],
      steps_taken: 7,
      stall_reason: 'strategy_loop',
      stall_history: ['completion_velocity', 'strategy_loop'],
      strategies_tried: [{ strategy: 'DIRECT_EDIT', outcome: 'switched' }],
      failure_classes: [{ class: 'compile_error', count: 3 }],
      reopened_tasks: ['task-2: wire the resolver'],
      open_contradictions: ['c1: belief A vs B'],
      blocking_unknowns: ['which auth backend'],
      budget_remaining: { plan_revisions_used: 2 },
    })
    expect(TrajectoryDigest.fromJSON(d.toJSON())).toEqual(d)
  })

  it('fromJSON is total on garbage', () => {
    const d = TrajectoryDigest.fromJSON({ steps_taken: 'not-an-int', goal: null, failure_classes: ['bad'] })
    expect(d.steps_taken).toBe(0)
    expect(d.goal).toEqual([])
    expect(d.failure_classes).toEqual([])
  })
})

function oversizedState() {
  const ss = new StrategyState({
    current_strategy: 'BROADER_SEARCH',
    switch_count: 3,
    switch_triggers: Array.from({ length: 20 }, (_, i) => `trigger-${i} ` + 'x'.repeat(300)),
    completion_history: Array(40).fill(0),
    stall_reason: 'strategy_loop ' + 'y'.repeat(500),
  })
  const fd = new FailureDiagnostics({
    failure_history: Array.from({ length: 60 }, (_, i) => failure(`class_${i % 5}`, i)),
  })
  const tg = new TaskGraph({ tasks: Array.from({ length: 30 }, (_, i) => failedTask(i)) })
  const wm = new WorldModel()
  wm.assumptions = Array.from({ length: 30 }, (_, i) => `assumption ${i} ` + 'z'.repeat(400))
  wm.contradictions = Array.from({ length: 15 }, (_, i) => contradiction(`c${i}`, 'HIGH', 'q'.repeat(500)))
  return { ss, fd, tg, wm }
}

describe('buildDigest boundedness', () => {
  it('caps every list and truncates every string', () => {
    const { ss, fd, tg, wm } = oversizedState()
    const dd = buildDigest(ss, fd, tg, wm).toJSON()
    expect(dd.stall_history.length).toBeLessThanOrEqual(10)
    expect(dd.strategies_tried.length).toBeLessThanOrEqual(10)
    expect(dd.failure_classes.length).toBeLessThanOrEqual(10)
    expect(dd.reopened_tasks.length).toBeLessThanOrEqual(10)
    expect(dd.open_contradictions.length).toBeLessThanOrEqual(10)
    expect(dd.blocking_unknowns.length).toBeLessThanOrEqual(10)
    expect(dd.stall_reason.length).toBeLessThanOrEqual(240)
    for (const s of dd.stall_history) expect(s.length).toBeLessThanOrEqual(80)
    for (const c of dd.open_contradictions) expect(c.length).toBeLessThanOrEqual(240)
  })

  it('serialises to JSON primitives only', () => {
    const { ss, fd, tg, wm } = oversizedState()
    const dd = buildDigest(ss, fd, tg, wm).toJSON()
    const blob = JSON.stringify(dd)
    expect(blob).not.toContain('failure_mode_library')
    expect(dd).not.toHaveProperty('beliefs')
  })
})

describe('buildDigest coherence from each stall proxy', () => {
  it('completion_velocity', () => {
    const ss = new StrategyState({
      stall_reason: 'completion_velocity',
      completion_history: [2, 2, 2, 2, 2],
      switch_count: 1,
    })
    const d = buildDigest(ss, new FailureDiagnostics(), new TaskGraph(), new WorldModel())
    expect(d.stall_reason).toBe('completion_velocity')
    expect(d.steps_taken).toBe(5)
  })

  it('strategy_loop', () => {
    const ss = new StrategyState({
      stall_reason: 'strategy_loop',
      switch_count: 3,
      switch_triggers: ['a', 'b', 'c'],
      current_strategy: DEFAULT_STRATEGY_ORDER[3],
    })
    const d = buildDigest(ss, new FailureDiagnostics(), new TaskGraph(), new WorldModel())
    expect(d.strategies_tried.slice(0, 3).map(s => s.strategy)).toEqual(DEFAULT_STRATEGY_ORDER.slice(0, 3))
    expect(d.stall_history).toEqual(['a', 'b', 'c'])
  })

  it('failure_recurrence', () => {
    const fd = new FailureDiagnostics({
      failure_history: [0, 1, 2].map(i => failure('flaky_test', i)),
    })
    const d = buildDigest(new StrategyState({ stall_reason: 'failure_recurrence' }), fd, new TaskGraph(), new WorldModel())
    expect(d.failure_classes).toEqual([{ class: 'flaky_test', count: 3 }])
  })

  it('risk_oscillation', () => {
    const ss = new StrategyState({
      stall_reason: 'risk_oscillation',
      risk_state_history: ['NORMAL', 'CAUTIOUS', 'NORMAL', 'CAUTIOUS'],
    })
    const d = buildDigest(ss, new FailureDiagnostics(), new TaskGraph(), new WorldModel())
    expect(d.stall_reason).toBe('risk_oscillation')
  })

  it('open_contradictions are HIGH only', () => {
    const wm = new WorldModel()
    wm.contradictions = [
      contradiction('hi', 'HIGH', 'real problem'),
      contradiction('lo', 'LOW', 'minor'),
    ]
    const d = buildDigest(new StrategyState(), new FailureDiagnostics(), new TaskGraph(), wm)
    expect(d.open_contradictions.some(c => c.startsWith('hi:'))).toBe(true)
    expect(d.open_contradictions.some(c => c.startsWith('lo:'))).toBe(false)
  })
})

// ── S2 — driveMainLoop wiring helper ────────────────────────────────────────

describe('coerceForWiredActions (S2)', () => {
  it('passes REDIRECT_STRATEGY / REFRAME_PLAN / CONTINUE through unchanged', () => {
    const r = new SupervisorDirective({ action: 'REDIRECT_STRATEGY', rationale: 'x', strategy_hint: 'TRACE_EXEC' })
    expect(coerceForWiredActions(r)).toBe(r)
    expect(coerceForWiredActions(SupervisorDirective.cont('ok')).action).toBe('CONTINUE')
  })

  // Every action is wired as of S3 — GATHER_EVIDENCE (S5) and ABORT/ASK_USER (S6/S3) are
  // all handled by driveMainLoop (investigation / EscalationHalt) after
  // resolveSupervisorDirective() returns, so coerceForWiredActions never rewrites them.
  it('passes ASK_USER through unchanged (S3 — driveMainLoop throws EscalationHalt)', () => {
    const d = new SupervisorDirective({
      action: 'ASK_USER',
      rationale: 'the reason',
      question: new UserQuestion({ question: 'which env?', options: ['staging', 'production'] }),
    })
    expect(coerceForWiredActions(d)).toBe(d)
    expect(d.action).toBe('ASK_USER')
    expect(d.question?.question).toBe('which env?')
  })

  it('passes GATHER_EVIDENCE through unchanged (S5 — wired downstream)', () => {
    const d = new SupervisorDirective({
      action: 'GATHER_EVIDENCE',
      rationale: 'need a fact',
      investigation: new InvestigationRequest({ question: 'which port?', suggested_tools: ['retrieve'], budget: 2 }),
    })
    expect(coerceForWiredActions(d)).toBe(d)
  })

  it('passes ABORT through unchanged (S6 — driveMainLoop throws EscalationHalt)', () => {
    const d = new SupervisorDirective({ action: 'ABORT', rationale: 'unrecoverable' })
    expect(coerceForWiredActions(d)).toBe(d)
  })
})

describe('resolveSupervisorDirective (S2)', () => {
  const digest = new TrajectoryDigest({ stall_reason: 'strategy_loop' }).toJSON()

  it('returns the coerced directive and reports it once', async () => {
    const seen: SupervisorDirective[] = []
    const d = await resolveSupervisorDirective(
      async () => ({ action: 'REDIRECT_STRATEGY', rationale: 'pivot', strategy_hint: 'REIMPLEMENT' }),
      digest,
      x => seen.push(x),
    )
    expect(d.action).toBe('REDIRECT_STRATEGY')
    expect(seen).toEqual([d])
  })

  it('a rejecting decider fails open to CONTINUE', async () => {
    const d = await resolveSupervisorDirective(async () => {
      throw new Error('LLM down')
    }, digest)
    expect(d.action).toBe('CONTINUE')
  })

  it('a null / malformed body fails open to CONTINUE', async () => {
    expect((await resolveSupervisorDirective(async () => null, digest)).action).toBe('CONTINUE')
    expect(
      (await resolveSupervisorDirective(async () => ({ action: 'NONSENSE' as never }), digest)).action,
    ).toBe('CONTINUE')
  })

  it('a wired ASK_USER from the decider passes through with its question intact (S3)', async () => {
    const d = await resolveSupervisorDirective(
      async () => ({ action: 'ASK_USER', rationale: 'stop', question: { question: 'which env?', options: ['a', 'b'] } }),
      digest,
    )
    expect(d.action).toBe('ASK_USER')
    expect(d.question?.question).toBe('which env?')
    expect(d.question?.options).toEqual(['a', 'b'])
  })

  it('a wired ABORT from the decider passes through (driveMainLoop escalates on it — S6)', async () => {
    const d = await resolveSupervisorDirective(async () => ({ action: 'ABORT', rationale: 'stop' }), digest)
    expect(d.action).toBe('ABORT')
  })

  it('a throwing onDirective handler is swallowed — the directive still returns', async () => {
    const d = await resolveSupervisorDirective(
      async () => ({ action: 'CONTINUE', rationale: 'ok' }),
      digest,
      () => {
        throw new Error('handler bug')
      },
    )
    expect(d.action).toBe('CONTINUE')
  })
})

// ── S6 — Q3 resolved (a): the supervisor never influences resolveControlState() ──

describe('Q3 (a) — supervisor stays out of the control-state resolver', () => {
  it('resolveControlState takes no supervisor / directive parameter', () => {
    const src = resolveControlState.toString()
    const paramList = src.slice(src.indexOf('('), src.indexOf(')') + 1).toLowerCase()
    expect(paramList).not.toContain('supervisor')
    expect(paramList).not.toContain('directive')
  })
})
