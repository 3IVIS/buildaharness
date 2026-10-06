import { describe, it, expect, vi, afterEach } from 'vitest'
import { PassThrough, Writable } from 'node:stream'
import type { ChatMessage, ChatOptions, ILLMClient, ToolDefinition, LLMStructuredResponse, FsBackend } from '@buildaharness/runtime'
import { InMemoryAdapter } from '@buildaharness/runtime'
import { HarnessRuntime, saveHarnessCheckpoint, type Task, type AskResponse } from '@buildaharness/harness'
import { PersonalAssistant } from './assistant.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'
import { runCli, StartupError, type RunCliOptions, type CliInstance } from './cli.js'
import { DEFAULT_CONFIG, type ConfigStore, type AssistantConfig } from './config.js'
import { classifyRiskLexical } from './risk-classifier.js'
import { PLAN_LINE_PREFIX } from './cli-icons.js'

/**
 * cli.ts's `main()` runs at import time (see non-interactive-mode.ts's doc comment) — runCli()
 * is the seam T1 added specifically so this file can drive command dispatch directly instead of
 * only through a live process. Every test builds its own isolated in-memory config
 * store/backend/assistant so nothing here touches the real filesystem, a real LLM backend, or a
 * real TTY.
 */

// Every turn now spends exactly one classifyTurnIntent call up front (see
// turn-intent-classifier.ts) — trimmed version of assistant.test.ts's own
// isTurnIntentRequest/deriveTurnIntentJSON, so the fakes below can answer that call with a
// realistic risk/triviality classification instead of it falling back to LOW by default.
function isTurnIntentRequest(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === 'system' && m.content.includes(' independent judgments'))
}

// Trimmed test-only stand-in for the deleted triviality-classifier.ts's classifyTriviality — see
// assistant.test.ts's looksTrivial for the full doc comment.
const TRIVIAL_HISTORY_MARKERS = /\b(earlier|before|you said|remember|again|previously|as I mentioned|still)\b/i
const TRIVIAL_GENERATIVE_MARKERS = /\b(write|draft|give me a|create|generate|compose|plan|design|pitch|summarize|explain|compare|pros and cons|recommend|best way|should I|how do I decide)\b/i
const TRIVIAL_COMPOUND_MARKERS = /\band also\b|\?.*\?|\band\s+(what|when|where|how|is|are|was|were|does|do|did|can|could|will|should|who|which)\b/i
const TRIVIAL_FACTUAL_SHAPE = /^(what|when|where|how many|how much|is|are|does|do)\b/i

function looksTrivial(message: string): boolean {
  const trimmed = message.trim()
  if (trimmed.split(/\s+/).filter(Boolean).length > 15) return false
  return (
    TRIVIAL_FACTUAL_SHAPE.test(trimmed) &&
    !TRIVIAL_HISTORY_MARKERS.test(trimmed) &&
    !TRIVIAL_GENERATIVE_MARKERS.test(trimmed) &&
    !TRIVIAL_COMPOUND_MARKERS.test(trimmed)
  )
}

function deriveTurnIntentJSON(messages: ChatMessage[]): string {
  const userContent = messages.find((m) => m.role === 'user')?.content ?? ''
  const risk = classifyRiskLexical(userContent)
  return JSON.stringify({
    riskLevel: risk.riskLevel,
    riskReason: risk.reason,
    isTrivial: risk.riskLevel === 'LOW' && looksTrivial(userContent),
    decomposedTasks: [],
    isReminderRequest: risk.reason.includes('reminder'),
    isBulkReminderRequest: risk.reason.includes('reminder') && risk.requiresApproval,
    isAbandonRequest: false,
    matchedPlanTemplate: null,
    needsMultiStepPlan: false,
  })
}

class FakeLLMClient implements ILLMClient {
  calls = 0
  constructor(private readonly reply: string = 'Noted.') {}
  async *callChat(): AsyncIterable<string> {
    this.calls++
    yield this.reply
  }
  async callChatSync(): Promise<string> {
    this.calls++
    return this.reply
  }
  async callChatStructured(messages: ChatMessage[]): Promise<LLMStructuredResponse> {
    this.calls++
    if (isTurnIntentRequest(messages)) return { content: deriveTurnIntentJSON(messages) }
    return { content: this.reply }
  }
}

/** Scripts a single tool-calling response (e.g. write_file), then a plain follow-up reply once the loop resolves — trimmed version of assistant.test.ts's ScriptedToolLLMClient. */
class ScriptedToolLLMClient implements ILLMClient {
  // One tool call served per non-turn-intent callChatStructured invocation, in order — a plain
  // array + shift() rather than the original single `served` boolean, so a test can script one
  // staged tool call per dispatchLine() turn across several separate turns (e.g. the "don't ask
  // again" remember-across-turns coverage below), not just once ever. Every call site that only
  // ever passes one tool call keeps exactly its old one-shot-then-"Done." behavior.
  private readonly toolCalls: { id: string; name: string; input: Record<string, unknown> }[]
  constructor(...toolCalls: { id: string; name: string; input: Record<string, unknown> }[]) {
    this.toolCalls = [...toolCalls]
  }
  async *callChat(): AsyncIterable<string> {
    yield 'Done.'
  }
  async callChatSync(): Promise<string> {
    return 'Done.'
  }
  async callChatStructured(messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMStructuredResponse> {
    if (isTurnIntentRequest(messages)) return { content: deriveTurnIntentJSON(messages) }
    // Auxiliary structured calls the goal graph makes around a turn (identity matcher, next-step
    // proposer) must not consume a scripted tool call meant for the turn itself.
    const system = String(messages[0]?.content ?? '')
    if (system.includes('existing goal threads')) return { content: '{"matchedGoalId":null,"ambiguous":false}' }
    if (system.includes('propose 0-3 concrete, actionable')) return { content: '{"suggestions":[]}' }
    const next = this.toolCalls.shift()
    if (next) return { content: '', toolCalls: [next] }
    return { content: 'Done.' }
  }
}

/**
 * Phase 3 (hierarchical_goal_tree_and_steering_plan.html) steering tests need a turn that
 * genuinely stays in flight until the test says so, so a second dispatchLine() can be observed
 * arriving while `turnInProgress` is still true. `callChat` (the streamed-reply path handleTurn's
 * writeToken loop consumes) blocks on `replyGate` until `release()` is called; `callChatStructured`
 * still answers the turn-intent classification immediately, same as FakeLLMClient, since only the
 * final reply generation needs to hang.
 */
class DeferredReplyLLMClient implements ILLMClient {
  private releaseReply: (() => void) | undefined
  private readonly replyGate: Promise<void>
  constructor(private readonly reply: string = 'Noted.') {
    this.replyGate = new Promise((resolve) => {
      this.releaseReply = resolve
    })
  }
  release(): void {
    this.releaseReply?.()
  }
  async *callChat(): AsyncIterable<string> {
    await this.replyGate
    yield this.reply
  }
  async callChatSync(): Promise<string> {
    await this.replyGate
    return this.reply
  }
  async callChatStructured(messages: ChatMessage[]): Promise<LLMStructuredResponse> {
    if (isTurnIntentRequest(messages)) return { content: deriveTurnIntentJSON(messages) }
    await this.replyGate
    return { content: this.reply }
  }
}

/** Yields until the microtask queue (and one macrotask tick) has drained — enough for dispatchOne's synchronous `turnInProgress = true` to have run after an un-awaited dispatchLine() call. */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function makeFakeBackend(): FsBackend {
  const files = new Map<string, string>()
  return {
    async readTextFile(path) {
      return files.get(path)
    },
    async writeTextFile(path, contents) {
      files.set(path, contents)
    },
    async removeFile(path) {
      files.delete(path)
    },
    async mkdir() {},
    async readDir() {
      return []
    },
  }
}

/** In-memory ConfigStore mirroring NodeConfigStore's own merge/undefined-deletes semantics (see node-config-store.test.ts) without touching a real file. */
function makeConfigStore(initial: Partial<AssistantConfig> = {}): ConfigStore {
  let persisted: Partial<AssistantConfig> = { ...initial }
  return {
    async load() {
      return { ...persisted }
    },
    async save(patch) {
      const next: Partial<AssistantConfig> = { ...persisted }
      for (const key of Object.keys(patch) as (keyof AssistantConfig)[]) {
        const value = patch[key]
        if (value === undefined) delete next[key]
        else Object.assign(next, { [key]: value })
      }
      persisted = next
    },
  }
}

const openCli: CliInstance[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const cli of openCli.splice(0)) cli.close()
})

/** Boots runCli() fully in-process: fake backend, in-memory config store, a scripted assistant, and piped-but-never-fed stdio — nothing here can touch the real ~/.buildaharness directory or a live TTY. */
async function setupCli(overrides: Partial<RunCliOptions> = {}): Promise<{ cli: CliInstance; configStore: ConfigStore }> {
  const configStore = overrides.configStore ?? makeConfigStore()
  // Silences runCli()'s startup banner (backend/capability lines) so it doesn't spill onto the
  // real terminal during the test run — captureOutput(), called after setupCli() resolves,
  // re-spies with a capturing implementation for whatever the test dispatches next.
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const cli = await runCli({
    dataDir: '/tmp/cli-test-unused',
    backend: makeFakeBackend(),
    remindersFile: '/tmp/cli-test-unused/reminders/reminders.json',
    envOverrides: {},
    nonInteractiveApprovalMode: undefined,
    input: new PassThrough(),
    output: new Writable({ write: (_chunk, _enc, cb) => cb() }),
    configStore,
    assistant: new PersonalAssistant({ llmClient: new FakeLLMClient() }),
    ...overrides,
  })
  openCli.push(cli)
  return { cli, configStore }
}

