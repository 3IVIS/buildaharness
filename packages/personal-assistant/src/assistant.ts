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
  InMemoryReminderStore,
  type MemoryAdapter,
  type ILLMClient,
  type ChatMessage,
  type ReminderStore,
} from '@buildaharness/runtime'
import { classifyRisk, type RiskClassification } from './risk-classifier.js'
import { classifyTriviality } from './triviality-classifier.js'
import { FILE_TOOLS, executeFileTool, applyPendingWrite, discardPendingWrite, type FileToolsContext } from './file-tools.js'
import { extractFactsFromTurn, type UserFact } from './fact-extraction.js'
import { compactTranscript } from './transcript-compaction.js'

const SYSTEM_PROMPT = 'You are a helpful, concise personal assistant. Answer directly; ask a clarifying question only when the request is genuinely ambiguous.'

// Most-recent facts injected into the system prompt each turn — a hard cap,
// not a summary, so this stays cheap even as the fact store grows.
const FACT_CAP = 20

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
  | { kind: 'final'; content: string; sources: AssistantSource[] }
  | { kind: 'needs_approval'; reason: string; pendingWriteId: string }
  | { kind: 'escalated'; reason: string }

export interface AssistantTrace {
  nodeExecutionOrder: string[]
  verificationHealth: { strength: number; feasibility: number }
}

/** A real, non-mutating file tool call the model made while producing a reply — grounds a reply in something other than the model's own words. write_file is deliberately excluded: until approved, nothing was actually read or changed. */
export interface AssistantSource {
  tool: 'read_file' | 'list_directory'
  path: string
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
  /** Real read_file/list_directory calls made while producing this reply, in call order. Only set when fileTools is configured and at least one such call happened this turn. */
  sources?: AssistantSource[]
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
  /** Stores reminders detected from "remind me"/"set a reminder"-shaped requests — defaults to an in-process store. See ReminderStore's `dueAt` doc: v1 stores raw text only, no time parsing, so `listDue()` won't return these yet. */
  reminderStore?: ReminderStore
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
  private readonly reminderStore: ReminderStore

