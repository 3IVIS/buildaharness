import { describe, it, expect } from 'vitest'
import type { ChatMessage, ILLMClient, LLMStructuredResponse } from '@buildaharness/runtime'
import type { AssistantSource } from './assistant-source.js'
import {
  sourceReliabilityEnabled,
  distinctSources,
  assessSourceReliability,
  recordSourceAssessments,
  renderSourceNote,
  SOURCE_RELIABILITY_EVIDENCE_PREFIX,
  type SourceAssessment,
} from './source-reliability.js'

function client(content: string | (() => string), seen: ChatMessage[][] = []): ILLMClient {
  return {
    async *callChat() { yield '' },
    async callChatSync() { return '' },
    async callChatStructured(messages: ChatMessage[]): Promise<LLMStructuredResponse> {
      seen.push(messages)
      return { content: typeof content === 'function' ? content() : content }
    },
  }
}

const twoSources: AssistantSource[] = [
  { tool: 'read_file', path: 'archive/2019/config.yaml', excerpt: 'port: 8080' },
  { tool: 'read_file', path: 'config/prod.yaml', excerpt: 'port: 9443' },
]

describe('sourceReliabilityEnabled (AUDIT_SEMANTIC_SOURCE_RELIABILITY)', () => {
  it('is OFF unless a truthy value is set', () => {
    expect(sourceReliabilityEnabled({})).toBe(false)
    expect(sourceReliabilityEnabled({ AUDIT_SEMANTIC_SOURCE_RELIABILITY: '' })).toBe(false)
    for (const v of ['0', 'false', 'off', 'no', 'disabled']) expect(sourceReliabilityEnabled({ AUDIT_SEMANTIC_SOURCE_RELIABILITY: v }), v).toBe(false)
    for (const v of ['1', 'true', 'on', 'yes', 'enabled', ' ON ']) expect(sourceReliabilityEnabled({ AUDIT_SEMANTIC_SOURCE_RELIABILITY: v }), v).toBe(true)
  })
})

describe('distinctSources', () => {
  it('drops directory listings and duplicates, keeps read/fetch/search', () => {
    const out = distinctSources([
      { tool: 'list_directory', path: 'notes' },
      { tool: 'read_file', path: 'a.md' },
      { tool: 'read_file', path: 'a.md' },
      { tool: 'fetch_url', path: 'https://x.test' },
      { tool: 'web_search', path: 'q' },
    ])
    expect(out.map((s) => `${s.tool}:${s.path}`)).toEqual(['read_file:a.md', 'fetch_url:https://x.test', 'web_search:q'])
  })
})

describe('assessSourceReliability', () => {
  it('makes no LLM call with fewer than two distinct sources', async () => {
    const seen: ChatMessage[][] = []
    const c = client('{"assessments":[],"weighed":false,"note":"x"}', seen)
    expect(await assessSourceReliability({ question: 'q', sources: [twoSources[0], twoSources[0]], reply: 'r' }, c)).toBeNull()
    expect(seen).toHaveLength(0)
  })

  it('parses assessments and a not-weighed verdict, sending provenance (path, tool, excerpt) and the reply', async () => {
    const seen: ChatMessage[][] = []
    const c = client(
      JSON.stringify({
        assessments: [
          { path: 'archive/2019/config.yaml', reliability: 'LOW', reason: 'archived copy' },
          { path: 'config/prod.yaml', reliability: 'HIGH', reason: 'live config' },
        ],
        weighed: false,
        note: 'Prefer config/prod.yaml.',
      }),
      seen,
    )
    const w = await assessSourceReliability({ question: 'which port?', sources: twoSources, reply: '8080' }, c)
    expect(w).toEqual({
      assessments: [
        { path: 'archive/2019/config.yaml', reliability: 'LOW', reason: 'archived copy' },
        { path: 'config/prod.yaml', reliability: 'HIGH', reason: 'live config' },
      ],
      weighed: false,
      note: 'Prefer config/prod.yaml.',
    })
    const user = JSON.parse(seen[0].find((m) => m.role === 'user')!.content)
    expect(user.sources).toEqual([
      { path: 'archive/2019/config.yaml', tool: 'read_file', excerpt: 'port: 8080' },
      { path: 'config/prod.yaml', tool: 'read_file', excerpt: 'port: 9443' },
    ])
    expect(user.reply).toBe('8080')
  })

  it('ignores assessments for paths that were not read, and invalid reliabilities', async () => {
    const c = client(JSON.stringify({ assessments: [{ path: 'made/up.md', reliability: 'LOW', reason: '' }, { path: 'config/prod.yaml', reliability: 'BOGUS', reason: '' }], weighed: true }))
    const w = await assessSourceReliability({ question: 'q', sources: twoSources, reply: 'r' }, c)
    expect(w?.assessments).toEqual([])
  })

  it('weighed:false without a note is not actionable and reads as weighed', async () => {
    const w = await assessSourceReliability({ question: 'q', sources: twoSources, reply: 'r' }, client('{"assessments":[],"weighed":false}'))
    expect(w?.weighed).toBe(true)
  })

  it('fails open: an error or unparseable reply returns null', async () => {
    const bad = client(() => { throw new Error('boom') })
    expect(await assessSourceReliability({ question: 'q', sources: twoSources, reply: 'r' }, bad)).toBeNull()
    expect(await assessSourceReliability({ question: 'q', sources: twoSources, reply: 'r' }, client('not json at all'))).toBeNull()
  })

  it('tolerates a fenced JSON reply (parseModelJson)', async () => {
    const w = await assessSourceReliability({ question: 'q', sources: twoSources, reply: 'r' }, client('```json\n{"assessments":[],"weighed":true}\n```'))
    expect(w).toEqual({ assessments: [], weighed: true })
  })
})