/**
 * Captures both console.log (banners, command output, needs_approval prompts) and raw
 * process.stdout.write (the reply text itself — handleTurn's writeToken/writeProgress bypass
 * console.log and write directly, see cli.ts) into one combined, chronological buffer, matching
 * what a user watching the terminal actually sees.
 */
function captureOutput(): string[] {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : chunk.toString())
    return true
  })
  return lines
}

describe('/layers settings|on|off|reset', () => {
  afterEach(() => {
    delete process.env.AUDIT_SEMANTIC_HYPOTHESES
    delete process.env.AUDIT_DECOMPOSITION
  })

  it('persists a choice, applies it to the layer flag at once, and lists it as changed', async () => {
    const { cli, configStore } = await setupCli()
    const lines = captureOutput()

    await cli.dispatchLine('/layers on semantic_hypotheses')
    expect(await configStore.load()).toMatchObject({ layers: { semantic_hypotheses: true } })
    expect(process.env.AUDIT_SEMANTIC_HYPOTHESES).toBe('1')

    lines.length = 0
    await cli.dispatchLine('/layers settings')
    expect(lines.join('\n')).toMatch(/semantic_hypotheses\s+on\s.*\(changed\)/)

    await cli.dispatchLine('/layers reset')
    expect(await configStore.load()).toMatchObject({ layers: {} })
    expect(process.env.AUDIT_SEMANTIC_HYPOTHESES).toBeUndefined()
  })

  it('refuses a locked or unknown layer and saves nothing', async () => {
    const { cli, configStore } = await setupCli()
    const lines = captureOutput()

    await cli.dispatchLine('/layers off approval_staging')
    await cli.dispatchLine('/layers off not_a_layer')

    expect(lines.join('\n')).toContain('cannot be switched off')
    expect(lines.join('\n')).toContain('Unknown layer')
    expect(await configStore.load()).toEqual({})
  })

  it('says so when the operator pinned the flag, instead of claiming the choice took effect', async () => {
    process.env.AUDIT_DECOMPOSITION = '1'
    const { cli } = await setupCli()
    const lines = captureOutput()

    await cli.dispatchLine('/layers off decomposition_reframe')

    expect(lines.join('\n')).toContain('pinned by its AUDIT_* env flag')
    expect(process.env.AUDIT_DECOMPOSITION).toBe('1')
  })
})

describe('/config', () => {
  it('bare /config lists every key at its current (default) value', async () => {
    const { cli } = await setupCli()
    const lines = captureOutput()

    await cli.dispatchLine('/config')

    const output = lines.join('\n')
    expect(output).toContain('llmBackend')
    expect(output).toContain(DEFAULT_CONFIG.llmBackend)
  })

  it('/config set <key> <value> persists the change and reflects it in a subsequent listing, taking effect without a restart', async () => {
    const { cli, configStore } = await setupCli()
    const lines = captureOutput()

    await cli.dispatchLine('/config set enableShell true')
    expect(await configStore.load()).toMatchObject({ enableShell: true })

    lines.length = 0
    await cli.dispatchLine('/config')
    expect(lines.join('\n')).toMatch(/enableShell\s+true/)
  })

  it('env-pinned keys reject /config set and explain which env var pins them (precedence: env var > persisted > default)', async () => {
    const { cli, configStore } = await setupCli({ envOverrides: { enableWeb: true, braveApiKey: 'test-key' } })
    const lines = captureOutput()

    await cli.dispatchLine('/config set enableWeb false')

    expect(lines.join('\n')).toContain('pinned by ASSISTANT_ENABLE_WEB')
    expect(await configStore.load()).toEqual({})
  })

  it('/config set with an unknown key is rejected with a clear error, not silently accepted', async () => {
    const { cli, configStore } = await setupCli()
    const lines = captureOutput()

    await cli.dispatchLine('/config set notARealKey banana')

    expect(lines.join('\n')).toContain('Unknown config key "notARealKey"')
    expect(await configStore.load()).toEqual({})
  })

  it('/config set with a value that fails to parse for the key type is rejected, leaving config unchanged', async () => {
    const { cli, configStore } = await setupCli()
    const lines = captureOutput()

    await cli.dispatchLine('/config set enableWeb not-a-boolean')

    expect(lines.join('\n')).toContain('enableWeb must be "true" or "false"')
    expect(await configStore.load()).toEqual({})
  })

  it('/config set rejects a combination validateConfig() disallows (enableWeb with no braveApiKey)', async () => {
    const { cli, configStore } = await setupCli()
    const lines = captureOutput()

    await cli.dispatchLine('/config set enableWeb true')

    expect(lines.join('\n')).toContain('braveApiKey')
    expect(await configStore.load()).toEqual({})
  })
})

describe('exit / quit', () => {
  it.each(['exit', 'quit', '/exit', '/quit', 'EXIT', '  Exit  '])('a bare %j ends the session without a model turn', async (word) => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    const turn = vi.spyOn(assistant, 'turn')
    const { cli } = await setupCli({ assistant })
    const lines = captureOutput()

    await cli.dispatchLine(word)

    expect(turn).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('Exiting.')
  })

  it('a message that merely starts with the word is still an ordinary turn', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    const turn = vi.spyOn(assistant, 'turn')
    const { cli } = await setupCli({ assistant })
    captureOutput()

    await cli.dispatchLine('exit strategy for my startup')

    expect(turn).toHaveBeenCalledTimes(1)
  })

  it('lines still buffered behind the quit command are dropped, not run', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    const turn = vi.spyOn(assistant, 'turn')
    const { cli } = await setupCli({ assistant })
    captureOutput()

    await cli.dispatchLine('exit')
    await cli.dispatchLine('hello after exit')

    expect(turn).not.toHaveBeenCalled()
  })

  it('/help lists it', async () => {
    const { cli } = await setupCli()
    const lines = captureOutput()
    await cli.dispatchLine('/help')
    expect(lines.join('\n')).toContain('/exit')
  })
})

describe('mid-task steering — LiveSteeringChannel routing (Phase 3, hierarchical_goal_tree_and_steering_plan.html)', () => {
  it('goalGraphMode explicitly disabled: a message sent while a turn is running still blocks on dispatchQueue, byte-identical to before the mechanism existed (INV-43)', async () => {
    const llm = new DeferredReplyLLMClient()
    const { cli } = await setupCli({ assistant: new PersonalAssistant({ llmClient: llm }), envOverrides: { goalGraphMode: 'disabled' } })
    const lines = captureOutput()

    const firstTurn = cli.dispatchLine('first message')
    await flushAsync()

    let secondResolved = false
    const secondTurn = cli.dispatchLine('second message').then(() => {
      secondResolved = true
    })
    await flushAsync()
    // Not routed to any steering channel — it's still waiting in dispatchQueue behind the
    // in-flight first turn, exactly like before this mechanism existed.
    expect(secondResolved).toBe(false)
    expect(lines.join('\n')).not.toContain('queued')

    llm.release()
    await firstTurn
    await secondTurn
    expect(secondResolved).toBe(true)
  })

  it('goalGraphMode unset (the default is now enabled): a message sent while a turn is running is absorbed into the steering channel instead of blocking', async () => {
    const llm = new DeferredReplyLLMClient()
    const { cli } = await setupCli({ assistant: new PersonalAssistant({ llmClient: llm }) })
    const lines = captureOutput()

    const firstTurn = cli.dispatchLine('first message')
    await flushAsync()
    await cli.dispatchLine('second message') // resolves immediately — not waiting behind the turn
    expect(lines.join('\n')).toContain('queued')

    llm.release()
    await firstTurn
  })

  it('goalGraphMode enabled: a plain message sent while a turn is running is absorbed into the steering channel, classified by the in-flight turn, and — when deferred — answered as its own follow-up turn, never dropped (R4)', async () => {
    const llm = new DeferredReplyLLMClient()
    const { cli } = await setupCli({ assistant: new PersonalAssistant({ llmClient: llm }), envOverrides: { goalGraphMode: 'enabled' } })
    const lines = captureOutput()

    const firstTurn = cli.dispatchLine('first message')
    await flushAsync()

    // Resolves immediately — routeMessage() only enqueues into steeringChannel, it never waits
    // on dispatchQueue the way the default-off case above does.
    await cli.dispatchLine('second message')
    expect(lines.join('\n')).toContain('queued')

    llm.release()
    await firstTurn
    // The running turn's own checkCallerUpdates classifies "second message"; the fail-safe default
    // under this mock LLM (SAME_GOAL_NEW_TASK × DEFERRED, since callChatStructured's non-turn-intent
    // branch returns plain text, not classifier-shaped JSON) means "wait until the current task
    // finishes" — so the reconcile channel hands it back and dispatchOne's post-turn drain runs it
    // as its own follow-up turn. (An earlier revision folded it into the run as a harness
    // criterion nothing ever acted on, and this test asserted the resulting single reply — i.e. it
    // enshrined the ask being silently dropped.) Flushing /status lets that queued turn finish.
    await cli.dispatchLine('/status')
    await flushAsync()

    const output = lines.join('\n')
    expect((output.match(/Noted\./g) ?? []).length).toBe(2)
  })

  it('onTurnBusyChange reports busy for the turn and for a deferred follow-up turn, idle at the end, and never for a slash command', async () => {
    const llm = new DeferredReplyLLMClient()
    const busy: boolean[] = []
    const { cli } = await setupCli({
      assistant: new PersonalAssistant({ llmClient: llm }),
      envOverrides: { goalGraphMode: 'enabled' },
      onTurnBusyChange: (b: boolean) => busy.push(b),
    })
    captureOutput()

    await cli.dispatchLine('/status')
    expect(busy).toEqual([])

    const first = cli.dispatchLine('first message')
    await flushAsync()
    expect(busy).toEqual([true])
    await cli.dispatchLine('second message') // queued mid-turn
    llm.release()
    await first
    await cli.dispatchLine('/status')
    await flushAsync()

    // true,false for the first turn, then true,false for the queued message run as its own turn.
    expect(busy).toEqual([true, false, true, false])
  })

  it('goalGraphMode enabled: a slash command sent while a turn is running still keeps dispatchQueue\'s strict serialization (never steered) — /config race-avoidance still holds', async () => {
    const llm = new DeferredReplyLLMClient()
    const { cli, configStore } = await setupCli({ assistant: new PersonalAssistant({ llmClient: llm }), envOverrides: { goalGraphMode: 'enabled' } })
    captureOutput()

    const firstTurn = cli.dispatchLine('first message')
    await flushAsync()

    let configResolved = false
    const configDispatch = cli.dispatchLine('/config set enableShell true').then(() => {
      configResolved = true
    })
    await flushAsync()
    // A command is never routed to the steering channel, regardless of goalGraphMode — it still
    // waits behind the running turn in dispatchQueue.
    expect(configResolved).toBe(false)

    llm.release()
    await firstTurn
    await configDispatch
    expect(configResolved).toBe(true)
    expect(await configStore.load()).toMatchObject({ enableShell: true })
  })
})

