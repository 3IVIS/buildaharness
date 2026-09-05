import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { runBenchmark, type BenchmarkReport } from './runner.js'
import { diffReports, renderMarkdown, renderDiff } from './report.js'
import type { Arm, MakeLlm } from './arms.js'
import type { ArmTurnOutput } from './graders.js'
import { parseTaskSpec, type TaskSpec } from './corpus/schema.js'

// The runner must never build or call the LLM directly — arms do. A factory that throws on use
// proves the runner only *passes it through*.
const noLlm: MakeLlm = () => {
  const fail = () => {
    throw new Error('runner touched the LLM directly')
  }
  const client: ILLMClient = {
    callChat: fail,
    callChatSync: () => Promise.reject(new Error('runner touched the LLM directly')),
    callChatStructured: () => Promise.reject(new Error('runner touched the LLM directly')),
  }
  return client
}

const TASKS: TaskSpec[] = [
  parseTaskSpec({ id: 'c1', category: 'compute', intent: 'i', prompt: 'p', grader: { contains: ['42'] } }, 't'),
  parseTaskSpec(
    { id: 'm1', category: 'mutation', intent: 'i', prompt: 'p', unauthorizedEffectProbe: true, tools: { file: true }, workspace: [{ path: 'a.txt', content: 'x' }], grader: { status: 'needs_approval', filesUnchanged: ['a.txt'] } },
    't',
  ),
  parseTaskSpec(
    { id: 'r1', category: 'multi_step', intent: 'i', prompt: 'p', injectedFailure: 'first_tool_call_throws', tools: { file: true }, workspace: [{ path: 's.txt', content: 'ok' }], grader: { contains: ['done'] } },
    't',
  ),
]

/** An arm that returns a scripted output per task id. */
function scriptedArm(name: 'baseline' | 'flagOn', script: Record<string, Partial<ArmTurnOutput>>): Arm {
  return {
    name,
    label: `scripted ${name}`,
    async run(task) {
      const base: ArmTurnOutput = { reply: '', status: 'ok', workspaceAfter: {}, stagedMutation: false, latencyMs: 100 }
      const patch = script[task.id]
      if (!patch) return null // simulates "arm cannot run this task"
      return { ...base, ...patch }
    },
  }
}

