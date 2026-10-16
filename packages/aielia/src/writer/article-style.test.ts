import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { createArticleMeta, parseArticleMeta, type ArticleMeta } from './article-model.js'
import { applyProfile, cleanProfile, renderStyleGuide, setBrief } from './article-style.js'
import { suggestEdits } from './article-edit-suggest.js'
import { ArticleService, createArticleChatPort, createMemoryArticleStore } from './article-service.js'
import { processWriterMessage } from './writer-chat-turn.js'

const NOW = '2026-10-16T10:00:00.000Z'
const meta = (): ArticleMeta => createArticleMeta('a1', 'Post')
const llmNever = {} as ILLMClient

describe('brief and writing profile', () => {
  it('keeps only filled fields, and an empty brief removes it', () => {
    const m = setBrief(meta(), { audience: ' SREs ', tone: '', notes: undefined })
    expect(m.brief).toEqual({ audience: 'SREs' })
    expect(setBrief(m, { audience: '  ' }).brief).toBeUndefined()
  })
  it('cleans a profile: needs a name, drops empty and repeated terms', () => {
    expect(cleanProfile({ id: 'p', name: '  ' })).toBeUndefined()
    const p = cleanProfile({ id: 'p', name: 'House', voice: ' plain ', terms: [{ use: 'customer', instead: 'user' }, { use: 'Customer' }, { use: ' ' }, { use: 'p99' }] })
    expect(p).toEqual({ id: 'p', name: 'House', voice: 'plain', terms: [{ use: 'customer', instead: 'user' }, { use: 'p99' }] })
  })
  it('renders nothing without a brief or profile, otherwise plain lines', () => {
    expect(renderStyleGuide(meta())).toBe('')
    const p = cleanProfile({ id: 'p', name: 'House', voice: 'plain and direct', terms: [{ use: 'customer', instead: 'user' }, { use: 'p99' }] })!
    const m = applyProfile(setBrief(meta(), { audience: 'SREs', purpose: 'explain the outage' }), p)
    expect(renderStyleGuide(m)).toBe('Audience: SREs\nPurpose: explain the outage\nVoice (House): plain and direct\nSay "customer", not "user".\nAlways write "p99" exactly so.')
    expect(applyProfile(m, null).style).toBeUndefined()
  })
  it('survives a round trip through the metadata file and old files without the fields still load', () => {
    const m = setBrief(meta(), { audience: 'SREs' })
    const back = parseArticleMeta(JSON.parse(JSON.stringify(m)))
    expect(back.ok && back.meta.brief).toEqual({ audience: 'SREs' })
    expect(parseArticleMeta(JSON.parse(JSON.stringify(meta()))).ok).toBe(true)
  })
  it('is sent to the model that proposes edits', async () => {
    const seen: string[] = []
    const llm = { callChatStructured: async (m: { role: string; content: string }[]) => { seen.push(m.find((x) => x.role === 'user')!.content); return { content: '{"suggestions":[]}' } } } as unknown as ILLMClient
    await suggestEdits({ meta: setBrief(meta(), { tone: 'dry' }), markdown: '# Post\n', instruction: 'tighten', now: NOW }, llm)
    expect(JSON.parse(seen[0]).styleGuide).toBe('Tone: dry')
    await suggestEdits({ meta: meta(), markdown: '# Post\n', instruction: 'tighten', now: NOW }, llm)
    expect(JSON.parse(seen[1]).styleGuide).toBeUndefined()
  })
  it('is kept by the service: profiles saved once, copied into an article, and shown to the answering model', async () => {
    const store = createMemoryArticleStore()
    const svc = new ArticleService({ store, llm: llmNever, now: () => NOW })
    const id = await svc.create('Post', '# Post\n\nBody.\n')
    expect(await svc.saveProfile({ name: '' })).toBeUndefined()
    const prof = (await svc.saveProfile({ name: 'House', voice: 'plain', terms: [{ use: 'customer', instead: 'user' }] }))!
    expect((await svc.profiles()).map((p) => p.name)).toEqual(['House'])
    expect(await svc.useProfile(id, 'nope')).toMatchObject({ ok: false })
    await svc.setBrief(id, { audience: 'SREs' })
    expect(await svc.useProfile(id, prof.id)).toEqual({ ok: true })
    // editing the saved profile later does not change the article's copy
    await svc.saveProfile({ id: prof.id, name: 'House', voice: 'formal' })
    expect((await svc.get(id)).meta.style?.voice).toBe('plain')
    const port = createArticleChatPort(store)
    expect(await port.styleText!(id)).toContain('Audience: SREs')
    await port.setActive(id)
    const out = await processWriterMessage({ port, message: 'hello', now: NOW }, { callChatStructured: async () => ({ content: '{"ops":[],"articleId":null}' }) } as unknown as ILLMClient)
    expect(out).toContain('Audience: SREs')
    await svc.deleteProfile(prof.id)
    expect(await svc.profiles()).toEqual([])
    expect(await svc.useProfile(id, null)).toEqual({ ok: true })
    expect((await svc.get(id)).meta.style).toBeUndefined()
  })
})
