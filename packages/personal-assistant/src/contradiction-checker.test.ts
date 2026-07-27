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

  it('flags the plural forms of "log" and "command" the same way it already flags their singulars (batch 29, conv3/convR2)', () => {
    // conv3: "The build logs show success right now." / "Actually, the build logs show failure
    // now after the last commit." reproduced the silent-drop shape live — neither statement
    // appeared in /memory's Facts list. convR2: same shape for "commands" ("All the deploy
    // commands are passing in CI right now." / "Actually, the deploy commands are now failing in
    // the staging environment.").
    expect(looksLikeCodingFact('The build logs show success right now.')).toBe(true)
    expect(looksLikeCodingFact('All the deploy commands are passing in CI right now.')).toBe(true)
  })

  it('flags the plural forms of "exception", "service", "function", "schema", "variable", and "environment" the same way it already flags their singulars (batch 42, h1/conv178/conv387)', () => {
    // convLF1: "My exceptions are all getting caught silently now and I can't figure out why."
    // convR1: "My services and functions are all throwing exceptions now, and my schemas and
    // variables seem fine." Both used only plural forms, so neither statement matched
    // CODING_FACT_MARKERS at all before this fix — same silent-drop shape as every other noun
    // already widened above. This closes out the last of the batch10-named sibling gaps
    // ("exception" was named in the original list but dropped from later tracking without ever
    // actually being fixed).
    expect(looksLikeCodingFact("My exceptions are all getting caught silently now and I can't figure out why.")).toBe(true)
    expect(
      looksLikeCodingFact('My services and functions are all throwing exceptions now, and my schemas and variables seem fine.'),
    ).toBe(true)
    expect(looksLikeCodingFact("I never bother deploying to the staging environments before production, it's not worth the hassle.")).toBe(
      true,
    )
  })

  // Simplified Chinese fixtures — first-pass phrasing per
  // plans/personal_assistant_chinese_lexical_checks_plan.html's Phase 2a step 3 (lower priority
  // within that phase: a missed match here just means the LLM contradiction check always runs
  // instead of being skipped, which is strictly safe, just slower); not yet reviewed by a fluent
  // Chinese speaker, see that plan's "Fixture-writing caveat".
  it('flags structured/technical claims in Chinese', () => {
    expect(looksLikeCodingFact('构建通过了，可以部署了。')).toBe(true)
    expect(looksLikeCodingFact('这个服务现在不可用。')).toBe(true)
    expect(looksLikeCodingFact('数据库中已经存在这条记录。')).toBe(true)
  })

  it('does not flag natural-language personal facts in Chinese', () => {
    expect(looksLikeCodingFact('我叫Alex，住在北京。')).toBe(false)
    expect(looksLikeCodingFact('我更喜欢喝茶而不是咖啡。')).toBe(false)
  })

  it('English loanwords (test/bug/API/CI-CD) embedded in an otherwise-Chinese sentence already match via the existing "en" pattern, with no Chinese-specific entry needed', () => {
    // JS regex treats CJK ideographs as non-word characters, so \b still finds a boundary at the
    // Chinese/Latin transition — the "en" pattern's \bapi\b and \bbugs?\b already match these
    // without any "zh" content, confirmed here so the loanword decision documented in the
    // CODING_FACT_MARKERS comment above has a regression test behind it.
    expect(looksLikeCodingFact('这个API不可用。')).toBe(true)
    expect(looksLikeCodingFact('他说这个bug还没修复。')).toBe(true)
  })

  it('known false-positive risk: 通过 ("pass") also matches its much more common everyday sense of "via/through"', () => {
    // "我通过朋友认识了她" ("I got to know her through a friend") is an ordinary personal
    // statement with no build/test meaning at all — flagged here per the CODING_FACT_MARKERS
    // comment above as the collision most worth a native speaker's attention, since 通过 is used
    // as this everyday preposition considerably more often than as "passed (a test/build)".
    expect(looksLikeCodingFact('我通过朋友认识了她。')).toBe(true)
  })

  it('known false-positive risk: 状态 ("status") and 日志 ("log") also match their everyday, non-technical senses', () => {
    // 状态 appears in "marital status" (婚姻状态) and general mood/state phrasing; 日志 is also the
    // ordinary word for a diary/journal entry, not just a system/build log.
    expect(looksLikeCodingFact('我现在的状态很好，谢谢关心。')).toBe(true)
    expect(looksLikeCodingFact('我写了一篇日志记录今天的心情。')).toBe(true)
  })

  it('does not flag bare "package"/"library"/"repository" senses that are unrelated to code, since those Chinese entries require the more specific compound word', () => {
    // 包/库/仓库 (bag/wrap; garage/warehouse; warehouse/storage) are extremely common everyday
    // words unrelated to software — CODING_FACT_MARKERS uses the more specific 软件包/代码库/
    // 代码仓库 instead, so ordinary sentences using the bare, non-technical senses are not flagged.
    expect(looksLikeCodingFact('我今天买了面包和牛奶。')).toBe(false)
    expect(looksLikeCodingFact('老家有个仓库放粮食。')).toBe(false)
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
