import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { applyCaptureOps, createEmptyWriterChatState, renderWriterChatBlock, WriterChatStateSchema, type ArticleRef, type CaptureOp } from './writer-chat-state.js'
import { captureChatState } from './writer-chat-capture.js'

const NOW = '2026-10-16T10:00:00.000Z'
const ARTICLES: ArticleRef[] = [
  { id: 'bakery', title: 'What we learned moving our bakery to a form' },
  { id: 'garden', title: 'Our monthly seed swap' },
]

function client(content: string | Error, seen: { messages?: { role: string; content: string }[]; calls?: number } = {}): ILLMClient {
  return {
    callChatStructured: async (messages: { role: string; content: string }[]) => {
      seen.messages = messages
      seen.calls = (seen.calls ?? 0) + 1
      if (content instanceof Error) throw content
      return { content }
    },
  } as unknown as ILLMClient
}

const FIVE: CaptureOp[] = [
  { op: 'add_comment', label: 'C1', reviewer: 'Dana', text: 'Check the two thirds figure.' },
  { op: 'add_comment', label: 'C4', reviewer: 'Dana', text: 'Open with the cost section.' },
  { op: 'add_comment', label: 'C5', reviewer: 'Tom', text: 'Keep the cost section last.' },
  { op: 'conflict', refs: ['C4', 'C5'] },
]

describe('applyCaptureOps', () => {
  it('adds comments, links a conflict both ways and leaves the input state untouched', () => {
    const before = createEmptyWriterChatState()
    const r = applyCaptureOps(before, 'bakery', FIVE, NOW)
    expect(before.comments).toHaveLength(0)
    expect(r.state.comments.map((c) => c.label)).toEqual(['C1', 'C4', 'C5'])
    const c4 = r.state.comments.find((c) => c.label === 'C4')!
    const c5 = r.state.comments.find((c) => c.label === 'C5')!
    expect(c4.conflictsWith).toEqual([c5.id])
    expect(c5.conflictsWith).toEqual([c4.id])
    expect(r.state.comments.every((c) => c.state === 'open' && c.origin === 'reviewer')).toBe(true)
    expect(() => WriterChatStateSchema.parse(r.state)).not.toThrow()
    expect(r.skipped).toEqual([])
  })

  it('records a decision without marking the comment done, and reaches the comment by label', () => {
    const s1 = applyCaptureOps(createEmptyWriterChatState(), 'bakery', FIVE, NOW).state
    const r = applyCaptureOps(s1, 'bakery', [{ op: 'decide', ref: 'c1', decision: 'fix the figure to what the stats show' }], NOW)
    const c1 = r.state.comments.find((c) => c.label === 'C1')!
    expect(c1.decision).toBe('fix the figure to what the stats show')
    expect(c1.state).toBe('open')
  })

  it('keeps labels apart between articles', () => {
    let s = applyCaptureOps(createEmptyWriterChatState(), 'bakery', [{ op: 'add_comment', label: 'C1', text: 'bakery one' }], NOW).state
    s = applyCaptureOps(s, 'garden', [{ op: 'add_comment', label: 'C1', text: 'garden one' }], NOW).state
    s = applyCaptureOps(s, 'garden', [{ op: 'set_state', ref: 'C1', state: 'dismissed' }], NOW).state
    expect(s.comments.find((c) => c.articleId === 'bakery')!.state).toBe('open')
    expect(s.comments.find((c) => c.articleId === 'garden')!.state).toBe('dismissed')
  })

  it('reports an unknown reference or empty content as skipped, never silently', () => {
    const r = applyCaptureOps(createEmptyWriterChatState(), 'bakery', [
      { op: 'decide', ref: 'C9', decision: 'x' },
      { op: 'add_comment', text: '  ' },
      { op: 'conflict', refs: ['C1', 'C2'] },
      { op: 'add_correction', note: '' },
    ], NOW)
    expect(r.state.comments).toHaveLength(0)
    expect(r.skipped).toHaveLength(4)
  })

  it('stores a correction as a lower-trust say-so that names what it replaces', () => {
    const r = applyCaptureOps(createEmptyWriterChatState(), 'bakery', [{ op: 'add_correction', note: 'p99 latency is 41 ms after a re-run', supersedes: '18 ms in rate_limiter_bench.txt' }], NOW)
    expect(r.state.corrections[0]).toMatchObject({ kind: 'say_so', trust: 'lower', supersedes: '18 ms in rate_limiter_bench.txt' })
  })
})

