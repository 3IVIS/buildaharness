#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LLMClient, FileSystemAdapter, FileSystemExperienceStore } from '@buildaharness/runtime'
import { PersonalAssistant } from './assistant.js'
import { createNodeFsBackend } from './node-fs-backend.js'

const proxyUrl = process.env.ASSISTANT_PROXY_URL ?? 'http://localhost:8787'
const authToken = process.env.ASSISTANT_PROXY_TOKEN ?? ''
const model = process.env.ASSISTANT_MODEL
const dataDir = join(homedir(), '.buildaharness', 'personal-assistant')

async function main(): Promise<void> {
  // create() only supplies a default for storage the caller didn't already pass
  // in (and falls back to in-memory outside a browser) — passing these explicit,
  // filesystem-backed stores is what gives the CLI real persistence across runs.
  // See plans/tauri_desktop_plan.html Phase 3.
  const backend = createNodeFsBackend()
  const assistant = await PersonalAssistant.create({
    llmClient: new LLMClient({ proxyUrl, authToken }),
    model,
    memory: new FileSystemAdapter({ backend, baseDir: dataDir, namespace: 'transcripts' }),
    experienceStore: await FileSystemExperienceStore.create({ backend, baseDir: dataDir, namespace: 'experience' }),
    checkpointStore: new FileSystemAdapter({ backend, baseDir: dataDir, namespace: 'checkpoints' }),
  })

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' })

  console.log('Personal assistant — 11-layer harness, one turn at a time. Ctrl+C to exit.\n')
  rl.prompt()

  async function handleTurn(message: string, approved = false): Promise<void> {
    try {
      const result = await assistant.turn(message, { sessionId: 'cli', approved })

      if (result.status === 'needs_approval') {
        console.log(`\n[needs approval — ${result.riskLevel}] ${result.reason}`)
        const confirmed = await askYesNo('Proceed? (y/N) ')
        if (confirmed) await handleTurn(message, true)
        else console.log('Cancelled.\n')
        return
      }

      if (result.status === 'escalated') {
        console.log(`\n[escalated] ${result.reason}\n`)
        return
      }

      console.log(`\nassistant> ${result.reply}\n`)
    } catch (err) {
      // Mirrors chat-ui's error bubble: a failed turn (e.g. proxy down) shouldn't
      // crash the REPL via an unhandled rejection — just report it and keep going.
      console.log(`\n[error] ${err instanceof Error ? err.message : 'Something went wrong.'}\n`)
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

    void handleTurn(message).finally(() => rl.prompt())
  })
}

void main()
