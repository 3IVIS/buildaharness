import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { looksLikeCodingFact, checkForContradictions } from './contradiction-checker.js'

describe('looksLikeCodingFact', () => {
  it('flags structured/technical claims', () => {
    expect(looksLikeCodingFact('the build is passing')).toBe(true)
    expect(looksLikeCodingFact('the service is unavailable')).toBe(true)
    expect(looksLikeCodingFact('config.yaml exists in the repo')).toBe(true)
  })

  it('does not flag natural-language personal facts', () => {
    expect(looksLikeCodingFact('the user lives in Boston')).toBe(false)
    expect(looksLikeCodingFact('my name is Alex')).toBe(false)
    expect(looksLikeCodingFact('I prefer tea over coffee')).toBe(false)
  })

  it('does not flag "passed away" as a build/test-status coding fact', () => {
    // convT: "passed" alone matches the build/test-status sense this list exists for, but also
    // coincidentally matches the unrelated "passed away" (died) idiom — a pet-death correction
    // ("Biscuit passed away last month") got admitted as a fact for the wrong reason.
    expect(looksLikeCodingFact('Actually, Biscuit passed away last month, I adopted a new cat named Pepper instead.')).toBe(false)
  })

  it('still flags a genuine build/test "passed"/"passing" status claim', () => {
    expect(looksLikeCodingFact('the build passed on the first try')).toBe(true)
    expect(looksLikeCodingFact('all tests are passing now')).toBe(true)
  })

  it('flags the plural "packages" the same way it already flags singular "package"', () => {
    // batch 10 re-probe (conv166/h12): \bpackage\b's word boundary can't match a directly-
    // appended plural "s" — "...tracking packages..." never looksLikeCodingFact, so the whole
    // statement was dropped before it ever became a belief (nothing for the contradiction check
    // to even run against, lexical or LLM).
    expect(looksLikeCodingFact('I never bother insuring or tracking packages, it\'s not worth the hassle.')).toBe(true)
  })

  it('flags the plural "repos" the same way it already flags singular "repo"', () => {
    // batch 12 re-probe (conv178/h12): same singular-only \b...\b gap as "package"/"packages",
    // confirmed live for "repo" — "...backing up my repos..." never looksLikeCodingFact, so the
    // contradicting statement was dropped before the belief graph ever saw it.
    expect(looksLikeCodingFact('I never bother backing up my repos anymore, it\'s not worth the hassle.')).toBe(true)
  })

  it('flags the plural "branches" the same way it already flags singular "branch"', () => {
    // batch 12 re-probe (conv198/h12): same gap as "repo"/"repos", confirmed live for "branch" —
    // "...rebasing branches..." never looksLikeCodingFact, so the contradicting statement was
    // dropped before the belief graph ever saw it.
    expect(looksLikeCodingFact('I never bother squashing or rebasing branches anymore, it\'s not worth the hassle.')).toBe(true)
  })

  it('flags the plural "libraries" the same way it already flags singular "library"', () => {
    // batch 20 (h1, re-probing conv178/conv198): same singular-only \b...\b gap as
    // "package"/"packages", confirmed live for "library" — "...pinning versions for
    // libraries..." never looksLikeCodingFact, so the contradicting statement ("I never bother
    // pinning versions for libraries, floating latest is fine these days.") was dropped before
    // the belief graph ever saw it, leaving an earlier "I always pin exact versions for any
    // library I use in production." unchallenged.
    expect(looksLikeCodingFact('I never bother pinning versions for libraries, floating latest is fine these days.')).toBe(true)
  })

  it('flags the plural "databases" the same way it already flags singular "database"', () => {
    // batch 21 (h2/convA, re-probing conv178/conv198): same singular-only \b...\b gap, confirmed
    // live for "database" — "I never bother backing up my databases anymore, it's not worth the
    // hassle." never looksLikeCodingFact, so the contradicting statement was dropped before the
    // belief graph ever saw it, leaving an earlier "I always back up every database before
    // deploying." unchallenged.
    expect(looksLikeCodingFact("I never bother backing up my databases anymore, it's not worth the hassle.")).toBe(true)
  })

  it('flags the plural "scripts" the same way it already flags singular "script"', () => {
    // batch 21 (h2/convA): confirmed live for "script" — both "I always keep my scripts under
    // version control." and "I never bother versioning my scripts these days, it's not worth it."
    // used only the plural form, so neither ever became a belief at all.
    expect(looksLikeCodingFact('I never bother versioning my scripts these days, it\'s not worth it.')).toBe(true)
  })

  it('flags the plural forms of "bug", "error", "config", and "endpoint" the same way it already flags their singulars', () => {
    // batch 25 (re-probing conv178/conv198): confirmed live — a four-pair always/never session
    // showed all four plural-form contradicting statements silently dropped from /memory's Facts
    // list, while the singular originals ("every bug", "every error", "every config file", "every
    // endpoint") were captured fine.
    expect(looksLikeCodingFact("I never bother triaging bugs anymore, it's not worth the hassle.")).toBe(true)
    expect(looksLikeCodingFact('I never bother checking errors anymore, it\'s not worth it.')).toBe(true)
    expect(looksLikeCodingFact('I never bother version-controlling configs anymore, it\'s not worth it.')).toBe(true)
    expect(looksLikeCodingFact('I never bother documenting endpoints anymore, it\'s not worth it.')).toBe(true)
  })
})

