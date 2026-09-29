import { describe, it, expect } from 'vitest'
import { ControlState, EvidenceStore } from '@buildaharness/harness'
import { InMemoryAdapter, InMemoryReminderStore } from '@buildaharness/runtime'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { AgentLoop, OneLoopPause } from './agent-loop.js'
import { REVIEW_NOTE_PREFIX } from './review-checker.js'
import { RECOVERY_NOTE_PREFIX } from './recovery-note.js'
import type { FileToolsContext } from './file-tools.js'
import type { FsBackend } from '@buildaharness/runtime'

/**
 * R2 of the internal plan: unit tests for
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

  readonly seenMessages: ChatMessage[][] = []

  async callChatStructured(messages: ChatMessage[], _tools?: ToolDefinition[], _options: ChatOptions = {}): Promise<LLMStructuredResponse> {
    this.seenMessages.push(messages.map((m) => ({ ...m })))
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

function buildAgentLoopWithMaxSteps(llmClient: ILLMClient, maxSteps: number): AgentLoop {
  const memory = new InMemoryAdapter()
  const reminderStore = new InMemoryReminderStore(memory)
  return new AgentLoop(memory, llmClient, () => undefined, fakeFileTools, undefined, undefined, undefined, reminderStore, maxSteps, undefined, undefined)
}

describe('AgentLoop.createOneLoopProposer — per-attempt budget (RECOVERY_HEADROOM)', () => {
  it('reserves a fixed headroom under maxSteps rather than a fraction — maxSteps=15 gives an 11-call budget, not half (8)', async () => {
    const responses = Array.from({ length: 12 }, () => ({ content: '<tool_call>' }))
    const llmClient = new ScriptedLLMClient(responses)
    const agentLoop = buildAgentLoopWithMaxSteps(llmClient, 15)
    const { proposer } = agentLoop.createOneLoopProposer('session-1', [], 'hi', 'system')

    const outcomes: unknown[] = []
    for (let i = 0; i < 12; i++) {
      outcomes.push(await proposer({ worldModel: undefined as never, evidenceStore: undefined as never }))
    }
    // Calls 1-11 (indices 0-10) dispatch a real tool call each — 'continue'. Call 12 (index 11)
    // is the 11th real LLM call already made by then; the 12th invocation is where iteration
    // (now 11) >= maxIterations (11) trips, reporting 'failed' instead of making a 12th call.
    expect(outcomes.slice(0, 11)).toEqual(Array(11).fill({ __harnessExecutionStatus: 'continue' }))
    expect(outcomes[11]).toMatchObject({ __harnessExecutionStatus: 'failed' })
    expect(llmClient.seenMessages).toHaveLength(11) // the 12th invocation made no LLM call
  })

  it('floors at 3 for a very small maxSteps (maxSteps=4 would go negative under maxSteps-4)', async () => {
    const llmClient = new ScriptedLLMClient([{ content: '<tool_call>' }, { content: '<tool_call>' }, { content: '<tool_call>' }])
    const agentLoop = buildAgentLoopWithMaxSteps(llmClient, 4)
    const { proposer } = agentLoop.createOneLoopProposer('session-1', [], 'hi', 'system')

    await proposer({ worldModel: undefined as never, evidenceStore: undefined as never })
    await proposer({ worldModel: undefined as never, evidenceStore: undefined as never })
    await proposer({ worldModel: undefined as never, evidenceStore: undefined as never })
    const exhausted = await proposer({ worldModel: undefined as never, evidenceStore: undefined as never })
    expect(exhausted).toMatchObject({ __harnessExecutionStatus: 'failed' })
  })
})

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

  it('splices fresh supervisor_investigation observations into the message context (S8 GATHER_EVIDENCE)', async () => {
    const llmClient = new ScriptedLLMClient([{ content: 'the answer is debug' }])
    const agentLoop = buildAgentLoop(llmClient)
    const proposer = agentLoop.createHarnessProposer({
      messages: [{ role: 'user', content: 'what is the effective LOG_LEVEL?' }],
      tools: [],
      sessionId: 'session-1',
      userMessage: 'what is the effective LOG_LEVEL?',
      maxIterations: 5,
      sources: [],
    })
    const worldModel = {
      observations: [
        { id: 'obs-1', source: 'supervisor_investigation', content: 'config.local.env:\nLOG_LEVEL=debug', recorded_at: 'now' },
        { id: 'obs-2', source: 'execution_engine', content: 'unrelated', recorded_at: 'now' },
      ],
    }

    await proposer({ worldModel: worldModel as never, evidenceStore: undefined as never })

    const spliced = llmClient.seenMessages[0].find((m) => m.content.includes('investigation findings'))
    expect(spliced).toBeDefined()
    expect(spliced!.role).toBe('user')
    expect(spliced!.content).toContain('LOG_LEVEL=debug')
    expect(spliced!.content).not.toContain('unrelated')
  })

  it('splices mid-turn steering notes in as a user turn before the LLM call, so the model — not a lexical rule — applies them', async () => {
    const llmClient = new ScriptedLLMClient([{ content: 'the audited figure is 3.9M' }])
    const agentLoop = buildAgentLoop(llmClient)
    const notes = [['use the audited figure, not the draft one']]
    const proposer = agentLoop.createHarnessProposer({
      messages: [{ role: 'user', content: 'what is the Q3 revenue?' }],
      tools: [],
      sessionId: 'session-1',
      userMessage: 'what is the Q3 revenue?',
      maxIterations: 5,
      sources: [],
      takeSteeringNotes: () => notes.shift() ?? [],
    })

    await proposer({ worldModel: undefined as never, evidenceStore: undefined as never })

    const spliced = llmClient.seenMessages[0].find((m) => m.content.includes('while you were working'))
    expect(spliced?.role).toBe('user')
    expect(spliced?.content).toContain('- use the audited figure, not the draft one')
  })

  it('splices a change-review note under its own header — never as something the user said', async () => {
    const llmClient = new ScriptedLLMClient([{ content: 'ok' }])
    const agentLoop = buildAgentLoop(llmClient)
    const notes = [[`${REVIEW_NOTE_PREFIX}a three-year agreement exceeds the twelve-month cap`]]
    const proposer = agentLoop.createHarnessProposer({
      messages: [{ role: 'user', content: 'build the catering plan' }],
      tools: [],
      sessionId: 'session-1',
      userMessage: 'build the catering plan',
      maxIterations: 5,
      sources: [],
      takeSteeringNotes: () => notes.shift() ?? [],
    })

    await proposer({ worldModel: undefined as never, evidenceStore: undefined as never })

    const sent = llmClient.seenMessages[0]
    const review = sent.find((m) => m.content.includes('a pre-check found'))
    expect(review?.role).toBe('user')
    expect(review?.content).toContain('- a three-year agreement exceeds the twelve-month cap')
    expect(review?.content).not.toContain(REVIEW_NOTE_PREFIX)
    expect(sent.some((m) => m.content.includes('the user sent the following'))).toBe(false)
  })

  it('splices a recovery note under its own header, distinct from a review note in the same batch', async () => {
    const llmClient = new ScriptedLLMClient([{ content: 'ok' }])
    const agentLoop = buildAgentLoop(llmClient)
    const notes = [[
      `${RECOVERY_NOTE_PREFIX}That failed with a recognized pattern (TOOL_UNAVAILABLE_CASCADE) — try a genuinely different approach rather than repeating the same call.`,
      `${REVIEW_NOTE_PREFIX}a three-year agreement exceeds the twelve-month cap`,
    ]]
    const proposer = agentLoop.createHarnessProposer({
      messages: [{ role: 'user', content: 'read the config again' }],
      tools: [],
      sessionId: 'session-1',
      userMessage: 'read the config again',
      maxIterations: 5,
      sources: [],
      takeSteeringNotes: () => notes.shift() ?? [],
    })

    await proposer({ worldModel: undefined as never, evidenceStore: undefined as never })

    const sent = llmClient.seenMessages[0]
    const recovery = sent.find((m) => m.content.includes('the previous attempt just failed'))
    const review = sent.find((m) => m.content.includes('a pre-check found'))
    expect(recovery?.content).toContain('- That failed with a recognized pattern (TOOL_UNAVAILABLE_CASCADE)')
    expect(recovery?.content).not.toContain(RECOVERY_NOTE_PREFIX)
    expect(review?.content).toContain('- a three-year agreement exceeds the twelve-month cap')
    expect(sent.some((m) => m.content.includes('the user sent the following'))).toBe(false)
  })

  it('adds nothing when there are no steering notes (flag-off stays byte-identical, INV-43)', async () => {
    const llmClient = new ScriptedLLMClient([{ content: 'ok' }])
    const agentLoop = buildAgentLoop(llmClient)
    const proposer = agentLoop.createHarnessProposer({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      sessionId: 'session-1',
      userMessage: 'hi',
      maxIterations: 5,
      sources: [],
      takeSteeringNotes: () => [],
    })

    await proposer({ worldModel: undefined as never, evidenceStore: undefined as never })

    expect(llmClient.seenMessages[0]).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('only splices each investigation observation once, across iterations', async () => {
    const llmClient = new ScriptedLLMClient([{ content: '<tool_call>' }, { content: 'done' }])
    const agentLoop = buildAgentLoop(llmClient)
    const proposer = agentLoop.createHarnessProposer({
      messages: [{ role: 'user', content: 'q' }],
      tools: [],
      sessionId: 'session-1',
      userMessage: 'q',
      maxIterations: 5,
      sources: [],
    })
    const worldModel = { observations: [{ id: 'obs-1', source: 'supervisor_investigation', content: 'finding', recorded_at: 'now' }] }
    const toolCtx = { worldModel: worldModel as never, evidenceStore: undefined as never }

    await proposer(toolCtx)
    await proposer(toolCtx)

    // The message array is cumulative across iterations — assert the second call did not
    // splice the same finding a second time (its snapshot still carries exactly one).
    const lastSnapshot = llmClient.seenMessages[llmClient.seenMessages.length - 1]
    const splicedInLast = lastSnapshot.filter((m) => m.content.includes('investigation findings')).length
    expect(splicedInLast).toBe(1)
  })

  it('never dispatches more than maxIterations calls — the budget-exhausted call reports a real harness failure instead of hanging or throwing', async () => {
    // Changed from throwing an escalated OneLoopPause: that throw was special-cased in
    // execute.ts (isHarnessPauseSignal) to bypass recordFailure()/rollbackAndReplan() entirely,
    // leaving failure_match's whole classification+bias+retry-hint chain structurally
    // unreachable from a real turn (see the layer_conversations audit). Budget exhaustion is a
    // genuine failure, not a pause/approval, so it's now a normal 'failed' execution status —
    // needs_approval (the other OneLoopPause use) is unaffected.
    const llmClient = new ScriptedLLMClient([
      { content: '<tool_call>' },
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
    await proposer({ worldModel: undefined as never, evidenceStore: undefined as never })

    const exhausted = await proposer({ worldModel: undefined as never, evidenceStore: undefined as never })
    expect(exhausted).toMatchObject({
      __harnessExecutionStatus: 'failed',
      error: 'Tool loop exceeded 2 iterations without producing a final answer.',
    })

    // The counter resets on exhaustion (see agent-loop.ts's doc comment) — a requeued retry
    // gets a fresh per-attempt budget rather than immediately re-tripping the same check.
    const afterReset = await proposer({ worldModel: undefined as never, evidenceStore: undefined as never })
    expect(afterReset).toEqual({ __harnessExecutionStatus: 'continue' })
  })
})

describe('AgentLoop.createOneLoopProposer — plan steps (stepInstruction)', () => {
  const ctx = (currentTaskId: string) => ({ worldModel: undefined as never, evidenceStore: undefined as never, currentTaskId })
  const instructionFor = (steps: Record<string, string>) => (taskId: string) => (steps[taskId] ? `DO STEP: ${steps[taskId]}` : undefined)

  it('tells the model which step it is on, and each later step continues from the earlier steps\' answers', async () => {
    const llm = new ScriptedLLMClient([{ content: 'scope: MVP for existing customers' }, { content: 'schedule: ship 15 Nov' }])
    const { proposer } = buildAgentLoop(llm).createOneLoopProposer(
      'session-1', [], 'Approved — run the plan.', 'system', undefined, undefined, undefined, 'LOW', undefined,
      instructionFor({ t1: 'Define scope', t2: 'Build the schedule' }),
    )

    expect(await proposer(ctx('t1'))).toEqual({ __harnessExecutionStatus: 'complete', output: 'scope: MVP for existing customers' })
    expect(await proposer(ctx('t2'))).toEqual({ __harnessExecutionStatus: 'complete', output: 'schedule: ship 15 Nov' })

    const first = llm.seenMessages[0].map((m) => `${m.role}: ${m.content}`)
    expect(first).toEqual(['system: system', 'user: Approved — run the plan.', 'user: DO STEP: Define scope'])
    // Step 2 sees the user's message, step 1's instruction AND its answer, then its own instruction.
    const second = llm.seenMessages[1].map((m) => `${m.role}: ${m.content}`)
    expect(second).toEqual([
      'system: system',
      'user: Approved — run the plan.',
      'user: DO STEP: Define scope',
      'assistant: scope: MVP for existing customers',
      'user: DO STEP: Build the schedule',
    ])
  })

  it('sends a step\'s instruction once, however many iterations the step takes', async () => {
    const llm = new ScriptedLLMClient([{ content: '<tool_call>' }, { content: 'done' }])
    const { proposer } = buildAgentLoop(llm).createOneLoopProposer('session-1', [], 'go', 'system', undefined, undefined, undefined, 'LOW', undefined, instructionFor({ t1: 'Define scope' }))

    await proposer(ctx('t1'))
    await proposer(ctx('t1'))

    const instructions = llm.seenMessages[1].filter((m) => m.role === 'user' && m.content.startsWith('DO STEP'))
    expect(instructions).toHaveLength(1)
  })

  it('a task with no instruction (an ordinary turn) sees exactly the messages it always did', async () => {
    const llm = new ScriptedLLMClient([{ content: 'answer' }])
    const { proposer } = buildAgentLoop(llm).createOneLoopProposer('session-1', [], 'hi', 'system', undefined, undefined, undefined, 'LOW', undefined, instructionFor({ t1: 'Define scope' }))

    await proposer(ctx('respond'))

    expect(llm.seenMessages[0].map((m) => `${m.role}: ${m.content}`)).toEqual(['system: system', 'user: hi'])
  })

  it('gives each step its own iteration budget, so a long plan does not run out partway through', async () => {
    // maxSteps 5 => a 3-call budget per attempt. Four steps of two calls each would exceed it if the
    // budget counted across the whole turn.
    const responses: LLMStructuredResponse[] = []
    for (let i = 0; i < 4; i++) responses.push({ content: '<tool_call>' }, { content: `step ${i + 1} done` })
    const llm = new ScriptedLLMClient(responses)
    const { proposer } = buildAgentLoop(llm).createOneLoopProposer(
      'session-1', [], 'go', 'system', undefined, undefined, undefined, 'LOW', undefined,
      instructionFor({ t1: 'a', t2: 'b', t3: 'c', t4: 'd' }),
    )

    for (const id of ['t1', 't2', 't3', 't4']) {
      await proposer(ctx(id))
      expect(await proposer(ctx(id))).toMatchObject({ __harnessExecutionStatus: 'complete' })
    }
  })
})

describe('AgentLoop.createOneLoopProposer — subtasks that share one answer (shareAnswer)', () => {
  const ctx = (currentTaskId?: string) => ({ worldModel: undefined as never, evidenceStore: undefined as never, ...(currentTaskId ? { currentTaskId } : {}) })
  const build = (llm: ILLMClient, share: (() => boolean) | undefined) =>
    buildAgentLoop(llm).createOneLoopProposer('session-1', [], 'Write up all of these.', 'system', undefined, undefined, undefined, 'LOW', undefined, undefined, share).proposer

  it('answers once and hands the same answer to every later subtask, without another model call', async () => {
    const llm = new ScriptedLLMClient([{ content: 'the one complete answer' }])
    const proposer = build(llm, () => true)

    for (const id of ['t1', 't2', 't3']) {
      expect(await proposer(ctx(id))).toEqual({ __harnessExecutionStatus: 'complete', output: 'the one complete answer' })
    }
    expect(llm.seenMessages).toHaveLength(1)
  })

  it('a task the harness runs again (a retry after a rejection) gets a fresh call, not the rejected answer', async () => {
    const llm = new ScriptedLLMClient([{ content: 'first answer' }, { content: 'second answer' }])
    const proposer = build(llm, () => true)

    await proposer(ctx('t1'))
    expect(await proposer(ctx('t2'))).toMatchObject({ output: 'first answer' })
    expect(await proposer(ctx('t2'))).toMatchObject({ output: 'second answer' })
    expect(llm.seenMessages).toHaveLength(2)
  })

  it('the answer is only shared once it is final — a tool-using first subtask finishes its own loop first', async () => {
    const llm = new ScriptedLLMClient([{ content: '<tool_call>' }, { content: 'final answer after a tool call' }])
    const proposer = build(llm, () => true)

    expect(await proposer(ctx('t1'))).toEqual({ __harnessExecutionStatus: 'continue' })
    expect(await proposer(ctx('t1'))).toMatchObject({ __harnessExecutionStatus: 'complete', output: 'final answer after a tool call' })
    expect(await proposer(ctx('t2'))).toMatchObject({ output: 'final answer after a tool call' })
    expect(llm.seenMessages).toHaveLength(2)
  })

  it('does nothing unless sharing is on for the turn, or when the task has no id', async () => {
    for (const [share, id] of [[undefined, 't1'], [() => false, 't1'], [() => true, undefined]] as const) {
      const llm = new ScriptedLLMClient([{ content: 'a' }, { content: 'b' }])
      const proposer = build(llm, share)
      await proposer(ctx(id))
      await proposer(ctx(id === undefined ? undefined : 't2'))
      expect(llm.seenMessages).toHaveLength(2)
    }
  })
})

describe('AgentLoop.createHarnessProposer — control_state tool-policy ablation (AUDIT_CONTROL_STATE_TOOL_POLICY, eval-only)', () => {
  // A harness ControlState that DENYs, folded into tool policy each iteration (agent-loop.ts's
  // moreRestrictiveControlState). With the ablation on that fold is skipped, so the read runs.
  async function readUnderHarnessDeny(pinned: boolean): Promise<string> {
    const prev = process.env.AUDIT_CONTROL_STATE_TOOL_POLICY
    if (pinned) process.env.AUDIT_CONTROL_STATE_TOOL_POLICY = '0'
    else delete process.env.AUDIT_CONTROL_STATE_TOOL_POLICY
    try {
      await fakeFileTools.backend.writeTextFile('/workspace/notes.txt', 'SECRET-FILE-BODY')
      const llmClient = new ScriptedLLMClient([
        { content: '', toolCalls: [{ id: 'toolu_1', name: 'read_file', input: { path: 'notes.txt' } }] },
        { content: 'done' },
      ])
      const proposer = buildAgentLoop(llmClient).createHarnessProposer({
        messages: [{ role: 'user', content: 'read notes.txt' }],
        tools: [],
        sessionId: 'session-1',
        userMessage: 'read notes.txt',
        maxIterations: 5,
        sources: [],
      })
      const deny = new ControlState({ permission: 'DENY', execution_mode: 'RECOVERY' })
      const toolCtx = { worldModel: undefined as never, evidenceStore: undefined as never, controlState: deny }
      await proposer(toolCtx)
      await proposer(toolCtx)
      return JSON.stringify(llmClient.seenMessages[1])
    } finally {
      if (prev === undefined) delete process.env.AUDIT_CONTROL_STATE_TOOL_POLICY
      else process.env.AUDIT_CONTROL_STATE_TOOL_POLICY = prev
    }
  }

  it('default: a harness DENY reaches tool policy — the model sees the denial, not the file', async () => {
    const seen = await readUnderHarnessDeny(false)
    expect(seen).toContain('harness control state denies action this turn')
    expect(seen).not.toContain('SECRET-FILE-BODY')
  })

  it('ablation on: the same harness DENY is ignored by tool policy — the read executes', async () => {
    const seen = await readUnderHarnessDeny(true)
    expect(seen).toContain('SECRET-FILE-BODY')
    expect(seen).not.toContain('harness control state denies action this turn')
  })
})

describe('AgentLoop.createHarnessProposer — source reliability (AUDIT_SEMANTIC_SOURCE_RELIABILITY)', () => {
  const twoSources = () => [
    { tool: 'read_file' as const, path: 'archive/2019/config.yaml', excerpt: 'port: 8080' },
    { tool: 'read_file' as const, path: 'config/prod.yaml', excerpt: 'port: 9443' },
  ]
  const weighing = (weighed: boolean) =>
    JSON.stringify({
      assessments: [
        { path: 'archive/2019/config.yaml', reliability: 'LOW', reason: 'archived copy' },
        { path: 'config/prod.yaml', reliability: 'HIGH', reason: 'live config' },
      ],
      weighed,
      ...(weighed ? {} : { note: 'Prefer config/prod.yaml.' }),
    })

  async function run(flag: boolean, responses: LLMStructuredResponse[]) {
    const prev = process.env.AUDIT_SEMANTIC_SOURCE_RELIABILITY
    if (flag) process.env.AUDIT_SEMANTIC_SOURCE_RELIABILITY = '1'
    else delete process.env.AUDIT_SEMANTIC_SOURCE_RELIABILITY
    try {
      const llmClient = new ScriptedLLMClient(responses)
      const agentLoop = buildAgentLoop(llmClient)
      let turnLocal: EvidenceStore | undefined
      const original = agentLoop.createControlPlaneState.bind(agentLoop)
      agentLoop.createControlPlaneState = () => {
        const state = original()
        turnLocal = state.evidenceStore
        return state
      }
      const messages: ChatMessage[] = [{ role: 'user', content: 'which port does prod use?' }]
      const proposer = agentLoop.createHarnessProposer({
        messages, tools: [], sessionId: 'session-1', userMessage: 'which port does prod use?', maxIterations: 5, sources: twoSources(),
      })
      const harnessStore = new EvidenceStore()
      const outcome = await proposer({ worldModel: undefined as never, evidenceStore: harnessStore })
      return { outcome, llmClient, messages, harnessStore, turnLocal: turnLocal! }
    } finally {
      if (prev === undefined) delete process.env.AUDIT_SEMANTIC_SOURCE_RELIABILITY
      else process.env.AUDIT_SEMANTIC_SOURCE_RELIABILITY = prev
    }
  }

  const ids = (store: EvidenceStore) => store.observations.map((o) => `${o.id}=${o.reliability}`)

  it('flag off: no assessment call, no note, nothing recorded (a second scripted response would throw if consumed)', async () => {
    const { outcome, llmClient, harnessStore } = await run(false, [{ content: 'port is 8080' }])
    expect(outcome).toEqual({ __harnessExecutionStatus: 'complete', output: 'port is 8080' })
    expect(llmClient.seenMessages).toHaveLength(1)
    expect(harnessStore.observations).toEqual([])
  })

  it('flag on, answer weighed the sources: returned as-is, assessments recorded in BOTH stores, no revision', async () => {
    const { outcome, llmClient, harnessStore, turnLocal } = await run(true, [{ content: 'port is 9443' }, { content: weighing(true) }])
    expect(outcome).toEqual({ __harnessExecutionStatus: 'complete', output: 'port is 9443' })
    expect(llmClient.seenMessages).toHaveLength(2)
    const expected = ['source-reliability:archive/2019/config.yaml=LOW', 'source-reliability:config/prod.yaml=HIGH']
    expect(ids(harnessStore)).toEqual(expected)
    expect(ids(turnLocal)).toEqual(expected)
  })

  it('flag on, answer did not weigh them: the assessment is put to the model and the revised answer is what is returned (once)', async () => {
    const { outcome, llmClient, messages, harnessStore } = await run(true, [
      { content: 'port is 8080' },
      { content: weighing(false) },
      { content: 'prod uses 9443; the archive says 8080 but is an old copy' },
    ])
    expect(outcome).toEqual({ __harnessExecutionStatus: 'complete', output: 'prod uses 9443; the archive says 8080 but is an old copy' })
    expect(llmClient.seenMessages).toHaveLength(3)
    const last = llmClient.seenMessages[2]
    expect(last.at(-2)).toMatchObject({ role: 'assistant', content: 'port is 8080' })
    expect(last.at(-1)?.content).toContain('- archive/2019/config.yaml: low reliability (archived copy)')
    expect(last.at(-1)?.content).toContain('Prefer config/prod.yaml.')
    expect(messages.at(-1)?.role).toBe('user')
    expect(ids(harnessStore)).toHaveLength(2)
  })

  it('a revised answer is not weighed again (at most one revision, no third call)', async () => {
    const { llmClient } = await run(true, [{ content: 'a' }, { content: weighing(false) }, { content: 'b' }])
    expect(llmClient.seenMessages).toHaveLength(3)
  })

  it('an unusable assessment fails open: the first answer stands and nothing is recorded', async () => {
    const { outcome, llmClient, harnessStore } = await run(true, [{ content: 'port is 8080' }, { content: 'not json' }])
    expect(outcome).toEqual({ __harnessExecutionStatus: 'complete', output: 'port is 8080' })
    expect(llmClient.seenMessages).toHaveLength(2)
    expect(harnessStore.observations).toEqual([])
  })
})

describe('AgentLoop.createHarnessProposer — reviewer revision note', () => {
  it('shows the model its previous answer and the finding, then asks for a new answer', async () => {
    const llmClient = new ScriptedLLMClient([{ content: 'first answer' }, { content: 'revised answer' }])
    const agentLoop = buildAgentLoop(llmClient)
    let pending: string[] = []
    const proposer = agentLoop.createHarnessProposer({
      messages: [{ role: 'user', content: 'do the thing' }],
      tools: [],
      sessionId: 'session-1',
      userMessage: 'do the thing',
      maxIterations: 5,
      sources: [],
      takeSteeringNotes: () => pending.splice(0),
    })
    const toolCtx = { worldModel: undefined as never, evidenceStore: undefined as never }
    expect(await proposer(toolCtx)).toEqual({ __harnessExecutionStatus: 'complete', output: 'first answer' })

    pending = ['[revision] Success criterion not covered by any belief: "x"']
    expect(await proposer(toolCtx)).toEqual({ __harnessExecutionStatus: 'complete', output: 'revised answer' })

    const second = llmClient.seenMessages[1]
    expect(second.at(-2)).toMatchObject({ role: 'assistant', content: 'first answer' })
    expect(second.at(-1)?.role).toBe('user')
    expect(second.at(-1)?.content).toContain('Success criterion not covered by any belief: "x"')
    expect(second.at(-1)?.content).toContain('Answer again')
  })

  it('a revision note is not treated as a steering note (the user did not send it)', async () => {
    const llmClient = new ScriptedLLMClient([{ content: 'answer' }])
    const agentLoop = buildAgentLoop(llmClient)
    const proposer = agentLoop.createHarnessProposer({
      messages: [{ role: 'user', content: 'q' }],
      tools: [], sessionId: 'session-1', userMessage: 'q', maxIterations: 5, sources: [],
      takeSteeringNotes: () => ['[revision] a finding'],
    })
    await proposer({ worldModel: undefined as never, evidenceStore: undefined as never })
    const sent = llmClient.seenMessages[0].map((m) => m.content).join('\n')
    expect(sent).not.toContain('the user sent the following while you were working')
  })
})
