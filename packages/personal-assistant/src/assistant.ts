import {
  HarnessRuntime,
  InMemoryExperienceStore,
  EscalationHalt,
  saveHarnessCheckpoint,
  loadHarnessCheckpoint,
  deleteHarnessCheckpoint,
  type ExperienceStore,
  type Task,
  type RiskState,
  type CheckpointStore,
} from '@buildaharness/harness'
import {
  InMemoryAdapter,
  IndexedDBAdapter,
  DexieExperienceStore,
  type MemoryAdapter,
  type ILLMClient,
  type ChatMessage,
} from '@buildaharness/runtime'
import { classifyRisk, type RiskClassification } from './risk-classifier.js'
import { classifyTriviality } from './triviality-classifier.js'
import { FILE_TOOLS, executeFileTool, applyPendingWrite, discardPendingWrite, type FileToolsContext } from './file-tools.js'

const SYSTEM_PROMPT = 'You are a helpful, concise personal assistant. Answer directly; ask a clarifying question only when the request is genuinely ambiguous.'

const isBrowser = (): boolean => typeof indexedDB !== 'undefined'

// Matches the existing maxSteps spirit for the harness loop below — a bounded
// number of tool round-trips per turn, not an open-ended agent loop.
const TOOL_LOOP_MAX_ITERATIONS = 5

function previewContent(content: string, maxLines = 20): string {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return content
  return `${lines.slice(0, maxLines).join('\n')}\n… (truncated)`
}

type ToolLoopResult =
  | { kind: 'final'; content: string }
  | { kind: 'needs_approval'; reason: string; pendingWriteId: string }
  | { kind: 'escalated'; reason: string }

export interface AssistantTrace {
  nodeExecutionOrder: string[]
  verificationHealth: { strength: number; feasibility: number }
}

export interface AssistantTurnResult {
  status: 'ok' | 'needs_approval' | 'escalated'
  reply: string | null
  reason?: string
  riskLevel?: RiskClassification['riskLevel']
  controlState?: { riskState: RiskState; escalationReason: string | null }
  stepsUsed?: number
  /** True when the turn was answered by the triviality fast path — no HarnessRuntime.run() this turn. */
  harnessSkipped?: boolean
  /** Structured harness telemetry for a "Why?" disclosure — the step sequence and verification confidence, not free-text reasoning. */
  trace?: AssistantTrace
  /** Set only when `needs_approval` was triggered by a `write_file` tool call — pass back into `turn(message, { approved, pendingWriteId })` to apply or discard it. */
  pendingWriteId?: string
}

export interface AssistantProgress {
  stepsUsed: number
  maxSteps: number
  currentNode?: string
}

export interface PersonalAssistantOptions {
  llmClient: ILLMClient
  model?: string
  /** Conversation transcript storage — defaults to an in-process Map, swap for IndexedDBAdapter in the browser. */
  memory?: MemoryAdapter
  /** Learning-layer store — persist and pass the same instance back in across sessions to retain strategy weights. */
  experienceStore?: ExperienceStore
  /** Stores an in-flight harness run's checkpoint so a crash/reload mid-turn can resume instead of losing the turn. */
  checkpointStore?: CheckpointStore
  maxSteps?: number
  /**
   * When set, `turn()` gives the model real read_file/list_directory/write_file
   * tools scoped to `workspaceRoot` instead of a single plain chat call. Absent
   * by default — behavior is byte-for-byte unchanged from before this option existed.
   * `write_file` never executes inline; it always stages a proposal and the turn
   * returns `needs_approval` with a `pendingWriteId`.
   */
  fileTools?: FileToolsContext
}

/**
 * A light, everyday-use wrapper around HarnessRuntime: one harness run per chat turn,
 * one real LLM call per turn (skipped entirely while a HIGH-risk action awaits approval).
 * Conversation history lives beside the harness run (in `memory`), not inside it — each
 * turn's WorldModel/TaskGraph/etc. are scratch state for that single turn, same as the
 * rest of the 11-layer runtime; only the transcript, the ExperienceStore, and (while a
 * turn is actually in flight) a HarnessRunState checkpoint persist.
 */
