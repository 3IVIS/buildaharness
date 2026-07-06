#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LLMClient, FileSystemAdapter, FileSystemExperienceStore, InMemoryReminderStore, type ILLMClient } from '@buildaharness/runtime'
import { PersonalAssistant, type AssistantProgress, type AssistantTrace, type AssistantSource, type AssistantTurnResult } from './assistant.js'
import type { AssistantToolStep } from './tool-step.js'
import { nodeDisplayName } from './node-display-names.js'
import { classifyError } from './error-classifier.js'
import { createNodeFsBackend } from './node-fs-backend.js'
import { ClaudeCliLLMClient } from './claude-cli-llm-client.js'
import { runApprovedShellCommand } from './shell-executor.js'
import { duckDuckGoSearch, braveSearch } from './web-search-provider.js'
import { resolveConfig, validateConfig, ConfigValidationError, type AssistantConfig } from './config.js'
import { NodeConfigStore } from './node-config-store.js'
import { isConfigKey, envOverridesFromProcessEnv, parseConfigValue, ConfigValueParseError, formatConfigListing, ENV_VAR_FOR_CONFIG_KEY, CONFIG_KEYS } from './cli-config.js'

const dataDir = join(homedir(), '.buildaharness', 'personal-assistant')
const configStore = new NodeConfigStore(join(dataDir, 'config.json'))

// Must match the exact path a FileSystemAdapter({ baseDir: dataDir, namespace:
// 'reminders' }) uses for the key "reminders" — see file-tools-mcp-server.mjs's
// doc comment — so the claude-cli backend's MCP subprocess and this process's
// own reminderStore (below) read/write the same file instead of two disconnected
// reminder lists. FileSystemAdapter's path formula is `${baseDir}/${namespace}/${sanitize(key)}.json`,
// and "reminders" sanitizes to itself (no special characters).
const remindersFile = join(dataDir, 'reminders', 'reminders.json')

// Env vars still win over persisted config — see cli-config.ts's envOverridesFromProcessEnv
// and config.ts's resolveConfig — so this stays a behavior-preserving migration for anyone
// who already sets ASSISTANT_ENABLE_WEB etc. and never touches /config.
const envOverrides = envOverridesFromProcessEnv(process.env)

// create() only supplies a default for storage the caller didn't already pass in (and falls
// back to in-memory outside a browser) — passing this explicit, filesystem-backed store is
// what gives the CLI real persistence across runs. See plans/tauri_desktop_plan.html Phase 3.
const backend = createNodeFsBackend()

/**
 * Builds a fresh PersonalAssistant (and the llmClient/search function it depends on) from a
 * resolved AssistantConfig — called once at startup and again after any /config change that
 * takes effect, so nothing requires a process restart. Reuses the same dataDir-backed stores
 * each time, so transcripts/experience/checkpoints/reminders carry over across a rebuild.
 */
async function buildAssistant(config: AssistantConfig): Promise<PersonalAssistant> {
  const workspaceRoot = config.workspaceRoot ?? process.cwd()
  const search =
    config.searchBackend === 'brave'
      ? (query: string) => braveSearch(query, config.braveApiKey as string)
      : (query: string) => duckDuckGoSearch(query)

  // Note: unlike the proxy backend, claude-cli has no web_search/fetch_url wiring for
  // enableWeb yet — web_search has no default backend on this path either (see
  // claude-cli-llm-client.ts's doc comment), so enableWeb only takes effect on the proxy
  // (LLMClient) backend below.
  const llmClient: ILLMClient =
    config.llmBackend === 'claude-cli'
      ? new ClaudeCliLLMClient({ fileTools: { workspaceRoot }, remindersFile, shellTools: config.enableShell ? { workspaceRoot } : undefined })
      : new LLMClient({ proxyUrl: config.proxyUrl, authToken: config.authToken })

  return PersonalAssistant.create({
    llmClient,
    model: config.model,
    memory: new FileSystemAdapter({ backend, baseDir: dataDir, namespace: 'transcripts' }),
    experienceStore: await FileSystemExperienceStore.create({ backend, baseDir: dataDir, namespace: 'experience' }),
    checkpointStore: new FileSystemAdapter({ backend, baseDir: dataDir, namespace: 'checkpoints' }),
    reminderStore: new InMemoryReminderStore(new FileSystemAdapter({ backend, baseDir: dataDir, namespace: 'reminders' })),
    fileTools: { backend, workspaceRoot },
    webTools: config.enableWeb ? { search } : undefined,
    // executeCommand is the real child_process.spawn-based implementation (shell-executor.ts) —
    // wired in here, not inside assistant.ts, so the browser build never needs node:child_process.
    shellTools: config.enableShell ? { backend, workspaceRoot, timeoutMs: config.shellTimeoutMs, executeCommand: runApprovedShellCommand } : undefined,
  })
}