describe('turn-end next steps (R7)', () => {
  /** Answers turn-intent, the next-step proposer (JSON), and plain replies; records every plain user turn it was asked to answer. */
  class NextStepLLMClient implements ILLMClient {
    answered: string[] = []
    async *callChat(messages: ChatMessage[]): AsyncIterable<string> {
      this.answered.push(String(messages.filter((m) => m.role === 'user').at(-1)?.content))
      yield 'Here you go.'
    }
    async callChatSync(messages: ChatMessage[]): Promise<string> {
      this.answered.push(String(messages.filter((m) => m.role === 'user').at(-1)?.content))
      return 'Here you go.'
    }
    async callChatStructured(messages: ChatMessage[]): Promise<LLMStructuredResponse> {
      if (String(messages[0]?.content).includes('propose 0-3 concrete, actionable')) {
        return {
          content: JSON.stringify({
            suggestions: [
              { description: 'add tests for the login page', confidence: 'high', rationale: 'r' },
              { description: 'wire it into the router', confidence: 'medium', rationale: 'r' },
            ],
          }),
        }
      }
      if (isTurnIntentRequest(messages)) return { content: deriveTurnIntentJSON(messages) }
      return { content: 'Here you go.' }
    }
  }
  const fullTurn = 'Can you summarize what the login page does in this project?'

  it('prints the options under the reply, with the hint that typing your own message also works', async () => {
    const llm = new NextStepLLMClient()
    const { cli } = await setupCli({ assistant: new PersonalAssistant({ llmClient: llm, goalGraphSuggestMode: 'enabled' }) })
    const lines = captureOutput()

    await cli.dispatchLine(fullTurn)

    const output = lines.join('\n')
    expect(output).toContain('Next steps you could take')
    expect(output).toContain('1. add tests for the login page')
    expect(output).toContain('2. wire it into the router')
    expect(output).toContain('just type your own message')
  })

  it('a bare 1 right after the options runs that option as the next message', async () => {
    const llm = new NextStepLLMClient()
    const { cli } = await setupCli({ assistant: new PersonalAssistant({ llmClient: llm, goalGraphSuggestMode: 'enabled' }) })
    const lines = captureOutput()

    await cli.dispatchLine(fullTurn)
    await cli.dispatchLine('1')

    expect(llm.answered.at(-1)).toContain('add tests for the login page')
    expect(lines.join('\n')).toContain('→ add tests for the login page')
  })

  it('typing your own message instead just works — options are only shortcuts, never a required choice', async () => {
    const llm = new NextStepLLMClient()
    const { cli } = await setupCli({ assistant: new PersonalAssistant({ llmClient: llm, goalGraphSuggestMode: 'enabled' }) })
    captureOutput()

    await cli.dispatchLine(fullTurn)
    await cli.dispatchLine('Actually, explain how the router picks a page in this project instead please')

    expect(llm.answered.at(-1)).toContain('explain how the router picks a page')
  })

  it('any other input drops the options: after a command, a bare 1 is just a plain message', async () => {
    const llm = new NextStepLLMClient()
    const { cli } = await setupCli({ assistant: new PersonalAssistant({ llmClient: llm, goalGraphSuggestMode: 'enabled' }) })
    captureOutput()

    await cli.dispatchLine(fullTurn)
    await cli.dispatchLine('/status')
    await cli.dispatchLine('1')

    expect(llm.answered.at(-1)).not.toContain('add tests for the login page')
  })

  it('shows nothing when suggestions are disabled', async () => {
    const llm = new NextStepLLMClient()
    const { cli } = await setupCli({ assistant: new PersonalAssistant({ llmClient: llm, goalGraphSuggestMode: 'disabled' }) })
    const lines = captureOutput()

    await cli.dispatchLine(fullTurn)

    expect(lines.join('\n')).not.toContain('Next steps you could take')
  })
})