class StructuredOnlyLLMClient implements ILLMClient {
  calls = 0
  receivedMessages: ChatMessage[][] = []
  constructor(private readonly content: string) {}

  async *callChat(): AsyncIterable<string> {
    yield ''
  }

  async callChatSync(): Promise<string> {
    return ''
  }

  async callChatStructured(messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMStructuredResponse> {
    this.calls++
    this.receivedMessages.push(messages)
    return { content: this.content }
  }
}

class ThrowingLLMClient implements ILLMClient {
  async *callChat(): AsyncIterable<string> {
    yield ''
  }
  async callChatSync(): Promise<string> {
    return ''
  }
  async callChatStructured(): Promise<LLMStructuredResponse> {
    throw new Error('backend unreachable')
  }
}

describe('checkForContradictions', () => {
  it('returns [] without calling the LLM when there are no new beliefs', async () => {
    const llm = new StructuredOnlyLLMClient('{"contradictions":[]}')
    const result = await checkForContradictions([], [{ id: 'b1', statement: 'the user lives in Boston' }], llm)
    expect(result).toEqual([])
    expect(llm.calls).toBe(0)
  })

  it('returns [] without calling the LLM when every new belief looks like a coding fact', async () => {
    const llm = new StructuredOnlyLLMClient('{"contradictions":[]}')
    const result = await checkForContradictions(
      [{ id: 'b2', statement: 'the build is passing' }],
      [{ id: 'b1', statement: 'the build is failing' }],
      llm,
    )
    expect(result).toEqual([])
    expect(llm.calls).toBe(0)
  })

  it('returns [] without calling the LLM when every new belief is a task-completion trail record', async () => {
    const llm = new StructuredOnlyLLMClient('{"contradictions":[]}')
    const result = await checkForContradictions(
      [{ id: 'b2', statement: 'Completed: Define the Q3 redesign scope' }],
      [{ id: 'b1', statement: 'Completed: Kick off the redesign' }],
      llm,
    )
    expect(result).toEqual([])
    expect(llm.calls).toBe(0)
  })

  it('calls the LLM and returns its findings when a new belief looks like a natural-language fact', async () => {
    const llm = new StructuredOnlyLLMClient(
      JSON.stringify({ contradictions: [{ beliefIds: ['b1', 'b2'], description: 'Boston and Seattle cannot both be the user\'s home city.' }] }),
    )
    const result = await checkForContradictions(
      [{ id: 'b2', statement: 'the user lives in Seattle' }],
      [{ id: 'b1', statement: 'the user lives in Boston' }],
      llm,
    )
    expect(llm.calls).toBe(1)
    expect(result).toEqual([{ beliefIds: ['b1', 'b2'], description: 'Boston and Seattle cannot both be the user\'s home city.' }])
    // Both the new and existing beliefs are sent so the model can compare across the boundary.
    const [sentMessages] = llm.receivedMessages
    const userMessage = sentMessages.find((m) => m.role === 'user')?.content ?? ''
    expect(userMessage).toContain('Seattle')
    expect(userMessage).toContain('Boston')
  })

  it('strips leaked belief ids out of the description even if the model names them', async () => {
    const llm = new StructuredOnlyLLMClient(
      JSON.stringify({
        contradictions: [
          {
            beliefIds: ['fact-respond-1-0', 'fact-respond-1-1'],
            description: 'fact-respond-1-0 states the person works as a nurse, while fact-respond-1-1 states they now work as a physical therapist.',
          },
        ],
      }),
    )
    const result = await checkForContradictions(
      [{ id: 'fact-respond-1-1', statement: 'the user works as a physical therapist' }],
      [{ id: 'fact-respond-1-0', statement: 'the user works as a nurse' }],
      llm,
    )
    expect(result).toHaveLength(1)
    expect(result[0].description).not.toContain('fact-respond-1-0')
    expect(result[0].description).not.toContain('fact-respond-1-1')
    expect(result[0].description).toContain('states the person works as a nurse')
  })

  it('returns [] on malformed JSON instead of throwing', async () => {
    const llm = new StructuredOnlyLLMClient('not json at all')
    const result = await checkForContradictions(
      [{ id: 'b2', statement: 'the user lives in Seattle' }],
      [{ id: 'b1', statement: 'the user lives in Boston' }],
      llm,
    )
    expect(result).toEqual([])
  })

  it('returns [] when the LLM call itself throws', async () => {
    const llm = new ThrowingLLMClient()
    const result = await checkForContradictions(
      [{ id: 'b2', statement: 'the user lives in Seattle' }],
      [{ id: 'b1', statement: 'the user lives in Boston' }],
      llm,
    )
    expect(result).toEqual([])
  })
})
