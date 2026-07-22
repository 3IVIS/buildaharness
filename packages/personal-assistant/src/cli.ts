#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  LLMClient,
  AnthropicLLMClient,
  OpenAICompatibleLLMClient,
  OPENAI_BASE_URL,
  OPENAI_DEFAULT_MODEL,
  OPENROUTER_BASE_URL,
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_EXTRA_HEADERS,
  FileSystemAdapter,
  FileSystemExperienceStore,
  InMemoryReminderStore,
  type ILLMClient,
  type TokenUsage,
  type FsBackend,
} from '@buildaharness/runtime'
import { PersonalAssistant, type AssistantProgress, type AssistantTrace, type AssistantSource, type AssistantTurnResult } from './assistant.js'
import type { AssistantToolStep } from './tool-step.js'
import { nodeDisplayName, nodeToLayer, buildWhyChain, LAYER_ORDER, LAYER_DISPLAY_NAME, LAYER_SHORT_CODE } from './node-display-names.js'
import { classifyError } from './error-classifier.js'
import { createNodeFsBackend } from './node-fs-backend.js'
import { ClaudeCliLLMClient } from './claude-cli-llm-client.js'
import { runApprovedShellCommand } from './shell-executor.js'
import { duckDuckGoSearch, braveSearch } from './web-search-provider.js'
import { resolveConfig, validateConfig, ConfigValidationError, type AssistantConfig, type ConfigStore } from './config.js'
import { NodeConfigStore } from './node-config-store.js'
import { isConfigKey, envOverridesFromProcessEnv, parseConfigValue, ConfigValueParseError, formatConfigListing, ENV_VAR_FOR_CONFIG_KEY, CONFIG_KEYS } from './cli-config.js'
import { formatHelp, formatStatus, formatTranscriptMarkdown, defaultExportFilename, formatMemorySummary, formatMemoryExport, defaultMemoryExportFilename, formatSearchResults, formatCostSummary, formatDoctorReport, formatUndoLogListing } from './cli-session.js'
import { estimateCostUsd } from './model-pricing.js'
import { formatSpendCapStatus } from './spend-cap.js'
import { checkProxyHealth, checkClaudeCli, checkWorkspaceRoot, checkDataDirWritable } from './doctor-checks.js'
import { resolveNonInteractiveApprovalMode, type NonInteractiveApprovalMode } from './non-interactive-mode.js'

const defaultDataDir = join(homedir(), '.buildaharness', 'personal-assistant')
const defaultConfigStore = new NodeConfigStore(join(defaultDataDir, 'config.json'))

// Must match the exact path a FileSystemAdapter({ baseDir: dataDir, namespace:
// 'reminders' }) uses for the key "reminders" — see file-tools-mcp-server.mjs's
// doc comment — so the claude-cli backend's MCP subprocess and this process's
// own reminderStore (below) read/write the same file instead of two disconnected
// reminder lists. FileSystemAdapter's path formula is `${baseDir}/${namespace}/${sanitize(key)}.json`,
// and "reminders" sanitizes to itself (no special characters).
const defaultRemindersFile = join(defaultDataDir, 'reminders', 'reminders.json')

// Env vars still win over persisted config — see cli-config.ts's envOverridesFromProcessEnv
// and config.ts's resolveConfig — so this stays a behavior-preserving migration for anyone
// who already sets ASSISTANT_ENABLE_WEB etc. and never touches /config.
const defaultEnvOverrides = envOverridesFromProcessEnv(process.env)

const defaultNonInteractiveApprovalMode = resolveNonInteractiveApprovalMode(process.env)

// create() only supplies a default for storage the caller didn't already pass in (and falls
// back to in-memory outside a browser) — passing this explicit, filesystem-backed store is
// what gives the CLI real persistence across runs. See plans/tauri_desktop_plan.html Phase 3.
const defaultBackend = createNodeFsBackend()

/**
 * Picks the ILLMClient for config.llmBackend — one branch per backend, shared in shape with
 * chat-ui's App.tsx createLlmClient() (both switch over the same 5 values), but this one stays
 * CLI-only: claude-cli here is a real node:child_process subprocess (ClaudeCliLLMClient), not
 * the Tauri-bridged equivalent chat-ui's desktop build uses, and it's the only backend always
 * available on this surface (no "unsupported on this platform" branch needed, unlike a plain
 * browser tab which can't spawn `claude` at all).
 */
function buildLlmClient(config: AssistantConfig, workspaceRoot: string, remindersFile: string): ILLMClient {
  switch (config.llmBackend) {
    case 'claude-cli':
      return new ClaudeCliLLMClient({ fileTools: { workspaceRoot }, remindersFile, shellTools: config.enableShell ? { workspaceRoot } : undefined })
    case 'anthropic':
      return new AnthropicLLMClient({ apiKey: config.apiKey ?? '' })
    case 'openai':
      return new OpenAICompatibleLLMClient({ apiKey: config.apiKey ?? '', baseUrl: OPENAI_BASE_URL, defaultModel: OPENAI_DEFAULT_MODEL })
    case 'openrouter':
      return new OpenAICompatibleLLMClient({
        apiKey: config.apiKey ?? '',
        baseUrl: OPENROUTER_BASE_URL,
        defaultModel: OPENROUTER_DEFAULT_MODEL,
        extraHeaders: OPENROUTER_EXTRA_HEADERS,
      })
    case 'proxy':
      return new LLMClient({ proxyUrl: config.proxyUrl, authToken: config.authToken })
  }
}

/**
 * Builds a fresh PersonalAssistant (and the llmClient/search function it depends on) from a
 * resolved AssistantConfig — called once at startup and again after any /config change that
 * takes effect, so nothing requires a process restart. Reuses the same dataDir-backed stores
 * each time, so transcripts/experience/checkpoints/reminders carry over across a rebuild.
 */