describe('/status and /cost — spend cap display (T2)', () => {
  it('shows no spend-cap line when no ceiling is configured', async () => {
    const { cli } = await setupCli()
    const lines = captureOutput()

    await cli.dispatchLine('/status')
    await cli.dispatchLine('/cost')

    const output = lines.join('\n')
    expect(output).not.toContain('spend cap')
    expect(output).not.toContain('Session ceiling')
  })

  it('/status and /cost show accumulated spend against a configured ceiling', async () => {
    class UsageReportingLLMClient implements ILLMClient {
      async *callChat(_messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string> {
        options?.onUsage?.({ inputTokens: 100, outputTokens: 100, costUsd: 2 })
        yield 'Noted.'
      }
      async callChatSync(_messages: ChatMessage[], options?: ChatOptions): Promise<string> {
        options?.onUsage?.({ inputTokens: 100, outputTokens: 100, costUsd: 2 })
        return 'Noted.'
      }
      async callChatStructured(messages: ChatMessage[]): Promise<LLMStructuredResponse> {
        if (isTurnIntentRequest(messages)) return { content: deriveTurnIntentJSON(messages) }
        return { content: 'Noted.' }
      }
    }
    const configStore = makeConfigStore({ sessionCostLimitUsd: 5 })
    const assistant = new PersonalAssistant({ llmClient: new UsageReportingLLMClient(), spendCap: { sessionCostLimitUsd: 5 } })

    const { cli } = await setupCli({ configStore, assistant })
    await cli.dispatchLine('hi')

    const lines = captureOutput()
    await cli.dispatchLine('/status')
    await cli.dispatchLine('/cost')

    const output = lines.join('\n')
    expect(output).toMatch(/spend cap\s+\$2\.0000 \/ \$5\.0000/)
    expect(output).toMatch(/Session ceiling: \$2\.0000 \/ \$5\.0000/)
  })

  it('/cost after /new still shows the tokens behind the carried-over spend, not "0 in / 0 out" next to a nonzero cost', async () => {
    class UsageReportingLLMClient implements ILLMClient {
      async *callChat(_messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string> {
        options?.onUsage?.({ inputTokens: 100, outputTokens: 100, costUsd: 2 })
        yield 'Noted.'
      }
      async callChatSync(_messages: ChatMessage[], options?: ChatOptions): Promise<string> {
        options?.onUsage?.({ inputTokens: 100, outputTokens: 100, costUsd: 2 })
        return 'Noted.'
      }
      async callChatStructured(messages: ChatMessage[]): Promise<LLMStructuredResponse> {
        if (isTurnIntentRequest(messages)) return { content: deriveTurnIntentJSON(messages) }
        return { content: 'Noted.' }
      }
    }
    // sessionCostLimitUsd configured purely so /cost's spend-cap line (and the underlying
    // persisted ledger it reads) is populated — recordSpend() itself always records regardless.
    const configStore = makeConfigStore({ sessionCostLimitUsd: 100 })
    const assistant = new PersonalAssistant({ llmClient: new UsageReportingLLMClient(), spendCap: { sessionCostLimitUsd: 100 } })
    const { cli } = await setupCli({ configStore, assistant })

    await cli.dispatchLine('hi') // spend:cli ledger now has 100 in / 100 out / $2 — persists past /new
    await cli.dispatchLine('/new')

    const lines = captureOutput()
    await cli.dispatchLine('/cost')

    const output = lines.join('\n')
    expect(output).toContain('This session: 100 in / 100 out tokens')
    expect(output).not.toContain('0 in / 0 out')
  })
})

describe('getStatusIndicators — persistent model/token/cost chrome (aielia_cli_formatting_plan.html Phase 1)', () => {
  it('always includes a model indicator and a zeroed token/cost indicator before any turn has run', async () => {
    const { cli } = await setupCli()

    const indicators = await cli.getStatusIndicators()

    expect(indicators.some((i) => i.startsWith('Model: '))).toBe(true)
    expect(indicators).toContain('↑0 ↓0 tokens (~$0.0000)')
  })

  it('token/cost indicator reflects accumulated spend after a turn, cross-turn like /cost', async () => {
    class UsageReportingLLMClient implements ILLMClient {
      async *callChat(_messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string> {
        options?.onUsage?.({ inputTokens: 100, outputTokens: 100, costUsd: 2 })
        yield 'Noted.'
      }
      async callChatSync(_messages: ChatMessage[], options?: ChatOptions): Promise<string> {
        options?.onUsage?.({ inputTokens: 100, outputTokens: 100, costUsd: 2 })
        return 'Noted.'
      }
      async callChatStructured(messages: ChatMessage[]): Promise<LLMStructuredResponse> {
        if (isTurnIntentRequest(messages)) return { content: deriveTurnIntentJSON(messages) }
        return { content: 'Noted.' }
      }
    }
    const { cli } = await setupCli({ assistant: new PersonalAssistant({ llmClient: new UsageReportingLLMClient() }) })

    await cli.dispatchLine('hi')
    const indicators = await cli.getStatusIndicators()

    expect(indicators).toContain('↑100 ↓100 tokens (~$2.0000)')
  })
})

describe('/checkpoint', () => {
  async function saveLeftoverCheckpoint(checkpointStore: InMemoryAdapter, sessionId: string): Promise<void> {
    const staleTask: Task = {
      id: 'respond', description: 'leftover objective', status: 'PENDING', risk_level: 'LOW',
      depends_on: [], parallel_write_domains: [], abstraction_level: 0, assigned_strategy: null,
    }
    const rt = new HarnessRuntime()
    const paused = await rt.run('leftover objective', ['done'], {
      initialTasks: [staleTask], max_steps: 5,
      toolExecutors: { default: () => 'stale draft' },
      runId: `turn:${sessionId}`, shouldPause: () => true,
    })
    if (paused.status !== 'paused') throw new Error('unreachable')
    await saveHarnessCheckpoint(checkpointStore, paused.checkpoint)
  }

  it('bare /checkpoint reports nothing present when there is no stuck run', async () => {
    const { cli } = await setupCli()
    const lines = captureOutput()

    await cli.dispatchLine('/checkpoint')

    expect(lines.join('\n')).toContain('No checkpoint present')
  })

  it('bare /checkpoint reports a present checkpoint without clearing it', async () => {
    const checkpointStore = new InMemoryAdapter({ scope: 'thread', namespace: 'cli-test-checkpoint' })
    await saveLeftoverCheckpoint(checkpointStore, 'cli')
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient(), checkpointStore })
    const { cli } = await setupCli({ assistant })
    const lines = captureOutput()

    await cli.dispatchLine('/checkpoint')

    expect(lines.join('\n')).toContain('A checkpoint is present')
    expect((await assistant.getCheckpointStatus('cli')).present).toBe(true)
  })

  it('/checkpoint clear clears a stuck checkpoint but does not wipe transcript/facts the way /clear does', async () => {
    const checkpointStore = new InMemoryAdapter({ scope: 'thread', namespace: 'cli-test-checkpoint-clear' })
    const llm = new FakeLLMClient('Got it.')
    const assistant = new PersonalAssistant({ llmClient: llm, checkpointStore })
    // Real prior turn, so there's transcript/fact history that must survive the checkpoint clear.
    await assistant.turn('My name is Ali.', { sessionId: 'cli' })
    await saveLeftoverCheckpoint(checkpointStore, 'cli')
    const { cli } = await setupCli({ assistant })
    const lines = captureOutput()

    await cli.dispatchLine('/checkpoint clear')

    expect(lines.join('\n')).toContain('Cleared the stuck checkpoint')
    expect((await assistant.getCheckpointStatus('cli')).present).toBe(false)
    expect(await assistant.getTranscript('cli')).not.toEqual([])
  })

  it('/checkpoint clear with nothing to clear reports that plainly instead of a stale/misleading success message', async () => {
    const { cli } = await setupCli()
    const lines = captureOutput()

    await cli.dispatchLine('/checkpoint clear')

    expect(lines.join('\n')).toContain('No checkpoint to clear')
  })
})

describe('approval-prompt handling', () => {
  it('a message-level HIGH-risk gate resolves through turn({approved}) on accept, via the askSelect selector (Phase 7) rather than free-text y/N', async () => {
    const llm = new FakeLLMClient('Draft sent.')
    const assistant = new PersonalAssistant({ llmClient: llm })
    const askSelect = vi.fn().mockResolvedValue('y')
    const { cli } = await setupCli({ assistant, askSelect })
    const lines = captureOutput()

    await cli.dispatchLine('Please send an email to my boss telling him I quit.')

    expect(askSelect).toHaveBeenCalledWith(
      expect.stringContaining('Proceed?'),
      expect.arrayContaining([expect.objectContaining({ key: 'y', label: 'Yes' }), expect.objectContaining({ key: 'n', label: 'No' })]),
    )
    expect(lines.join('\n')).toContain('Draft sent.')
  })

  it('a message-level HIGH-risk gate resolves through turn({approved}) on decline (askSelect resolving "n"), and records the declined request rather than silently dropping it', async () => {
    const llm = new FakeLLMClient('Draft sent.')
    const assistant = new PersonalAssistant({ llmClient: llm })
    const askSelect = vi.fn().mockResolvedValue('n')
    const { cli } = await setupCli({ assistant, askSelect })
    const lines = captureOutput()

    await cli.dispatchLine('Please send an email to my boss telling him I quit.')

    expect(lines.join('\n')).toContain('Cancelled.')
    expect(llm.calls).toBe(1) // the one mandatory classification call — declining spends no more
    const transcript = await assistant.getTranscript('cli')
    expect(transcript.some((m) => m.content.includes('email'))).toBe(true)
  })

  it('a staged write_file action resolves through turn({approved, pendingActionId}) on accept and actually applies', async () => {
    const backend = makeFakeBackend()
    const llm = new ScriptedToolLLMClient({ id: 'toolu_1', name: 'write_file', input: { path: 'summary.md', content: 'hello' } })
    const assistant = new PersonalAssistant({ llmClient: llm, fileTools: { backend, workspaceRoot: '/workspace' } })
    const askSelect = vi.fn().mockResolvedValue('y')
    const { cli } = await setupCli({ assistant, askSelect })
    captureOutput()

    await cli.dispatchLine('Write a summary to summary.md')

    expect(askSelect).toHaveBeenCalledWith(expect.stringContaining('Apply this write?'), expect.any(Array))
    expect(await backend.readTextFile('/workspace/summary.md')).toBe('hello')
  })

  it('a staged write_file action resolves through turn({approved: false, pendingActionId}) on decline and applies nothing', async () => {
    const backend = makeFakeBackend()
    const llm = new ScriptedToolLLMClient({ id: 'toolu_1', name: 'write_file', input: { path: 'summary.md', content: 'hello' } })
    const assistant = new PersonalAssistant({ llmClient: llm, fileTools: { backend, workspaceRoot: '/workspace' } })
    const askSelect = vi.fn().mockResolvedValue('n')
    const { cli } = await setupCli({ assistant, askSelect })
    captureOutput()

    await cli.dispatchLine('Write a summary to summary.md')

    expect(await backend.readTextFile('/workspace/summary.md')).toBeUndefined()
  })

  it('picking "don\'t ask again" ("a") on a staged write approves it and auto-approves the next same-kind staged write without prompting again', async () => {
    const backend = makeFakeBackend()
    const llm = new ScriptedToolLLMClient(
      { id: 'toolu_1', name: 'write_file', input: { path: 'one.md', content: 'first' } },
      { id: 'toolu_2', name: 'write_file', input: { path: 'two.md', content: 'second' } },
    )
    const assistant = new PersonalAssistant({ llmClient: llm, fileTools: { backend, workspaceRoot: '/workspace' } })
    const askSelect = vi.fn().mockResolvedValue('a')
    const { cli } = await setupCli({ assistant, askSelect })
    const lines = captureOutput()

    // The approved first write goes back to the model, which proposes the second write in the same
    // turn: it is auto-approved from the remembered "don't ask again" — askSelect is not called
    // again, and the write still actually applies.
    await cli.dispatchLine('Write a summary to one.md and two.md')

    expect(askSelect).toHaveBeenCalledTimes(1)
    expect(await backend.readTextFile('/workspace/one.md')).toBe('first')
    expect(lines.join('\n')).toContain('auto-approved')
    expect(await backend.readTextFile('/workspace/two.md')).toBe('second')
  })

  it('askSelect with no test override falls back to the last (safe) option when nonInteractiveApprovalMode is "decline", never approving', async () => {
    const llm = new FakeLLMClient('Draft sent.')
    const assistant = new PersonalAssistant({ llmClient: llm })
    const { cli } = await setupCli({ assistant, nonInteractiveApprovalMode: 'decline' })
    const lines = captureOutput()

    await cli.dispatchLine('Please send an email to my boss telling him I quit.')

    expect(lines.join('\n')).toContain('Cancelled.')
  })

  it('/undo-action with no argument lists entries rather than erroring (bare form is a valid listing, not a missing-id failure)', async () => {
    const { cli } = await setupCli()
    const lines = captureOutput()

    await cli.dispatchLine('/undo-action')

    expect(lines.join('\n')).toContain('No undo-log entries yet')
  })

  it('/undo-action <id> for an assistant with no file/shell tools configured fails with a clear message rather than throwing unhandled', async () => {
    const { cli } = await setupCli()
    const lines = captureOutput()

    await expect(cli.dispatchLine('/undo-action some-id')).resolves.not.toThrow()

    expect(lines.join('\n')).toContain('No workspace configured')
  })
})

/**
 * Q6 (the internal plan) — the CLI's text-mode equivalent of chat-ui's
 * AskQuestionCard. Drives a real PersonalAssistant instance whose `turn` method is spied on
 * (rather than a scripted ILLMClient) so the needs_clarification/resolve pair is scripted exactly
 * the same way App.test.tsx mocks PersonalAssistant.create's `turn` for the same feature — cli.ts
 * never talks to the harness escalation machinery directly, only to the AssistantTurnResult shape
 * it returns, so this is the right layer to fake at.
 */
describe('clarification-prompt handling (Q6)', () => {
  it('single-select: picking an option by number then "s" submits, resolving via pendingClarificationId + clarificationAnswer', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    let resolvedAnswer: AskResponse | undefined
    vi.spyOn(assistant, 'turn').mockImplementation(async (_message, options) => {
      if (options?.pendingClarificationId === 'pc-1') {
        resolvedAnswer = options.clarificationAnswer
        return { status: 'ok', reply: 'Building it in Python.' }
      }
      return {
        status: 'needs_clarification',
        reply: null,
        pendingClarificationId: 'pc-1',
        questions: [{ id: 'lang', question: 'Which language should the new service use?', options: [{ label: 'TypeScript' }, { label: 'Python' }] }],
      }
    })
    const askLineQueue = ['2', 's']
    const askLine = vi.fn(async () => askLineQueue.shift() ?? '')
    const { cli } = await setupCli({ assistant, askLine })
    const lines = captureOutput()

    await cli.dispatchLine('Build me a service')

    expect(resolvedAnswer).toEqual({ answers: [{ questionId: 'lang', kind: 'selected', selectedLabels: ['Python'] }] })
    expect(lines.join('\n')).toContain('Building it in Python.')
  })

  it('multi-select: toggling two options with t<n> submits both as selectedLabels', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    let resolvedAnswer: AskResponse | undefined
    vi.spyOn(assistant, 'turn').mockImplementation(async (_message, options) => {
      if (options?.pendingClarificationId === 'pc-2') {
        resolvedAnswer = options.clarificationAnswer
        return { status: 'ok', reply: 'Noted both.' }
      }
      return {
        status: 'needs_clarification',
        reply: null,
        pendingClarificationId: 'pc-2',
        questions: [
          { id: 'features', question: 'Which features should ship first?', allowMultiple: true, options: [{ label: 'Auth' }, { label: 'Billing' }, { label: 'Search' }] },
        ],
      }
    })
    const askLineQueue = ['t1', 't3', 's']
    const askLine = vi.fn(async () => askLineQueue.shift() ?? '')
    const { cli } = await setupCli({ assistant, askLine })
    captureOutput()

    await cli.dispatchLine('Which features should ship first?')

    expect(resolvedAnswer).toEqual({ answers: [{ questionId: 'features', kind: 'selected', selectedLabels: ['Auth', 'Search'] }] })
  })

  it('"o" records a free-text answer, overriding any option selected first', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    let resolvedAnswer: AskResponse | undefined
    vi.spyOn(assistant, 'turn').mockImplementation(async (_message, options) => {
      if (options?.pendingClarificationId === 'pc-3') {
        resolvedAnswer = options.clarificationAnswer
        return { status: 'ok', reply: 'Got it.' }
      }
      return {
        status: 'needs_clarification',
        reply: null,
        pendingClarificationId: 'pc-3',
        questions: [{ id: 'q1', question: 'Anything else to add?', options: [{ label: 'Yes' }, { label: 'No' }] }],
      }
    })
    const askLineQueue = ['1', 'o', 'Actually, something custom', 's']
    const askLine = vi.fn(async () => askLineQueue.shift() ?? '')
    const { cli } = await setupCli({ assistant, askLine })
    captureOutput()

    await cli.dispatchLine('Anything else?')

    expect(resolvedAnswer).toEqual({ answers: [{ questionId: 'q1', kind: 'free_text', freeText: 'Actually, something custom' }] })
  })

  it('e<n> attaches a note to an already-picked option, submitting as selected_with_edit', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    let resolvedAnswer: AskResponse | undefined
    vi.spyOn(assistant, 'turn').mockImplementation(async (_message, options) => {
      if (options?.pendingClarificationId === 'pc-4') {
        resolvedAnswer = options.clarificationAnswer
        return { status: 'ok', reply: 'Noted with your note.' }
      }
      return {
        status: 'needs_clarification',
        reply: null,
        pendingClarificationId: 'pc-4',
        questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
      }
    })
    const askLineQueue = ['1', 'e1', 'please prioritize this', 's']
    const askLine = vi.fn(async () => askLineQueue.shift() ?? '')
    const { cli } = await setupCli({ assistant, askLine })
    captureOutput()

    await cli.dispatchLine('Pick one')

    expect(resolvedAnswer).toEqual({ answers: [{ questionId: 'q1', kind: 'selected_with_edit', selectedLabels: ['A'], editText: 'please prioritize this' }] })
  })

  it('b/n navigate a multi-question batch without losing already-drafted answers, and "s" submits all of them together', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    let resolvedAnswer: AskResponse | undefined
    vi.spyOn(assistant, 'turn').mockImplementation(async (_message, options) => {
      if (options?.pendingClarificationId === 'pc-5') {
        resolvedAnswer = options.clarificationAnswer
        return { status: 'ok', reply: 'Both answered.' }
      }
      return {
        status: 'needs_clarification',
        reply: null,
        pendingClarificationId: 'pc-5',
        questions: [
          { id: 'q1', question: 'First question', options: [{ label: 'A' }, { label: 'B' }] },
          { id: 'q2', question: 'Second question', options: [{ label: 'C' }, { label: 'D' }] },
        ],
      }
    })
    // select A on q1, move to q2, select D, go back to q1 (unchanged), forward to q2 (unchanged), submit.
    const askLineQueue = ['1', 'n', '2', 'b', 'n', 's']
    const askLine = vi.fn(async () => askLineQueue.shift() ?? '')
    const { cli } = await setupCli({ assistant, askLine })
    captureOutput()

    await cli.dispatchLine('Ask me two things')

    expect(resolvedAnswer).toEqual({
      answers: [
        { questionId: 'q1', kind: 'selected', selectedLabels: ['A'] },
        { questionId: 'q2', kind: 'selected', selectedLabels: ['D'] },
      ],
    })
  })

  it('a REAL structured question (an unspied assistant halting on its step budget) is rendered as numbered options, and answering by number resumes it to a reply', async () => {
    const files = new Map([['/ws/note.txt', 'hello from a seeded file']])
    const backend: FsBackend = {
      async readTextFile(p) { return files.get(p) },
      async writeTextFile(p, c) { files.set(p, c) },
      async removeFile(p) { files.delete(p) },
      async mkdir() {},
      async readDir() { return ['note.txt'] },
    }
    const readNote = { content: '', toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'note.txt' } }] }
    // Deterministic model: keeps re-reading until the answer to the question arrives, then finishes. (A queue of scripted
    // responses would let the resumed turn burn through leftover reads and hit the tiny budget again.)
    const inner = createScriptedLLMClient({ responses: [], streamChunks: ['The note says: hello from a seeded file.'] })
    const answered = (messages: ChatMessage[]) => messages.some((m) => m.role === 'user' && m.content.includes('Answer to your question'))
    const scripted: ILLMClient = {
      callChat: (m, o) => inner.callChat(m, o),
      callChatSync: (m, o) => inner.callChatSync(m, o),
      callChatStructured: async (m, t, o) => {
        if (isTurnIntentRequest(m)) return inner.callChatStructured(m, t, o)
        if (m.some((x) => x.role === 'system' && x.content.includes('You check whether'))) return inner.callChatStructured(m, t, o)
        return answered(m) ? { content: 'The note says: hello from a seeded file.' } : readNote
      },
    }
    const assistant = new PersonalAssistant({
      llmClient: scripted,
      fileTools: { backend, workspaceRoot: '/ws' },
      checkpointStore: new InMemoryAdapter({ scope: 'thread', namespace: 'cli-real-ask' }),
      oneLoopMode: 'enabled',
      goalGraphSuggestMode: 'disabled',
      askMode: 'enabled',
      maxSteps: 2,
    })
    const turnSpy = vi.spyOn(assistant, 'turn') // observe only — the real implementation still runs
    const askLineQueue = ['1', 's']
    const askLine = vi.fn(async () => askLineQueue.shift() ?? '')
    const { cli } = await setupCli({ assistant, askLine })
    const lines = captureOutput()

    await cli.dispatchLine('Keep re-reading note.txt until you are certain of every word')

    const out = lines.join('\n')
    // rendered from the real result: the question text and its options, numbered
    expect(out).toContain('The step budget is exhausted')
    expect(out).toMatch(/1[.)\]]?\s+Continue with 10 more steps/)
    expect(out).toMatch(/2[.)\]]?\s+Stop and summarize progress so far/)
    // answered by ID: the follow-up turn carried the pending id and a `selected` answer for that option
    const resume = turnSpy.mock.calls.find(([, opts]) => opts?.pendingClarificationId !== undefined)
    expect(resume?.[1]?.clarificationAnswer?.answers[0]).toMatchObject({ kind: 'selected', selectedLabels: ['Continue with 10 more steps'] })
    // and the resumed turn ended in a real reply, not silence
    expect(out).toContain('hello from a seeded file')
  })

  it('non-interactive decline mode auto-declines a needs_clarification pause without ever prompting or resolving it', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    const turnSpy = vi.spyOn(assistant, 'turn').mockResolvedValue({
      status: 'needs_clarification',
      reply: null,
      reason: 'This request needs clarification.',
      pendingClarificationId: 'pc-decline',
      questions: [{ id: 'lang', question: 'Which language should the new service use?', options: [{ label: 'TypeScript' }, { label: 'Python' }] }],
    })
    const askLine = vi.fn()
    const { cli } = await setupCli({ assistant, askLine, nonInteractiveApprovalMode: 'decline' })
    const lines = captureOutput()

    await cli.dispatchLine('Build me a service')

    expect(askLine).not.toHaveBeenCalled()
    expect(turnSpy).toHaveBeenCalledTimes(1)
    expect(lines.join('\n')).toContain('auto-declining')
    expect(lines.join('\n')).toContain('Which language should the new service use?')
  })
})

