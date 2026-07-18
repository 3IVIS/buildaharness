import { describe, it, expect, vi, afterEach } from 'vitest'
import { PassThrough, Writable } from 'node:stream'
import type { ChatMessage, ChatOptions, ILLMClient, ToolDefinition, LLMStructuredResponse, FsBackend } from '@buildaharness/runtime'
import { InMemoryAdapter } from '@buildaharness/runtime'
import { HarnessRuntime, saveHarnessCheckpoint, type Task } from '@buildaharness/harness'
import { PersonalAssistant } from './assistant.js'
import { runCli, type RunCliOptions, type CliInstance } from './cli.js'
import { DEFAULT_CONFIG, type ConfigStore, type AssistantConfig } from './config.js'

/**
 * cli.ts's `main()` runs at import time (see non-interactive-mode.ts's doc comment) — runCli()
 * is the seam T1 added specifically so this file can drive command dispatch directly instead of
 * only through a live process. Every test builds its own isolated in-memory config
 * store/backend/assistant so nothing here touches the real filesystem, a real LLM backend, or a
 * real TTY.
 */

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
  async callChatStructured(): Promise<LLMStructuredResponse> {
    this.calls++
    return { content: this.reply }
  }
}

/** Scripts a single tool-calling response (e.g. write_file), then a plain follow-up reply once the loop resolves — trimmed version of assistant.test.ts's ScriptedToolLLMClient. */
class ScriptedToolLLMClient implements ILLMClient {
  private served = false
  constructor(private readonly toolCall: { id: string; name: string; input: Record<string, unknown> }) {}
  async *callChat(): AsyncIterable<string> {
    yield 'Done.'
  }
  async callChatSync(): Promise<string> {
    return 'Done.'
  }
  async callChatStructured(_messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMStructuredResponse> {
    if (!this.served) {
      this.served = true
      return { content: '', toolCalls: [this.toolCall] }
    }
    return { content: 'Done.' }
  }
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

    await cli.dispatchLine('/config set enableWeb true')
    expect(await configStore.load()).toMatchObject({ enableWeb: true })

    lines.length = 0
    await cli.dispatchLine('/config')
    expect(lines.join('\n')).toMatch(/enableWeb\s+true/)
  })

  it('env-pinned keys reject /config set and explain which env var pins them (precedence: env var > persisted > default)', async () => {
    const { cli, configStore } = await setupCli({ envOverrides: { enableWeb: true } })
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

  it('/config set rejects a combination validateConfig() disallows (brave search backend with no braveApiKey)', async () => {
    const { cli, configStore } = await setupCli()
    const lines = captureOutput()

    await cli.dispatchLine('/config set searchBackend brave')

    expect(lines.join('\n')).toContain('braveApiKey')
    expect(await configStore.load()).toEqual({})
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
      async callChatStructured(): Promise<LLMStructuredResponse> {
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
    expect(output).toMatch(/spend cap\s+\$2\.0000 \/ \$5\.00/)
    expect(output).toMatch(/Session ceiling: \$2\.0000 \/ \$5\.00/)
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
  it('a message-level HIGH-risk gate resolves through turn({approved}) on accept', async () => {
    const llm = new FakeLLMClient('Draft sent.')
    const assistant = new PersonalAssistant({ llmClient: llm })
    const askYesNo = vi.fn().mockResolvedValue(true)
    const { cli } = await setupCli({ assistant, askYesNo })
    const lines = captureOutput()

    await cli.dispatchLine('Please send an email to my boss telling him I quit.')

    expect(askYesNo).toHaveBeenCalledWith(expect.stringContaining('Proceed?'))
    expect(lines.join('\n')).toContain('Draft sent.')
  })

  it('a message-level HIGH-risk gate resolves through turn({approved}) on decline, and records the declined request rather than silently dropping it', async () => {
    const llm = new FakeLLMClient('Draft sent.')
    const assistant = new PersonalAssistant({ llmClient: llm })
    const askYesNo = vi.fn().mockResolvedValue(false)
    const { cli } = await setupCli({ assistant, askYesNo })
    const lines = captureOutput()

    await cli.dispatchLine('Please send an email to my boss telling him I quit.')

    expect(lines.join('\n')).toContain('Cancelled.')
    expect(llm.calls).toBe(0)
    const transcript = await assistant.getTranscript('cli')
    expect(transcript.some((m) => m.content.includes('email'))).toBe(true)
  })

  it('a staged write_file action resolves through turn({approved, pendingActionId}) on accept and actually applies', async () => {
    const backend = makeFakeBackend()
    const llm = new ScriptedToolLLMClient({ id: 'toolu_1', name: 'write_file', input: { path: 'summary.md', content: 'hello' } })
    const assistant = new PersonalAssistant({ llmClient: llm, fileTools: { backend, workspaceRoot: '/workspace' } })
    const askYesNo = vi.fn().mockResolvedValue(true)
    const { cli } = await setupCli({ assistant, askYesNo })
    captureOutput()

    await cli.dispatchLine('Write a summary to summary.md')

    expect(askYesNo).toHaveBeenCalledWith(expect.stringContaining('Apply this write?'))
    expect(await backend.readTextFile('/workspace/summary.md')).toBe('hello')
  })

  it('a staged write_file action resolves through turn({approved: false, pendingActionId}) on decline and applies nothing', async () => {
    const backend = makeFakeBackend()
    const llm = new ScriptedToolLLMClient({ id: 'toolu_1', name: 'write_file', input: { path: 'summary.md', content: 'hello' } })
    const assistant = new PersonalAssistant({ llmClient: llm, fileTools: { backend, workspaceRoot: '/workspace' } })
    const askYesNo = vi.fn().mockResolvedValue(false)
    const { cli } = await setupCli({ assistant, askYesNo })
    captureOutput()

    await cli.dispatchLine('Write a summary to summary.md')

    expect(await backend.readTextFile('/workspace/summary.md')).toBeUndefined()
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

describe('command dispatch table', () => {
  const NO_ARG_COMMANDS = ['/why', '/layers', '/sources', '/plan', '/help', '/status', '/cost']

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
      cli.dispatchLine('/config set enableWeb true'),
      cli.dispatchLine('/config set enableShell true'),
    ])

    // Both patches landed — a race would have let one read-modify-write clobber the other.
    expect(await configStore.load()).toMatchObject({ enableWeb: true, enableShell: true })
  })
})
