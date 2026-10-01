import { describe, it, expect } from 'vitest'
import { ControlState } from '@buildaharness/harness'
import { createTurnControlPlaneState, recordToolOutcome, toolAvailabilityManifest, moreRestrictiveControlState, controlStateToolPolicyEnabled, controlStateGateEnabled, type TurnControlPlaneState } from './tool-control-plane.js'

describe('toolAvailabilityManifest', () => {
  it('marks every named tool available', () => {
    const manifest = toolAvailabilityManifest(['web_search', 'read_file'])
    expect(manifest).toEqual({
      web_search: { available: true, fallback_tool: null },
      read_file: { available: true, fallback_tool: null },
    })
  })
})

describe('createTurnControlPlaneState', () => {
  it('starts at the same permissive baseline as the pre-evidence default (ALLOW/NORMAL/NONE)', () => {
    const state = createTurnControlPlaneState(['web_search'])
    expect(state.controlState.permission).toBe('ALLOW')
    expect(state.controlState.execution_mode).toBe('NORMAL')
    expect(state.controlState.escalation).toBe('NONE')
  })

  it('seeds the evidence store so gatherEvidence does not silently no-op for a configured tool', () => {
    const state = createTurnControlPlaneState(['web_search'])
    expect(state.evidenceStore.isToolAvailable('web_search')).toBe(true)
    expect(state.evidenceStore.isToolAvailable('some_unconfigured_tool')).toBe(false)
  })
})

describe('recordToolOutcome', () => {
  it('records a successful call as evidence without changing the baseline ControlState', () => {
    const state = createTurnControlPlaneState(['web_search'])
    const cs = recordToolOutcome(state, { toolName: 'web_search', ok: true, summary: 'web_search succeeded' })
    expect(state.evidenceStore.observations).toHaveLength(1)
    expect(cs.permission).toBe('ALLOW')
    expect(cs.execution_mode).toBe('NORMAL')
  })

  it('a single tool-call failure stays ALLOW — one failure is not a pattern', () => {
    const state = createTurnControlPlaneState(['read_file'])
    const cs = recordToolOutcome(state, { toolName: 'read_file', ok: false, summary: 'read_file failed: not found' })
    expect(cs.permission).toBe('ALLOW')
  })

  it('a few failures (fewer than the DENY boundary) stay ALLOW', () => {
    const state = createTurnControlPlaneState(['read_file'])
    let cs = state.controlState
    for (let i = 0; i < 5; i++) {
      cs = recordToolOutcome(state, { toolName: 'read_file', ok: false, summary: `read_file failed: attempt ${i}` })
    }
    expect(cs.permission).toBe('ALLOW')
    expect(state.failureDiagnostics.failure_history).toHaveLength(5)
  })

  it('exactly 7 same-turn tool failures still stay ALLOW (one below the pinned boundary)', () => {
    const state = createTurnControlPlaneState(['read_file'])
    let cs = state.controlState
    for (let i = 0; i < 7; i++) {
      cs = recordToolOutcome(state, { toolName: 'read_file', ok: false, summary: `read_file failed: attempt ${i}` })
    }
    expect(cs.permission).toBe('ALLOW')
  })

  it('8 same-turn tool failures cross CRITICAL_THRESHOLD and flip permission to DENY (RECOVERY mode) — pinned boundary, not the 9 a back-of-envelope reading would suggest (see this file\'s own doc comment: a floating-point rounding quirk already present in resolve-control-state.ts, not introduced here, trips one failure earlier than exact decimal math)', () => {
    const state = createTurnControlPlaneState(['read_file'])
    let cs = state.controlState
    for (let i = 0; i < 8; i++) {
      cs = recordToolOutcome(state, { toolName: 'read_file', ok: false, summary: `read_file failed: attempt ${i}` })
    }
    expect(cs.permission).toBe('DENY')
    expect(cs.execution_mode).toBe('RECOVERY')
    // A single blocked dimension can't form a cycle in the recovery-action dependency graph, so
    // this should be a plain DENY, not an escalation.
    expect(cs.escalation).toBe('NONE')
  })

  it('the first tool call of a turn always sees the fresh, unaffected baseline (no leakage across turns)', () => {
    const priorTurnState = createTurnControlPlaneState(['read_file'])
    for (let i = 0; i < 9; i++) {
      recordToolOutcome(priorTurnState, { toolName: 'read_file', ok: false, summary: `read_file failed: attempt ${i}` })
    }
    expect(priorTurnState.controlState.permission).toBe('DENY')

    const freshState = createTurnControlPlaneState(['read_file'])
    expect(freshState.controlState.permission).toBe('ALLOW')
  })

  it('pins coverage_health and the other execution_health sub-dimensions at their constructor-safe defaults — regression guard against reintroducing a spurious DENY via updateDiagnostics()', () => {
    const state = createTurnControlPlaneState(['read_file'])
    for (let i = 0; i < 9; i++) {
      recordToolOutcome(state, { toolName: 'read_file', ok: false, summary: `read_file failed: attempt ${i}` })
    }
    expect(state.diagnostics.coverage_health).toEqual({ symptom_coverage: 0.5, explanation_coverage: 0.5 })
    expect(state.diagnostics.execution_health.progress_rate).toBe(1.0)
    expect(state.diagnostics.execution_health.oscillation_score).toBe(0.0)
  })

  it('a tool unavailable in the manifest is not recorded as evidence but is still tracked as a failure', () => {
    const state = createTurnControlPlaneState(['web_search'])
    recordToolOutcome(state, { toolName: 'not_in_manifest', ok: false, summary: 'unexpected tool' })
    expect(state.evidenceStore.observations).toHaveLength(0)
    expect(state.failureDiagnostics.failure_history).toHaveLength(1)
  })
})