describe('command dispatch table', () => {
  const NO_ARG_COMMANDS = ['/why', '/layers', '/sources', '/plan', '/help', '/status', '/cost', '/goals']

  it.each(NO_ARG_COMMANDS)('%s routes to its handler without throwing and without invoking the LLM', async (command) => {
    const llm = new FakeLLMClient()
    const assistant = new PersonalAssistant({ llmClient: llm })
    const { cli } = await setupCli({ assistant })
    captureOutput()

    await expect(cli.dispatchLine(command)).resolves.not.toThrow()

    expect(llm.calls).toBe(0)
  })

  it('/search with no query prints usage instead of running an empty search', async () => {
    const { cli } = await setupCli()
    const lines = captureOutput()

    await cli.dispatchLine('/search')

    expect(lines.join('\n')).toContain('Usage: /search')
  })

  it('/goals prints the empty-graph message for a session that never touched goal-thread machinery', async () => {
    const { cli } = await setupCli()
    const lines = captureOutput()

    await cli.dispatchLine('/goals')

    expect(lines.join('\n')).toContain('No goal threads')
  })

  it('/model with no argument shows the current value without changing config', async () => {
    const { cli, configStore } = await setupCli()
    const lines = captureOutput()

    await cli.dispatchLine('/model')

    expect(lines.join('\n')).toBeTruthy()
    expect(await configStore.load()).toEqual({})
  })

  it('a plain, non-command message is routed to the LLM turn instead of a command handler', async () => {
    const llm = new FakeLLMClient('General Kenobi.')
    const assistant = new PersonalAssistant({ llmClient: llm })
    const { cli } = await setupCli({ assistant })
    const lines = captureOutput()

    await cli.dispatchLine('Hello there')

    expect(llm.calls).toBeGreaterThan(0)
    expect(lines.join('\n')).toContain('General Kenobi.')
  })

  it('an unrecognized slash "command" is also routed to the LLM turn, not silently dropped (no unknown-command interception today — this locks in that behavior rather than assuming otherwise)', async () => {
    const llm = new FakeLLMClient('ok')
    const assistant = new PersonalAssistant({ llmClient: llm })
    const { cli } = await setupCli({ assistant })

    await cli.dispatchLine('/totally-not-a-command')

    expect(llm.calls).toBeGreaterThan(0)
  })

  it('concurrent dispatches serialize (one fully resolves before the next begins), so back-to-back /config set calls never race', async () => {
    const { cli, configStore } = await setupCli()
    captureOutput()

    await Promise.all([
      cli.dispatchLine('/config set dangerouslySkipPermissions true'),
      cli.dispatchLine('/config set enableShell true'),
    ])

    // Both patches landed — a race would have let one read-modify-write clobber the other.
    expect(await configStore.load()).toMatchObject({ dangerouslySkipPermissions: true, enableShell: true })
  })
})