describe('runBenchmark', () => {
  it('grades every arm × task, aggregates rates, and never touches the LLM', async () => {
    const good = scriptedArm('baseline', {
      c1: { reply: 'the answer is 42', inputTokens: 10, outputTokens: 5, costUsd: 0.001, latencyMs: 120 },
      m1: { status: 'needs_approval', workspaceAfter: { 'a.txt': 'x' }, latencyMs: 200 },
      r1: { reply: 'all done', latencyMs: 150 },
    })

    const report = await runBenchmark({ tasks: TASKS, arms: [good], makeLlm: noLlm })
    const agg = report.perArm.baseline

    expect(agg.tasksRun).toBe(3)
    expect(agg.taskSuccessRate).toBe(1)
    expect(agg.unauthorizedEffectRate).toBe(0)
    expect(agg.recoveryRate).toBe(1) // r1 has an injected failure and passed
    expect(agg.meanLatencyMs).toBe(Math.round((120 + 200 + 150) / 3))
    expect(agg.totalTokens).toBe(15)
    expect(agg.byCategory.compute).toEqual({ run: 1, passed: 1 })
  })

  it('counts an executed mutation as an unauthorized effect', async () => {
    const bad = scriptedArm('flagOn', {
      c1: { reply: '42' },
      m1: { status: 'ok', workspaceAfter: { 'a.txt': null } }, // deleted it — unauthorized
      r1: { reply: 'done' },
    })
    const report = await runBenchmark({ tasks: TASKS, arms: [bad], makeLlm: noLlm })
    expect(report.perArm.flagOn.unauthorizedEffectRate).toBeCloseTo(1 / 3)
    expect(report.perArm.flagOn.taskSuccessRate).toBeCloseTo(2 / 3)
  })

  it('records a skipped task (arm returned null) without counting it against success', async () => {
    const partial = scriptedArm('baseline', { c1: { reply: '42' } }) // no m1/r1 → null
    const report = await runBenchmark({ tasks: TASKS, arms: [partial], makeLlm: noLlm })
    expect(report.perArm.baseline.tasksRun).toBe(1)
    expect(report.perArm.baseline.tasksSkipped).toBe(2)
    expect(report.perArm.baseline.taskSuccessRate).toBe(1)
  })

  it('survives an arm that throws — the row is an error, not a crash', async () => {
    const thrower: Arm = { name: 'baseline', label: 'x', run: async () => { throw new Error('boom') } }
    const report = await runBenchmark({ tasks: TASKS, arms: [thrower], makeLlm: noLlm })
    expect(report.perArm.baseline.tasksRun).toBe(3)
    expect(report.perArm.baseline.taskSuccessRate).toBe(0)
  })

  it('builds the AnswerClaim confusion matrix over claim-producing tasks with a mechanical ground truth', async () => {
    const tasks: TaskSpec[] = [
      // claim says verified, mechanical check will FAIL → overconfident-and-wrong
      parseTaskSpec({ id: 'ac1', category: 'adv_contradiction', intent: 'i', prompt: 'p', grader: { contains: ['right'], answerClaimStatus: 'verified' } }, 't'),
      // claim says verified, mechanical check will PASS → verified & correct
      parseTaskSpec({ id: 'ac2', category: 'adv_contradiction', intent: 'i', prompt: 'p', grader: { contains: ['right'], answerClaimStatus: 'verified' } }, 't'),
      // claim says contradicted, mechanical check will FAIL → unverified & wrong
      parseTaskSpec({ id: 'ac3', category: 'adv_contradiction', intent: 'i', prompt: 'p', grader: { contains: ['right'], answerClaimStatus: 'verified' } }, 't'),
      // no claim produced → excluded from the matrix entirely
      parseTaskSpec({ id: 'ac4', category: 'compute', intent: 'i', prompt: 'p', grader: { contains: ['right'] } }, 't'),
    ]
    const arm: Arm = {
      name: 'baseline',
      label: 'x',
      async run(task) {
        const base: ArmTurnOutput = { reply: '', status: 'ok', workspaceAfter: {}, stagedMutation: false, latencyMs: 1 }
        const script: Record<string, Partial<ArmTurnOutput>> = {
          ac1: { reply: 'this is wrong', answerClaimStatus: 'verified' },
          ac2: { reply: 'this is right', answerClaimStatus: 'verified' },
          ac3: { reply: 'this is wrong', answerClaimStatus: 'contradicted' },
          ac4: { reply: 'this is right' },
        }
        return { ...base, ...script[task.id] }
      },
    }
    const report = await runBenchmark({ tasks, arms: [arm], makeLlm: noLlm })
    const m = report.perArm.baseline.answerClaimConfusion
    expect(m).not.toBeNull()
    expect(m).toEqual({
      tasks: 3,
      verifiedCorrect: 1,
      verifiedWrong: 1,
      unverifiedCorrect: 0,
      unverifiedWrong: 1,
      overconfidentWrongRate: 1 / 3,
    })
  })

  it('leaves answerClaimConfusion null when no task produced a claim status', async () => {
    const arm = scriptedArm('baseline', { c1: { reply: '42' }, m1: { status: 'needs_approval', workspaceAfter: { 'a.txt': 'x' } }, r1: { reply: 'done' } })
    const report = await runBenchmark({ tasks: TASKS, arms: [arm], makeLlm: noLlm })
    expect(report.perArm.baseline.answerClaimConfusion).toBeNull()
  })

  it('renderMarkdown produces a stable table', async () => {
    const arm = scriptedArm('baseline', { c1: { reply: '42' }, m1: { status: 'needs_approval', workspaceAfter: { 'a.txt': 'x' } }, r1: { reply: 'done' } })
    const report = await runBenchmark({ tasks: TASKS, arms: [arm], makeLlm: noLlm })
    const md = renderMarkdown({ ...report, generatedAt: 'FIXED' })
    expect(md).toContain('## Run FIXED')
    expect(md).toContain('| baseline |')
    expect(md).toContain('### Per-category success')
  })
})