describe('moreRestrictiveControlState', () => {
  const allow = () => new ControlState()
  const cautious = () => new ControlState({ execution_mode: 'CAUTIOUS' })
  const humanRequired = () => new ControlState({ escalation: 'HUMAN_REQUIRED' })
  const deny = () => new ControlState({ permission: 'DENY', execution_mode: 'RECOVERY' })

  it('keeps a DENY over any lesser state, in either argument position', () => {
    expect(moreRestrictiveControlState(deny(), allow()).permission).toBe('DENY')
    expect(moreRestrictiveControlState(allow(), deny()).permission).toBe('DENY')
    expect(moreRestrictiveControlState(deny(), humanRequired()).permission).toBe('DENY')
  })

  it('a HUMAN_REQUIRED escalation outranks a plain CAUTIOUS or ALLOW', () => {
    expect(moreRestrictiveControlState(cautious(), humanRequired()).escalation).toBe('HUMAN_REQUIRED')
    expect(moreRestrictiveControlState(humanRequired(), allow()).escalation).toBe('HUMAN_REQUIRED')
  })

  it('CAUTIOUS outranks ALLOW', () => {
    expect(moreRestrictiveControlState(allow(), cautious()).execution_mode).toBe('CAUTIOUS')
  })

  it('a tie returns the first argument (the turn-local accumulated state the one-loop proposer passes first)', () => {
    const a = deny()
    expect(moreRestrictiveControlState(a, deny())).toBe(a)
  })

  it('regression: a fresh harness ALLOW must not erase a turn-local DENY earned from repeated failures', () => {
    // The exact shape AgentLoop.createHarnessProposer folds each iteration: the turn-local
    // ControlState (after 8+ same-turn tool failures -> DENY) vs the harness's own per-iteration
    // ControlState (which never saw those failures as its own evidence -> ALLOW).
    const turnLocalAfterFailures = deny()
    const freshHarnessState = allow()
    expect(moreRestrictiveControlState(turnLocalAfterFailures, freshHarnessState).permission).toBe('DENY')
  })
})