export class PersonalAssistant {
  private readonly llmClient: ILLMClient
  private readonly model?: string
  private readonly memory: MemoryAdapter
  private readonly experienceStore: ExperienceStore
  private readonly checkpointStore: CheckpointStore
  private readonly maxSteps: number
  private readonly fileTools?: FileToolsContext

  constructor(options: PersonalAssistantOptions) {
    this.llmClient = options.llmClient
    this.model = options.model
    this.memory = options.memory ?? new InMemoryAdapter({ scope: 'thread', namespace: 'personal-assistant' })
    this.experienceStore = options.experienceStore ?? new InMemoryExperienceStore()
    this.checkpointStore = options.checkpointStore ?? new InMemoryAdapter({ scope: 'thread', namespace: 'personal-assistant-checkpoints' })
    this.maxSteps = options.maxSteps ?? 5
    this.fileTools = options.fileTools
  }

  /**
   * Preferred entry point in a browser: defaults transcript, learning, and
   * checkpoint storage to their IndexedDB/Dexie-backed implementations so all
   * three survive a page reload, instead of the in-process defaults the plain
   * constructor uses. Falls back to the same in-memory defaults as `new
   * PersonalAssistant(...)` outside a browser (e.g. the CLI).
   */
  static async create(options: PersonalAssistantOptions): Promise<PersonalAssistant> {
    if (!isBrowser()) return new PersonalAssistant(options)

    const memory = options.memory ?? new IndexedDBAdapter({ namespace: 'personal-assistant' })
    const experienceStore = options.experienceStore ?? await DexieExperienceStore.create({ namespace: 'personal-assistant' })
    const checkpointStore = options.checkpointStore ?? new IndexedDBAdapter({ namespace: 'personal-assistant-checkpoints' })

    return new PersonalAssistant({ ...options, memory, experienceStore, checkpointStore })
  }

