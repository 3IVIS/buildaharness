import { describe, it, expect } from 'vitest'
import { renderMarkdown, renderDiff, diffReports, aggregateSeeds, diffSeeds, renderSeedDiff } from './report.js'
import type { BenchmarkReport, ArmAggregate } from './runner.js'

function aggregate(partial: Partial<ArmAggregate> & { arm: ArmAggregate['arm'] }): ArmAggregate {
  return {
    label: 'x',
    tasksRun: 3,
    tasksSkipped: 0,
    taskSuccessRate: 1,
    hallucinationRate: 0,
    unauthorizedEffectRate: 0,
    recoveryRate: null,
    meanLatencyMs: 100,
    meanCostUsd: null,
    totalTokens: 0,
    supervisorConsultsMean: 0,
    supervisorConsultsTotal: 0,
    byCategory: {},
    answerClaimConfusion: null,
    ...partial,
  }
}

function report(perArm: Record<string, ArmAggregate>): BenchmarkReport {
  return { generatedAt: 'FIXED', corpusSize: 3, judgeEnabled: true, perArm, rows: [] }
}

describe('renderMarkdown — AnswerClaim calibration section', () => {
  it('renders a 2x2 matrix and the overconfident-and-wrong line for an arm with claim tasks', () => {
    const md = renderMarkdown(
      report({
        baseline: aggregate({
          arm: 'baseline',
          answerClaimConfusion: {
            tasks: 6,
            verifiedCorrect: 3,
            verifiedWrong: 1,
            unverifiedCorrect: 2,
            unverifiedWrong: 0,
            overconfidentWrongRate: 1 / 6,
          },
        }),
      }),
    )
    expect(md).toContain('### AnswerClaim calibration')
    expect(md).toContain('| answer correct | answer wrong |')
    expect(md).toContain('| claim = `verified` | 3 | 1 |')
    expect(md).toContain('| claim ≠ `verified` | 2 | 0 |')
    expect(md).toContain('overconfident-and-wrong: 1/6 (16.7%)')
  })

  it('says so when an arm produced no AnswerClaim tasks', () => {
    const md = renderMarkdown(report({ bare: aggregate({ arm: 'bare', answerClaimConfusion: null }) }))
    expect(md).toContain('### AnswerClaim calibration')
    expect(md).toContain('no AnswerClaim-producing tasks')
  })
})

describe('diffReports — overconfidentWrongRate gating (Rule 6)', () => {
  const withConfusion = (verifiedWrong: number, tasks: number) =>
    report({
      flagOn: aggregate({
        arm: 'flagOn',
        answerClaimConfusion: {
          tasks,
          verifiedCorrect: tasks - verifiedWrong,
          verifiedWrong,
          unverifiedCorrect: 0,
          unverifiedWrong: 0,
          overconfidentWrongRate: tasks === 0 ? 0 : verifiedWrong / tasks,
        },
      }),
    })

  it('a rise in overconfident-and-wrong is a gating regression', () => {
    const d = diffReports(withConfusion(0, 4), withConfusion(2, 4), 'flagOn')
    expect(d.regressed).toBe(true)
    expect(d.regressions).toContain('overconfidentWrongRate')
    expect(renderDiff(d)).toContain('overconfidentWrongRate')
  })

  it('a fall in overconfident-and-wrong is not a regression', () => {
    const d = diffReports(withConfusion(3, 4), withConfusion(1, 4), 'flagOn')
    expect(d.regressed).toBe(false)
  })

  it('no gating when either report ran zero AnswerClaim tasks', () => {
    const d = diffReports(
      report({ flagOn: aggregate({ arm: 'flagOn', answerClaimConfusion: null }) }),
      withConfusion(4, 4),
      'flagOn',
    )
    expect(d.regressed).toBe(false)
  })
})

describe('multi-seed aggregation (S7 Rule 6)', () => {
  const seedReport = (arm: string, successRate: number, consults: number): BenchmarkReport =>
    report({ [arm]: aggregate({ arm: arm as ArmAggregate['arm'], taskSuccessRate: successRate, supervisorConsultsMean: consults }) })

  it('aggregateSeeds computes mean / sample-stddev / ci95 across seeds', () => {
    const agg = aggregateSeeds(
      [seedReport('flagOn', 0.8, 0), seedReport('flagOn', 0.7, 0), seedReport('flagOn', 0.9, 0)],
      'flagOn',
    )
    expect(agg.seeds).toBe(3)
    expect(agg.stats.taskSuccessRate.mean).toBeCloseTo(0.8, 6)
    expect(agg.stats.taskSuccessRate.stddev).toBeCloseTo(0.1, 6)
    expect(agg.stats.taskSuccessRate.ci95).toBeCloseTo((1.96 * 0.1) / Math.sqrt(3), 6)
  })

  it('diffSeeds verdict is neutral when the taskSuccessRate CI straddles 0', () => {
    const a = aggregateSeeds([seedReport('flagOn', 0.8, 0), seedReport('flagOn', 0.7, 0), seedReport('flagOn', 0.9, 0)], 'flagOn')
    const b = aggregateSeeds([seedReport('supervisorOn', 0.82, 1), seedReport('supervisorOn', 0.71, 1), seedReport('supervisorOn', 0.88, 1)], 'supervisorOn')
    const d = diffSeeds(a, b)
    expect(d.verdict).toBe('neutral')
    expect(renderSeedDiff(d)).toContain('NEUTRAL')
  })

  it('diffSeeds verdict is positive when armB clearly beats armA with no gating regression', () => {
    const a = aggregateSeeds([seedReport('flagOn', 0.50, 0), seedReport('flagOn', 0.51, 0), seedReport('flagOn', 0.49, 0)], 'flagOn')
    const b = aggregateSeeds([seedReport('supervisorOn', 0.80, 1), seedReport('supervisorOn', 0.81, 1), seedReport('supervisorOn', 0.79, 1)], 'supervisorOn')
    const d = diffSeeds(a, b)
    expect(d.verdict).toBe('positive')
  })

  it('diffSeeds verdict is regressed when a gating metric moves clearly worse', () => {
    const a = aggregateSeeds(
      [
        report({ flagOn: aggregate({ arm: 'flagOn', taskSuccessRate: 0.8, hallucinationRate: 0.0 }) }),
        report({ flagOn: aggregate({ arm: 'flagOn', taskSuccessRate: 0.8, hallucinationRate: 0.0 }) }),
        report({ flagOn: aggregate({ arm: 'flagOn', taskSuccessRate: 0.8, hallucinationRate: 0.0 }) }),
      ],
      'flagOn',
    )
    const b = aggregateSeeds(
      [
        report({ supervisorOn: aggregate({ arm: 'supervisorOn', taskSuccessRate: 0.8, hallucinationRate: 0.3 }) }),
        report({ supervisorOn: aggregate({ arm: 'supervisorOn', taskSuccessRate: 0.8, hallucinationRate: 0.31 }) }),
        report({ supervisorOn: aggregate({ arm: 'supervisorOn', taskSuccessRate: 0.8, hallucinationRate: 0.29 }) }),
      ],
      'supervisorOn',
    )
    expect(diffSeeds(a, b).verdict).toBe('regressed')
  })
})
