import { describe, it, expect } from 'vitest'
import { computeRunState, computeTrend, deriveConsequentialTools } from './turn-signals.js'

describe('deriveConsequentialTools', () => {
  const manifest = { read_file: 'read', web_search: 'network', write_file: 'write', run_shell_command: 'execute' } as const
  it('keeps write/execute tools and drops read/network ones', () => {
    const out = deriveConsequentialTools(['read_file', 'web_search', 'write_file', 'run_shell_command'], manifest)
    expect([...out].sort()).toEqual(['run_shell_command', 'write_file'])
  })
  it('treats a tool missing from the manifest as consequential', () => {
    expect(deriveConsequentialTools(['mystery'], manifest).has('mystery')).toBe(true)
  })
  it('is empty for read-only availability', () => {
    expect(deriveConsequentialTools(['read_file'], manifest).size).toBe(0)
  })
})

describe('computeTrend', () => {
  it('is unknown for fewer than two points', () => expect(computeTrend([1])).toBe('unknown'))
  it('detects improving and degrading', () => {
    expect(computeTrend([0.2, 0.3, 0.8, 0.9])).toBe('improving')
    expect(computeTrend([0.9, 0.8, 0.3, 0.2])).toBe('degrading')
    expect(computeTrend([0.9, 0.8, 0.3, 0.2], true)).toBe('improving')
    expect(computeTrend([0.5, 0.5, 0.5, 0.5])).toBe('flat')
  })
})

describe('computeRunState', () => {
  it('defaults are neutral', () => {
    expect(computeRunState()).toEqual({
      consecutiveFailures: 0, turnDepth: 0, cumulativeSpend: 0, sessionBudget: null,
      diagnosticsTrend: 'unknown', verificationTrend: 'unknown', toolReliability: {}, untrustedContentInContext: false,
    })
  })
  it('counts trailing failures only', () => {
    expect(computeRunState({ outcomes: [true, false, true, true] }).consecutiveFailures).toBe(2)
    expect(computeRunState({ outcomes: [true, true, false] }).consecutiveFailures).toBe(0)
  })
  it('passes state features through', () => {
    const s = computeRunState({ turnDepth: 3, cumulativeSpend: 1.5, sessionBudget: 5, toolReliability: { a: 0.5 }, untrustedContentInContext: true })
    expect(s).toMatchObject({ turnDepth: 3, cumulativeSpend: 1.5, sessionBudget: 5, toolReliability: { a: 0.5 }, untrustedContentInContext: true })
  })
})
