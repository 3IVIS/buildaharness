import { describe, it, expect } from 'vitest'
import { auditVerdict } from './aggregate.js'
import type { BenchmarkReport, ArmAggregate } from '../runner.js'

function arm(partial: Partial<ArmAggregate> & { arm: string }): ArmAggregate {
  return {
    label: 'x',
    tasksRun: 18,
    tasksSkipped: 0,
    taskSuccessRate: 0.7,
    hallucinationRate: 0,
    unauthorizedEffectRate: 0,
    recoveryRate: 0.2,
    meanLatencyMs: 10_000,
    meanCostUsd: 0.009,
    totalTokens: 9_000,
    supervisorConsultsMean: 0,
    supervisorConsultsTotal: 0,
    byCategory: {},
    answerClaimConfusion: null,
    ...partial,
  } as ArmAggregate
}

function report(control: ArmAggregate, candidate: ArmAggregate): BenchmarkReport {
  return {
    generatedAt: 'FIXED',
    corpusSize: 18,
    judgeEnabled: true,
    perArm: { [control.arm]: control, [candidate.arm]: candidate },
    rows: [],
  }
}

/** N identical seed reports with the given per-arm success + cost. */
function seeds(n: number, ctl: Partial<ArmAggregate>, cand: Partial<ArmAggregate>): BenchmarkReport[] {
  return Array.from({ length: n }, () =>
    report(arm({ arm: 'bare', ...ctl }), arm({ arm: 'flagOn', ...cand })),
  )
}

describe('auditVerdict', () => {
  it('CUT when the candidate regresses task success beyond its CI band', () => {
    const reports = [
      report(arm({ arm: 'bare', taskSuccessRate: 0.72 }), arm({ arm: 'flagOn', taskSuccessRate: 0.72 })),
      report(arm({ arm: 'bare', taskSuccessRate: 0.72 }), arm({ arm: 'flagOn', taskSuccessRate: 0.66 })),
      report(arm({ arm: 'bare', taskSuccessRate: 0.72 }), arm({ arm: 'flagOn', taskSuccessRate: 0.66 })),
    ]
    const r = auditVerdict(reports, 'bare', 'flagOn', 'demo')
    expect(r.verdict).toBe('CUT')
    expect(r.rationale).toMatch(/regress/i)
  })

  it('KEEP when the candidate beats control on success with CI clearing 0', () => {
    const reports = [
      report(arm({ arm: 'bare', taskSuccessRate: 0.60 }), arm({ arm: 'flagOn', taskSuccessRate: 0.80 })),
      report(arm({ arm: 'bare', taskSuccessRate: 0.62 }), arm({ arm: 'flagOn', taskSuccessRate: 0.82 })),
      report(arm({ arm: 'bare', taskSuccessRate: 0.61 }), arm({ arm: 'flagOn', taskSuccessRate: 0.81 })),
    ]
    const r = auditVerdict(reports, 'bare', 'flagOn', 'demo')
    expect(r.verdict).toBe('KEEP')
  })

  it('CUT when success is flat but the candidate costs materially more', () => {
    const reports = seeds(3, { taskSuccessRate: 0.72, meanCostUsd: 0.009 }, { taskSuccessRate: 0.72, meanCostUsd: 0.013 })
    const r = auditVerdict(reports, 'bare', 'flagOn', 'demo')
    expect(r.verdict).toBe('CUT')
    expect(r.rationale).toMatch(/neutral with real cost/i)
    expect(r.costDeltaPct).toBeGreaterThan(0.1)
  })

  it('INCONCLUSIVE when flat and no material cost difference', () => {
    const reports = seeds(3, { taskSuccessRate: 0.72, meanCostUsd: 0.009 }, { taskSuccessRate: 0.72, meanCostUsd: 0.0093 })
    const r = auditVerdict(reports, 'bare', 'flagOn', 'demo')
    expect(r.verdict).toBe('INCONCLUSIVE')
  })

  it('INCONCLUSIVE (underpowered) with fewer than 3 seeds even if flat', () => {
    const reports = seeds(2, { taskSuccessRate: 0.72 }, { taskSuccessRate: 0.72 })
    const r = auditVerdict(reports, 'bare', 'flagOn', 'demo')
    expect(r.verdict).toBe('INCONCLUSIVE')
    expect(r.rationale).toMatch(/underpowered/i)
  })
})