describe('/plan vs. the triviality fast path', () => {
  // planStatus's own doc comment (assistant.ts): it "can be non-null across many consecutive
  // turns in the same session" — present only on turns a plan actually drove, absent otherwise,
  // *not* absent-because-the-plan-ended. The triviality fast path (assistant.ts's isTrivial
  // branch) never touches plan state at all and always omits planStatus from its result
  // regardless of whether a plan is active. Before this fix, cli.ts unconditionally did
  // `lastPlanStatus = result.planStatus` every turn, so a single trivial Q&A aside during an
  // otherwise-active plan wiped `/plan`'s view of it back to "No active plan for this session" —
  // reproduced live in a 40-message batch session (batch_1_20260730T084228Z_822271/convB).
  it('an intervening trivial turn does not make /plan forget an active, in-progress plan', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    const { cli } = await setupCli({ assistant })

    const planStatus: NonNullable<Awaited<ReturnType<PersonalAssistant['turn']>>['planStatus']> = {
      templateName: 'project_planning',
      successCriteria: 'Launch shipped',
      completionPct: 100 / 6,
      tasks: [
        { id: 'scope_definition', description: 'Define scope', status: 'COMPLETE' },
        { id: 'asset_prep', description: 'Prep assets', status: 'PENDING' },
      ],
    }
    const turnSpy = vi.spyOn(assistant, 'turn')
    turnSpy.mockResolvedValueOnce({ status: 'ok', reply: 'Kicking off the plan.', harnessSkipped: false, planStatus })
    turnSpy.mockResolvedValueOnce({ status: 'ok', reply: '96.', harnessSkipped: true }) // trivial fast path: no planStatus field at all

    await cli.dispatchLine('Plan the product launch')
    await cli.dispatchLine("What's 12 times 8?")

    const lines = captureOutput()
    await cli.dispatchLine('/plan')

    const output = lines.join('\n')
    expect(output).not.toContain('No active plan for this session')
    expect(output).toContain('project_planning')
    expect(output).toContain('scope_definition')
  })

  // Plan-mode drafting is harnessSkipped (INV-30 — drafting runs no tool loop) but its result
  // carries a real planStatus for the draft it just built (plan-drafting-service.ts). Regression
  // for the live mismatch where the drafting reply printed its inline "(plan: 0% — /plan)" hint
  // and /plan then answered "No active plan for this session" — the old `!harnessSkipped` gate
  // dropped a planStatus the turn genuinely reported.
  it('a plan-mode drafting turn (harnessSkipped but planStatus set) is remembered by /plan', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    const { cli } = await setupCli({ assistant })

    const planStatus: NonNullable<Awaited<ReturnType<PersonalAssistant['turn']>>['planStatus']> = {
      templateName: null,
      successCriteria: 'Nakasendo locked as the hiking anchor',
      completionPct: 0,
      tasks: [{ id: 't1', description: 'Lock the route', status: 'PENDING' }],
    }
    vi.spyOn(assistant, 'turn').mockResolvedValueOnce({
      status: 'ok',
      reply: "I've drafted the plan — take a look.",
      harnessSkipped: true,
      planStatus,
    })

    await cli.dispatchLine('Plan a two-week trip to Japan')

    const lines = captureOutput()
    await cli.dispatchLine('/plan')

    const output = lines.join('\n')
    expect(output).not.toContain('No active plan for this session')
    expect(output).toContain('custom plan')
    expect(output).toContain('t1')
  })

  // Mirror case: once a turn genuinely reports no plan (never created, or abandoned), /plan
  // must still correctly say so — the fix must not make lastPlanStatus "sticky" forever, only
  // resilient to a harness-skipped turn's uninformative absence.
  it('/plan still reports no active plan once a real (non-trivial) turn confirms none exists', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    const { cli } = await setupCli({ assistant })

    const turnSpy = vi.spyOn(assistant, 'turn')
    turnSpy.mockResolvedValueOnce({ status: 'ok', reply: 'Sure, happy to chat.', harnessSkipped: false }) // non-trivial, no plan

    await cli.dispatchLine('Tell me about your day')

    const lines = captureOutput()
    await cli.dispatchLine('/plan')

    expect(lines.join('\n')).toContain('No active plan for this session')
  })

  // Phase 6 of the CLI formatting plan ("distinct plan-mode UI") — printPlan()'s output must
  // carry PLAN_LINE_PREFIX so tui-app.tsx's classifyLineKind renders it as a dedicated PlanBox
  // instead of plain 'system' text; this is the plain (non-TUI) CLI's own view of that same
  // console.log call, so the raw marker is expected to show through here unstripped (only the
  // TUI strips it for display).
  it("/plan's printed status carries the PLAN_LINE_PREFIX marker for the TUI to render as a dedicated widget", async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    const { cli } = await setupCli({ assistant })

    const planStatus: NonNullable<Awaited<ReturnType<PersonalAssistant['turn']>>['planStatus']> = {
      templateName: 'project_planning',
      successCriteria: 'Launch shipped',
      completionPct: 50,
      tasks: [{ id: 'scope_definition', description: 'Define scope', status: 'COMPLETE' }],
    }
    vi.spyOn(assistant, 'turn').mockResolvedValueOnce({ status: 'ok', reply: 'Kicking off the plan.', harnessSkipped: false, planStatus })
    await cli.dispatchLine('Plan the product launch')

    const lines = captureOutput()
    await cli.dispatchLine('/plan')

    expect(lines.join('\n')).toContain(PLAN_LINE_PREFIX)
  })
})

