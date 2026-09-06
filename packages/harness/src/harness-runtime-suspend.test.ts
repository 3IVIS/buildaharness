import { describe, it, expect } from 'vitest'
import { HarnessRuntime, type GateDecisionEvent } from './harness-runtime.js'
import { CHECKPOINT_SCHEMA_VERSION, CHECKPOINT_MIGRATIONS, type HarnessCheckpoint, type PendingProposalData } from './harness-checkpoint.js'
import type { ContinuableExecutionOutcome } from './nodes/execute.js'
import type { Task } from './state/task-graph.js'
import { EscalationHalt } from './nodes/escalate.js'

// Phase D1 — the "not done" signal: execute.ts's ContinuableExecutionOutcome, the
// pendingProposal suspend point reused for a 'continue' outcome, the BLOCK/ESCALATE
// consequence surfaced via onGateDecision, and the v1→v2 checkpoint migration this phase
// introduces. See plans/harness_consolidation_and_control_plane_plan.html, Phase D1.

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    description: `Task ${id}`,
    status: 'PENDING',
    risk_level: 'LOW',
    depends_on: [],
    parallel_write_domains: [],
    abstraction_level: 1,
    assigned_strategy: null,
    ...overrides,
  }
}

/** A toolFn that reports 'continue' `continueTimes` times, then 'complete'. */
function makeMultiStepToolFn(continueTimes: number): () => ContinuableExecutionOutcome {
  let calls = 0
  return () => {
    calls++
    if (calls <= continueTimes) {
      return { __harnessExecutionStatus: 'continue', output: { step: calls } }
    }
    return { __harnessExecutionStatus: 'complete', output: { step: calls, done: true } }
  }
}