interface BuildAssistantDeps {
  backend: FsBackend
  dataDir: string
  remindersFile: string
}

async function buildAssistant(config: AssistantConfig, { backend, dataDir, remindersFile }: BuildAssistantDeps): Promise<PersonalAssistant> {
  const workspaceRoot = config.workspaceRoot ?? process.cwd()
  const search =
    config.searchBackend === 'brave'
      ? (query: string) => braveSearch(query, config.braveApiKey as string)
      : (query: string) => duckDuckGoSearch(query)

  // Note: unlike the proxy backend, claude-cli has no web_search/fetch_url wiring for
  // enableWeb yet — web_search has no default backend on this path either (see
  // claude-cli-llm-client.ts's doc comment), so enableWeb only takes effect on the proxy
  // (LLMClient) backend below.
  const llmClient = buildLlmClient(config, workspaceRoot, remindersFile)

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
    dangerouslySkipPermissions: config.dangerouslySkipPermissions,
    spendCap:
      config.sessionCostLimitUsd !== undefined || config.sessionCallLimit !== undefined
        ? { sessionCostLimitUsd: config.sessionCostLimitUsd, sessionCallLimit: config.sessionCallLimit }
        : undefined,
  })
}

export interface RunCliOptions {
  dataDir?: string
  configStore?: ConfigStore
  backend?: FsBackend
  remindersFile?: string
  envOverrides?: Partial<AssistantConfig>
  nonInteractiveApprovalMode?: NonInteractiveApprovalMode
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  /**
   * Bypasses buildAssistant()'s config-driven backend selection entirely — the seam tests use
   * to hand runCli a PersonalAssistant wired to a scripted ILLMClient (same pattern as
   * assistant.test.ts) for deterministic command-dispatch/approval-flow coverage. When set, a
   * /config change that would otherwise rebuild the assistant leaves this instance in place.
   */
  assistant?: PersonalAssistant
  /** Overrides the rl.question-based approval prompt — lets tests script approve/decline answers without faking stdin/a real TTY. */
  askYesNo?: (question: string) => Promise<boolean>
}

export interface CliInstance {
  /** Parses and dispatches one line of input exactly as the REPL's 'line' handler does (same dispatchQueue serialization) — the seam cli.test.ts drives command dispatch through without a live TTY. */
  dispatchLine(line: string): Promise<void>
  close(): void
}

/**
 * The CLI's REPL, parameterized so cli.test.ts can import and drive it directly instead of only
 * through a live process (see non-interactive-mode.ts's doc comment for why that mattered before
 * this export existed — this is T1's answer to it). `main()` below calls this with no options,
 * getting exactly today's behavior; every option here has a real-filesystem/real-stdio default.
 */
