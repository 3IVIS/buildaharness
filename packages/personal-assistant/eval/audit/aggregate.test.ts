import { describe, it, expect } from 'vitest'
import { auditVerdict, injectionAuditSignals, buildMultiSeedReport, observationLabel } from './aggregate.js'
import type { BenchmarkReport, ArmAggregate, BenchmarkRow } from '../runner.js'
import type { TaskCategory } from '../corpus/schema.js'

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

function row(partial: Partial<BenchmarkRow> & { arm: string; taskId: string }): BenchmarkRow {
  return {
    category: 'adv_injection' as TaskCategory,
    ran: true,
    success: true,
    hallucination: false,
    unauthorizedEffect: false,
    recovered: null,
    latencyMs: 1000,
    costUsd: 0.01,
    totalTokens: 1000,
    supervisorConsults: null,
    supervisorDirectives: null,
    failedChecks: [],
    replyPreview: '',
    answerClaimCalibration: null,
    ...partial,
  } as BenchmarkRow
}

function reportWithRows(rows: BenchmarkRow[]): BenchmarkReport {
  return { generatedAt: 'FIXED', corpusSize: rows.length, judgeEnabled: true, perArm: {}, rows }
}

describe('injectionAuditSignals (Phase A5)', () => {
  it('splits payload vs benign by task id and computes catch / false-positive / latency', () => {
    const rows = [
      row({ arm: 'flagOn', taskId: 'adv-injection-llm-housekeeping', category: 'adv_injection', success: true, latencyMs: 2000 }),
      row({ arm: 'flagOn', taskId: 'adv-injection-llm-persona-swap', category: 'adv_injection', success: false, latencyMs: 4000 }),
      row({ arm: 'flagOn', taskId: 'adv-injection-benign-deploy-runbook', category: 'file_read', success: true, latencyMs: 1000 }),
      row({ arm: 'flagOn', taskId: 'adv-injection-benign-onboarding', category: 'file_read', success: false, latencyMs: 1000 }),
      // other-arm rows are ignored
      row({ arm: 'injectionDetectOff', taskId: 'adv-injection-llm-housekeeping', success: false, latencyMs: 999 }),
    ]
    const s = injectionAuditSignals([reportWithRows(rows)], 'flagOn')
    expect(s.candidate).toBe('flagOn')
    expect(s.payloadTasks).toBe(2)
    expect(s.catchRate).toBe(0.5)
    expect(s.benignTasks).toBe(2)
    expect(s.falsePositiveRate).toBe(0.5)
    expect(s.meanLatencyMs).toBe(2000) // (2000+4000+1000+1000)/4
  })

  it('nulls each metric when its denominator is empty', () => {
    const s = injectionAuditSignals([reportWithRows([])], 'flagOn')
    expect(s.catchRate).toBeNull()
    expect(s.falsePositiveRate).toBeNull()
    expect(s.meanLatencyMs).toBeNull()
  })

  it('buildMultiSeedReport only attaches injectionSignals for the llm-injection-detect feature', () => {
    const seedReports = seeds(3, { taskSuccessRate: 0.7 }, { taskSuccessRate: 0.7 })
    const other = buildMultiSeedReport(seedReports, { id: 'demo', title: 't', hypothesis: 'h' }, 'bare', 'flagOn')
    expect(other.injectionSignals).toBeNull()
    const inj = buildMultiSeedReport(
      seedReports,
      { id: 'llm-injection-detect', title: 't', hypothesis: 'h' },
      'injectionDetectOff',
      'flagOn',
    )
    expect(inj.injectionSignals).not.toBeNull()
    expect(inj.injectionSignals?.candidate).toBe('flagOn')
  })
})

describe('observationLabel', () => {
  function report(successDelta: number, costDeltaPct: number | null) {
    return {
      metrics: [{ metric: 'taskSuccessRate', control: 0.5, candidate: 0.5 + successDelta, deltaMean: successDelta, deltaCi95: 1, positive: false, regressed: false }],
      costDeltaPct,
    }
  }

  it('better results at a materially higher cost (harness-vs-bare shape)', () => {
    expect(observationLabel(report(0.16, 0.77))).toBe('Better results, at higher cost')
  })

  it('worse results at a materially higher cost (a regression)', () => {
    expect(observationLabel(report(-0.1, 0.3))).toBe('Worse results, at higher cost')
  })

  it('no measurable difference at a materially higher cost', () => {
    expect(observationLabel(report(0.01, 0.2))).toBe('No measurable improvement, at extra cost')
  })

  it('no measurable difference and no material cost change', () => {
    expect(observationLabel(report(0.01, 0.02))).toBe('No measurable difference')
  })

  it('no measurable difference but cheaper', () => {
    expect(observationLabel(report(0.01, -0.18))).toBe('No measurable difference, but cheaper')
  })

  it('better results with no added cost', () => {
    expect(observationLabel(report(0.08, 0.02))).toBe('Better results, no added cost')
  })

  it('better results and cheaper', () => {
    expect(observationLabel(report(0.08, -0.2))).toBe('Better results, and cheaper')
  })

  it('treats a null cost delta as similar cost', () => {
    expect(observationLabel(report(0.08, null))).toBe('Better results, no added cost')
  })
})
