import { describe, it, expect } from 'vitest'
import type { AssistantTrace } from './assistant.js'
import type { AnswerClaim } from './answer-claim.js'
import {
  explainWhy, explainLayers, explainSources, explainSteps, explainPlan, explainCommand,
  verificationHealthLabel, answerClaimLabel, batchBudgetSummaryLine,
  FAST_PATH_REASON, GENERIC_NO_TRACE_REASON, NO_SOURCES_TEXT, NO_STEPS_TEXT, NO_PLAN_TEXT,
} from './run-explain.js'

function trace(over: Partial<AssistantTrace> = {}): AssistantTrace {
  return {
    verificationHealth: { strength: 0.9, feasibility: 0.8 },
    layerActivity: [
      { layer: 'evidence_reasoning', fired: true, reason: 'read 2 files' },
      { layer: 'evidence_reasoning', fired: true, reason: 'read 1 more' },
      { layer: 'verification', fired: true, reason: 'checked the answer' },
      { layer: 'recovery', fired: false, reason: 'nothing failed' },
    ],
    ...over,
  } as AssistantTrace
}

const claim = (over: Partial<AnswerClaim> = {}): AnswerClaim => ({
  evidence: [], confidence: 0.8, freshness: null, source_type: 'tool_result', verification_status: 'verified', ...over,
}) as AnswerClaim

describe('labels', () => {
  it('buckets verification health by the weaker score', () => {
    expect(verificationHealthLabel({ strength: 0.9, feasibility: 0.9 })).toBe('High confidence')
    expect(verificationHealthLabel({ strength: 0.9, feasibility: 0.5 })).toBe('Reasonably confident')
    expect(verificationHealthLabel({ strength: 0.2, feasibility: 0.9 })).toBe('Worth double-checking')
  })

  it('gives each answer-claim status its own sentence', () => {
    const texts = (['verified', 'unverified_attempted', 'contradicted', 'no_evidence'] as const).map((s) => answerClaimLabel(claim({ verification_status: s })))
    expect(new Set(texts).size).toBe(4)
    expect(answerClaimLabel(claim({ verification_status: 'unverified_attempted', grounding_note: 'total differs' }))).toContain('total differs')
  })

  it('summarises a batch', () => {
    const line = batchBudgetSummaryLine({
      itemCount: 3, totalCallsUsed: 5, projectedTotal: 6.2,
      perItemOutcomes: [
        { item: 'a', status: 'found', callsUsed: 2 }, { item: 'b', status: 'not_found', callsUsed: 2 }, { item: 'c', status: 'truncated_while_productive', callsUsed: 1 },
      ],
    } as NonNullable<AssistantTrace['batchBudget']>)
    expect(line).toBe('Batch: 3 items — 1 found, 1 not found, 1 truncated (5 calls used, projected ~7)')
  })
})

describe('explainWhy', () => {
  it('says why there is no trace: specific reason, fast path, or generic', () => {
    expect(explainWhy({ noTraceReason: 'No harness trace — declined.' })[0]).toBe('No harness trace — declined.')
    expect(explainWhy({ harnessSkipped: true, trace: trace() })[0]).toBe(FAST_PATH_REASON)
    expect(explainWhy({})[0]).toBe(GENERIC_NO_TRACE_REASON)
  })

  it('always ends with the memory line, trace or not', () => {
    expect(explainWhy({}).at(-1)).toContain('no memory has been put in front of the model')
    expect(explainWhy({ trace: trace() }).at(-1)).toContain('no memory has been put in front of the model')
  })

  it('shows confidence, the answer-claim line, and each fired layer once in firing order', () => {
    const lines = explainWhy({ trace: trace(), answerClaim: claim() })
    expect(lines[0]).toBe('High confidence')
    expect(lines).toContain(answerClaimLabel(claim()))
    expect(lines).toContain('What I checked:')
    const layerLines = lines.filter((l) => /^ {2}(Evidence & Reasoning|Verification|Recovery):/.test(l))
    expect(layerLines).toEqual(['  Evidence & Reasoning: read 2 files', '  Verification: checked the answer'])
  })

  it('stays quiet about layers when none fired', () => {
    const lines = explainWhy({ trace: trace({ layerActivity: [{ layer: 'recovery', fired: false, reason: 'x' }] }) })
    expect(lines).not.toContain('What I checked:')
  })
})