describe('control_state ablation — AUDIT_CONTROL_STATE_TOOL_POLICY / _GATE (eval-only)', () => {
  it('both gates default ON for unset/empty/truthy values and OFF only for falsy ones', () => {
    for (const [fn, key] of [
      [controlStateToolPolicyEnabled, 'AUDIT_CONTROL_STATE_TOOL_POLICY'],
      [controlStateGateEnabled, 'AUDIT_CONTROL_STATE_GATE'],
    ] as const) {
      expect(fn({})).toBe(true)
      expect(fn({ [key]: '' })).toBe(true)
      for (const v of ['1', 'true', 'on', 'enabled']) expect(fn({ [key]: v }), `${key}=${v}`).toBe(true)
      for (const v of ['0', 'false', 'off', 'no', 'disabled', ' OFF ']) expect(fn({ [key]: v }), `${key}=${v}`).toBe(false)
    }
  })

  it('the two switches are independent', () => {
    expect(controlStateToolPolicyEnabled({ AUDIT_CONTROL_STATE_GATE: '0' })).toBe(true)
    expect(controlStateGateEnabled({ AUDIT_CONTROL_STATE_TOOL_POLICY: '0' })).toBe(true)
  })

  it('pinNormal: 8 failures still record evidence and failures but never leave ALLOW/NORMAL', () => {
    const state = createTurnControlPlaneState(['read_file'], { pinNormal: true })
    let cs = state.controlState
    for (let i = 0; i < 8; i++) {
      cs = recordToolOutcome(state, { toolName: 'read_file', ok: false, summary: `read_file failed: attempt ${i}` })
    }
    expect(state.failureDiagnostics.failure_history).toHaveLength(8)
    expect(cs.permission).toBe('ALLOW')
    expect(cs.execution_mode).toBe('NORMAL')
  })

  it('without pinNormal the identical sequence is DENY (so the pinned case above is not vacuous)', () => {
    const state = createTurnControlPlaneState(['read_file'])
    let cs = state.controlState
    for (let i = 0; i < 8; i++) {
      cs = recordToolOutcome(state, { toolName: 'read_file', ok: false, summary: `read_file failed: attempt ${i}` })
    }
    expect(cs.permission).toBe('DENY')
  })
})

describe('negative answers (a missing file) are information, not faults', () => {
  const negative = (state: TurnControlPlaneState, path: string) =>
    recordToolOutcome(state, { toolName: 'read_file', ok: true, negative: true, callKey: `read_file:${JSON.stringify({ path })}`, summary: `read_file found nothing: ${path}` })

  it('many DIFFERENT missing paths never close the gate', () => {
    const state = createTurnControlPlaneState(['read_file'])
    for (let i = 0; i < 30; i++) negative(state, `guess-${i}.conf`)
    expect(state.controlState.permission).toBe('ALLOW')
    expect(state.failureDiagnostics.failure_history).toHaveLength(0)
  })

  it('the same missing path asked for again and again is a retry: the first two are free, then failures count and the gate closes', () => {
    const state = createTurnControlPlaneState(['read_file'])
    negative(state, 'gone.txt')
    negative(state, 'gone.txt')
    expect(state.failureDiagnostics.failure_history).toHaveLength(0)
    negative(state, 'gone.txt')
    expect(state.failureDiagnostics.failure_history).toHaveLength(1)
    for (let i = 0; i < 7; i++) negative(state, 'gone.txt')
    expect(state.failureDiagnostics.failure_history).toHaveLength(8)
    expect(state.controlState.permission).toBe('DENY')
  })

  it('a real error still counts every time (unchanged): 8 of them close the gate', () => {
    const state = createTurnControlPlaneState(['read_file'])
    for (let i = 0; i < 8; i++) recordToolOutcome(state, { toolName: 'read_file', ok: false, callKey: `read_file:${i}`, summary: 'read_file failed: EACCES' })
    expect(state.controlState.permission).toBe('DENY')
  })

  it('a negative answer is recorded as an observation, not a system error, so it does not dent tool reliability', () => {
    const state = createTurnControlPlaneState(['read_file'])
    negative(state, 'a.txt')
    expect(state.evidenceStore.observations.at(-1)?.evidence_type).not.toBe('SYSTEM_ERROR')
  })
})
