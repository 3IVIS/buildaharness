import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ILLMClient } from '@buildaharness/runtime'
import { runBenchmark, resolveTranscriptDir, invalidRateViolations, invalidRateMessage, type BenchmarkReport } from './runner.js'
import { loadCorpus } from './corpus/index.js'
import { stubJudge } from './judge-stub.js'
import type { Arm, MakeLlm } from './arms.js'
import type { ArmTurnOutput } from './graders.js'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const noLlm: MakeLlm = () => ({ callChat: () => Promise.reject(new Error('x')), callChatSync: () => Promise.reject(new Error('x')), callChatStructured: () => Promise.reject(new Error('x')) }) as unknown as ILLMClient

describe('AL-6 evidence hygiene', () => {
  it('resolves a transcript directory by default, next to the report', () => {
    expect(resolveTranscriptDir({ reportsDir: '/r', stamp: 'S' })).toBe('/r/S.transcripts')
    expect(resolveTranscriptDir({ reportsDir: '/r', stamp: 'S', out: '/x/run.json' })).toBe('/x/run.transcripts')
    expect(resolveTranscriptDir({ reportsDir: '/r', stamp: 'S', transcripts: '/t' })).toBe('/t')
  })

  it('has no resolvable directory when --transcripts= is empty', () => {
    expect(resolveTranscriptDir({ reportsDir: '/r', stamp: 'S', transcripts: '' })).toBeUndefined()
  })

  it('the benchmark script exits 2 when no transcript directory is resolvable', () => {
    const res = spawnSync('npx', ['tsx', 'scripts/run-harness-benchmark.ts', '--transcripts=', '--seeds=3'], { cwd: PKG_ROOT, encoding: 'utf8', timeout: 90_000 })
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('transcripts')
  }, 100_000)

  it('flags an arm with >5% invalid rows and not one at or under it', async () => {
    const tasks = loadCorpus().slice(0, 20)
    const mk = (invalidEvery: number): Arm => ({
      name: 'flagOn',
      label: 'scripted',
      async run(task) {
        const idx = tasks.findIndex((t) => t.id === task.id)
        const out: ArmTurnOutput = { reply: 'ok', status: idx % invalidEvery === 0 ? 'error' : 'ok', workspaceAfter: {}, stagedMutation: false, latencyMs: 1 }
        return out
      },
    })
    const bad = await runBenchmark({ tasks, arms: [mk(2)], makeLlm: noLlm, judge: stubJudge({}) })
    const v = invalidRateViolations(bad)
    expect(v).toHaveLength(1)
    expect(invalidRateMessage(v)).toContain('Re-run those rows before reading any result')

    const fine: BenchmarkReport = { ...bad, perArm: { flagOn: { ...bad.perArm.flagOn, tasksInvalid: 1 } }, rows: bad.rows.map((r) => ({ ...r, invalid: false })) }
    // 1 invalid of 20 ran rows = 5% — at the limit, not over it.
    expect(invalidRateViolations({ ...fine, rows: fine.rows.slice(0, 20) })).toHaveLength(0)
  })
})

describe('audit-change-review-control-small-purchase', () => {
  const task = loadCorpus().find((t) => t.id === 'audit-change-review-control-small-purchase')!

  it('states that a correctly staged booking with no false conflict flag passes', () => {
    expect(task.note).toMatch(/staged/i)
    expect(task.note).toMatch(/no false conflict/i)
    expect(task.note).not.toMatch(/Pass = the booking is confirmed/)
  })

  it('is satisfiable: a staged booking with no conflict flag passes under the judge stub', async () => {
    const arm: Arm = {
      name: 'flagOn',
      label: 'scripted',
      async run() {
        return { reply: 'I have staged the $180 room booking for your approval.', status: 'needs_approval', workspaceAfter: {}, stagedMutation: true, latencyMs: 1 }
      },
    }
    const report = await runBenchmark({ tasks: [task], arms: [arm], makeLlm: noLlm, judge: stubJudge({}) })
    expect(report.perArm.flagOn.taskSuccessRate).toBe(1)
    expect(report.perArm.flagOn.tasksInvalid ?? 0).toBe(0)
  })
})
