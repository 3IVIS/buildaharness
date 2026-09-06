import type {
  ChatMessage,
  ChatOptions,
  ILLMClient,
  LLMStructuredResponse,
  ToolDefinition,
} from '@buildaharness/runtime'
import { classifyRisk } from './risk-classifier.js'

/**
 * A deterministic, network-free {@link ILLMClient} for tests and demos — the one publicly
 * supported way to drive a real `PersonalAssistant` turn end to end without a proxy, an API key,
 * or a live model. Built for plans/chat_ui_browser_e2e_plan.html phase B1 (the browser-e2e lane
 * that unblocks the `ASSISTANT_ONE_LOOP` default-flip), and reusable by chat-ui's `demo-seed.ts`.
 *
 * It mirrors the shape of the internal `ScriptedToolLLMClient` that `assistant.test.ts` has used
 * for a long time: every turn spends exactly one mandatory `classifyTurnIntent` call up front,
 * which this client recognises (by a distinctive phrase from that classifier's system prompt) and
 * answers on its own from a lightweight, deterministic default — so `responses` only has to
 * script the *tool loop / one-loop proposer's* own calls, not that bookkeeping call.
 *
 * `responses` entries are consumed in order, one per non-classifier `callChatStructured` call:
 *   - a plain `string` → `{ content: string }` (a final answer, no tool calls)
 *   - an `LLMStructuredResponse` → use as-is (set `toolCalls` to simulate the model calling a tool)
 *
 * `callChat`/`callChatSync` (the no-tools reply path, and post-approval synthesis) stream
 * `streamChunks` (default: `['']`).
 */
export interface ScriptedLLMClientScript {
  /** Ordered structured responses for the tool loop / one-loop proposer. A bare string is shorthand for a final answer with no tool calls. */
  responses?: Array<string | LLMStructuredResponse>
  /** Chunks streamed from `callChat`/`callChatSync`. Defaults to `['']`. */
  streamChunks?: string[]
  /**
   * Per-user-message override of the auto-answered `classifyTurnIntent` JSON fields (e.g.
   * `{ isTrivial: true }`, `{ riskLevel: 'HIGH' }`, `{ decomposedTasks: [...] }`). Return
   * `undefined` to keep the derived default for that message.
   */
  classify?: (userMessage: string) => Record<string, unknown> | undefined
}

/** The phrase that opens `turn-intent-classifier.ts`'s system prompt — stable, and how every scripted client tells that mandatory call apart from a real tool-loop call. */
const TURN_INTENT_MARKER = 'seven independent judgments'

function isTurnIntentRequest(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === 'system' && m.content.includes(TURN_INTENT_MARKER))
}

/**
 * The deterministic stand-in for what a real model would return for `classifyTurnIntent` —
 * risk comes from the same lexical `classifyRisk` the real fallback path uses; everything else
 * is inert (not trivial, not a reminder, no decomposition, no plan template) unless `override`
 * says otherwise. `isTrivial` defaults to `false` so a scripted turn actually exercises the
 * harness loop (the interesting case for one-loop parity tests); pass `{ isTrivial: true }` via
 * `classify` for the triviality fast path.
 */
function deriveTurnIntentJSON(messages: ChatMessage[], override?: Record<string, unknown>): string {
  const userContent = messages.find((m) => m.role === 'user')?.content ?? ''
  const risk = classifyRisk(userContent)
  const isReminderRequest = risk.reason.includes('reminder')
  const base = {
    riskLevel: risk.riskLevel,
    riskReason: risk.reason,
    isTrivial: false,
    decomposedTasks: [],
    isReminderRequest,
    isBulkReminderRequest: isReminderRequest && risk.requiresApproval,
    isAbandonRequest: false,
    matchedPlanTemplate: null,
    statesDurableFact: null,
  }
  return JSON.stringify({ ...base, ...override })
}

class ScriptedLLMClient implements ILLMClient {
  /** Non-classifier `callChatStructured` calls made so far — the index into `responses`. */
  toolCalls = 0
  private responseIndex = 0

  constructor(private readonly script: ScriptedLLMClientScript) {}

  private get streamChunks(): string[] {
    return this.script.streamChunks && this.script.streamChunks.length > 0 ? this.script.streamChunks : ['']
  }

  async *callChat(_messages: ChatMessage[], _options?: ChatOptions): AsyncIterable<string> {
    for (const chunk of this.streamChunks) yield chunk
  }

  async callChatSync(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const chunks: string[] = []
    for await (const chunk of this.callChat(messages, options)) chunks.push(chunk)
    return chunks.join('')
  }

  async callChatStructured(messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMStructuredResponse> {
    if (isTurnIntentRequest(messages)) {
      const userContent = messages.find((m) => m.role === 'user')?.content ?? ''
      return { content: deriveTurnIntentJSON(messages, this.script.classify?.(userContent)) }
    }
    this.toolCalls++
    const responses = this.script.responses ?? []
    if (this.responseIndex >= responses.length) {
      throw new Error(
        `createScriptedLLMClient: no scripted response for tool-loop call #${this.responseIndex + 1} (scripted ${responses.length})`,
      )
    }
    const next = responses[this.responseIndex++]
    return typeof next === 'string' ? { content: next } : next
  }
}

/**
 * Builds a scripted {@link ILLMClient}. See {@link ScriptedLLMClientScript}. The returned value
 * is a plain `ILLMClient` — pass it straight to `PersonalAssistant.create({ llmClient })`.
 */
export function createScriptedLLMClient(script: ScriptedLLMClientScript = {}): ILLMClient {
  return new ScriptedLLMClient(script)
}
