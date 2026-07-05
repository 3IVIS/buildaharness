#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { LLMClient } from '@buildaharness/runtime'
import { PersonalAssistant } from './assistant.js'

const proxyUrl = process.env.ASSISTANT_PROXY_URL ?? 'http://localhost:8787'
const authToken = process.env.ASSISTANT_PROXY_TOKEN ?? ''
const model = process.env.ASSISTANT_MODEL

async function main(): Promise<void> {
  // create() defaults to IndexedDB/Dexie-backed storage in a browser; in Node
  // (here) there's no indexedDB, so it falls back to the same in-memory
  // defaults `new PersonalAssistant(...)` would use.
  const assistant = await PersonalAssistant.create({
    llmClient: new LLMClient({ proxyUrl, authToken }),
    model,
  })

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' })

  console.log('Personal assistant — 11-layer harness, one turn at a time. Ctrl+C to exit.\n')
  rl.prompt()

  async function handleTurn(message: string, approved = false): Promise<void> {
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