describe('explainWhy — memory and source reliability', () => {
  it('lists the facts the prompt held and how many were left out', () => {
    const lines = explainWhy({ trace: trace(), memoryInjection: { facts: [{ text: 'the user likes tea', unconfirmed: false }], notShown: 4 } })
    expect(lines.at(-1)).toContain('4 not shown this turn')
    expect(lines.at(-1)).toContain('the user likes tea')
  })

  it('shows a LOW-assessed source, and stays quiet when none was judged LOW', () => {
    const low = claim({ verification_status: 'unverified_attempted', evidence: [{ id: 'source-reliability:notes/old-wiki.md', obs: 'notes/old-wiki.md — archived forum copy', reliability: 'LOW' }] as never })
    expect(explainWhy({ trace: trace(), answerClaim: low })).toContain('Less reliable source: notes/old-wiki.md — archived forum copy')
    expect(explainWhy({ trace: trace(), answerClaim: claim() }).join('\n')).not.toContain('Less reliable source')
  })
})

describe('explainLayers', () => {
  it('lists all 11 layers, marking fired and unevaluated ones (latest event per layer)', () => {
    const lines = explainLayers({ trace: trace() })
    expect(lines).toHaveLength(11)
    expect(lines[1]).toMatch(/^\[✓\] Evidence & Reasoning\s+read 1 more$/)
    expect(lines[0]).toMatch(/^\[·\] World Model\s+not evaluated this turn$/)
  })

  it('explains a missing trace without the memory line', () => {
    expect(explainLayers({})).toEqual([GENERIC_NO_TRACE_REASON])
  })
})

describe('explainSources / explainSteps / explainPlan', () => {
  it('dedupes sources and flags external ones', () => {
    const lines = explainSources({ sources: [
      { tool: 'read_file', path: 'a.md' }, { tool: 'read_file', path: 'a.md' }, { tool: 'fetch_url', path: 'https://x.test' },
    ] as never })
    expect(lines).toEqual(['- Read a.md', '- Fetched https://x.test (external)'])
    expect(explainSources({})).toEqual([NO_SOURCES_TEXT])
  })

  it('numbers tool steps, using the denial text for a denied call', () => {
    const lines = explainSteps({ toolSteps: [
      { tool: 'read_file', input: { path: 'a.md' }, summary: 'Reading a.md' },
      { tool: 'write_file', input: {}, summary: 'Writing b', deniedReason: 'not allowed' },
    ] as never })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^1\. /)
    expect(lines[1]).toBe('2. Writing b')
    expect(explainSteps({})).toEqual([NO_STEPS_TEXT])
  })

  it('words a finished write/command step as done', () => {
    const lines = explainSteps({ toolSteps: [
      { tool: 'run_shell_command', input: { command: 'uname -a' }, summary: 'Proposing to run: uname -a' },
      { tool: 'write_file', input: { path: 'x.md' }, summary: 'Proposing a write to x.md' },
    ] as never })
    expect(lines).toEqual(['1. Ran: uname -a', '2. Wrote x.md'])
  })

  it('renders a plan checklist with notes and success criteria', () => {
    const lines = explainPlan({ planStatus: {
      templateName: 'Ship it', completionPct: 50, successCriteria: 'tests pass',
      tasks: [{ id: 't1', description: 'build', status: 'COMPLETE' }, { id: 't2', description: 'test', status: 'FAILED', note: 'flaky' }],
    } as never })
    expect(lines).toEqual([
      'Plan: Ship it (50.0% complete)',
      '  ✓ [COMPLETE] t1 — build',
      '  ✗ [FAILED] t2 — test',
      '      not accepted as done: flaky',
      'Success criteria: tests pass',
    ])
    expect(explainPlan({})).toEqual([NO_PLAN_TEXT])
  })
})

describe('explainCommand', () => {
  it('maps bare commands and ignores everything else', () => {
    expect(explainCommand('/sources', {})).toEqual([NO_SOURCES_TEXT])
    expect(explainCommand('  /why  ', {})?.[0]).toBe(GENERIC_NO_TRACE_REASON)
    expect(explainCommand('/plan graph', {})).toBeUndefined()
    expect(explainCommand('/layers settings', {})).toBeUndefined()
    expect(explainCommand('why is the sky blue', {})).toBeUndefined()
  })
})