  constructor(options: PersonalAssistantOptions) {
    this.llmClient = options.llmClient
    this.model = options.model
    this.memory = options.memory ?? new InMemoryAdapter({ scope: 'thread', namespace: 'personal-assistant' })
    this.experienceStore = options.experienceStore ?? new InMemoryExperienceStore()
    this.checkpointStore = options.checkpointStore ?? new InMemoryAdapter({ scope: 'thread', namespace: 'personal-assistant-checkpoints' })
    this.maxSteps = options.maxSteps ?? 5
    this.fileTools = options.fileTools
    this.reminderStore = options.reminderStore ?? new InMemoryReminderStore(new InMemoryAdapter({ scope: 'thread', namespace: 'personal-assistant-reminders' }))
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
    options: {
      sessionId?: string
      approved?: boolean
      pendingWriteId?: string
      onProgress?: (progress: AssistantProgress) => void
      /**
       * Called with each token as the model's reply streams in. Only fires for
       * the plain chat path (no fileTools configured) — the file-tools ReAct
       * loop drives callChatStructured, which isn't a streaming call for either
       * backend, so a turn using file tools never streams. ClaudeCliLLMClient's
       * callChat isn't real per-token streaming either (it yields the whole
       * reply as one chunk) — this only reads token-by-token on the proxy backend.
       */
      onToken?: (token: string) => void
    } = {},
  ): Promise<AssistantTurnResult> {
    const sessionId = options.sessionId ?? 'default'
    const transcriptKey = `transcript:${sessionId}`

    // A staged write is resumed by ID, not re-derived from a second LLM call —
    // see T4 in plans/personal_assistant_file_tools_plan.html for why a second
    // call has no guarantee of proposing identical content.
    if (options.pendingWriteId) {
      return this.resolvePendingWrite(transcriptKey, options.pendingWriteId, options.approved ?? false)
    }

    const rawTranscript = ((await this.memory.get(transcriptKey)) as ChatMessage[] | undefined) ?? []
    const { transcript, compacted } = compactTranscript(rawTranscript)
    if (compacted) await this.memory.set(transcriptKey, transcript)

    const factsKey = `facts:${sessionId}`
    const facts = ((await this.memory.get(factsKey)) as UserFact[] | undefined) ?? []
    const factsBlock = facts.length > 0
      ? `\nKnown facts about the user:\n${facts.slice(-FACT_CAP).map(f => `- ${f.text}`).join('\n')}`
      : ''
    const systemPrompt = `${SYSTEM_PROMPT}${factsBlock}`

    const classification = classifyRisk(userMessage)

    // A reminder-shaped MEDIUM request stores a record immediately — detection,
    // not action gating, so it happens whether or not the rest of the turn is
    // ultimately approved/completed. v1 stores raw text with no time parsing
    // (dueAt: null) — see ReminderStore's doc comment.
    if (classification.riskLevel === 'MEDIUM' && classification.reason.includes('reminder')) {
      await this.reminderStore.create(userMessage, null)
    }

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
    let sources: AssistantSource[] | undefined
    if (this.fileTools) {
      const loopResult = await this.runToolLoop(transcript, userMessage, systemPrompt)

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
      sources = loopResult.sources.length > 0 ? loopResult.sources : undefined
    } else {
      // The only real network call this turn makes — everything the harness does
      // around it (risk, gating, verification, recovery, review) is local bookkeeping.
      // Read via callChat (not callChatSync) so a caller-supplied onToken sees each
      // chunk as it arrives; accumulating here gives the exact same final string
      // callChatSync would have returned when no listener is attached.
      draftReply = ''
      for await (const token of this.llmClient.callChat(
        [{ role: 'system', content: systemPrompt }, ...transcript, { role: 'user', content: userMessage }],
        { model: this.model },
      )) {
        draftReply += token
        options.onToken?.(token)
      }
    }

    // Self-contained factual questions ("what timezone is Tokyo in") skip the harness
    // run entirely — no verification/reviewer pass/checkpoint for this turn. Deliberately
    // conservative: see triviality-classifier.ts for what disqualifies a turn from this path.
    const triviality = classifyTriviality(userMessage, classification.riskLevel)
    if (triviality.isTrivial) {
      await this.memory.set(transcriptKey, { role: 'user', content: userMessage } satisfies ChatMessage, 'append')
      await this.memory.set(transcriptKey, { role: 'assistant', content: draftReply } satisfies ChatMessage, 'append')
      await this.recordFacts(sessionId, userMessage)
      return { status: 'ok', reply: draftReply, riskLevel: classification.riskLevel, stepsUsed: 0, harnessSkipped: true, sources }
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
      await this.recordFacts(sessionId, userMessage)

      return { status: 'ok', reply, riskLevel: classification.riskLevel, controlState, stepsUsed, harnessSkipped: false, trace, sources }
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

  /** Captures a durable fact from the user's message, if any, into the session's fact store. A no-op for ordinary turns. */
  private async recordFacts(sessionId: string, userMessage: string): Promise<void> {
    const facts = extractFactsFromTurn(userMessage, `turn:${sessionId}`)
    for (const fact of facts) {
      await this.memory.set(`facts:${sessionId}`, fact, 'append')
    }
  }

  /**
   * Bounded ReAct loop: calls callChatStructured with the file tools, executing
   * real (non-mutating) tool calls and looping, until either a final text reply
   * comes back, a write_file call needs staging + approval, or the iteration
   * cap is hit. Only ever invoked when `fileTools` is configured.
   */
  private async runToolLoop(transcript: ChatMessage[], userMessage: string, systemPrompt: string): Promise<ToolLoopResult> {
    const fileTools = this.fileTools
    if (!fileTools) throw new Error('runToolLoop() requires fileTools to be configured')

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...transcript,
      { role: 'user', content: userMessage },
    ]
    const sources: AssistantSource[] = []

    for (let iteration = 0; iteration < TOOL_LOOP_MAX_ITERATIONS; iteration++) {
      const response = await this.llmClient.callChatStructured(messages, FILE_TOOLS, { model: this.model })

      if (!response.toolCalls || response.toolCalls.length === 0) {
        return { kind: 'final', content: response.content, sources }
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
          // Only a call that actually succeeded grounds the reply in something
          // real — a rejected path or tool error below is reported to the model
          // but isn't a source.
          if (call.name === 'read_file' || call.name === 'list_directory') {
            sources.push({ tool: call.name, path: String(call.input.path) })
          }
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