  async turn(
    userMessage: string,
    options: { sessionId?: string; approved?: boolean; pendingWriteId?: string; onProgress?: (progress: AssistantProgress) => void } = {},
  ): Promise<AssistantTurnResult> {
    const sessionId = options.sessionId ?? 'default'
    const transcriptKey = `transcript:${sessionId}`

    // A staged write is resumed by ID, not re-derived from a second LLM call —
    // see T4 in plans/personal_assistant_file_tools_plan.html for why a second
    // call has no guarantee of proposing identical content.
    if (options.pendingWriteId) {
      return this.resolvePendingWrite(transcriptKey, options.pendingWriteId, options.approved ?? false)
    }

    const transcript = ((await this.memory.get(transcriptKey)) as ChatMessage[] | undefined) ?? []

    const classification = classifyRisk(userMessage)

    if (classification.requiresApproval && !options.approved) {
      await this.memory.set(transcriptKey, { role: 'user', content: userMessage } satisfies ChatMessage, 'append')
      return {
        status: 'needs_approval',
        reply: null,
        reason: classification.reason,
        riskLevel: classification.riskLevel,
      }
    }

    let draftReply: string
    if (this.fileTools) {
      const loopResult = await this.runToolLoop(transcript, userMessage)

      if (loopResult.kind === 'needs_approval') {
        await this.memory.set(transcriptKey, { role: 'user', content: userMessage } satisfies ChatMessage, 'append')
        return {
          status: 'needs_approval',
          reply: null,
          reason: loopResult.reason,
          // A write_file call is consequential regardless of what classifyRisk
          // made of the message text — this is a tool-call-level gate, not the
          // message-level one above (see the Diagnosis tab of the file-tools plan).
          riskLevel: 'HIGH',
          pendingWriteId: loopResult.pendingWriteId,
        }
      }
      if (loopResult.kind === 'escalated') {
        await this.memory.set(transcriptKey, { role: 'user', content: userMessage } satisfies ChatMessage, 'append')
        return { status: 'escalated', reply: null, reason: loopResult.reason, riskLevel: classification.riskLevel }
      }
      draftReply = loopResult.content
    } else {
      // The only real network call this turn makes — everything the harness does
      // around it (risk, gating, verification, recovery, review) is local bookkeeping.
      draftReply = await this.llmClient.callChatSync(
        [{ role: 'system', content: SYSTEM_PROMPT }, ...transcript, { role: 'user', content: userMessage }],
        { model: this.model },
      )
    }

    // Self-contained factual questions ("what timezone is Tokyo in") skip the harness
    // run entirely — no verification/reviewer pass/checkpoint for this turn. Deliberately
    // conservative: see triviality-classifier.ts for what disqualifies a turn from this path.
    const triviality = classifyTriviality(userMessage, classification.riskLevel)
    if (triviality.isTrivial) {
      await this.memory.set(transcriptKey, { role: 'user', content: userMessage } satisfies ChatMessage, 'append')
      await this.memory.set(transcriptKey, { role: 'assistant', content: draftReply } satisfies ChatMessage, 'append')
      return { status: 'ok', reply: draftReply, riskLevel: classification.riskLevel, stepsUsed: 0, harnessSkipped: true }
    }

    const task: Task = {
      id: 'respond',
      description: userMessage,
      status: 'PENDING',
      risk_level: classification.riskLevel,
      depends_on: [],
      parallel_write_domains: [],
      abstraction_level: 0,
      assigned_strategy: null,
    }

    const runtime = new HarnessRuntime()
    // One harness run per (session, turn) — a run_id a resumed run can be found under
    // if this turn's process died mid-run before reaching the `finally` cleanup below.
    const runId = `turn:${sessionId}`
    let stepsUsed = 0
    let controlState: AssistantTurnResult['controlState']

    try {
      const runOptions = {
        initialTasks: [task],
        toolExecutors: { default: () => draftReply },
        experienceStore: this.experienceStore,
        max_steps: this.maxSteps,
        runId,
        onCheckpoint: (checkpoint: Parameters<typeof saveHarnessCheckpoint>[1]) => {
          options.onProgress?.({
            stepsUsed: checkpoint.progress.stepsUsed,
            maxSteps: this.maxSteps,
            currentNode: checkpoint.progress.nodeExecutionOrder.at(-1),
          })
          return saveHarnessCheckpoint(this.checkpointStore, checkpoint)
        },
      }

      const priorCheckpoint = await loadHarnessCheckpoint(this.checkpointStore, runId)
      const outcome = priorCheckpoint
        ? await runtime.resume(priorCheckpoint, runOptions)
        : await runtime.run(
            userMessage,
            ['Respond helpfully, accurately, and safely to the user request.'],
            runOptions,
          )

      // PersonalAssistant never asks the harness to pause mid-turn, so a 'paused'
      // outcome here would mean a bug in the driving code, not a real HITL wait.
      if (outcome.status !== 'complete') {
        throw new Error(`harness run for "${runId}" paused unexpectedly instead of completing`)
      }
      const result = outcome.result
      stepsUsed = result.stepsUsed
      controlState = {
        riskState: result.initResult.controlState.risk_state,
        escalationReason: result.initResult.controlState.escalation_reason,
      }
      const trace: AssistantTrace = {
        nodeExecutionOrder: result.nodeExecutionOrder,
        verificationHealth: { ...result.initResult.diagnostics.verification_health },
      }

      const reply = typeof result.finalResult === 'string' ? result.finalResult : draftReply

      await this.memory.set(transcriptKey, { role: 'user', content: userMessage } satisfies ChatMessage, 'append')
      await this.memory.set(transcriptKey, { role: 'assistant', content: reply } satisfies ChatMessage, 'append')

      return { status: 'ok', reply, riskLevel: classification.riskLevel, controlState, stepsUsed, harnessSkipped: false, trace }
    } catch (err) {
      if (err instanceof EscalationHalt) {
        await this.memory.set(transcriptKey, { role: 'user', content: userMessage } satisfies ChatMessage, 'append')
        return {
          status: 'escalated',
          reply: null,
          reason: err.blocker.missing_info.join('; ') || err.blocker.reason,
          riskLevel: classification.riskLevel,
          stepsUsed,
        }
      }
      throw err
    } finally {
      // The turn either completed or escalated (a terminal halt, not a resumable
      // pause) — either way there's nothing left to resume, so drop the checkpoint.
      await deleteHarnessCheckpoint(this.checkpointStore, runId).catch(() => {})
    }
  }

