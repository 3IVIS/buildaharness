// S5 of plans/harness_trajectory_supervisor_plan.html — TS twin of
// adapter/tests/test_harness_supervisor_s4.py's investigation-module layer.
// INV-23 (read-only allowlist), INV-24 (depth cap), INV-25 (bounded budget + timeout),
// provenance merge + generation bump, per-run cap counting.

import { describe, it, expect } from 'vitest'
import {
  INVESTIGATION_CAP_K,
  INVESTIGATION_READ_ONLY_TOOLS,
  InvestigationDepthExceededError,
  countInvestigations,
  mergeInvestigationFindings,
  resolveGatherEvidence,
  runInvestigation,
  validateInvestigationTools,
  type InvestigationFinding,
} from './investigation.js'
import { SupervisorDirective, InvestigationRequest } from './supervisor.js'
import { WorldModel } from './state/world-model.js'

describe('validateInvestigationTools (INV-23)', () => {
  it('rejects write / shell / email / unknown fn_refs, keeps read-only ones in order', () => {
    const forbidden = ['write_file', 'run_shell_command', 'send_email', 'deploy', 'made_up']
    const { allowed, rejected } = validateInvestigationTools([...forbidden, 'retrieve', 'web_search'])
    expect(allowed).toEqual(['retrieve', 'web_search'])
    expect(new Set(rejected)).toEqual(new Set(forbidden))
    expect(INVESTIGATION_READ_ONLY_TOOLS.has('write_file')).toBe(false)
  })
})

describe('runInvestigation', () => {
  it('never dispatches a rejected tool (INV-23)', async () => {
    const dispatched: string[] = []
    const outcome = await runInvestigation(
      { question: 'q', suggested_tools: ['write_file', 'retrieve', 'run_shell_command', 'read_file'], budget: 9 },
      {
        toolRunner: (tool: string) => {
          dispatched.push(tool)
          return `${tool}: found it`
        },
      },
    )
    expect(dispatched).toEqual(['retrieve', 'read_file'])
    expect(new Set(outcome.rejectedTools)).toEqual(new Set(['write_file', 'run_shell_command']))
    expect(outcome.findings).toHaveLength(2)
  })

  it('throws at depth >= 1 (INV-24)', async () => {
    await expect(
      runInvestigation({ question: 'q', suggested_tools: ['retrieve'], budget: 1 }, { toolRunner: () => 'x', depth: 1 }),
    ).rejects.toBeInstanceOf(InvestigationDepthExceededError)
  })

  it('a budget smaller than the tool list returns partial findings + exhausted (INV-25)', async () => {
    const outcome = await runInvestigation(
      { question: 'q', suggested_tools: ['retrieve', 'web_search', 'read_file'], budget: 1 },
      { toolRunner: (t: string) => `${t} ok` },
    )
    expect(outcome.callsMade).toBe(1)
    expect(outcome.exhausted).toBe(true)
    expect(outcome.findings.map(f => f.tool)).toEqual(['retrieve'])
  })

  it('cuts off a hanging tool at the per-call timeout and still returns (INV-25)', async () => {
    const started = Date.now()
    const outcome = await runInvestigation(
      { question: 'q', suggested_tools: ['web_search', 'retrieve'], budget: 5 },
      {
        perCallTimeoutMs: 50,
        toolRunner: async (t: string) => {
          if (t === 'web_search') await new Promise(r => setTimeout(r, 5_000))
          return `${t} ok`
        },
      },
    )
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(outcome.findings.map(f => f.tool)).toEqual(['retrieve'])
    expect(outcome.callsMade).toBe(2)
  })

  it('isolates a throwing tool', async () => {
    const outcome = await runInvestigation(
      { question: 'q', suggested_tools: ['retrieve', 'read_file'], budget: 5 },
      {
        toolRunner: (t: string) => {
          if (t === 'retrieve') throw new Error('boom')
          return `${t} ok`
        },
      },
    )
    expect(outcome.findings.map(f => f.tool)).toEqual(['read_file'])
  })

  it('tags HIGH reliability only when the tool_reliability map says so', async () => {
    const outcome = await runInvestigation(
      { question: 'q', suggested_tools: ['retrieve'], budget: 1 },
      { toolRunner: () => 'fact', toolReliability: { retrieve: 'HIGH' } },
    )
    expect(outcome.findings[0].reliability).toBe('HIGH')
  })
})