describe('/plan approval (the whole-plan P2 gate)', () => {
  const snapshot = {
    templateName: null as string | null,
    successCriteria: 'Nakasendo locked as the hiking anchor',
    rationale: 'Keeps the hike on the Tokyo–Kyoto corridor.',
    tasks: [
      { id: 't1', description: 'Lock the route', riskLevel: 'LOW' as const },
      { id: 't2', description: 'Book lodging', riskLevel: 'MEDIUM' as const },
    ],
    reviewNotes: ['t2 has no fallback if lodging is full.'],
  }
  const staged = { status: 'needs_plan_approval' as const, reply: null, planApprovalId: 'pa1', planApproval: snapshot }

  // Before this wiring existed the CLI had no needs_plan_approval branch at all: a staged plan
  // (whose result carries reply: null) fell through to the ordinary render and printed as a bare
  // "- null", with no way to approve, edit, or decline it. chat-ui's PlanApprovalCard was the
  // only surface that could resolve one.
  it('renders the staged plan (not "- null") and resolves an approve through turn({planApprovalId, planDecision})', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    const askSelect = vi.fn().mockResolvedValue('y')
    const { cli } = await setupCli({ assistant, askSelect })
    const turnSpy = vi.spyOn(assistant, 'turn')
    turnSpy.mockResolvedValueOnce(staged)
    turnSpy.mockResolvedValueOnce({ status: 'ok', reply: 'Plan is active — starting t1.' })

    const lines = captureOutput()
    await cli.dispatchLine('Plan a two-week trip to Japan')

    const output = lines.join('\n')
    expect(output).not.toContain('- null')
    expect(output).toContain('Plan ready for approval')
    expect(output).toContain('Lock the route')
    expect(output).toContain('t2 has no fallback') // review notes surface at the gate
    expect(output).toContain('Plan is active — starting t1.')
    expect(askSelect).toHaveBeenCalledWith('Approve this plan?', expect.any(Array))
    expect(turnSpy).toHaveBeenLastCalledWith(
      'Plan a two-week trip to Japan',
      expect.objectContaining({ planApprovalId: 'pa1', planDecision: 'approve' }),
    )
  })

  it('a decline resolves turn({planDecision: "decline"}) and falls through to the ordinary reply', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    const { cli } = await setupCli({ assistant, askSelect: vi.fn().mockResolvedValue('n') })
    const turnSpy = vi.spyOn(assistant, 'turn')
    turnSpy.mockResolvedValueOnce(staged)
    turnSpy.mockResolvedValueOnce({ status: 'ok', reply: 'Discarded the draft plan.' })

    const lines = captureOutput()
    await cli.dispatchLine('Plan a two-week trip to Japan')

    expect(turnSpy).toHaveBeenLastCalledWith(
      'Plan a two-week trip to Japan',
      expect.objectContaining({ planDecision: 'decline' }),
    )
    expect(lines.join('\n')).toContain('Discarded the draft plan.')
  })

  it('"approve & trust" resolves approve_trusted', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    const { cli } = await setupCli({ assistant, askSelect: vi.fn().mockResolvedValue('t') })
    const turnSpy = vi.spyOn(assistant, 'turn')
    turnSpy.mockResolvedValueOnce(staged)
    turnSpy.mockResolvedValueOnce({ status: 'ok', reply: 'Trusted — running.' })

    await cli.dispatchLine('Plan a two-week trip to Japan')

    expect(turnSpy).toHaveBeenLastCalledWith(
      'Plan a two-week trip to Japan',
      expect.objectContaining({ planDecision: 'approve_trusted' }),
    )
  })

  it('"approve with edits" collects cancel/edited tasks via askLine and passes them as planEdits', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    const askLine = vi.fn().mockResolvedValueOnce('t2').mockResolvedValueOnce('t1=Lock the Nakasendo route')
    const { cli } = await setupCli({ assistant, askSelect: vi.fn().mockResolvedValue('e'), askLine })
    const turnSpy = vi.spyOn(assistant, 'turn')
    turnSpy.mockResolvedValueOnce(staged)
    turnSpy.mockResolvedValueOnce({ status: 'ok', reply: 'Applied edits — running.' })

    await cli.dispatchLine('Plan a two-week trip to Japan')

    expect(turnSpy).toHaveBeenLastCalledWith(
      'Plan a two-week trip to Japan',
      expect.objectContaining({
        planDecision: 'approve_with_edits',
        planEdits: { cancelTaskIds: ['t2'], editedTasks: [{ id: 't1', description: 'Lock the Nakasendo route' }] },
      }),
    )
  })

  it('"decide later" leaves the plan pending, and /plan approve then resolves it', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    const { cli } = await setupCli({ assistant, askSelect: vi.fn().mockResolvedValue('d') })
    const turnSpy = vi.spyOn(assistant, 'turn')
    turnSpy.mockResolvedValueOnce(staged)
    turnSpy.mockResolvedValueOnce({ status: 'ok', reply: 'Plan is active.' })

    const lines = captureOutput()
    await cli.dispatchLine('Plan a two-week trip to Japan')
    expect(lines.join('\n')).toContain('Left pending')

    // /plan while a decision is pending shows the staged draft itself, not the previous plan / "No active plan".
    lines.length = 0
    await cli.dispatchLine('/plan')
    expect(lines.join('\n')).toContain('Plan ready for approval')
    expect(lines.join('\n')).not.toContain('No active plan')

    lines.length = 0
    await cli.dispatchLine('/plan approve')

    expect(turnSpy).toHaveBeenLastCalledWith(
      'Plan a two-week trip to Japan',
      expect.objectContaining({ planApprovalId: 'pa1', planDecision: 'approve' }),
    )
    expect(lines.join('\n')).toContain('Plan is active.')
  })

  it('/plan decline with no plan awaiting approval says so and does not call turn', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    const { cli } = await setupCli({ assistant })
    const turnSpy = vi.spyOn(assistant, 'turn')

    const lines = captureOutput()
    await cli.dispatchLine('/plan decline')

    expect(lines.join('\n')).toContain('No plan is awaiting approval')
    expect(turnSpy).not.toHaveBeenCalled()
  })
})

describe('/plan sketch', () => {
  // Report finding: legacy-path plan prose (markdown headers, `- [ ]` checklists) rendered as
  // literal characters because it was classified as plain 'system' text, not 'assistant' text —
  // the only kind tui-app.tsx renders through markdown-line.tsx. Routing this specific reply
  // through the same 'Aielia>' marker an ordinary chat reply already uses fixes that without any
  // new rendering path.
  it("prefixes the sketch's reply with the assistant-reply marker so the TUI renders its markdown instead of literal characters", async () => {
    const llm = new FakeLLMClient('ok')
    const assistant = new PersonalAssistant({ llmClient: llm })
    vi.spyOn(assistant, 'sketchPlan').mockResolvedValue({ status: 'ok', reply: '## Checklist\n- [ ] Book venue', harnessSkipped: true })
    const { cli } = await setupCli({ assistant })

    const lines = captureOutput()
    await cli.dispatchLine('/plan sketch a small conference')

    expect(lines.join('\n')).toContain('Aielia> ## Checklist\n- [ ] Book venue')
  })
})