describe('renderWriterChatBlock', () => {
  const state = applyCaptureOps(
    applyCaptureOps(createEmptyWriterChatState(), 'bakery', [...FIVE, { op: 'decide', ref: 'C1', decision: 'fix the figure' }, { op: 'add_correction', note: 'the figure is 9 to 4' }], NOW).state,
    'garden',
    [{ op: 'add_comment', label: 'G1', text: 'Give the next swap a date.' }],
    NOW,
  ).state

  it('shows the open, undecided and conflicting items of the active article only', () => {
    const block = renderWriterChatBlock(state, 'bakery', ARTICLES)
    expect(block).toContain('What we learned moving our bakery')
    expect(block).toContain('comment C1')
    expect(block).toContain('writer decided: fix the figure')
    expect(block).toMatch(/comment C4 \(Dana\) \[open\]: Open with the cost section\.; IN CONFLICT with C5/)
    expect(block).toContain('correction from the writer: the figure is 9 to 4')
    expect(block).not.toContain('G1')
    expect(block).not.toContain('seed swap')
  })

  it('is empty without an active article or without anything recorded', () => {
    expect(renderWriterChatBlock(state, undefined, ARTICLES)).toBe('')
    expect(renderWriterChatBlock(createEmptyWriterChatState(), 'bakery', ARTICLES)).toBe('')
  })
})

describe('captureChatState', () => {
  const state = createEmptyWriterChatState()

  it('applies the ops the model proposes to the article it names', async () => {
    const reply = JSON.stringify({ articleId: 'bakery', ops: FIVE })
    const r = await captureChatState({ message: 'Here are the comments ...', state, articles: ARTICLES, now: NOW }, client(reply))
    expect(r.status).toBe('captured')
    expect(r.articleId).toBe('bakery')
    expect(r.state.comments).toHaveLength(3)
  })

  it('shows the model the writer\'s message and what is already recorded, and nothing the assistant said', async () => {
    const seen: { messages?: { role: string; content: string }[] } = {}
    const s1 = applyCaptureOps(state, 'bakery', [{ op: 'add_comment', label: 'C1', text: 'Check the figure.' }], NOW).state
    await captureChatState({ message: 'Fix C1.', state: s1, articles: ARTICLES, now: NOW }, client('{"articleId":"bakery","ops":[]}', seen))
    const user = JSON.parse(seen.messages!.find((m) => m.role === 'user')!.content)
    expect(user.message).toBe('Fix C1.')
    expect(user.comments[0]).toMatchObject({ id: 'wc1', label: 'C1' })
  })

  it('defaults to the only article when there is just one', async () => {
    const reply = JSON.stringify({ articleId: null, ops: [{ op: 'add_correction', note: 'now 41 ms' }] })
    const r = await captureChatState({ message: 'it is 41 ms', state, articles: [ARTICLES[0]], now: NOW }, client(reply))
    expect(r.status).toBe('captured')
    expect(r.articleId).toBe('bakery')
  })

  it('asks which article instead of guessing when there are several and the message does not say', async () => {
    const reply = JSON.stringify({ articleId: null, ops: [{ op: 'add_correction', note: 'now 41 ms' }] })
    const r = await captureChatState({ message: 'it is 41 ms', state, articles: ARTICLES, now: NOW }, client(reply))
    expect(r.status).toBe('needs_article')
    expect(r.question).toBeTruthy()
    expect(r.pendingOps).toHaveLength(1)
    expect(r.state).toBe(state)
  })

  it('treats an unknown article id like an unnamed one', async () => {
    const reply = JSON.stringify({ articleId: 'nope', ops: [{ op: 'add_correction', note: 'x' }] })
    expect((await captureChatState({ message: 'm', state, articles: ARTICLES, now: NOW }, client(reply))).status).toBe('needs_article')
  })

  it('leaves the state unchanged and says not_captured when the call fails or the reply is unusable', async () => {
    for (const c of [client(new Error('503')), client('not json at all'), client('{"articleId":"bakery"}')]) {
      const r = await captureChatState({ message: 'm', state, articles: ARTICLES, now: NOW }, c)
      expect(r.status).toBe('not_captured')
      expect(r.state).toBe(state)
    }
  })

  it('does not call the model for an empty message, and an empty op list changes nothing', async () => {
    const seen: { calls?: number } = {}
    expect((await captureChatState({ message: '  ', state, articles: ARTICLES }, client('{}', seen))).status).toBe('captured')
    expect(seen.calls ?? 0).toBe(0)
    const r = await captureChatState({ message: 'Yes, go ahead.', state, articles: ARTICLES }, client('{"articleId":null,"ops":[]}'))
    expect(r).toMatchObject({ status: 'captured', applied: [] })
    expect(r.state).toBe(state)
  })

  it('drops malformed ops but keeps the good ones', async () => {
    const reply = JSON.stringify({ articleId: 'bakery', ops: [{ op: 'add_comment', text: 'ok', label: 'C1' }, { op: 'decide', ref: 'C1' }, { op: 'bogus' }, 7] })
    const r = await captureChatState({ message: 'm', state, articles: ARTICLES, now: NOW }, client(reply))
    expect(r.state.comments).toHaveLength(1)
  })
})