async function main(): Promise<void> {
  const persisted = await configStore.load()
  let { config, overriddenKeys } = resolveConfig(persisted, envOverrides)

  try {
    validateConfig({}, config)
  } catch (err) {
    if (!(err instanceof ConfigValidationError)) throw err
    console.error(err.message)
    process.exit(1)
  }

  let assistant = await buildAssistant(config)

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' })

  // No silent default: capabilities only appear in the banner when actually configured,
  // so the banner never implies something is available that isn't.
  const enabledCapabilities: string[] = []
  if (config.enableWeb) enabledCapabilities.push(`web search/fetch (${config.searchBackend})`)
  if (config.enableShell) enabledCapabilities.push('shell commands (approval-gated)')
  const capabilitySuffix = enabledCapabilities.length > 0 ? ` — enabled: ${enabledCapabilities.join(', ')}` : ''

  console.log(`Personal assistant — 11-layer harness, one turn at a time. Ctrl+C to exit.${capabilitySuffix}\n`)
  console.log('Type /config to view settings.\n')
  rl.prompt()

  let lastTrace: AssistantTrace | undefined
  let lastSources: AssistantSource[] | undefined
  let lastPlanStatus: AssistantTurnResult['planStatus']

  const PLAN_TASK_STATUS_ICON: Record<string, string> = {
    PENDING: '○', RUNNING: '▶', COMPLETE: '✓', FAILED: '✗', BLOCKED: '✗', HUMAN_REQUIRED: '~',
  }

  function printPlan(): void {
    if (!lastPlanStatus) {
      console.log('\nNo active plan for this session.\n')
      return
    }
    console.log(`\nPlan: ${lastPlanStatus.templateName} (${lastPlanStatus.completionPct.toFixed(1)}% complete)`)
    for (const task of lastPlanStatus.tasks) {
      console.log(`  ${PLAN_TASK_STATUS_ICON[task.status] ?? '?'} [${task.status}] ${task.id} — ${task.description}`)
    }
    console.log(`\nSuccess criteria: ${lastPlanStatus.successCriteria}\n`)
  }

  function verificationHealthLabel({ strength, feasibility }: AssistantTrace['verificationHealth']): string {
    const confidence = Math.min(strength, feasibility)
    if (confidence >= 0.7) return 'High confidence'
    if (confidence >= 0.4) return 'Reasonably confident'
    return 'Worth double-checking'
  }

  function printWhy(): void {
    if (!lastTrace) {
      console.log('\nNo harness trace for the last turn (nothing to explain yet, or it took the fast path).\n')
      return
    }
    console.log(`\n${verificationHealthLabel(lastTrace.verificationHealth)}`)
    for (const node of lastTrace.nodeExecutionOrder) {
      console.log(`  - ${nodeDisplayName(node)}`)
    }
    console.log('')
  }

  const SOURCE_TOOL_LABEL: Record<AssistantSource['tool'], string> = {
    read_file: 'Read',
    list_directory: 'Listed',
    web_search: 'Searched',
    fetch_url: 'Fetched',
  }

  function printSources(): void {
    if (!lastSources || lastSources.length === 0) {
      console.log('\nNo sources for the last turn (it used no file/web tool calls).\n')
      return
    }
    console.log('')
    for (const source of lastSources) {
      console.log(`  - ${SOURCE_TOOL_LABEL[source.tool]} ${source.path}`)
    }
    console.log('')
  }

  let lastProgressLineLength = 0
  function writeProgress(progress: AssistantProgress): void {
    const node = nodeDisplayName(progress.currentNode)
    const line = `[step ${progress.stepsUsed}/${progress.maxSteps}]${node ? ` ${node}…` : ''}`
    process.stdout.write(`\r${line.padEnd(lastProgressLineLength)}`)
    lastProgressLineLength = line.length
  }
  function clearProgress(): void {
    if (lastProgressLineLength === 0) return
    process.stdout.write(`\r${' '.repeat(lastProgressLineLength)}\r`)
    lastProgressLineLength = 0
  }

  // A discrete event, not a progress bar — each call gets its own scrolled-past line
  // (unlike writeProgress's single overwritten \r line), the way Claude Code's own CLI
  // shows a running log of what it's doing. Clears the progress line first so a tool step
  // never gets mangled mid-overwrite.
  function writeToolStep(step: AssistantToolStep): void {
    clearProgress()
    console.log(`  ⚙ ${step.summary}`)
  }

  async function handleTurn(message: string, approved = false, pendingActionId?: string): Promise<void> {
    // Set only once the first token of an actual streamed reply arrives — the
    // message-level approval gate and the file-tools loop both produce a full
    // reply with no streaming, so this stays false for those turns and the
    // final branch below falls back to printing the whole reply at once.
    let streamedAnyTokens = false
    function writeToken(token: string): void {
      if (!streamedAnyTokens) {
        process.stdout.write('\nassistant> ')
        streamedAnyTokens = true
      }
      process.stdout.write(token)
    }

    try {
      const result = await assistant.turn(message, {
        sessionId: 'cli',
        approved,
        pendingActionId,
        onProgress: writeProgress,
        onToken: writeToken,
        onToolStep: writeToolStep,
      })
      clearProgress()

      // A write_file/run_shell_command tool call, gated at the point of the call itself
      // rather than by the message text — see the file-tools and web+shell-tools plans'
      // Diagnosis tabs. Unlike the message-level gate below, both a yes and a no need to
      // re-call turn() (to apply or discard the staged action), not just a yes.
      if (result.status === 'needs_approval' && result.pendingActionId) {
        const isShell = result.pendingActionKind === 'shell'
        console.log(`\n[needs approval — ${isShell ? 'shell command' : 'write'}] ${result.reason}`)
        const confirmed = await askYesNo(isShell ? 'Run this command? (y/N) ' : 'Apply this write? (y/N) ')
        await handleTurn(message, confirmed, result.pendingActionId)
        return
      }

      if (result.status === 'needs_approval') {
        console.log(`\n[needs approval — ${result.riskLevel}] ${result.reason}`)
        console.log(`  "${message}"`)
        const confirmed = await askYesNo('Proceed? (y/N) ')
        if (confirmed) await handleTurn(message, true)
        else console.log('Cancelled.\n')
        return
      }

      if (result.status === 'escalated') {
        console.log(`\n[escalated] ${result.reason}\n`)
        return
      }

      lastTrace = result.trace
      lastSources = result.sources
      lastPlanStatus = result.planStatus
      const riskSuffix = result.riskLevel && result.riskLevel !== 'LOW' ? ` [risk: ${result.riskLevel}]` : ''
      const sourcesHint = result.sources && result.sources.length > 0 ? ` (${result.sources.length} source${result.sources.length > 1 ? 's' : ''} — /sources)` : ''
      const planHint = result.planStatus ? ` (plan: ${result.planStatus.completionPct.toFixed(0)}% — /plan)` : ''
      if (streamedAnyTokens) {
        // The reply text is already on screen, printed token-by-token as it
        // streamed in — just append whatever suffix belongs after it.
        process.stdout.write(`${riskSuffix}${sourcesHint}${planHint}\n\n`)
      } else {
        console.log(`\nassistant>${riskSuffix} ${result.reply}${sourcesHint}${planHint}\n`)
      }
    } catch (err) {
      // Mirrors chat-ui's error bubble: a failed turn (e.g. proxy down) shouldn't
      // crash the REPL via an unhandled rejection — just report it and keep going.
      clearProgress()
      const { message: errorMessage, retryable } = classifyError(err)
      console.log(`\n[error] ${errorMessage}${retryable ? ' Type the message again to retry.' : ''}\n`)
    }
  }

  function askYesNo(question: string): Promise<boolean> {
    return new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim().toLowerCase().startsWith('y')))
    })
  }

  // Refreshes `config`/`overriddenKeys` from disk and rebuilds `assistant` so a persisted
  // change (set or reset) takes effect on the very next turn — no restart needed. Cheap
  // enough to call unconditionally rather than special-casing which keys "matter": it's
  // just re-running the same wiring buildAssistant/main already do once at startup.
  async function reloadAssistant(): Promise<void> {
    const nextPersisted = await configStore.load()
    ;({ config, overriddenKeys } = resolveConfig(nextPersisted, envOverrides))
    assistant = await buildAssistant(config)
  }

  async function handleConfigCommand(args: string[]): Promise<void> {
    if (args.length === 0) {
      console.log(`\n${formatConfigListing(config, overriddenKeys)}\n`)
      return
    }

    if (args[0] === 'set') {
      const key = args[1]
      const raw = args.slice(2).join(' ')
      if (!key || !isConfigKey(key)) {
        console.log(`\n✗ Unknown config key "${key ?? ''}". Known keys: ${CONFIG_KEYS.join(', ')}\n`)
        return
      }
      if (!raw) {
        console.log(`\nUsage: /config set ${key} <value>\n`)
        return
      }
      if (overriddenKeys.has(key)) {
        console.log(`\n✗ "${key}" is pinned by ${ENV_VAR_FOR_CONFIG_KEY[key]} — unset that env var to change it here.\n`)
        return
      }

      let value: unknown
      try {
        value = parseConfigValue(key, raw)
      } catch (err) {
        if (!(err instanceof ConfigValueParseError)) throw err
        console.log(`\n✗ ${err.message}\n`)
        return
      }

      const patch = { [key]: value } as Partial<AssistantConfig>
      try {
        validateConfig(patch, config)
      } catch (err) {
        if (!(err instanceof ConfigValidationError)) throw err
        console.log(`\n✗ ${err.message}\n`)
        return
      }

      await configStore.save(patch)
      await reloadAssistant()
      console.log(`\n✓ ${key} updated (took effect immediately, no restart needed)\n`)
      return
    }

    if (args[0] === 'reset') {
      const key = args[1]
      if (key && !isConfigKey(key)) {
        console.log(`\n✗ Unknown config key "${key}". Known keys: ${CONFIG_KEYS.join(', ')}\n`)
        return
      }
      const clearPatch = key
        ? ({ [key]: undefined } as Partial<AssistantConfig>)
        : (Object.fromEntries(CONFIG_KEYS.map((k) => [k, undefined])) as Partial<AssistantConfig>)
      await configStore.save(clearPatch)
      await reloadAssistant()
      console.log(`\n✓ Reset ${key ?? 'all settings'} to default\n`)
      return
    }

    console.log('\nUsage: /config | /config set <key> <value> | /config reset [key]\n')
  }

  // readline's 'line' event fires for every buffered line as soon as it's parsed — it does
  // not wait for a previous line's async handler to finish, so piped/pasted multi-line input
  // can dispatch several commands concurrently. That's harmless for read-only commands
  // (/why, /sources, a plain turn) but not for /config: two concurrent handleConfigCommand
  // calls read and validate against the same in-memory `config` before either's update lands,
  // which can both corrupt the on-screen result and validate against stale state. Chaining
  // every dispatch onto `dispatchQueue` makes the loop a real REPL — one command fully
  // resolves before the next begins — matching what a human typing into the prompt would
  // experience anyway.
  let dispatchQueue: Promise<void> = Promise.resolve()
  rl.on('line', (line) => {
    const message = line.trim()
    if (!message) { rl.prompt(); return }
    dispatchQueue = dispatchQueue
      .then(async () => {
        if (message === '/why') { printWhy(); rl.prompt(); return }
        if (message === '/sources') { printSources(); rl.prompt(); return }
        if (message === '/plan') { printPlan(); rl.prompt(); return }
        if (message === '/config' || message.startsWith('/config ')) {
          await handleConfigCommand(message.split(/\s+/).slice(1))
          rl.prompt()
          return
        }
        await handleTurn(message)
        rl.prompt()
      })
      // An unexpected throw here must not poison the queue for lines typed after it.
      .catch((err) => {
        console.error('[unexpected error]', err)
        rl.prompt()
      })
  })
}

void main()