describe('/memory governance surfaces (M6)', () => {
  const FACT = { text: 'the user likes tea', extractedAt: '2026-01-01T00:00:00.000Z', sourceTurn: 't', source: 'user_asserted', durable: true }
  const OLD = { text: 'the user lives in Oslo', extractedAt: '2025-01-01T00:00:00.000Z', sourceTurn: 't', source: 'user_asserted', durable: true, retiredAt: '2026-02-01T00:00:00.000Z' }

  async function memoryCli(): Promise<{ cli: CliInstance; memory: InMemoryAdapter; assistant: PersonalAssistant }> {
    const memory = new InMemoryAdapter()
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient(), memory })
    const { cli } = await setupCli({ assistant })
    return { cli, memory, assistant }
  }

  it('/memory off stops writes and says what stays; /memory on resumes; the state is the shared service state', async () => {
    const { cli, assistant } = await memoryCli()
    const lines = captureOutput()
    await cli.dispatchLine('/memory off')
    expect(lines.join('\n')).toContain('Memory writes are OFF')
    expect(await assistant.isMemoryEnabled()).toBe(false)
    await cli.dispatchLine('/memory status')
    expect(lines.join('\n')).toContain('Writes: OFF')
    await cli.dispatchLine('/memory on')
    expect(await assistant.isMemoryEnabled()).toBe(true)
  })

  it('/memory status shows the write mode and store-vs-budget line', async () => {
    const { cli, memory } = await memoryCli()
    await memory.set('facts:durable', [FACT])
    const lines = captureOutput()
    await cli.dispatchLine('/memory status')
    const out = lines.join('\n')
    expect(out).toContain('mode: staged')
    expect(out).toMatch(/Store: 1 fact, \d+\/4000 chars/)
  })

  it('/memory archive lists replaced facts; /memory archive forget <n> erases one; a bad index is reported', async () => {
    const { cli, memory } = await memoryCli()
    await memory.set('facts:retired', [OLD])
    const lines = captureOutput()
    await cli.dispatchLine('/memory archive')
    expect(lines.join('\n')).toContain('1. the user lives in Oslo')
    lines.length = 0
    await cli.dispatchLine('/memory archive forget 9')
    expect(lines.join('\n')).toContain('No archived fact #9')
    lines.length = 0
    await cli.dispatchLine('/memory archive forget 1')
    expect(lines.join('\n')).toContain('forgotten: the user lives in Oslo')
    expect(await memory.get('facts:retired')).toEqual([])
  })

  it('/memory history reads the audit log through the shared service (empty message when the log is empty)', async () => {
    const { cli, memory } = await memoryCli()
    const lines = captureOutput()
    await cli.dispatchLine('/memory history')
    expect(lines.join('\n')).toMatch(/No memory changes recorded/)
    await memory.set('memory:audit', [{ seq: 1, at: '2026-01-01T00:00:00.000Z', op: 'add', factId: 'x|y', after: FACT, store: 'durable', writer: 'recordFacts', turn: 's' }])
    lines.length = 0
    await cli.dispatchLine('/memory history')
    expect(lines.join('\n')).toContain('#1 2026-01-01T00:00:00.000Z add [durable] the user likes tea (recordFacts)')
  })

  it('/memory consolidate runs the consolidator PersonalAssistant registers itself (flag off: says so), and a host-registered one replaces it', async () => {
    const { cli, assistant } = await memoryCli()
    const lines = captureOutput()
    await cli.dispatchLine('/memory consolidate')
    expect(lines.join('\n')).toContain('Memory consolidation is off')
    assistant.registerMemoryConsolidator(async () => ({ status: 'nothing_to_do', message: 'Nothing to consolidate.' }))
    lines.length = 0
    await cli.dispatchLine('/memory consolidate')
    expect(lines.join('\n')).toContain('Nothing to consolidate.')
  })

  it('/why shows what memory the last reply could have known: before any turn, then after one', async () => {
    const { cli, memory } = await memoryCli()
    await memory.set('facts:durable', [FACT])
    const lines = captureOutput()
    await cli.dispatchLine('/why')
    expect(lines.join('\n')).toContain('No turn has run yet')
    await cli.dispatchLine('What is the capital of France?')
    lines.length = 0
    await cli.dispatchLine('/why')
    expect(lines.join('\n')).toContain('Memory in the prompt: 1 fact')
    expect(lines.join('\n')).toContain('- the user likes tea')
  })

  it('/doctor includes the memory checks (size vs budget, pending, last consolidation, audit log)', async () => {
    const { cli } = await memoryCli()
    const lines = captureOutput()
    await cli.dispatchLine('/doctor')
    const out = lines.join('\n')
    expect(out).toContain('memory store:')
    expect(out).toContain('memory pending:')
    expect(out).toContain('memory last consolidation: never')
    expect(out).toContain('memory audit log:')
  })

  it('/config set memoryWriteMode persists a valid mode and rejects an invalid one, leaving config unchanged', async () => {
    const configStore = makeConfigStore()
    const { cli } = await setupCli({ configStore, assistant: new PersonalAssistant({ llmClient: new FakeLLMClient() }) })
    const lines = captureOutput()
    await cli.dispatchLine('/config set memoryWriteMode user_only')
    expect(await configStore.load()).toMatchObject({ memoryWriteMode: 'user_only' })
    lines.length = 0
    await cli.dispatchLine('/config set memoryWriteMode yolo')
    expect(lines.join('\n')).toContain('memoryWriteMode must be')
    expect(await configStore.load()).toMatchObject({ memoryWriteMode: 'user_only' })
  })
})


describe('/plan graph', () => {
  const record = {
    templateName: null,
    successCriteria: 'Ship it',
    rationale: '',
    mode: 'gated',
    executingOnPlan: false,
    tasks: [
      { id: 'research', description: 'Research the options', status: 'COMPLETE', depends_on: [] },
      { id: 'build', description: 'Build the thing', status: 'PENDING', depends_on: ['research'] },
    ],
  } as unknown as NonNullable<Awaited<ReturnType<PersonalAssistant['getPlanGraph']>>>

  it('flag off (default): behaves as plain /plan and never reads the graph', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    const spy = vi.spyOn(assistant, 'getPlanGraph').mockResolvedValue(record)
    const { cli } = await setupCli({ assistant })
    const lines = captureOutput()
    await cli.dispatchLine('/plan graph')
    expect(lines.join('\n')).toContain('No active plan for this session')
    expect(spy).not.toHaveBeenCalled()
    expect(await cli.getPlanGraphNodes()).toBeUndefined()
  })

  it('flag on, plain CLI: prints one static render of the plan', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    vi.spyOn(assistant, 'getPlanGraph').mockResolvedValue(record)
    const { cli } = await setupCli({ assistant, envOverrides: { planGraphMode: 'enabled' } })
    const lines = captureOutput()
    await cli.dispatchLine('/plan graph')
    const output = lines.join('\n')
    expect(output).toContain('Research the options')
    expect(output).toContain('Build the thing')
    expect(output).toMatch(/[┌└│]/)
  })

  it('flag on, TUI seam: hands the nodes to openPlanGraph instead of printing', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    vi.spyOn(assistant, 'getPlanGraph').mockResolvedValue(record)
    const openPlanGraph = vi.fn()
    const { cli } = await setupCli({ assistant, envOverrides: { planGraphMode: 'enabled' }, openPlanGraph })
    const lines = captureOutput()
    await cli.dispatchLine('/plan graph')
    expect(openPlanGraph).toHaveBeenCalledTimes(1)
    expect(openPlanGraph.mock.calls[0][0].map((n: { id: string }) => n.id)).toEqual(['research', 'build', 'plan'])
    expect(lines.join('\n')).not.toContain('Research the options')
    const live = await cli.getPlanGraphNodes([{ id: 'build', status: 'RUNNING' as never }])
    expect(live?.find((n) => n.id === 'build')?.status).toBe('running')
  })

  it('flag on, no plan: says so', async () => {
    const assistant = new PersonalAssistant({ llmClient: new FakeLLMClient() })
    const { cli } = await setupCli({ assistant, envOverrides: { planGraphMode: 'enabled' } })
    const lines = captureOutput()
    await cli.dispatchLine('/plan graph')
    expect(lines.join('\n')).toContain('No active plan for this session')
  })
})

describe('invalid configuration fails loudly (benchmark 10-12: process exited silently under the TUI)', () => {
  it('runCli rejects with a StartupError naming the problem and how to fix it, instead of calling process.exit', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit must not be called') }) as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const run = runCli({
      dataDir: '/tmp/cli-test-unused',
      backend: makeFakeBackend(),
      remindersFile: '/tmp/cli-test-unused/reminders/reminders.json',
      envOverrides: {},
      input: new PassThrough(),
      output: new Writable({ write: (_c, _e, cb) => cb() }),
      configStore: makeConfigStore({ enableWeb: true }),
    })
    await expect(run).rejects.toBeInstanceOf(StartupError)
    await expect(run).rejects.toThrow(/enableWeb requires braveApiKey/)
    await expect(run).rejects.toThrow(/Fix it by setting the missing value/)
    expect(exit).not.toHaveBeenCalled()
  })
})