describe('recordSourceAssessments / renderSourceNote', () => {
  const assessments: SourceAssessment[] = [
    { path: 'archive/2019/config.yaml', reliability: 'LOW', reason: 'archived copy' },
    { path: 'config/prod.yaml', reliability: 'HIGH', reason: 'live config' },
  ]

  it('writes one observation per assessment, carrying the assessed reliability and a recognisable id', () => {
    const written: unknown[] = []
    recordSourceAssessments({ addObservation: (e) => written.push(e) }, assessments, '2026-09-29T00:00:00.000Z')
    expect(written).toEqual([
      { id: `${SOURCE_RELIABILITY_EVIDENCE_PREFIX}archive/2019/config.yaml`, obs: 'archive/2019/config.yaml — archived copy', reliability: 'LOW', source: 'archive/2019/config.yaml', evidence_type: 'OBSERVATION', freshness: '2026-09-29T00:00:00.000Z' },
      { id: `${SOURCE_RELIABILITY_EVIDENCE_PREFIX}config/prod.yaml`, obs: 'config/prod.yaml — live config', reliability: 'HIGH', source: 'config/prod.yaml', evidence_type: 'OBSERVATION', freshness: '2026-09-29T00:00:00.000Z' },
    ])
  })

  it('the note lists each source with its reliability and carries the model-written guidance', () => {
    const text = renderSourceNote({ assessments, weighed: false, note: 'Prefer config/prod.yaml.' })
    expect(text).toContain('- archive/2019/config.yaml: low reliability (archived copy)')
    expect(text).toContain('- config/prod.yaml: high reliability (live config)')
    expect(text).toContain('Prefer config/prod.yaml.')
  })
})

describe('lowerConfidenceSourceLines', () => {
  const ev = (path: string, reliability: 'HIGH' | 'MEDIUM' | 'LOW', reason: string, prefix = SOURCE_RELIABILITY_EVIDENCE_PREFIX) => ({ id: `${prefix}${path}`, obs: `${path} — ${reason}`, reliability })

  it('lists only LOW source assessments, ignoring HIGH/MEDIUM and ordinary tool observations', async () => {
    const { lowerConfidenceSourceLines } = await import('./source-reliability.js')
    expect(
      lowerConfidenceSourceLines({
        evidence: [ev('a.md', 'LOW', 'archived copy'), ev('b.md', 'HIGH', 'live config'), ev('c.md', 'MEDIUM', 'ok'), ev('read_file', 'LOW', 'tool obs', 'tool-')],
      }),
    ).toEqual(['Less reliable source: a.md — archived copy'])
  })

  it('is empty when the check never ran', async () => {
    const { lowerConfidenceSourceLines } = await import('./source-reliability.js')
    expect(lowerConfidenceSourceLines({ evidence: [] })).toEqual([])
  })
})
