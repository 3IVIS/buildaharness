import { describe, it, expect } from 'vitest'
import type { ILLMClient, LLMStructuredResponse } from '@buildaharness/runtime'
import { ClaudeCliJudge, parseYesNo, buildJudgePrompt } from './judge.js'

/** A fake ILLMClient whose structured call returns a scripted string, or throws if given `null`. */
function fakeClient(reply: string | null): ILLMClient {
  return {
    callChat: (() => {
      throw new Error('judge should only call callChatStructured')
    }) as unknown as ILLMClient['callChat'],
    callChatSync: () => Promise.reject(new Error('judge should only call callChatStructured')),
    callChatStructured: async (): Promise<LLMStructuredResponse> => {
      if (reply === null) throw new Error('claude exited with code 1')
      return { content: reply }
    },
  }
}

describe('parseYesNo', () => {
  it('accepts a bare or decorated YES', () => {
    for (const s of ['YES', 'yes', 'Yes.', '**YES**', 'YES\nbecause the reply names both values']) {
      expect(parseYesNo(s)).toBe(true)
    }
  })
  it('rejects a bare or decorated NO', () => {
    for (const s of ['NO', 'no', 'No.', '**NO**', 'NO — the reply invented a value']) {
      expect(parseYesNo(s)).toBe(false)
    }
  })
  it('rejects garbage, empty, and ambiguous responses', () => {
    for (const s of ['', '   ', 'maybe', 'I think it depends', 'YES and NO', 'the answer is unclear', '{"verdict":42}']) {
      expect(parseYesNo(s)).toBe(false)
    }
  })
  it('rejects a non-string', () => {
    expect(parseYesNo(undefined)).toBe(false)
    expect(parseYesNo(null)).toBe(false)
    expect(parseYesNo(123)).toBe(false)
  })
})

describe('buildJudgePrompt', () => {
  it('embeds the rubric, prompt, and reply', () => {
    const p = buildJudgePrompt('is it polite', 'say hi', 'hello there')
    expect(p).toContain('is it polite')
    expect(p).toContain('say hi')
    expect(p).toContain('hello there')
  })
  it('marks an empty reply explicitly rather than leaving a blank', () => {
    expect(buildJudgePrompt('r', 'p', '')).toContain('no reply')
  })
})

describe('ClaudeCliJudge', () => {
  it('YES → pass', async () => {
    const j = new ClaudeCliJudge(fakeClient('YES'))
    expect(await j.judge('rubric', 'prompt', 'reply')).toBe(true)
  })
  it('NO → fail', async () => {
    const j = new ClaudeCliJudge(fakeClient('NO'))
    expect(await j.judge('rubric', 'prompt', 'reply')).toBe(false)
  })
  it('garbage → fail', async () => {
    const j = new ClaudeCliJudge(fakeClient('I am not sure, could be either'))
    expect(await j.judge('rubric', 'prompt', 'reply')).toBe(false)
  })
  it('a thrown client error → fail, never re-thrown', async () => {
    const j = new ClaudeCliJudge(fakeClient(null))
    await expect(j.judge('rubric', 'prompt', 'reply')).resolves.toBe(false)
  })
})
