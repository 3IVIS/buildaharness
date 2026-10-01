import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '@buildaharness/runtime'
import { compactTranscript, compactTranscriptSemantic, SUMMARY_HEADER } from './transcript-compaction.js'

function messages(n: number, contentLength = 10): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `msg-${i}-${'x'.repeat(contentLength)}`,
  }))
}

describe('compactTranscript', () => {
  it('leaves a short transcript untouched', () => {
    const transcript = messages(6)
    const result = compactTranscript(transcript)
    expect(result.compacted).toBe(false)
    expect(result.transcript).toBe(transcript)
  })

  it('collapses everything but the most recent messages once the message-count threshold is crossed', () => {
    const transcript = messages(45)
    const result = compactTranscript(transcript)

    expect(result.compacted).toBe(true)
    // 1 summary message + the 10 most recent originals.
    expect(result.transcript).toHaveLength(11)
    expect(result.transcript[0].content).toContain('[Earlier conversation summary]')
    // The most recent messages are preserved verbatim, not summarized.
    expect(result.transcript.slice(1)).toEqual(transcript.slice(-10))
  })

  it('collapses once the char-count threshold is crossed even with few messages', () => {
    const transcript = messages(15, 2000)
    const result = compactTranscript(transcript)

    expect(result.compacted).toBe(true)
    expect(result.transcript).toHaveLength(11)
  })

  it('does not compact when there are too few messages to summarize away, even over threshold', () => {
    const transcript = messages(5, 10000)
    const result = compactTranscript(transcript)

    expect(result.compacted).toBe(false)
    expect(result.transcript).toBe(transcript)
  })
})

describe('compactTranscriptSemantic', () => {
  const long = (n: number): ChatMessage[] =>
    Array.from({ length: n }, (_, i) => ({ role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant', content: `message ${i} ${'x'.repeat(900)}` }))

  it('below the thresholds: untouched, and the summarizer is never called', async () => {
    let calls = 0
    const t = long(6)
    const r = await compactTranscriptSemantic(t, async () => { calls++; return 'nope' })
    expect(r).toEqual({ transcript: t, compacted: false })
    expect(calls).toBe(0)
  })

  it('over the thresholds: the older messages become the summarizer\'s text, the same recent messages are kept', async () => {
    const t = long(50)
    let seen: ChatMessage[] = []
    const r = await compactTranscriptSemantic(t, async (older) => { seen = older; return 'Renewal is 14 March.' })
    expect(r.compacted).toBe(true)
    expect(seen).toEqual(t.slice(0, 40))
    expect(r.transcript[0]).toEqual({ role: 'assistant', content: `${SUMMARY_HEADER}\nRenewal is 14 March.` })
    expect(r.transcript.slice(1)).toEqual(t.slice(-10))
  })

  it('a summarizer that returns null or throws falls back to exactly what compactTranscript produces', async () => {
    const t = long(50)
    const plain = compactTranscript(t)
    expect(await compactTranscriptSemantic(t, async () => null)).toEqual(plain)
    expect(await compactTranscriptSemantic(t, async () => { throw new Error('down') })).toEqual(plain)
  })
})
