import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, ToolDefinition, LLMStructuredResponse } from '@buildaharness/runtime'
import { InMemoryAdapter } from '@buildaharness/runtime'
import { HarnessRuntime, saveHarnessCheckpoint, loadHarnessCheckpoint, type Task } from '@buildaharness/harness'
import { PersonalAssistant } from './assistant.js'

class FakeLLMClient implements ILLMClient {
  calls = 0
  receivedMessages: ChatMessage[][] = []
  constructor(private readonly reply: string = 'Here you go.') {}

  async *callChat(): AsyncIterable<string> {
    this.calls++
    yield this.reply
  }

  async callChatSync(messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    this.calls++
    this.receivedMessages.push(messages)
    return this.reply
  }

  async callChatStructured(_messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMStructuredResponse> {
    this.calls++
    return { content: this.reply }
  }
}

describe('PersonalAssistant', () => {
  it('answers a plain chat turn with a single LLM call', async () => {
    const llm = new FakeLLMClient('The forecast looks mild.')
    const assistant = new PersonalAssistant({ llmClient: llm })

    const result = await assistant.turn('What is the weather usually like in autumn?')

    expect(result.status).toBe('ok')
    expect(result.reply).toBe('The forecast looks mild.')
    expect(result.riskLevel).toBe('LOW')
    expect(llm.calls).toBe(1)
  })

  it('gates a consequential action behind approval without calling the LLM', async () => {
    const llm = new FakeLLMClient()
    const assistant = new PersonalAssistant({ llmClient: llm })

    const result = await assistant.turn('Please send an email to my boss telling him I quit.')

    expect(result.status).toBe('needs_approval')
    expect(result.riskLevel).toBe('HIGH')
    expect(result.reason).toMatch(/sends a message/)
    expect(llm.calls).toBe(0)
  })

  it('proceeds once the gated action is explicitly approved', async () => {
    const llm = new FakeLLMClient('Draft sent.')
    const assistant = new PersonalAssistant({ llmClient: llm })

    const message = 'Please send an email to my boss telling him I quit.'
    await assistant.turn(message)
    const approved = await assistant.turn(message, { approved: true })

    expect(approved.status).toBe('ok')
    expect(approved.reply).toBe('Draft sent.')
    expect(llm.calls).toBe(1)
  })

  it('persists conversation history across turns in the same session', async () => {
    const llm = new FakeLLMClient('Got it.')
    const assistant = new PersonalAssistant({ llmClient: llm })

    await assistant.turn('My name is Ali.', { sessionId: 'sess-1' })
    await assistant.turn('What is my name?', { sessionId: 'sess-1' })

    // second turn's transcript passed to the LLM must include the first exchange
    expect(llm.receivedMessages).toHaveLength(2)
    expect(llm.receivedMessages[1].some(m => m.content.includes('My name is Ali.'))).toBe(true)
  })

  it('cleans up its harness checkpoint once a turn completes normally', async () => {
    const llm = new FakeLLMClient('All done.')
    const checkpointStore = new InMemoryAdapter({ scope: 'thread', namespace: 'test-checkpoints' })
    const assistant = new PersonalAssistant({ llmClient: llm, checkpointStore })

    const result = await assistant.turn('What time is it in Tokyo?', { sessionId: 'cleanup-test' })

    expect(result.status).toBe('ok')
    expect(await loadHarnessCheckpoint(checkpointStore, 'turn:cleanup-test')).toBeUndefined()
  })

  it('resumes an interrupted turn from a leftover checkpoint instead of starting over', async () => {
    const checkpointStore = new InMemoryAdapter({ scope: 'thread', namespace: 'test-checkpoints' })
    const sessionId = 'crash-recovery'
    const runId = `turn:${sessionId}`

    // Simulate a prior process crashing mid-turn: a real harness run got paused
    // (standing in for "the tab closed before this run finished") and its
    // checkpoint was the last thing written before the crash.
    const staleTask: Task = {
      id: 'respond',
      description: 'leftover objective',
      status: 'PENDING',
      risk_level: 'LOW',
      depends_on: [],
      parallel_write_domains: [],
      abstraction_level: 0,
      assigned_strategy: null,
    }
    const rt = new HarnessRuntime()
    const paused = await rt.run('leftover objective', ['done'], {
      initialTasks: [staleTask],
      max_steps: 5,
      toolExecutors: { default: () => 'stale draft from the interrupted run' },
      runId,
      shouldPause: () => true,
    })
    expect(paused.status).toBe('paused')
    if (paused.status !== 'paused') throw new Error('unreachable')
    const stepsUsedAtPause = paused.checkpoint.progress.stepsUsed
    await saveHarnessCheckpoint(checkpointStore, paused.checkpoint)

    const llm = new FakeLLMClient('A brand new reply.')
    const assistant = new PersonalAssistant({ llmClient: llm, checkpointStore })
    const result = await assistant.turn('Please continue.', { sessionId })

    expect(result.status).toBe('ok')
    // A fresh run always starts at stepsUsed 1 on its first iteration — finishing
    // higher than the paused checkpoint's stepsUsed proves the loop actually
    // continued from that checkpoint instead of re-initializing from scratch.
    expect(result.stepsUsed).toBeGreaterThan(stepsUsedAtPause)
    expect(await loadHarnessCheckpoint(checkpointStore, runId)).toBeUndefined()
  })
})
