import { describe, it, expect } from 'vitest'
import { ControlState } from '@buildaharness/harness'
import { InMemoryAdapter, InMemoryReminderStore } from '@buildaharness/runtime'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { AgentLoop, OneLoopPause } from './agent-loop.js'
import type { FileToolsContext } from './file-tools.js'
import type { FsBackend } from '@buildaharness/runtime'

/**
 * R2 of plans/harness_d2_one_loop_rewire_plan.html: unit tests for
 * AgentLoop.createHarnessProposer — the toolExecutors['default'] entry HarnessBridge.run() swaps
 * in when the one-loop flag is enabled. These call the returned proposer directly (the shape
 * driveMainLoop itself calls it, once per main-loop iteration) rather than going through a full
 * HarnessRuntime run, so the translation into ContinuableExecutionOutcome/OneLoopPause is tested
 * in isolation from the rest of the harness.
 */
class ScriptedLLMClient implements ILLMClient {
  private i = 0
  constructor(private readonly responses: LLMStructuredResponse[]) {}

  async *callChat(): AsyncIterable<string> {
    yield ''
  }

  async callChatSync(): Promise<string> {
    return ''
  }

  async callChatStructured(_messages: ChatMessage[], _tools?: ToolDefinition[], _options: ChatOptions = {}): Promise<LLMStructuredResponse> {
    if (this.i >= this.responses.length) throw new Error('ScriptedLLMClient: no more scripted responses')
    return this.responses[this.i++]
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
    async readDir(dir) {
      const prefix = `${dir}/`
      const names: string[] = []
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) names.push(key.slice(prefix.length))
      }
      return names
    },
  }
}

const fakeFileTools: FileToolsContext = { backend: makeFakeBackend(), workspaceRoot: '/workspace' }

function buildAgentLoop(llmClient: ILLMClient): AgentLoop {
  const memory = new InMemoryAdapter()
  const reminderStore = new InMemoryReminderStore(memory)
  return new AgentLoop(memory, llmClient, () => undefined, fakeFileTools, undefined, undefined, undefined, reminderStore, 5, undefined, undefined)
}

describe('AgentLoop.createHarnessProposer (R2 of the D2 one-loop-rewire follow-up plan)', () => {
  it('a plain final answer resolves to a complete ContinuableExecutionOutcome with the real text as output', async () => {
    const llmClient = new ScriptedLLMClient([{ content: 'the final answer' }])
    const agentLoop = buildAgentLoop(llmClient)
    const sources: never[] = []
    const proposer = agentLoop.createHarnessProposer({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      sessionId: 'session-1',
      userMessage: 'hi',
      maxIterations: 5,
      sources,
    })

    const outcome = await proposer({ worldModel: undefined as never, evidenceStore: undefined as never })
    expect(outcome).toEqual({ __harnessExecutionStatus: 'complete', output: 'the final answer' })
  })

  it('a write_file tool call throws a OneLoopPause carrying the needs_approval result, not a tool failure', async () => {
    const llmClient = new ScriptedLLMClient([
      { content: '', toolCalls: [{ id: 'toolu_1', name: 'write_file', input: { path: 'notes.txt', content: 'hello' } }] },
    ])
    const agentLoop = buildAgentLoop(llmClient)
    const proposer = agentLoop.createHarnessProposer({
      messages: [{ role: 'user', content: 'write notes.txt' }],
      tools: [],
      sessionId: 'session-1',
      userMessage: 'write notes.txt',
      maxIterations: 5,
      sources: [],
    })

    let caught: unknown
    try {
      await proposer({ worldModel: undefined as never, evidenceStore: undefined as never })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(OneLoopPause)
    const pause = caught as OneLoopPause
    expect(pause.result.kind).toBe('needs_approval')
    expect(pause.result).toMatchObject({ kind: 'needs_approval', pendingActionKind: 'write' })
  })

  it('a HUMAN_REQUIRED escalation from the live harness ControlState throws a OneLoopPause with an escalated result, not a thrown plain Error', async () => {
    const llmClient = new ScriptedLLMClient([
      { content: '', toolCalls: [{ id: 'toolu_1', name: 'read_file', input: { path: 'notes.txt' } }] },
    ])
    const agentLoop = buildAgentLoop(llmClient)
    const proposer = agentLoop.createHarnessProposer({
      messages: [{ role: 'user', content: 'read notes.txt' }],
      tools: [],
      sessionId: 'session-1',
      userMessage: 'read notes.txt',
      maxIterations: 5,
      sources: [],
    })
    const escalatedControlState = new ControlState({ escalation: 'HUMAN_REQUIRED' })

    let caught: unknown
    try {
      await proposer({ worldModel: undefined as never, evidenceStore: undefined as never, controlState: escalatedControlState })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(OneLoopPause)
    expect((caught as OneLoopPause).result.kind).toBe('escalated')
  })

  it('dispatches a real read-only tool call with a live harness ControlState present without crashing recordToolOutcome', async () => {
    // Regression: R2's proposer wrapped toolCtx.controlState in a synthetic
    // `{ controlState } as TurnControlPlaneState`, which has no evidenceStore — so the moment
    // runToolIterationStep dispatched any non-staged tool call and reached recordToolOutcome
    // (which dereferences state.evidenceStore), it threw `Cannot read properties of undefined`.
    // The proposer now holds a real createControlPlaneState() object for the whole turn.
    const llmClient = new ScriptedLLMClient([
      { content: '', toolCalls: [{ id: 'toolu_1', name: 'read_file', input: { path: 'missing.txt' } }] },
      { content: 'here is the answer' },
    ])
    const agentLoop = buildAgentLoop(llmClient)
    const proposer = agentLoop.createHarnessProposer({
      messages: [{ role: 'user', content: 'read missing.txt' }],
      tools: [],
      sessionId: 'session-1',
      userMessage: 'read missing.txt',
      maxIterations: 5,
      sources: [],
    })
    // worldModel/evidenceStore left undefined on purpose — the proposer must not read them off
    // toolCtx; it uses its own createControlPlaneState() stores for recordToolOutcome.
    const toolCtx = { worldModel: undefined as never, evidenceStore: undefined as never, controlState: new ControlState() }

    const first = await proposer(toolCtx)
    expect(first).toEqual({ __harnessExecutionStatus: 'continue' })

    const second = await proposer(toolCtx)
    expect(second).toEqual({ __harnessExecutionStatus: 'complete', output: 'here is the answer' })
  })

  it('never dispatches more than maxIterations calls — the final one throws an escalated OneLoopPause instead of hanging', async () => {
    const llmClient = new ScriptedLLMClient([
      { content: '<tool_call>' },
      { content: '<tool_call>' },
    ])
    const agentLoop = buildAgentLoop(llmClient)
    const proposer = agentLoop.createHarnessProposer({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      sessionId: 'session-1',
      userMessage: 'hi',
      maxIterations: 2,
      sources: [],
    })

    const first = await proposer({ worldModel: undefined as never, evidenceStore: undefined as never })
    expect(first).toEqual({ __harnessExecutionStatus: 'continue' })

    let caught: unknown
    try {
      await proposer({ worldModel: undefined as never, evidenceStore: undefined as never })
      await proposer({ worldModel: undefined as never, evidenceStore: undefined as never })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(OneLoopPause)
    expect((caught as OneLoopPause).result.kind).toBe('escalated')
  })
})