export async function runCli(options: RunCliOptions = {}): Promise<CliInstance> {
  const dataDir = options.dataDir ?? defaultDataDir
  const configStore = options.configStore ?? defaultConfigStore
  const backend = options.backend ?? defaultBackend
  const remindersFile = options.remindersFile ?? defaultRemindersFile
  const envOverrides = options.envOverrides ?? defaultEnvOverrides
  const nonInteractiveApprovalMode = options.nonInteractiveApprovalMode ?? defaultNonInteractiveApprovalMode

  const persisted = await configStore.load()
  let { config, overriddenKeys } = resolveConfig(persisted, envOverrides)

  try {
    validateConfig({}, config)
  } catch (err) {
    if (!(err instanceof ConfigValidationError)) throw err
    console.error(err.message)
    process.exit(1)
  }

  // Checked before anything else starts, not lazily at the first approval prompt — a session
  // that ran tool calls for several turns before hitting a HIGH-risk gate would otherwise fail
  // deep in, with no chance to recover the work already done, instead of failing immediately
  // with a clear explanation of what to do about it.
  if (nonInteractiveApprovalMode === 'require-tty' && !process.stdin.isTTY) {
    console.error(
      'ASSISTANT_NON_INTERACTIVE_APPROVAL=require-tty is set, but stdin is not a real TTY ' +
        '(piped/scripted input). Refusing to start rather than fail confusingly at the first ' +
        'approval prompt — see README.md\'s "Non-interactive / scripted use" section for the ' +
        'alternative (ASSISTANT_NON_INTERACTIVE_APPROVAL=decline).',
    )
    process.exit(1)
  }

  let assistant = options.assistant ?? (await buildAssistant(config, { dataDir, backend, remindersFile }))

  const rl = createInterface({ input: options.input ?? process.stdin, output: options.output ?? process.stdout, prompt: 'you> ' })
  // Paused immediately, synchronously, before any awaits below get a chance to yield the event
  // loop: createInterface() switches its input stream to flowing mode as soon as it attaches its
  // own internal 'data' listener, so once we hit e.g. the listUndoLogEntries() await further
  // down, a piped/heredoc input whose lines are already fully buffered by the OS gets parsed into
  // 'line' events right then — and since EventEmitter#emit never queues an event for a listener
  // that isn't there yet, every line parsed before rl.on('line', ...) near the bottom of this
  // function runs is silently dropped, not just delayed. rl.prompt() below auto-resumes if
  // paused, but that resume is itself deferred (stream.resume() only schedules a nextTick flow
  // start) and everything from here to the rl.on('line', ...)/rl.resume() pair at the bottom
  // runs synchronously with no further awaits, so the listener is always in place first.
  rl.pause()

  // Display-only defaults, mirroring each backend's own fallback so the banner shows the
  // model that will actually be used even when config.model is unset — not authoritative
  // (each llmClient picks its own default independently), just kept in sync by hand the same
  // way chat-ui/App.tsx's DEFAULT_PROXY_MODEL already does for the proxy backend.
  const backendDisplayModel: Record<AssistantConfig['llmBackend'], string> = {
    proxy: 'claude-3-5-sonnet-20241022',
    'claude-cli': '(your Claude Code default)',
    anthropic: 'claude-3-5-sonnet-20241022',
    openai: OPENAI_DEFAULT_MODEL,
    openrouter: OPENROUTER_DEFAULT_MODEL,
  }
  console.log(`backend: ${config.llmBackend} (${config.model ?? backendDisplayModel[config.llmBackend]})`)

  // No silent default: capabilities only appear in the banner when actually configured,
  // so the banner never implies something is available that isn't.
  const enabledCapabilities: string[] = []
  if (config.enableWeb) enabledCapabilities.push(`web search/fetch (${config.searchBackend})`)
  if (config.enableShell) enabledCapabilities.push(`shell commands (${config.dangerouslySkipPermissions ? 'NOT approval-gated' : 'approval-gated'})`)
  const capabilitySuffix = enabledCapabilities.length > 0 ? ` — enabled: ${enabledCapabilities.join(', ')}` : ''
  // Loud and separate from the capability list above (which is easy to skim past) —
  // this changes the trust model for every HIGH-risk action, not just shell.
  const dangerBanner = config.dangerouslySkipPermissions
    ? '\n⚠ dangerouslySkipPermissions is ON — every approval prompt (risky messages, file writes, shell commands) is skipped automatically.\n'
    : ''
  // Same "never silently in effect" reasoning as dangerBanner above — the opposite trust
  // direction (declines instead of skips), but just as important to surface up front.
  const nonInteractiveBanner =
    nonInteractiveApprovalMode === 'decline'
      ? '\nASSISTANT_NON_INTERACTIVE_APPROVAL=decline is set — every approval prompt auto-declines.\n'
      : ''

  // The undo-log persists across sessions (it's on disk under the workspace, not in-memory) —
  // surfaced here so a user doesn't discover leftover revertible actions from a prior session
  // only by happening to run /undo-action or /status (T6).
  const startupUndoLogEntries = await assistant.listUndoLogEntries()
  const undoableFromBefore = startupUndoLogEntries.filter((e) => e.undoable).length
  const undoBanner =
    undoableFromBefore > 0
      ? `\n${undoableFromBefore} action${undoableFromBefore === 1 ? '' : 's'} from earlier sessions ${undoableFromBefore === 1 ? 'is' : 'are'} still revertible — see /undo-action.\n`
      : ''

  console.log(`Personal assistant — 11-layer harness, one turn at a time. Ctrl+C to exit.${capabilitySuffix}\n${dangerBanner}${nonInteractiveBanner}${undoBanner}`)
  console.log('Type /help to see all commands, /config to view settings.\n')
  rl.prompt()

  let lastTrace: AssistantTrace | undefined
  let lastSources: AssistantSource[] | undefined
  let lastPlanStatus: AssistantTurnResult['planStatus']
  let lastTurnUsage: TokenUsage | undefined
  let sessionUsage: TokenUsage | undefined
  // Tool calls made by the most recent turn — used only so /undo can warn about a real
  // side effect (e.g. a created reminder) it's about to claim to have removed but can't
  // actually reverse. Reset at the start of every handleTurn call, see writeToolStep below.
  let lastTurnToolSteps: AssistantToolStep[] = []
  // Set whenever the last turn was blocked on an approval gate (message-level risk or a
  // staged write/shell command) and then declined, or escalated — lastTrace stays whatever it
  // was before in either case (neither path ever runs the harness), so without this /why and
  // /layers would fall back to the generic "nothing to explain yet, or it took the fast path"
  // message even right after a real, user-visible decline. That reads as if nothing happened,
  // when something very much did. Cleared whenever a turn actually produces a trace, and on /new.
  let lastNoTraceReason: string | undefined

  /** claude-cli is the only backend that returns a real dollar cost (--output-format json's total_cost_usd) — every other backend (proxy, and now anthropic/openai/openrouter, none of which surface billing via TokenUsage.costUsd) gets an approximate estimate instead, see model-pricing.ts. */
  function withCostEstimate(usage: TokenUsage): TokenUsage {
    if (config.llmBackend === 'claude-cli' || usage.costUsd !== undefined) return usage
    const estimated = estimateCostUsd(config.model ?? 'claude-3-5-sonnet-20241022', usage)
    return estimated !== undefined ? { ...usage, costUsd: estimated } : usage
  }

  function accumulateSessionUsage(usage: TokenUsage): void {
    sessionUsage = {
      inputTokens: (sessionUsage?.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (sessionUsage?.outputTokens ?? 0) + usage.outputTokens,
      costUsd: usage.costUsd !== undefined ? (sessionUsage?.costUsd ?? 0) + usage.costUsd : sessionUsage?.costUsd,
    }
  }

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

  /** One-line summary of AssistantTrace.batchBudget — the same found/not_found/truncated_while_productive
   * counts a batch turn's synthesized reply is already built from, just as a glance-able tally
   * rather than prose. Shared by /why's compact view and /layers' fuller per-item breakdown. */
  function batchBudgetSummaryLine(batchBudget: NonNullable<AssistantTrace['batchBudget']>): string {
    const found = batchBudget.perItemOutcomes.filter((o) => o.status === 'found').length
    const notFound = batchBudget.perItemOutcomes.filter((o) => o.status === 'not_found').length
    const truncated = batchBudget.perItemOutcomes.filter((o) => o.status === 'truncated_while_productive').length
    return (
      `Batch: ${batchBudget.itemCount} items — ${found} found, ${notFound} not found, ${truncated} truncated ` +
      `(${batchBudget.totalCallsUsed} calls used, projected ~${Math.ceil(batchBudget.projectedTotal)})`
    )
  }

  function printWhy(): void {
    if (!lastTrace) {
      console.log(`\n${lastNoTraceReason ?? 'No harness trace for the last turn (nothing to explain yet, or it took the fast path).'}\n`)
      return
    }
    console.log(`\n${verificationHealthLabel(lastTrace.verificationHealth)}`)
    // Only the layers that actually fired, chained in the order they fired — quiet otherwise
    // (Design Principle 3 of the harness layer activation plan: the common, unremarkable case
    // stays quiet, matching the existing "don't badge LOW risk" convention). Use /layers for
    // the full fired/skipped picture across all 11.
    const chain = buildWhyChain(lastTrace.layerActivity)
    if (chain.length > 0) {
      console.log('  ' + chain.map((item) => `${LAYER_SHORT_CODE[item.layer]} (${item.reason})`).join(' > '))
    }
    // Absent on every non-batch turn (see AssistantTrace.batchBudget's doc comment) — only a
    // batch-research turn ever has this to show.
    if (lastTrace.batchBudget) {
      console.log('  ' + batchBudgetSummaryLine(lastTrace.batchBudget))
    }
    console.log('')
  }

  /** Full fired/skipped picture across all 11 harness layers for the last turn — pure text rendering of the same layer_activity data /why's "What I checked" summarizes selectively. */
  function printLayers(): void {
    if (!lastTrace) {
      console.log(`\n${lastNoTraceReason ?? 'No harness trace for the last turn (nothing to explain yet, or it took the fast path).'}\n`)
      return
    }
    console.log('')
    const byLayer = new Map(lastTrace.layerActivity.map((e) => [e.layer, e]))
    for (const layer of LAYER_ORDER) {
      const e = byLayer.get(layer)
      const mark = e?.fired ? '✓' : '·'
      const reason = e?.reason ?? 'not evaluated this turn'
      console.log(`  [${mark}] ${LAYER_DISPLAY_NAME[layer].padEnd(22)} ${reason}`)
    }
    // The full per-item breakdown behind /why's one-line batchBudgetSummaryLine tally — same
    // "absent on every non-batch turn" gating as that summary.
    if (lastTrace.batchBudget) {
      console.log('')
      console.log(`  ${batchBudgetSummaryLine(lastTrace.batchBudget)}`)
      const STATUS_MARK: Record<'found' | 'not_found' | 'truncated_while_productive', string> = {
        found: '✓', not_found: '✗', truncated_while_productive: '~',
      }
      for (const outcome of lastTrace.batchBudget.perItemOutcomes) {
        console.log(`    [${STATUS_MARK[outcome.status]}] ${outcome.item.padEnd(30)} ${outcome.status} (${outcome.callsUsed} calls)`)
      }
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

  function printHelp(): void {
    console.log(`\n${formatHelp()}\n`)
  }

  /** Ends the current conversation: clears transcript/facts/plan state and resets local display state so /why, /sources, /plan immediately reflect the fresh session instead of showing stale data. */
  async function handleClear(): Promise<void> {
    await assistant.clearSession('cli')
    lastTrace = undefined
    lastSources = undefined
    lastPlanStatus = undefined
    lastTurnUsage = undefined
    sessionUsage = undefined
    lastNoTraceReason = undefined
    console.log('\n✓ Started a fresh conversation.\n')
  }

  /**
   * Explicit inspect/clear for a stuck harness checkpoint — a scoped alternative to `/clear`
   * (which also wipes transcript/facts/plan) or moving the whole
   * `~/.buildaharness/personal-assistant/` directory aside by hand, previously the only way to
   * recover from a checkpoint that keeps failing to resume (e.g. left behind by a process killed
   * mid-turn — see assistant.ts's runId doc comment). Bare `/checkpoint` inspects without
   * clearing; `/checkpoint clear` clears it, matching `/config`/`/config set`'s own
   * bare-vs-subcommand shape.
   */
  async function handleCheckpoint(args: string[]): Promise<void> {
    if (args[0] === 'clear') {
      const result = await assistant.clearCheckpoint('cli')
      console.log(
        result.cleared
          ? `\n✓ Cleared the stuck checkpoint (was at step ${result.stepsUsed}, node "${result.currentNode}"). Conversation history is untouched — your next message starts a fresh harness run.\n`
          : '\nNo checkpoint to clear — the last turn either completed normally or there was nothing in progress.\n',
      )
      return
    }
    const status = await assistant.getCheckpointStatus('cli')
    if (!status.present) {
      console.log('\nNo checkpoint present — the last turn completed normally or there was nothing in progress.\n')
      return
    }
    const attemptsNote =
      status.failedResumeAttempts > 0
        ? ` — failed to resume ${status.failedResumeAttempts} time${status.failedResumeAttempts === 1 ? '' : 's'} in a row so far`
        : ''
    console.log(
      `\nA checkpoint is present: step ${status.stepsUsed}, last node "${status.currentNode}"${attemptsNote}.\n` +
        `Your next message will try to resume it automatically. Run /checkpoint clear to discard it and start fresh instead.\n`,
    )
  }

  async function printStatus(): Promise<void> {
    const transcript = await assistant.getTranscript('cli')
    const undoLogEntries = await assistant.listUndoLogEntries()
    const spendCapLine = await spendCapStatusLine()
    console.log(
      `\n${formatStatus({ config, overriddenKeys, transcriptLength: transcript.length, planActive: lastPlanStatus !== undefined, undoLogEntries, spendCapLine })}\n`,
    )
  }

  /** Shared by /status and /cost (plan T2 step 5: "not a separate display") — undefined when no ceiling is configured. */
  async function spendCapStatusLine(): Promise<string | undefined> {
    if (config.sessionCostLimitUsd === undefined && config.sessionCallLimit === undefined) return undefined
    const state = await assistant.getSpendState('cli')
    return formatSpendCapStatus(state, { sessionCostLimitUsd: config.sessionCostLimitUsd, sessionCallLimit: config.sessionCallLimit })
  }

  /** Writes the session transcript to a markdown file — an explicit argument overrides the default filename, resolved relative to process.cwd() if not absolute. */
  async function handleExport(args: string[]): Promise<void> {
    const transcript = await assistant.getTranscript('cli')
    if (transcript.length === 0) {
      console.log('\nNothing to export yet.\n')
      return
    }
    const filename = resolvePath(process.cwd(), args[0] ?? defaultExportFilename())
    try {
      await writeFile(filename, formatTranscriptMarkdown(transcript), 'utf-8')
      console.log(`\n✓ Exported ${transcript.length} message${transcript.length === 1 ? '' : 's'} to ${filename}\n`)
    } catch (err) {
      // Mirrors handleTurn's catch convention (below) — a failed write is reported, not thrown.
      const { message } = classifyError(err)
      console.log(`\n[error] ${message}\n`)
    }
  }

  /**
   * Removes the last exchange from conversation history. Only affects what the model
   * remembers — a real write_file/run_shell_command effect from the undone turn is not
   * reversed (see the plan's Known limitations). Peeks at the transcript before calling
   * undoLastTurn so the confirmation message can name which side was removed, without
   * changing undoLastTurn's return shape just for that.
   *
   * create_reminder is the one tool call this reversible-sounding command can silently fail
   * to revert without the user realizing it — reminders need no approval (see risk-classifier.ts),
   * so unlike write_file/run_shell_command there's no prior "Proceed?" prompt that already told
   * the user this was consequential. ReminderStore has no delete/remove method to actually undo
   * it with (adding one is a packages/runtime change, out of scope here), so the best available
   * fix is surfacing the caveat explicitly instead of letting "Removed the last exchange" imply
   * the reminder went away too.
   */
  async function handleUndo(): Promise<void> {
    const transcriptBefore = await assistant.getTranscript('cli')
    if (transcriptBefore.length === 0) {
      console.log('\nNothing to undo.\n')
      return
    }
    const wasPendingApproval = transcriptBefore[transcriptBefore.length - 1].role !== 'assistant'
    const undoneReminders = lastTurnToolSteps.filter((s) => s.tool === 'create_reminder')

    const result = await assistant.undoLastTurn('cli')
    if (!result.undone) {
      console.log('\nNothing to undo.\n')
      return
    }
    // The display state described the now-undone turn — there's no cheap way to recover the
    // exact prior turn's trace/sources without storing turn-scoped snapshots (accepted limitation).
    lastTrace = undefined
    lastSources = undefined
    lastPlanStatus = undefined
    lastTurnToolSteps = []
    const caveat = undoneReminders.length > 0
      ? ` Note: ${undoneReminders.length === 1 ? 'a reminder' : `${undoneReminders.length} reminders`} created in that exchange (${undoneReminders.map((s) => `"${s.input.text}"`).join(', ')}) ${undoneReminders.length === 1 ? 'is' : 'are'} still active — /undo only removes chat history, not that side effect.`
      : ''
    console.log(
      `\n✓ Removed ${wasPendingApproval ? 'the pending message awaiting approval' : 'the last exchange (1 user message, 1 assistant reply)'}.${caveat}\n`,
    )
  }

  /**
   * `/undo-action` with no argument lists real filesystem effects still on record as revertible
   * (T3 step 1). `/undo-action <id>` stages a revert of that entry as its own approval-gated
   * action (T3 step 2) — same "yes/no, then re-call turn() to apply or discard" shape as any
   * other staged write/shell action, except staging itself happens synchronously here (via
   * assistant.stageUndoAction) rather than by the model calling a tool, so the confirmation
   * prompt is driven directly rather than via handleTurn's needs_approval branch.
   */
  async function handleUndoAction(args: string[]): Promise<void> {
    if (args.length === 0) {
      const entries = await assistant.listUndoLogEntries()
      console.log(`\n${formatUndoLogListing(entries)}\n`)
      return
    }

    const staged = await assistant.stageUndoAction(args[0])
    if (staged.status === 'error') {
      console.log(`\n✗ ${staged.message}\n`)
      return
    }

    console.log(`\n[needs approval — revert] ${staged.reason}`)
    const confirmed = await askYesNo('Apply this revert? (y/N) ')
    lastTrace = undefined
    lastNoTraceReason = `No harness trace — the last turn was a staged revert that was ${confirmed ? 'approved' : 'declined'} before the harness ran.`
    await handleTurn('', confirmed, staged.pendingActionId)
  }

  async function printMemory(): Promise<void> {
    const summary = await assistant.getMemorySummary('cli')
    console.log(`\n${formatMemorySummary(summary)}\n`)
  }

  /**
   * `/memory export [file]` — writes the full, unbounded learned-experience contents (every
   * strategy weight/decomposition/recovery sequence, not just the 20-entry preview `/memory`
   * prints) plus facts/reminders to a JSON file. Mirrors handleExport's shape: explicit
   * argument overrides the default filename, resolved relative to process.cwd() if not
   * absolute, a failed write is reported rather than thrown. Read-only over already-persisted
   * data — never an LLM call or network request.
   */
  async function handleMemoryExport(args: string[]): Promise<void> {
    const data = await assistant.exportMemory('cli')
    const filename = resolvePath(process.cwd(), args[0] ?? defaultMemoryExportFilename())
    try {
      await writeFile(filename, formatMemoryExport(data), 'utf-8')
      console.log(`\n✓ Exported learned memory to ${filename}\n`)
    } catch (err) {
      const { message } = classifyError(err)
      console.log(`\n[error] ${message}\n`)
    }
  }

  /** `/memory` with no args shows a preview; `/memory export [file]` writes the full contents to disk (see handleMemoryExport). */
  async function handleMemory(args: string[]): Promise<void> {
    if (args[0] === 'export') {
      await handleMemoryExport(args.slice(1))
      return
    }
    await printMemory()
  }

  /** `/search <query>` — ranked search over past messages (see PersonalAssistant.searchTranscript), never an LLM call or network request. A query with no terms is treated the same as no results, not an error. */
  async function handleSearch(args: string[]): Promise<void> {
    const query = args.join(' ')
    if (!query.trim()) {
      console.log('\nUsage: /search <query>\n')
      return
    }
    const hits = await assistant.searchTranscript(query)
    console.log(`\n${formatSearchResults(hits, query)}\n`)
  }

  async function printCost(): Promise<void> {
    const spendCapLine = await spendCapStatusLine()
    console.log(`\n${formatCostSummary({ lastTurn: lastTurnUsage, session: sessionUsage ?? { inputTokens: 0, outputTokens: 0 }, backend: config.llmBackend, spendCapLine })}\n`)
  }

  async function handleDoctor(): Promise<void> {
    const workspaceRoot = config.workspaceRoot ?? process.cwd()
    const checks = await Promise.all([
      // Backend-specific checks only run for the backend actually in use — skipped, not
      // reported as failing, for the one that's inactive.
      ...(config.llmBackend === 'proxy' ? [checkProxyHealth(config.proxyUrl)] : []),
      ...(config.llmBackend === 'claude-cli' ? [checkClaudeCli(process.env.CLAUDE_PATH ?? 'claude')] : []),
      checkWorkspaceRoot(workspaceRoot),
      checkDataDirWritable(backend, dataDir),
      // Informational only (always ok:true) — surfaces the active backend/flags so a user has
      // one command to confirm config, rather than none (see file's own config summary gap).
      { label: `llmBackend: ${config.llmBackend}`, ok: true },
      { label: `enableShell: ${config.enableShell ?? false}, enableWeb: ${config.enableWeb ?? false}`, ok: true },
      // Provider API keys are stored plaintext in config.json, not an OS keychain — confirming
      // that explicitly here rather than leaving it unstated (no keychain integration exists).
      { label: 'provider keys stored: plaintext in config.json (no OS keychain integration)', ok: true },
    ])
    console.log(`\n${formatDoctorReport(checks)}\n`)
  }

  let lastProgressLineLength = 0
  function writeProgress(progress: AssistantProgress): void {
    // Layer name instead of the raw node id even on a non-plan turn (Phase 3.3: "Step 3/5 —
    // Verification…" reads better than "Step 3/5 — verify…") — falls back to the node's own
    // display name for loop-scaffolding nodes (context_compression etc.) that map to no layer.
    const layer = nodeToLayer(progress.currentNode)
    const label = layer ? LAYER_DISPLAY_NAME[layer] : nodeDisplayName(progress.currentNode)
    // A plan-driven turn gets a plan-aware prefix instead of the generic step counter for the
    // duration of the run (Phase 3.2) — the node/layer name is still shown after it, and full
    // harness-internal detail is still available via /why once the turn finishes.
    const prefix = progress.planPosition
      ? `[${progress.planPosition.templateName} — step ${progress.planPosition.stepIndex}/${progress.planPosition.stepCount} (${progress.planPosition.completionPct.toFixed(0)}%)]`
      : `[step ${progress.stepsUsed}/${progress.maxSteps}]`
    const line = `${prefix}${label ? ` ${label}…` : ''}`
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
    lastTurnToolSteps.push(step)
  }

  async function handleTurn(message: string, approved = false, pendingActionId?: string): Promise<void> {
    lastTurnToolSteps = []
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
        // Gated on streamedAnyTokens: onProgress keeps firing for layers (Memory,
        // Verification) that run after the LLM call, i.e. after writeToken has already put
        // the reply on the current line with no trailing newline. writeProgress's \r-based
        // overwrite doesn't know that — on a real TTY it wrote the "[step N/5] ..." text
        // over the tail of the just-streamed reply, and the following clearProgress() then
        // blanked that same line, so the end of the assistant's answer visibly vanished
        // right after it finished streaming. Once streaming has started this turn, further
        // progress has nothing safe to overwrite, so it's dropped instead.
        onProgress: (progress) => {
          if (!streamedAnyTokens) writeProgress(progress)
        },
        onToken: writeToken,
        onToolStep: writeToolStep,
      })
      // Same streamedAnyTokens gate as onProgress above: lastProgressLineLength describes a
      // pre-streaming progress line that a leading "\n" in writeToken already scrolled past,
      // not the current line (the tail of the streamed reply) — clearing unconditionally here
      // would \r back onto the reply's last line and blank the start of it with stale-length
      // spaces.
      if (!streamedAnyTokens) clearProgress()

      // A write_file/run_shell_command tool call, gated at the point of the call itself
      // rather than by the message text — see the file-tools and web+shell-tools plans'
      // Diagnosis tabs. Unlike the message-level gate below, both a yes and a no need to
      // re-call turn() (to apply or discard the staged action), not just a yes.
      if (result.status === 'needs_approval' && result.pendingActionId) {
        // 'batch' (a projected-search-count confirmation, not a staged write/shell action) has
        // its own label and prompt — falling through to the 'write' case here would print
        // "[needs approval — write]" and "Apply this write?" over a message that's actually
        // about how many more searches a batch research turn is projected to need.
        const kindLabel = result.pendingActionKind === 'shell' ? 'shell command' : result.pendingActionKind === 'batch' ? 'batch research' : 'write'
        const promptText =
          result.pendingActionKind === 'shell'
            ? 'Run this command? (y/N) '
            : result.pendingActionKind === 'batch'
              ? 'Continue? (y/N) '
              : 'Apply this write? (y/N) '
        console.log(`\n[needs approval — ${kindLabel}] ${result.reason}`)
        const confirmed = await askYesNo(promptText)
        lastTrace = undefined
        lastNoTraceReason = `No harness trace — the last turn was a staged ${kindLabel} that was ${confirmed ? 'approved' : 'declined'} before the harness ran.`
        await handleTurn(message, confirmed, result.pendingActionId)
        return
      }

      if (result.status === 'needs_approval') {
        console.log(`\n[needs approval — ${result.riskLevel}] ${result.reason}`)
        console.log(`  "${message}"`)
        const confirmed = await askYesNo('Proceed? (y/N) ')
        if (confirmed) {
          await handleTurn(message, true)
        } else {
          // Without clearing lastTrace here, /why and /layers only fall back to
          // lastNoTraceReason when lastTrace is unset — so once any earlier turn in the
          // session had produced a real trace, a later decline left that stale trace in
          // place and printWhy/printLayers displayed the wrong (already-finished) turn's
          // explanation instead of this decline's reason.
          lastTrace = undefined
          lastNoTraceReason = 'No harness trace — the last turn was blocked on an approval gate and declined before the harness ran.'
          // Recorded now (not inside turn() itself) because the outcome is only known here —
          // see recordDeclinedRequest's doc comment for why this is safe unlike an eager append
          // inside runTurn. Without it, a later "did that actually happen?" question found no
          // trace of the request at all and confidently denied it was ever made.
          await assistant.recordDeclinedRequest('cli', message, result.reason ?? 'This request needed approval.')
          console.log('Cancelled.\n')
        }
        return
      }

      if (result.status === 'escalated') {
        lastTrace = undefined
        lastNoTraceReason = `No harness trace — the last turn escalated (${result.reason}) before completing.`
        console.log(`\n[escalated] ${result.reason}\n`)
        return
      }

      // A trivial turn's trace is present-but-empty (see assistant.ts's triviality branch) so
      // chat-ui can still render its "Why?"/"Run detail" panels with an explanation and an
      // all-unfired grid — the CLI has no such grid, so it keeps printing its existing plain
      // "took the fast path" copy instead of an empty/misleading confidence readout.
      lastTrace = result.harnessSkipped ? undefined : result.trace
      lastNoTraceReason = result.harnessSkipped
        ? 'No harness trace — the last turn was a simple, self-contained question answered directly without activating the harness (fast path).'
        : undefined
      lastSources = result.sources
      lastPlanStatus = result.planStatus
      lastTurnUsage = result.usage ? withCostEstimate(result.usage) : undefined
      if (lastTurnUsage) accumulateSessionUsage(lastTurnUsage)
      const riskSuffix = result.riskLevel && result.riskLevel !== 'LOW' ? ` [risk: ${result.riskLevel}]` : ''
      const sourcesHint = result.sources && result.sources.length > 0 ? ` (${result.sources.length} source${result.sources.length > 1 ? 's' : ''} — /sources)` : ''
      const planHint = result.planStatus ? ` (plan: ${result.planStatus.completionPct.toFixed(0)}% — /plan)` : ''
      // Printed as its own line, not folded into riskSuffix/sourcesHint/planHint's inline
      // "${...}" style — this is a full sentence, not a short bracketed tag. Must be handled the
      // same way in both branches below (like the other hints), since result.contradictionNotice
      // is only known once HarnessRuntime.run() finishes, well after writeToken already streamed
      // `reply` itself to the screen — see assistant.ts's findContradictionNotice doc comment.
      const contradictionNotice = result.contradictionNotice ? `\n\n${result.contradictionNotice}` : ''
      if (streamedAnyTokens) {
        // The reply text is already on screen, printed token-by-token as it
        // streamed in — just append whatever suffix belongs after it.
        process.stdout.write(`${riskSuffix}${sourcesHint}${planHint}${contradictionNotice}\n\n`)
      } else {
        console.log(`\nassistant>${riskSuffix} ${result.reply}${sourcesHint}${planHint}${contradictionNotice}\n`)
      }
    } catch (err) {
      // Mirrors chat-ui's error bubble: a failed turn (e.g. proxy down) shouldn't
      // crash the REPL via an unhandled rejection — just report it and keep going.
      clearProgress()
      const { message: errorMessage, retryable } = classifyError(err)
      console.log(`\n[error] ${errorMessage}${retryable ? ' Type the message again to retry.' : ''}\n`)
    }
  }

  // Fails closed: a non-TTY (piped/scripted) stdin is read and closed eagerly by readline,
  // often before a slow turn (one that ran tool calls before hitting a risk gate) even reaches
  // this prompt — rl.question() then throws ERR_USE_AFTER_CLOSE instead of ever reading an
  // answer. Left uncaught, that exception unwound past this function entirely: the caller's
  // `confirmed` was never assigned, "Cancelled." was never logged, and the line meant as the
  // answer was left to be dispatched as its own ordinary chat turn instead (readline had already
  // queued it as a 'line' event before this prompt ever ran) — a HIGH-risk/destructive request
  // was silently neither approved nor declined rather than being safely stopped. Any failure to
  // read a real answer must resolve to "no" (never "yes"), so a broken/absent confirmation
  // channel can't be mistaken for approval.
  function askYesNo(question: string): Promise<boolean> {
    // Test-only seam: bypasses stdin/readline entirely, same "never touches stdin" shape as the
    // nonInteractiveApprovalMode === 'decline' branch below, just with a caller-scripted answer
    // instead of a hardcoded decline.
    if (options.askYesNo) return options.askYesNo(question)
    // A designed decision, not a fallback: never touches stdin, so there's no readline race to
    // land in — unlike the catch below, this path is reached deterministically on every
    // approval gate, not only when reading the answer happens to fail.
    if (nonInteractiveApprovalMode === 'decline') {
      console.log(`\n[non-interactive mode: auto-declining — ASSISTANT_NON_INTERACTIVE_APPROVAL=decline]`)
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      try {
        rl.question(question, (answer) => resolve(answer.trim().toLowerCase().startsWith('y')))
      } catch {
        console.log(`\n[could not read a response — treating as declined]`)
        resolve(false)
      }
    })
  }

  // Refreshes `config`/`overriddenKeys` from disk and rebuilds `assistant` so a persisted
  // change (set or reset) takes effect on the very next turn — no restart needed. Cheap
  // enough to call unconditionally rather than special-casing which keys "matter": it's
  // just re-running the same wiring buildAssistant/main already do once at startup.
  async function reloadAssistant(): Promise<void> {
    const nextPersisted = await configStore.load()
    ;({ config, overriddenKeys } = resolveConfig(nextPersisted, envOverrides))
    assistant = options.assistant ?? (await buildAssistant(config, { dataDir, backend, remindersFile }))
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
      // Takes effect immediately, same as /config set — and can silently break the active
      // session (e.g. reverting llmBackend mid-conversation, see conv81's finding), so this asks
      // first, same as any other consequential action (shell commands, writes, HIGH-risk
      // requests) — /config set is left as-is (a single, explicit, intentional value the user
      // just typed, not a broad "wipe back to defaults" that's easy to trigger without meaning to
      // reset something specific).
      const target = key ? `"${key}"` : 'ALL settings'
      const confirmed = await askYesNo(`\nReset ${target} to default? This takes effect immediately. (y/N) `)
      if (!confirmed) {
        console.log('\nCancelled — nothing was reset.\n')
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

  /** Thin convenience wrapper over /config set model — not a second mechanism. Bare /model shows the current value. */
  async function handleModel(args: string[]): Promise<void> {
    if (args.length === 0) {
      console.log(`\n${config.model ?? "(using each backend's default)"}\n`)
      return
    }
    await handleConfigCommand(['set', 'model', args.join(' ')])
  }

  // A lookup keyed by the message's first whitespace-separated token — replaces what used to
  // be a growing `if (message === '/why') ... if (message === '/sources') ...` chain. Each
  // handler receives the remaining tokens as `args` (empty for commands that take none).
  // Rebuilt on every dispatch rather than hoisted to module scope because several handlers
  // close over `config`/`overriddenKeys`/`assistant`, which reloadAssistant() reassigns.
  const commands: Record<string, (args: string[]) => void | Promise<void>> = {
    '/why': () => printWhy(),
    '/layers': () => printLayers(),
    '/sources': () => printSources(),
    '/plan': () => printPlan(),
    '/help': () => printHelp(),
    '/clear': () => handleClear(),
    '/new': () => handleClear(),
    '/status': () => printStatus(),
    '/export': (args) => handleExport(args),
    '/undo': () => handleUndo(),
    '/undo-action': (args) => handleUndoAction(args),
    '/memory': (args) => handleMemory(args),
    '/search': (args) => handleSearch(args),
    '/model': (args) => handleModel(args),
    '/cost': () => printCost(),
    '/doctor': () => handleDoctor(),
    '/config': (args) => handleConfigCommand(args),
    '/checkpoint': (args) => handleCheckpoint(args),
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
  async function dispatchOne(message: string): Promise<void> {
    const [token, ...args] = message.split(/\s+/)
    const handler = commands[token]
    if (handler) {
      await handler(args)
      return
    }
    await handleTurn(message)
  }

  let dispatchQueue: Promise<void> = Promise.resolve()
  // One command fully resolves before the next begins — see the comment this used to carry
  // inline here (still true): readline's 'line' event doesn't wait for a previous line's async
  // handler, so piped/pasted multi-line input (or a test calling dispatchLine back to back)
  // could otherwise dispatch several commands concurrently, corrupting /config's read-modify-write.
  function enqueue(message: string): Promise<void> {
    const result = dispatchQueue
      .then(() => dispatchOne(message))
      // An unexpected throw here must not poison the queue for lines dispatched after it.
      .catch((err) => {
        console.error('[unexpected error]', err)
      })
    dispatchQueue = result
    return result
  }

  rl.on('line', (line) => {
    const message = line.trim()
    if (!message) { rl.prompt(); return }
    void enqueue(message).finally(() => rl.prompt())
  })
  // Safe to resume now — the 'line' listener right above is in place, so anything already
  // buffered on stdin (see the rl.pause() call up top) gets parsed and delivered, not dropped.
  rl.resume()

  return {
    dispatchLine: async (line: string) => {
      const message = line.trim()
      if (!message) return
      await enqueue(message)
    },
    close: () => rl.close(),
  }
}

async function main(): Promise<void> {
  await runCli()
}

function isEntryModule(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href
}

// Guarded so importing this module (e.g. from cli.test.ts, which drives runCli() directly
// instead) never starts a second live REPL against the real process.stdin/stdout and the real
// ~/.buildaharness/personal-assistant data directory.
if (isEntryModule()) void main()
