import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { createArticleMeta, type ArticleMeta } from './article-model.js'
import { reconcileSections } from './article-sections.js'
import { checkConsistency, CONSISTENCY_MAX_ARTICLE_CHARS } from './article-consistency.js'

const NOW = '2026-10-17T10:00:00.000Z'
const ids = (t: ReadonlySet<string>): string => `s${t.size + 1}`
const MD = '# Post\n\nWe moved to the scheduler.\n\n## Cost\n\nWe pay the $200 minimum against $180 for the old server.\n\n## Conclusion\n\nIt costs less than the server it replaced. Every team should move.\n'

function build(): ArticleMeta {
  const sections = reconcileSections([], MD, ids).sections
  return { ...createArticleMeta('a1', 'Post'), sections, sources: [{ id: 'src1', kind: 'upload', freshness: 'current', trust: 'normal', passage: 'Tested on one pipeline of 40 jobs only.' } as ArticleMeta['sources'][number]] }
}
function client(reply: unknown | Error, seen: string[] = []): ILLMClient {
  return {
    callChatStructured: async (messages: { role: string; content: string }[]) => {
      seen.push(messages.find((m) => m.role === 'user')!.content)
      if (reply instanceof Error) throw reply
      return { content: JSON.stringify(reply) }
    },
  } as unknown as ILLMClient
}
const [, , conclusion] = build().sections.map((s) => s.id)

describe('checkConsistency', () => {
  it('marks the section of each finding as needing review with the reason, keeps only quotes that are in that section, and sends the sources', async () => {
    const seen: string[] = []
    const reply = { findings: [
      { sectionId: conclusion, kind: 'conflict', quote: 'It costs less than the server it replaced.', reason: 'The Cost section says $200 against $180.' },
      { sectionId: conclusion, kind: 'overreach', quote: 'Every team should move.', reason: 'The source covers one pipeline.' },
      { sectionId: conclusion, kind: 'conflict', quote: 'A sentence that is not in the text.', reason: 'invented' },
      { sectionId: 'nope', kind: 'conflict', quote: 'Every team should move.', reason: 'no such section' },
    ] }
    const r = await checkConsistency({ meta: build(), markdown: MD, now: NOW }, client(reply, seen))
    expect(r.status).toBe('checked')
    expect(r.findings.map((f) => f.kind)).toEqual(['conflict', 'overreach'])
    expect(r.meta.sections.find((s) => s.id === conclusion)!.review).toMatchObject({ state: 'needs_review', setBy: 'resolver' })
    expect(r.meta.sections.find((s) => s.id === conclusion)!.review.reason).toContain('Goes further than the sources')
    expect(seen[0]).toContain('Tested on one pipeline')
    expect(seen[0]).toContain('<untrusted_external_content>')
  })
  it('leaves the article alone when nothing is found, when the model fails or answers badly, and when the article is too long to send whole', async () => {
    const meta = build()
    expect((await checkConsistency({ meta, markdown: MD, now: NOW }, client({ findings: [] }))).meta).toBe(meta)
    for (const c of [client(new Error('503')), client({ nope: 1 })]) {
      const r = await checkConsistency({ meta, markdown: MD, now: NOW }, c)
      expect(r).toMatchObject({ status: 'not_checked', findings: [] })
      expect(r.meta).toBe(meta)
    }
    const seen: string[] = []
    const long = await checkConsistency({ meta, markdown: MD + 'x'.repeat(CONSISTENCY_MAX_ARTICLE_CHARS), now: NOW }, client({ findings: [] }, seen))
    expect(long.status).toBe('too_long')
    expect(seen).toHaveLength(0)
  })
})
