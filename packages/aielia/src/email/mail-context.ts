import type { EmailCache } from './cache.js'
import type { Message } from './model.js'

/**
 * Context chips (plan section 6): what the next chat message applies to, as removable chips, so "this one" and "these"
 * always mean something the user can see. The chat input shows `chipLabel(chip)`; the user can remove any chip. When no chip
 * remains the context is empty and a message-relative request ("this one") resolves to nothing rather than a guess.
 * No `node:*` and no DOM imports.
 */

export type MailChip =
  | { kind: 'message'; messageId: string; threadId?: string; label?: string }
  | { kind: 'thread'; threadId: string; label?: string }
  | { kind: 'selection'; messageIds: string[] }
  | { kind: 'view'; folderId?: string; folderName?: string; searchText?: string }
  | { kind: 'account'; accountId: string }

export interface MailContext {
  chips: MailChip[]
}

export const EMPTY_MAIL_CONTEXT: MailContext = { chips: [] }

export function chipKey(chip: MailChip): string {
  switch (chip.kind) {
    case 'message': return `message:${chip.messageId}`
    case 'thread': return `thread:${chip.threadId}`
    case 'selection': return `selection:${[...chip.messageIds].sort().join(',')}`
    case 'view': return `view:${chip.folderId ?? ''}:${chip.searchText ?? ''}`
    case 'account': return `account:${chip.accountId}`
  }
}

export function chipLabel(chip: MailChip): string {
  switch (chip.kind) {
    case 'message': return chip.label ? `This message: ${chip.label}` : 'This message'
    case 'thread': return chip.label ? `This thread: ${chip.label}` : 'This thread'
    case 'selection': return `${chip.messageIds.length} selected message${chip.messageIds.length === 1 ? '' : 's'}`
    case 'view': return chip.searchText ? `Search: ${chip.searchText}` : chip.folderName ? `Everything in ${chip.folderName}` : 'Everything in this view'
    case 'account': return 'The whole account'
  }
}

/** Add a chip (replacing an equal one). Opening a message replaces any earlier message or thread chip: one "this" at a time. */
export function addChip(ctx: MailContext, chip: MailChip): MailContext {
  const single = chip.kind === 'message' || chip.kind === 'thread'
  const kept = ctx.chips.filter((c) => chipKey(c) !== chipKey(chip) && !(single && (c.kind === 'message' || c.kind === 'thread')))
  return { chips: [...kept, chip] }
}

export function removeChip(ctx: MailContext, chip: MailChip | string): MailContext {
  const key = typeof chip === 'string' ? chip : chipKey(chip)
  return { chips: ctx.chips.filter((c) => chipKey(c) !== key) }
}

/** Which chips say "this one": an open message or thread. */
export const hasThisChip = (ctx: MailContext): boolean => ctx.chips.some((c) => c.kind === 'message' || c.kind === 'thread')

export interface ResolvedContext {
  messages: Message[]
  /** True when the chips cover a whole view or account, and the list was cut at `limit`. */
  truncated: boolean
}

/**
 * The messages the chips stand for, newest first, de-duplicated. Privacy is NOT applied here (a user-facing list may show
 * excluded mail); every path that gives text to a model goes through `buildMailModelInput` in mail-tools.ts.
 */
export async function resolveContext(ctx: MailContext, cache: EmailCache, accountId: string, limit = 200): Promise<ResolvedContext> {
  const byId = new Map<string, Message>()
  let truncated = false
  const add = (m: Message | undefined): void => { if (m) byId.set(m.id, m) }
  for (const chip of ctx.chips) {
    switch (chip.kind) {
      case 'message': add(await cache.getMessage(chip.messageId)); break
      case 'thread': {
        const r = await cache.queryMessages({ threadId: chip.threadId }, { offset: 0, limit })
        r.items.forEach(add)
        break
      }
      case 'selection':
        for (const id of chip.messageIds.slice(0, limit)) add(await cache.getMessage(id))
        break
      case 'view': {
        const r = await cache.queryMessages({ folderId: chip.folderId }, { offset: 0, limit })
        const needle = chip.searchText?.toLowerCase()
        for (const m of r.items) if (!needle || `${m.subject}\n${m.from.address}\n${m.textBody}`.toLowerCase().includes(needle)) add(m)
        if (r.total > r.items.length) truncated = true
        break
      }
      case 'account': {
        const r = await cache.queryMessages({}, { offset: 0, limit })
        r.items.filter((m) => m.accountId === accountId).forEach(add)
        if (r.total > r.items.length) truncated = true
        break
      }
    }
  }
  const messages = [...byId.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : 1))
  return { messages, truncated }
}
