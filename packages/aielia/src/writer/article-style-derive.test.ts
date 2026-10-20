import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { createArticleMeta } from './article-model.js'
import { deriveStyle, shouldDeriveStyle } from './article-style-derive.js'

const client = (reply: unknown | Error, seen: string[] = []): ILLMClient =>
  ({ callChatStructured: async (m: { role: string; content: string }[]) => { seen.push(m[1].content); if (reply instanceof Error) throw reply; return { content: JSON.stringify(reply) } } }) as unknown as ILLMClient
const REPLY = { audience: 'Data engineers', purpose: 'Explain why we moved', tone: 'plain, direct', length: 'about 900 words', notes: 'Each section opens with the result', voice: 'First person plural, short sentences.', terms: [{ use: 'scheduler', instead: 'orchestrator' }, { use: 'run-hour', instead: '' }] }

describe('deriveStyle', () => {
  it('fills the brief and a writing profile from the text, and sends the article as untrusted data', async () => {
    const seen: string[] = []
    const r = await deriveStyle({ meta: createArticleMeta('a', 'T'), markdown: '# T\n\nWe moved.\n' }, client(REPLY, seen))
    expect(r.status).toBe('derived')
    expect(r.meta.brief).toMatchObject({ audience: 'Data engineers', tone: 'plain, direct', length: 'about 900 words' })
    expect(r.meta.style).toMatchObject({ name: 'From this article', voice: 'First person plural, short sentences.', terms: [{ use: 'scheduler', instead: 'orchestrator' }, { use: 'run-hour' }] })
    expect(r.filled).toEqual(['audience', 'purpose', 'tone', 'length', 'notes', 'writing profile'])
    expect(seen[0]).toContain('<untrusted_external_content>')
  })
  it('keeps what the writer already set: a brief field with text and a profile already on the article', async () => {
    const meta = { ...createArticleMeta('a', 'T'), brief: { audience: 'Managers', tone: '' }, style: { id: 'p1', name: 'House', voice: 'Dry.', terms: [] } }
    const r = await deriveStyle({ meta, markdown: 'Text.' }, client(REPLY))
    expect(r.meta.brief?.audience).toBe('Managers')
    expect(r.meta.brief?.tone).toBe('plain, direct')
    expect(r.meta.style?.name).toBe('House')
    expect(r.filled).not.toContain('audience')
    expect(r.filled).not.toContain('writing profile')
  })
  it('leaves the article as it was on a model failure, a bad answer, an empty text, or nothing to say', async () => {
    const meta = createArticleMeta('a', 'T')
    expect((await deriveStyle({ meta, markdown: 'Text.' }, client(new Error('503')))).meta).toBe(meta)
    expect((await deriveStyle({ meta, markdown: 'Text.' }, client('junk'))).status).toBe('not_derived')
    expect((await deriveStyle({ meta, markdown: '  ' }, client(REPLY))).status).toBe('not_derived')
    const empty = await deriveStyle({ meta, markdown: 'Text.' }, client({ audience: '', purpose: '', tone: '', length: '', notes: '', voice: '', terms: [] }))
    expect(empty).toMatchObject({ status: 'derived', filled: [] })
    expect(empty.meta).toBe(meta)
  })
})

describe('shouldDeriveStyle', () => {
  const page = Array.from({ length: 320 }, () => 'word').join(' ')
  it('is true for a page of text and nothing set', () => {
    const meta = createArticleMeta('a', 'A')
    expect(shouldDeriveStyle(meta, page)).toBe(true)
    expect(shouldDeriveStyle(meta, 'short text')).toBe(false)
    expect(shouldDeriveStyle({ ...meta, brief: { tone: 'dry' } }, page)).toBe(false)
  })
})
