import { z } from 'zod'
import type { ChatMessage, ChatOptions, ILLMClient, TokenUsage, ToolDefinition } from '@buildaharness/runtime'
import { withCostEstimate } from '../turn-cost.js'
import { classifyCall } from './write-spend.js'

/**
 * The permission list (T11): what the assistant may do on its own in Aielia Write, with defaults the writer can change, and
 * a spending cap that stops model calls once reached. Changes the text only ever as suggestions (T9), so there is no
 * "edit directly" permission to grant. Pure data plus a client wrapper; storage goes through any `get`/`set` of settings.
 */

export const WritePermissionsSchema = z.object({
  /** Read each message for reviewer comments, decisions and corrections (T13). On by default; off means nothing is recorded from chat. */
  captureChat: z.boolean(),
  /** Run the claim check and the effects check on its own after the writer stops typing. Off by default: it spends the writer's money without being asked. */
  autoCheck: z.boolean(),
  /** Stop all model calls once this much has been spent in this browser, in US dollars. Unset means no cap. */
  spendCapUsd: z.number().positive().optional(),
})
export type WritePermissions = z.infer<typeof WritePermissionsSchema>

export const DEFAULT_WRITE_PERMISSIONS: WritePermissions = { captureChat: true, autoCheck: false }

const KEY = 'writer:permissions'

export interface SettingsStore {
  getSetting(key: string): Promise<unknown>
  setSetting(key: string, value: unknown): Promise<void>
}

export async function loadPermissions(store: SettingsStore): Promise<WritePermissions> {
  const parsed = WritePermissionsSchema.safeParse(await store.getSetting(KEY))
  return parsed.success ? parsed.data : DEFAULT_WRITE_PERMISSIONS
}

export async function savePermissions(store: SettingsStore, permissions: WritePermissions): Promise<void> {
  await store.setSetting(KEY, WritePermissionsSchema.parse(permissions))
}

export class SpendCapReachedError extends Error {
  constructor(readonly capUsd: number, readonly spentUsd: number) {
    super(`The spending cap of $${capUsd.toFixed(2)} has been reached ($${spentUsd.toFixed(2)} spent). Raise it in Settings to continue.`)
    this.name = 'SpendCapReachedError'
  }
}

/** Running total of what the model calls cost, persisted so a reload does not reset the cap. */
export interface SpendMeter {
  spentUsd(): number
  /** `model` is the model that made the call; it is priced by that model, falling back to the meter's default. */
  record(usage: TokenUsage, callType?: string, model?: string): Promise<void>
  /** Dollars and number of calls so far for each kind of call (the chat, the claim check, ...). Calls made before this was kept are in the total only. */
  byType(): Record<string, { usd: number; calls: number }>
  /** Throws SpendCapReachedError when the cap is set and reached. */
  assertWithinCap(capUsd: number | undefined): void
}

const SPEND_KEY = 'writer:spent-usd'
const SPEND_BY_TYPE_KEY = 'writer:spent-by-type'

export async function createSpendMeter(store: SettingsStore, pricing: { backend?: string; model?: string }): Promise<SpendMeter> {
  const saved = await store.getSetting(SPEND_KEY)
  let total = typeof saved === 'number' && Number.isFinite(saved) ? saved : 0
  const savedTypes = await store.getSetting(SPEND_BY_TYPE_KEY)
  const types: Record<string, { usd: number; calls: number }> = {}
  if (savedTypes && typeof savedTypes === 'object') {
    for (const [k, v] of Object.entries(savedTypes as Record<string, { usd?: unknown; calls?: unknown }>)) {
      if (typeof v?.usd === 'number' && Number.isFinite(v.usd) && typeof v.calls === 'number') types[k] = { usd: v.usd, calls: v.calls }
    }
  }
  return {
    spentUsd: () => total,
    byType: () => ({ ...types }),
    async record(usage, callType, model) {
      const cost = withCostEstimate(usage, { ...pricing, model: model ?? pricing.model }).costUsd ?? 0
      total += cost
      if (callType) types[callType] = { usd: (types[callType]?.usd ?? 0) + cost, calls: (types[callType]?.calls ?? 0) + 1 }
      await store.setSetting(SPEND_KEY, total)
      if (callType) await store.setSetting(SPEND_BY_TYPE_KEY, types)
    },
    assertWithinCap(capUsd) {
      if (capUsd !== undefined && total >= capUsd) throw new SpendCapReachedError(capUsd, total)
    },
  }
}

/**
 * Wraps a client so every call is counted, and no call starts once the cap is reached. Every model step in the article
 * service fails closed on an error (nothing is marked checked), so hitting the cap degrades to "not checked", never to a wrong result.
 */
export function withSpendCap(inner: ILLMClient, meter: SpendMeter, getCap: () => number | undefined): ILLMClient {
  const counted = (messages: ChatMessage[], o?: ChatOptions): ChatOptions => {
    const type = classifyCall(messages).id
    return { ...o, onUsage: (u) => { void meter.record(u, type, o?.model); o?.onUsage?.(u) } }
  }
  return {
    async *callChat(messages: ChatMessage[], options?: ChatOptions) {
      meter.assertWithinCap(getCap())
      yield* inner.callChat(messages, counted(messages, options))
    },
    async callChatSync(messages: ChatMessage[], options?: ChatOptions) {
      meter.assertWithinCap(getCap())
      return inner.callChatSync(messages, counted(messages, options))
    },
    async callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions) {
      meter.assertWithinCap(getCap())
      return inner.callChatStructured(messages, tools, counted(messages, options))
    },
  }
}
