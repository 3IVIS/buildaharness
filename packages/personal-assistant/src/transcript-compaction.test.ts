import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '@buildaharness/runtime'
import { compactTranscript } from './transcript-compaction.js'

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
