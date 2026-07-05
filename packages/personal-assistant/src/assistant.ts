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

const SYSTEM_PROMPT = 'You are a helpful, concise personal assistant. Answer directly; ask a clarifying question only when the request is genuinely ambiguous.'

const isBrowser = (): boolean => typeof indexedDB !== 'undefined'

export interface AssistantTurnResult {
  status: 'ok' | 'needs_approval' | 'escalated'
  reply: string | null
  reason?: string
  riskLevel?: RiskClassification['riskLevel']
  controlState?: { riskState: RiskState; escalationReason: string | null }
  stepsUsed?: number
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

  constructor(options: PersonalAssistantOptions) {
    this.llmClient = options.llmClient
    this.model = options.model
    this.memory = options.memory ?? new InMemoryAdapter({ scope: 'thread', namespace: 'personal-assistant' })
    this.experienceStore = options.experienceStore ?? new InMemoryExperienceStore()
    this.checkpointStore = options.checkpointStore ?? new InMemoryAdapter({ scope: 'thread', namespace: 'personal-assistant-checkpoints' })
    this.maxSteps = options.maxSteps ?? 5
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

  async turn(userMessage: string, options: { sessionId?: string; approved?: boolean } = {}): Promise<AssistantTurnResult> {
    const sessionId = options.sessionId ?? 'default'
    const transcriptKey = `transcript:${sessionId}`
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

    // The only real network call this turn makes — everything the harness does
    // around it (risk, gating, verification, recovery, review) is local bookkeeping.
    const draftReply = await this.llmClient.callChatSync(
      [{ role: 'system', content: SYSTEM_PROMPT }, ...transcript, { role: 'user', content: userMessage }],
      { model: this.model },
    )

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
        onCheckpoint: (checkpoint: Parameters<typeof saveHarnessCheckpoint>[1]) =>
          saveHarnessCheckpoint(this.checkpointStore, checkpoint),
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

      const reply = typeof result.finalResult === 'string' ? result.finalResult : draftReply

      await this.memory.set(transcriptKey, { role: 'user', content: userMessage } satisfies ChatMessage, 'append')
      await this.memory.set(transcriptKey, { role: 'assistant', content: reply } satisfies ChatMessage, 'append')

      return { status: 'ok', reply, riskLevel: classification.riskLevel, controlState, stepsUsed }
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
}