  /**
   * Bounded ReAct loop: calls callChatStructured with the file tools, executing
   * real (non-mutating) tool calls and looping, until either a final text reply
   * comes back, a write_file call needs staging + approval, or the iteration
   * cap is hit. Only ever invoked when `fileTools` is configured.
   */
  private async runToolLoop(transcript: ChatMessage[], userMessage: string): Promise<ToolLoopResult> {
    const fileTools = this.fileTools
    if (!fileTools) throw new Error('runToolLoop() requires fileTools to be configured')

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...transcript,
      { role: 'user', content: userMessage },
    ]

    for (let iteration = 0; iteration < TOOL_LOOP_MAX_ITERATIONS; iteration++) {
      const response = await this.llmClient.callChatStructured(messages, FILE_TOOLS, { model: this.model })

      if (!response.toolCalls || response.toolCalls.length === 0) {
        return { kind: 'final', content: response.content }
      }

      // The Claude CLI backend's own agentic loop resolves read_file/list_directory
      // calls internally within one subprocess call, and — because write_file must
      // never execute inline for that backend either — its MCP tool handler already
      // staged the write itself before returning here. It signals that with this
      // synthetic tool name instead of `write_file`, so we adopt the id it already
      // staged rather than staging a second, redundant pending write.
      const alreadyStagedCall = response.toolCalls.find(call => call.name === '__staged_write')
      if (alreadyStagedCall) {
        const { id, path, content } = alreadyStagedCall.input as { id: string; path: string; content: string }
        return {
          kind: 'needs_approval',
          reason: `Proposes writing to "${path}":\n${previewContent(content)}`,
          pendingWriteId: id,
        }
      }

      const writeCall = response.toolCalls.find(call => call.name === 'write_file')
      if (writeCall) {
        // Stop immediately — don't execute any other tool calls from this same
        // response — and stage the write rather than ever touching real disk.
        const result = await executeFileTool(fileTools, 'write_file', writeCall.input)
        if (result.kind !== 'staged_write') {
          throw new Error('write_file executor returned an unexpected result kind')
        }
        return {
          kind: 'needs_approval',
          reason: `Proposes writing to "${result.path}":\n${previewContent(result.content)}`,
          pendingWriteId: result.id,
        }
      }

      messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls })
      for (const call of response.toolCalls) {
        let resultText: string
        try {
          const result = await executeFileTool(fileTools, call.name, call.input)
          resultText = result.kind === 'text' ? result.text : ''
        } catch (err) {
          // A rejected path or tool error is reported back to the model as a
          // tool result, not thrown — matches the "clear decline, never a
          // silent no-op dressed up as success" baseline this plan preserves.
          resultText = `Error: ${err instanceof Error ? err.message : String(err)}`
        }
        messages.push({ role: 'tool', content: resultText, toolCallId: call.id })
      }
    }

    return {
      kind: 'escalated',
      reason: `File-tool loop exceeded ${TOOL_LOOP_MAX_ITERATIONS} iterations without producing a final answer.`,
    }
  }

  /** Resumes a staged write by ID instead of re-deriving it from a second LLM call — see T4. */
  private async resolvePendingWrite(transcriptKey: string, pendingWriteId: string, approved: boolean): Promise<AssistantTurnResult> {
    const fileTools = this.fileTools
    if (!fileTools) throw new Error('turn() received pendingWriteId but no fileTools are configured')

    if (!approved) {
      await discardPendingWrite(fileTools.backend, fileTools.workspaceRoot, pendingWriteId)
      const reply = 'Cancelled — nothing was written.'
      await this.memory.set(transcriptKey, { role: 'assistant', content: reply } satisfies ChatMessage, 'append')
      return { status: 'ok', reply }
    }

    const record = await applyPendingWrite(fileTools.backend, fileTools.workspaceRoot, pendingWriteId)
    const reply = `Wrote "${record.path}".`
    await this.memory.set(transcriptKey, { role: 'assistant', content: reply } satisfies ChatMessage, 'append')
    return { status: 'ok', reply }
  }
}
