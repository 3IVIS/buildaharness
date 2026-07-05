#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LLMClient, FileSystemAdapter, FileSystemExperienceStore, type ILLMClient } from '@buildaharness/runtime'
import { PersonalAssistant, type AssistantProgress, type AssistantTrace } from './assistant.js'
import { nodeDisplayName } from './node-display-names.js'
import { classifyError } from './error-classifier.js'
import { createNodeFsBackend } from './node-fs-backend.js'
import { ClaudeCliLLMClient } from './claude-cli-llm-client.js'

const proxyUrl = process.env.ASSISTANT_PROXY_URL ?? 'http://localhost:8787'
const authToken = process.env.ASSISTANT_PROXY_TOKEN ?? ''
const model = process.env.ASSISTANT_MODEL
const dataDir = join(homedir(), '.buildaharness', 'personal-assistant')

// Sandbox root for the read_file/list_directory/write_file tools — mirrors how
// `claude` itself defaults to the launch directory. Everything outside this
// directory is off-limits to those tools, regardless of backend.
const workspaceRoot = process.env.ASSISTANT_WORKSPACE_DIR ?? process.cwd()

// ASSISTANT_LLM_BACKEND=claude-cli routes turns through a local `claude -p` subprocess
// (your already-authenticated Claude Code CLI session) instead of the proxy + API key.
const llmClient: ILLMClient =
  process.env.ASSISTANT_LLM_BACKEND === 'claude-cli'
    ? new ClaudeCliLLMClient({ fileTools: { workspaceRoot } })
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
    fileTools: { backend, workspaceRoot },
  })

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' })

  console.log('Personal assistant — 11-layer harness, one turn at a time. Ctrl+C to exit.\n')
  rl.prompt()

  let lastTrace: AssistantTrace | undefined

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

  async function handleTurn(message: string, approved = false, pendingWriteId?: string): Promise<void> {
    try {
      const result = await assistant.turn(message, { sessionId: 'cli', approved, pendingWriteId, onProgress: writeProgress })
      clearProgress()

      // A write_file tool call, gated at the point of the call itself rather than
      // by the message text — see the file-tools plan's Diagnosis tab. Unlike the
      // message-level gate below, both a yes and a no need to re-call turn() (to
      // apply or discard the staged write), not just a yes.
      if (result.status === 'needs_approval' && result.pendingWriteId) {
        console.log(`\n[needs approval — write] ${result.reason}`)
        const confirmed = await askYesNo('Apply this write? (y/N) ')
        await handleTurn(message, confirmed, result.pendingWriteId)
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
      const riskSuffix = result.riskLevel && result.riskLevel !== 'LOW' ? ` [risk: ${result.riskLevel}]` : ''
      console.log(`\nassistant>${riskSuffix} ${result.reply}\n`)
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

    void handleTurn(message).finally(() => rl.prompt())
  })
}

void main()