describe('mergeInvestigationFindings', () => {
  const finding = (tool: string): InvestigationFinding => ({ content: `via ${tool}`, tool, reliability: 'MEDIUM' })

  it('writes provenanced observations and bumps the generation id', () => {
    const wm = new WorldModel()
    const before = wm.generation_id
    const merged = mergeInvestigationFindings(wm, [finding('retrieve')], { question: 'which port?' })
    expect(merged).toHaveLength(1)
    expect(merged[0].source).toBe('supervisor_investigation')
    expect(merged[0].content).toContain('derived_from=supervisor_investigation')
    expect(merged[0].content).toContain('q=which port?')
    expect(wm.generation_id).toBe(before + 1)
    expect(wm.observations).toContain(merged[0])
  })

  it('an empty findings list still bumps the generation id', () => {
    const wm = new WorldModel()
    const before = wm.generation_id
    expect(mergeInvestigationFindings(wm, [], { question: 'q' })).toEqual([])
    expect(wm.generation_id).toBe(before + 1)
  })
})

describe('countInvestigations (per-run cap K)', () => {
  it('counts distinct investigations, not distinct findings', () => {
    const wm = new WorldModel()
    for (const q of ['q1', 'q1', 'q2']) {
      mergeInvestigationFindings(wm, [{ content: 'f', tool: 'retrieve', reliability: 'MEDIUM' }], { question: q })
    }
    expect(countInvestigations(wm)).toBe(2)
  })
})

describe('resolveGatherEvidence (S5 degradation + cap rules)', () => {
  const directive = () =>
    new SupervisorDirective({
      action: 'GATHER_EVIDENCE',
      rationale: 'need a fact',
      investigation: new InvestigationRequest({ question: 'which port?', suggested_tools: ['retrieve'], budget: 2 }),
    })

  it('degrades to CONTINUE (labelled) when no host callback is supplied', async () => {
    const wm = new WorldModel()
    const out = await resolveGatherEvidence(wm, directive(), undefined)
    expect(out.action).toBe('CONTINUE')
    expect(out.rationale).toContain('not wired: GATHER_EVIDENCE')
    expect(wm.observations).toHaveLength(0)
  })

  it('runs the host, merges findings, bumps generation, returns CONTINUE', async () => {
    const wm = new WorldModel()
    const before = wm.generation_id
    const host = async () => [{ content: 'adapter is on :8000', tool: 'retrieve', reliability: 'MEDIUM' as const }]
    const out = await resolveGatherEvidence(wm, directive(), host)
    expect(out.action).toBe('CONTINUE')
    expect(out.rationale).toContain('investigation done')
    expect(wm.observations).toHaveLength(1)
    expect(wm.observations[0].source).toBe('supervisor_investigation')
    expect(wm.generation_id).toBe(before + 1)
  })

  it('a throwing host degrades to CONTINUE without merging', async () => {
    const wm = new WorldModel()
    const out = await resolveGatherEvidence(wm, directive(), async () => {
      throw new Error('host bug')
    })
    expect(out.action).toBe('CONTINUE')
    expect(out.rationale).toContain('investigation failed')
    expect(wm.observations).toHaveLength(0)
  })

  it('degrades once the per-run cap K is hit', async () => {
    const wm = new WorldModel()
    for (let i = 0; i < INVESTIGATION_CAP_K; i++) {
      mergeInvestigationFindings(wm, [{ content: 'f', tool: 'retrieve', reliability: 'MEDIUM' }], { question: `seed-${i}` })
    }
    const host = async () => [{ content: 'late', tool: 'retrieve', reliability: 'MEDIUM' as const }]
    const out = await resolveGatherEvidence(wm, directive(), host)
    expect(out.action).toBe('CONTINUE')
    expect(out.rationale).toContain(`cap ${INVESTIGATION_CAP_K}`)
    expect(countInvestigations(wm)).toBe(INVESTIGATION_CAP_K) // host not run, nothing new merged
  })
})
