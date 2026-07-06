#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LLMClient, FileSystemAdapter, FileSystemExperienceStore, InMemoryReminderStore, type ILLMClient } from '@buildaharness/runtime'
import { PersonalAssistant, type AssistantProgress, type AssistantTrace, type AssistantSource } from './assistant.js'
import type { AssistantToolStep } from './tool-step.js'
import { nodeDisplayName } from './node-display-names.js'
import { classifyError } from './error-classifier.js'
import { createNodeFsBackend } from './node-fs-backend.js'
import { ClaudeCliLLMClient } from './claude-cli-llm-client.js'
import { runApprovedShellCommand } from './shell-executor.js'
import { duckDuckGoSearch } from './web-search-provider.js'

const proxyUrl = process.env.ASSISTANT_PROXY_URL ?? 'http://localhost:8787'
const authToken = process.env.ASSISTANT_PROXY_TOKEN ?? ''
const model = process.env.ASSISTANT_MODEL
const dataDir = join(homedir(), '.buildaharness', 'personal-assistant')

// Sandbox root for the read_file/list_directory/write_file/run_shell_command tools —
// mirrors how `claude` itself defaults to the launch directory. Everything outside
// this directory is off-limits to those tools, regardless of backend.
const workspaceRoot = process.env.ASSISTANT_WORKSPACE_DIR ?? process.cwd()

// Must match the exact path a FileSystemAdapter({ baseDir: dataDir, namespace:
// 'reminders' }) uses for the key "reminders" — see file-tools-mcp-server.mjs's
// doc comment — so the claude-cli backend's MCP subprocess and this process's
// own reminderStore (below) read/write the same file instead of two disconnected
// reminder lists. FileSystemAdapter's path formula is `${baseDir}/${namespace}/${sanitize(key)}.json`,
// and "reminders" sanitizes to itself (no special characters).
const remindersFile = join(dataDir, 'reminders', 'reminders.json')

// Both capabilities are opt-in and off by default — absent, turn() behaves exactly as
// before these options existed. ASSISTANT_ENABLE_SHELL must be exactly "1" (not just
// truthy) — a copy-pasted ASSISTANT_ENABLE_SHELL=0 left in an env file must not silently
// enable the highest-risk tool this assistant has.
const enableWeb = process.env.ASSISTANT_ENABLE_WEB === '1'
const enableShell = process.env.ASSISTANT_ENABLE_SHELL === '1'
const shellTimeoutMs = process.env.ASSISTANT_SHELL_TIMEOUT_MS ? Number(process.env.ASSISTANT_SHELL_TIMEOUT_MS) : undefined

// ASSISTANT_LLM_BACKEND=claude-cli routes turns through a local `claude -p` subprocess
// (your already-authenticated Claude Code CLI session) instead of the proxy + API key.
// Note: unlike the proxy backend, this backend has no web_search/fetch_url wiring for
// ASSISTANT_ENABLE_WEB yet — web_search has no default backend on this path either (see
// claude-cli-llm-client.ts's doc comment), so ASSISTANT_ENABLE_WEB only takes effect on
// the proxy (LLMClient) backend below.
const llmClient: ILLMClient =
  process.env.ASSISTANT_LLM_BACKEND === 'claude-cli'
    ? new ClaudeCliLLMClient({ fileTools: { workspaceRoot }, remindersFile, shellTools: enableShell ? { workspaceRoot } : undefined })
    : new LLMClient({ proxyUrl, authToken })

async function main(): Promise<void> {
  // create() only supplies a default for storage the caller didn't already pass
  // in (and falls back to in-memory outside a browser) — passing these explicit,
  // filesystem-backed stores is what gives the CLI real persistence across runs.
  // See plans/tauri_desktop_plan.html Phase 3.
  const backend = createNodeFsBackend()
  const assistant = await PersonalAssistant.create({
    llmClient,
    model,
    memory: new FileSystemAdapter({ backend, baseDir: dataDir, namespace: 'transcripts' }),
    experienceStore: await FileSystemExperienceStore.create({ backend, baseDir: dataDir, namespace: 'experience' }),
    checkpointStore: new FileSystemAdapter({ backend, baseDir: dataDir, namespace: 'checkpoints' }),
    reminderStore: new InMemoryReminderStore(new FileSystemAdapter({ backend, baseDir: dataDir, namespace: 'reminders' })),
    fileTools: { backend, workspaceRoot },
    webTools: enableWeb ? { search: (query) => duckDuckGoSearch(query) } : undefined,
    // executeCommand is the real child_process.spawn-based implementation (shell-executor.ts) —
    // wired in here, not inside assistant.ts, so the browser build never needs node:child_process.
    shellTools: enableShell ? { backend, workspaceRoot, timeoutMs: shellTimeoutMs, executeCommand: runApprovedShellCommand } : undefined,
  })

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' })

  // No silent default: capabilities only appear in the banner when actually configured,
  // so the banner never implies something is available that isn't.
  const enabledCapabilities: string[] = []
  if (enableWeb) enabledCapabilities.push('web search/fetch')
  if (enableShell) enabledCapabilities.push('shell commands (approval-gated)')
  const capabilitySuffix = enabledCapabilities.length > 0 ? ` — enabled: ${enabledCapabilities.join(', ')}` : ''

  console.log(`Personal assistant — 11-layer harness, one turn at a time. Ctrl+C to exit.${capabilitySuffix}\n`)
  rl.prompt()

  let lastTrace: AssistantTrace | undefined
  let lastSources: AssistantSource[] | undefined

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
      const riskSuffix = result.riskLevel && result.riskLevel !== 'LOW' ? ` [risk: ${result.riskLevel}]` : ''
      const sourcesHint = result.sources && result.sources.length > 0 ? ` (${result.sources.length} source${result.sources.length > 1 ? 's' : ''} — /sources)` : ''
      if (streamedAnyTokens) {
        // The reply text is already on screen, printed token-by-token as it
        // streamed in — just append whatever suffix belongs after it.
        process.stdout.write(`${riskSuffix}${sourcesHint}\n\n`)
      } else {
        console.log(`\nassistant>${riskSuffix} ${result.reply}${sourcesHint}\n`)
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

  rl.on('line', (line) => {
    const message = line.trim()
    if (!message) { rl.prompt(); return }
    if (message === '/why') { printWhy(); rl.prompt(); return }
    if (message === '/sources') { printSources(); rl.prompt(); return }

    void handleTurn(message).finally(() => rl.prompt())
  })
}

void main()
