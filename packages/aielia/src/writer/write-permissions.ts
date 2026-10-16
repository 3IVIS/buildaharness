import { z } from 'zod'
import type { ChatMessage, ChatOptions, ILLMClient, TokenUsage, ToolDefinition } from '@buildaharness/runtime'
import { withCostEstimate } from '../turn-cost.js'

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
  record(usage: TokenUsage): Promise<void>
  /** Throws SpendCapReachedError when the cap is set and reached. */
  assertWithinCap(capUsd: number | undefined): void
}

const SPEND_KEY = 'writer:spent-usd'

export async function createSpendMeter(store: SettingsStore, pricing: { backend?: string; model?: string }): Promise<SpendMeter> {
  const saved = await store.getSetting(SPEND_KEY)
  let total = typeof saved === 'number' && Number.isFinite(saved) ? saved : 0
  return {
    spentUsd: () => total,
    async record(usage) {
      total += withCostEstimate(usage, pricing).costUsd ?? 0
      await store.setSetting(SPEND_KEY, total)
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
  const counted = (o?: ChatOptions): ChatOptions => ({ ...o, onUsage: (u) => { void meter.record(u); o?.onUsage?.(u) } })
  return {
    async *callChat(messages: ChatMessage[], options?: ChatOptions) {
      meter.assertWithinCap(getCap())
      yield* inner.callChat(messages, counted(options))
    },
    async callChatSync(messages: ChatMessage[], options?: ChatOptions) {
      meter.assertWithinCap(getCap())
      return inner.callChatSync(messages, counted(options))
    },
    async callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions) {
      meter.assertWithinCap(getCap())
      return inner.callChatStructured(messages, tools, counted(options))
    },
  }
}