describe('Phase D1 — continue outcome', () => {
  it('a toolFn reporting continue keeps the task RUNNING and the run eventually completes', async () => {
    const rt = new HarnessRuntime()
    const outcome = await rt.run('multi-step objective', ['done'], {
      initialTasks: [makeTask('t1')],
      max_steps: 20,
      toolExecutors: { default: makeMultiStepToolFn(2) },
    })

    expect(outcome.status).toBe('complete')
    if (outcome.status !== 'complete') throw new Error('unreachable')
    expect(outcome.result.initResult.taskGraph.tasks[0].status).toBe('COMPLETE')
    expect(outcome.result.finalResult).toEqual({ step: 3, done: true })
  })

  it('a toolFn that keeps reporting continue forever still hits the maxSteps backstop instead of spinning forever', async () => {
    // Regression: the pendingProposal resume branch (kind: 'continuation') used to never
    // increment stepsUsed or check maxSteps — only the fresh-iteration path did — so this
    // toolFn (never resolves to 'complete') would previously run unbounded.
    const rt = new HarnessRuntime()

    let caught: unknown
    try {
      await rt.run('never finishes objective', ['done'], {
        initialTasks: [makeTask('t1')],
        max_steps: 3,
        toolExecutors: { default: makeMultiStepToolFn(1000) },
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(EscalationHalt)
    expect((caught as EscalationHalt).blocker.reason).toBe('budget_exhausted')
  })

  it('pauses at a checkpoint mid-continue, and the checkpoint carries a continuation-kind pendingProposal', async () => {
    const rt = new HarnessRuntime()
    let sawContinuationCheckpoint = false

    const paused = await rt.run('multi-step objective', ['done'], {
      initialTasks: [makeTask('t1')],
      max_steps: 20,
      toolExecutors: { default: makeMultiStepToolFn(2) },
      shouldPause: (checkpoint) => {
        if (checkpoint.progress.pendingProposal?.kind === 'continuation') {
          sawContinuationCheckpoint = true
          return true
        }
        return false
      },
    })

    expect(sawContinuationCheckpoint).toBe(true)
    expect(paused.status).toBe('paused')
    if (paused.status !== 'paused') throw new Error('unreachable')
    expect(paused.checkpoint.progress.pendingProposal?.kind).toBe('continuation')
    // The task is still RUNNING — it has not been marked complete or failed.
    expect(paused.checkpoint.runState.taskGraph.tasks[0].status).toBe('RUNNING')
  })

  it('resumes a paused continuation across a simulated process restart (JSON round-trip) and reaches completion', async () => {
    const rt = new HarnessRuntime()
    const paused = await rt.run('multi-step objective', ['done'], {
      initialTasks: [makeTask('t1')],
      max_steps: 20,
      toolExecutors: { default: makeMultiStepToolFn(2) },
      shouldPause: (checkpoint) => checkpoint.progress.pendingProposal?.kind === 'continuation',
    })
    expect(paused.status).toBe('paused')
    if (paused.status !== 'paused') throw new Error('unreachable')

    const serialized: HarnessCheckpoint = JSON.parse(JSON.stringify(paused.checkpoint))
    const resumed = await rt.resume(serialized, {
      max_steps: 20,
      toolExecutors: { default: makeMultiStepToolFn(2) },
    })

    expect(resumed.status).toBe('complete')
    if (resumed.status !== 'complete') throw new Error('unreachable')
    expect(resumed.result.initResult.taskGraph.tasks[0].status).toBe('COMPLETE')
  })

  it('two turns can each hold their own suspended continuation independently (concurrent-turn)', async () => {
    const rtA = new HarnessRuntime()
    const rtB = new HarnessRuntime()

    const [pausedA, pausedB] = await Promise.all([
      rtA.run('objective A', ['done'], {
        initialTasks: [makeTask('a1')],
        max_steps: 20,
        toolExecutors: { default: makeMultiStepToolFn(1) },
        shouldPause: (checkpoint) => checkpoint.progress.pendingProposal?.kind === 'continuation',
      }),
      rtB.run('objective B', ['done'], {
        initialTasks: [makeTask('b1')],
        max_steps: 20,
        toolExecutors: { default: makeMultiStepToolFn(1) },
        shouldPause: (checkpoint) => checkpoint.progress.pendingProposal?.kind === 'continuation',
      }),
    ])

    expect(pausedA.status).toBe('paused')
    expect(pausedB.status).toBe('paused')
    if (pausedA.status !== 'paused' || pausedB.status !== 'paused') throw new Error('unreachable')
    expect(pausedA.checkpoint.progress.pendingProposal?.taskId).toBe('a1')
    expect(pausedB.checkpoint.progress.pendingProposal?.taskId).toBe('b1')

    const [resumedA, resumedB] = await Promise.all([
      rtA.resume(pausedA.checkpoint, { max_steps: 20, toolExecutors: { default: makeMultiStepToolFn(1) } }),
      rtB.resume(pausedB.checkpoint, { max_steps: 20, toolExecutors: { default: makeMultiStepToolFn(1) } }),
    ])
    expect(resumedA.status).toBe('complete')
    expect(resumedB.status).toBe('complete')
  })

  it('a plain, non-opted-in toolFn return is unaffected — still resolves to a single-shot complete', async () => {
    const rt = new HarnessRuntime()
    const outcome = await rt.run('single-shot objective', ['done'], {
      initialTasks: [makeTask('t1')],
      max_steps: 5,
      toolExecutors: { default: () => ({ completed: true }) },
    })
    expect(outcome.status).toBe('complete')
    if (outcome.status !== 'complete') throw new Error('unreachable')
    expect(outcome.result.initResult.taskGraph.tasks[0].status).toBe('COMPLETE')
  })

  it('a non-throwing failed status gets the same FAILED task treatment a thrown error gets', async () => {
    const rt = new HarnessRuntime()
    const outcome = await rt.run('failing objective', ['done'], {
      initialTasks: [makeTask('t1')],
      max_steps: 5,
      toolExecutors: {
        default: (): ContinuableExecutionOutcome => ({ __harnessExecutionStatus: 'failed', error: 'boom' }),
      },
    })
    expect(outcome.status).toBe('complete')
    if (outcome.status !== 'complete') throw new Error('unreachable')
    // rollback_replan ran (recovery), not a straight COMPLETE.
    expect(outcome.result.initResult.taskGraph.tasks[0].status).not.toBe('COMPLETE')
  })
})

describe('Phase D1 — onGateDecision', () => {
  it('fires with the specific BLOCK decision and reason instead of leaving it invisible to the caller', async () => {
    const rt = new HarnessRuntime()
    const events: GateDecisionEvent[] = []

    // A task the classifier considers HIGH risk, with a permission-DENY control-state note the
    // resolver produces for a low-confidence, low-coverage run — enough to route through BLOCK
    // deterministically rather than trying to force it via internal state directly.
    const tasks = [makeTask('t1', { risk_level: 'HIGH' })]

    await rt.run('risky objective', [], {
      initialTasks: tasks,
      max_steps: 3,
      toolExecutors: { default: () => ({ completed: true }) },
      onGateDecision: (event) => events.push(event),
    }).catch(() => {
      // A BLOCK that can't make progress escalates (EscalationHalt) — still exercises the event.
    })

    // Whether or not this particular run reaches a BLOCK depends on resolver internals not
    // stubbed here; assert the callback is at least wired with the right shape when it does fire.
    for (const event of events) {
      expect(['BLOCK', 'ESCALATE']).toContain(event.result)
      expect(event.taskId).toBe('t1')
      expect(typeof event.haltedRun).toBe('boolean')
    }
  })

  // The test above tolerates zero firings (its comment says so). This one forces a real BLOCK
  // end-to-end through the public HarnessRuntime.run() surface with nothing about the control
  // state stubbed — the follow-up the Phase D1 implementation note in
  // plans/harness_consolidation_and_control_plane_plan.html asked for ("a stronger test that
  // actually drives a real BLOCK end-to-end is a good follow-up").
  it('fires with a real BLOCK when a SYSTEM_BREAKING contradiction denies the gate — no resolver stubbing', async () => {
    const rt = new HarnessRuntime()
    const events: GateDecisionEvent[] = []
    let checkerCalls = 0

    // t1 executes and its two extracted facts become two INFERENCE beliefs. On the next
    // iteration (t2) the contradiction checker runs — it has >=2 new beliefs — and reports the
    // pair as irreconcilable. recordExternalContradiction pushes a SYSTEM_BREAKING contradiction,
    // which is Tier 1 of resolveControlState: permission -> DENY, so actionGate returns BLOCK for
    // t2. The block is a genuine consequence of state the run itself produced, not an injected
    // ControlState.
    await rt.run('reconcile the two ledgers', ['done'], {
      initialTasks: [makeTask('t1'), makeTask('t2', { depends_on: ['t1'] })],
      max_steps: 8,
      toolExecutors: { default: () => ({ completed: true }) },
      factExtractor: () => [
        { statement: 'The Q3 balance is $10,000', isNew: true },
        { statement: 'The Q3 balance is $40,000', isNew: true },
      ],
      contradictionChecker: async (newBeliefs) => {
        checkerCalls++
        if (newBeliefs.length < 2) return []
        return [{
          beliefIds: [newBeliefs[0].id, newBeliefs[1].id],
          description: 'The two stated Q3 balances cannot both be true',
          severity: 'SYSTEM_BREAKING',
        }]
      },
      onGateDecision: (event) => events.push(event),
    }).catch(() => {
      // A denied gate that also cannot make progress ends the run with EscalationHalt — the
      // event still fired before the throw, which is exactly what this test asserts.
    })

    expect(checkerCalls).toBeGreaterThan(0)
    const block = events.find((e) => e.result === 'BLOCK')
    expect(block, 'onGateDecision should have fired with a real BLOCK').toBeDefined()
    expect(block!.taskId).toBe('t2')
    expect(block!.reason).toBe('SYSTEM_BREAKING_CONTRADICTION')
    expect(typeof block!.haltedRun).toBe('boolean')
  })
})

describe('Phase D1 — INV-15: no execute without a gate decision in the same run', () => {
  it('every "execute" entry in nodeExecutionOrder is preceded by an action_gate (fresh or replayed) entry', async () => {
    const rt = new HarnessRuntime()
    const outcome = await rt.run('multi-step objective', ['done'], {
      initialTasks: [makeTask('t1')],
      max_steps: 20,
      toolExecutors: { default: makeMultiStepToolFn(2) },
    })
    expect(outcome.status).toBe('complete')
    if (outcome.status !== 'complete') throw new Error('unreachable')

    const order = outcome.result.nodeExecutionOrder
    let gateSeenSinceLastExecute = false
    for (const node of order) {
      if (node === 'action_gate' || node === 'action_gate_replay' || node === 'action_gate_replay_continuation') {
        gateSeenSinceLastExecute = true
      } else if (node === 'execute') {
        expect(gateSeenSinceLastExecute).toBe(true)
        gateSeenSinceLastExecute = false
      }
    }
  })
})

describe('Phase D1 — checkpoint schema v1 → v2 migration', () => {
  function makeV1Checkpoint(pendingProposal: Omit<PendingProposalData, 'kind'> | null): HarnessCheckpoint {
    return {
      runId: 'turn:v1-migration',
      runState: {} as HarnessCheckpoint['runState'],
      runConfig: { objective: 'obj', successCriteria: [], maxSteps: 10, depGraphBudget: {} as never, processConceptId: null },
      progress: {
        stepsUsed: 1,
        nodeExecutionOrder: [],
        finalResult: null,
        consecutiveReviewFailures: [],
        propagationQueue: { reopenedTaskIds: [] },
        pendingProposal: pendingProposal as unknown as PendingProposalData | null,
      },
      schemaVersion: 1,
    }
  }

  it('stamps kind: "proposal" onto a v1 pendingProposal and bumps schemaVersion to 2', () => {
    const v1 = makeV1Checkpoint({ taskId: 't1', gateResult: 'PASS', shouldGatherEvidence: false })
    const migrated = CHECKPOINT_MIGRATIONS[1](v1)
    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION)
    expect(migrated.progress.pendingProposal).toEqual({ taskId: 't1', gateResult: 'PASS', shouldGatherEvidence: false, kind: 'proposal' })
  })

  it('leaves a null pendingProposal null through the migration', () => {
    const v1 = makeV1Checkpoint(null)
    const migrated = CHECKPOINT_MIGRATIONS[1](v1)
    expect(migrated.progress.pendingProposal).toBeNull()
    expect(migrated.schemaVersion).toBe(2)
  })

  it('a v1 checkpoint round-trips through HarnessRuntime.resume() via the registered migration', async () => {
    const rt = new HarnessRuntime()
    // Get a real, fully-valid checkpoint (every state structure's actual fromJSON()-compatible
    // shape) by pausing a genuine run mid-continuation, then downgrade it to look like it was
    // written by a pre-D1 build: schemaVersion 1, pendingProposal missing `kind`.
    const paused = await rt.run('multi-step objective', ['done'], {
      initialTasks: [makeTask('t1')],
      max_steps: 20,
      toolExecutors: { default: makeMultiStepToolFn(2) },
      shouldPause: (checkpoint) => checkpoint.progress.pendingProposal?.kind === 'continuation',
    })
    expect(paused.status).toBe('paused')
    if (paused.status !== 'paused') throw new Error('unreachable')

    const legacyShaped = JSON.parse(JSON.stringify(paused.checkpoint)) as HarnessCheckpoint
    legacyShaped.schemaVersion = 1
    if (legacyShaped.progress.pendingProposal) {
      delete (legacyShaped.progress.pendingProposal as Partial<PendingProposalData>).kind
    }

    const resumed = await rt.resume(legacyShaped, { max_steps: 20, toolExecutors: { default: makeMultiStepToolFn(2) } })
    expect(resumed.status).toBe('complete')
    if (resumed.status !== 'complete') throw new Error('unreachable')
    expect(resumed.result.initResult.taskGraph.tasks[0].status).toBe('COMPLETE')
  })
})