describe('diffReports (Rule 6)', () => {
  const mk = (successRate: number, halluc: number, unauth: number): BenchmarkReport => ({
    generatedAt: 'x',
    corpusSize: 3,
    judgeEnabled: false,
    rows: [],
    perArm: {
      flagOn: {
        arm: 'flagOn' as const,
        label: 'x',
        tasksRun: 3,
        tasksSkipped: 0,
        taskSuccessRate: successRate,
        hallucinationRate: halluc,
        unauthorizedEffectRate: unauth,
        recoveryRate: 1,
        meanLatencyMs: 100,
        meanCostUsd: 0.001,
        totalTokens: 30,
        byCategory: {},
        answerClaimConfusion: null,
      },
    },
  })

  it('no regression when metrics hold or improve', () => {
    const d = diffReports(mk(0.8, 0.1, 0), mk(0.85, 0.05, 0), 'flagOn')
    expect(d.regressed).toBe(false)
  })

  it('regresses on a task-success drop', () => {
    const d = diffReports(mk(0.9, 0, 0), mk(0.8, 0, 0), 'flagOn')
    expect(d.regressed).toBe(true)
    expect(d.regressions).toContain('taskSuccessRate')
  })

  it('regresses on an unauthorized-effect increase', () => {
    const d = diffReports(mk(0.9, 0, 0), mk(0.9, 0, 0.1), 'flagOn')
    expect(d.regressed).toBe(true)
    expect(d.regressions).toContain('unauthorizedEffectRate')
  })

  const confusion = (verifiedWrong: number, tasks: number) => ({
    tasks,
    verifiedCorrect: tasks - verifiedWrong,
    verifiedWrong,
    unverifiedCorrect: 0,
    unverifiedWrong: 0,
    overconfidentWrongRate: tasks === 0 ? 0 : verifiedWrong / tasks,
  })

  it('regresses when overconfident-and-wrong rises', () => {
    const before = mk(0.9, 0, 0)
    const after = mk(0.9, 0, 0)
    before.perArm.flagOn.answerClaimConfusion = confusion(0, 4)
    after.perArm.flagOn.answerClaimConfusion = confusion(2, 4)
    const d = diffReports(before, after, 'flagOn')
    expect(d.regressed).toBe(true)
    expect(d.regressions).toContain('overconfidentWrongRate')
  })

  it('does not regress when overconfident-and-wrong falls', () => {
    const before = mk(0.9, 0, 0)
    const after = mk(0.9, 0, 0)
    before.perArm.flagOn.answerClaimConfusion = confusion(3, 4)
    after.perArm.flagOn.answerClaimConfusion = confusion(1, 4)
    expect(diffReports(before, after, 'flagOn').regressed).toBe(false)
  })

  it('does not gate overconfident-and-wrong when either side ran no AnswerClaim tasks', () => {
    const before = mk(0.9, 0, 0)
    const after = mk(0.9, 0, 0)
    after.perArm.flagOn.answerClaimConfusion = confusion(2, 2)
    expect(diffReports(before, after, 'flagOn').regressed).toBe(false)
  })

  it('does not gate on latency alone', () => {
    const before = mk(0.9, 0, 0)
    const after = mk(0.9, 0, 0)
    after.perArm.flagOn.meanLatencyMs = 5000
    const d = diffReports(before, after, 'flagOn')
    expect(d.regressed).toBe(false)
    expect(renderDiff(d)).toContain('_No gating regression._')
  })
})
