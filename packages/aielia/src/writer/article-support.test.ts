import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { createArticleMeta, type ArticleMeta, type Claim } from './article-model.js'
import { effectiveSourceStatus } from './article-rules.js'
import { createSource } from './article-sources.js'
import { checkClaimSupport, needsAutoCheck, sourcesForClaim } from './article-support.js'

const NOW = '2026-10-16T10:00:00.000Z'
const MD = '# T\n\n## M\n\nThe limiter uses 40 MB at 10,000 clients. It is small.\n'
const quote = 'The limiter uses 40 MB at 10,000 clients.'

function claim(over: Partial<Claim> = {}): Claim {
  return { id: 'k1', sectionId: 's1', quote, position: MD.indexOf(quote), kind: 'factual', author: 'model', authorAt: NOW, confirmed: false, sourceStatus: 'attached', ...over }
}
function meta(sourceKinds: ('upload' | 'say_so')[] = ['upload'], over: Partial<ArticleMeta> = {}): ArticleMeta {
  const sources = sourceKinds.map((k, i) => createSource({ id: `src${i + 1}`, kind: k, passage: 'Memory at 10,000 active clients: 40 MB', now: NOW }))
  return {
    ...createArticleMeta('a1', 'T'),
    claims: [claim()],
    sources,
    links: sources.map((s, i) => ({ id: `l${i + 1}`, from: { type: 'claim' as const, id: 'k1' }, to: { type: 'source' as const, id: s.id }, kind: 'supported_by', origin: 'confirmed' as const, at: NOW })),
    ...over,
  }
}
function client(reply: unknown | Error, seen: { users: string[] } = { users: [] }): ILLMClient {
  return {
    callChatStructured: async (messages: { role: string; content: string }[]) => {
      seen.users.push(messages.find((m) => m.role === 'user')!.content)
      if (reply instanceof Error) throw reply
      return { content: typeof reply === 'string' ? reply : JSON.stringify(reply) }
    },
  } as unknown as ILLMClient
}
const run = (m: ArticleMeta, c: ILLMClient) => checkClaimSupport({ meta: m, markdown: MD, claimId: 'k1', modelName: 'checker-1', now: NOW }, c)

describe('checkClaimSupport', () => {
  it('stores the verdict with what it ran on, so it counts only for this text and these passages', async () => {
    const r = await run(meta(), client({ verdict: 'supported', reason: 'matches the 40 MB figure' }))
    expect(r.status).toBe('checked')
    if (r.status !== 'checked') return
    const c = r.meta.claims[0]
    expect(c.sourceStatus).toBe('supported')
    expect(c.check).toMatchObject({ model: 'checker-1', claimText: quote, ranAt: NOW, reason: 'matches the 40 MB figure' })
    expect(effectiveSourceStatus(c, r.meta.sources)).toBe('supported')
    const changedSource = r.meta.sources.map((s) => ({ ...s, fingerprint: 'other' }))
    expect(effectiveSourceStatus(c, changedSource)).toBe('stale')
  })

  it('passes the passages as untrusted data with the paragraph for context', async () => {
    const seen = { users: [] as string[] }
    await run(meta(), client({ verdict: 'supported', reason: 'ok' }, seen))
    const sent = JSON.parse(seen.users[0])
    expect(sent.claim).toBe(quote)
    expect(sent.context).toContain('It is small.')
    expect(sent.sources[0].passage).toContain('<untrusted_external_content>')
  })

  it('does not call the model when no passage is attached', async () => {
    const seen = { users: [] as string[] }
    const r = await run(meta([], { links: [] }), client({ verdict: 'supported', reason: 'x' }, seen))
    expect(r.status).toBe('no_sources')
    expect(seen.users).toHaveLength(0)
  })

  it('never shows a claim as fully supported on the writer\'s say-so alone', async () => {
    const r = await run(meta(['say_so']), client({ verdict: 'supported', reason: 'the writer says so' }))
    expect(r.status === 'checked' && r.verdict).toBe('partly_supported')
    expect(r.status === 'checked' && r.reason).toContain('say-so')
    const mixed = await run(meta(['say_so', 'upload']), client({ verdict: 'supported', reason: 'ok' }))
    expect(mixed.status === 'checked' && mixed.verdict).toBe('supported')
  })

  it('keeps the claim as it was, and says not_checked, when the call fails or the verdict is unusable', async () => {
    const m = meta()
    for (const c of [client(new Error('503')), client('garbage'), client({ verdict: 'maybe', reason: 'x' })]) {
      const r = await run(m, c)
      expect(r.status).toBe('not_checked')
      expect(r.meta).toBe(m)
    }
    expect((await checkClaimSupport({ meta: m, markdown: MD, claimId: 'nope', modelName: 'x', now: NOW }, client({}))).status).toBe('not_checked')
  })

  it('records a contradiction and clears a pending recheck flag', async () => {
    const m = meta()
    m.claims[0] = claim({ needsRecheck: true })
    const r = await run(m, client({ verdict: 'contradicted', reason: 'passage says 4 MB' }))
    expect(r.status === 'checked' && r.meta.claims[0]).toMatchObject({ sourceStatus: 'contradicted', needsRecheck: undefined })
  })
})

describe('helpers', () => {
  it('finds the sources linked by supported_by only', () => {
    const m = meta(['upload', 'upload'])
    m.links.push({ id: 'l9', from: { type: 'claim', id: 'k1' }, to: { type: 'source', id: 'src1' }, kind: 'repeats', origin: 'proposed', at: NOW })
    expect(sourcesForClaim(m, 'k1').map((s) => s.id)).toEqual(['src1', 'src2'])
  })
  it('checks automatically what the model wrote, not what only the writer wrote or non-factual statements', () => {
    expect(needsAutoCheck(claim({ author: 'model' }))).toBe(true)
    expect(needsAutoCheck(claim({ author: 'mixed' }))).toBe(true)
    expect(needsAutoCheck(claim({ author: 'writer' }))).toBe(false)
    expect(needsAutoCheck(claim({ kind: 'opinion' }))).toBe(false)
  })
})
