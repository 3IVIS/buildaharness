import type { EmailCache } from './cache.js'
import type { Message } from './model.js'
import { EmailProviderError, type EmailProvider } from './provider.js'

/**
 * Action log, undo and bulk preview for reversible organising (plans/aielia_email_plan.html, sections 6 and 9, decision 5).
 * Every change is recorded with the pre-image needed to restore it (folders, read and starred flags). One message runs and
 * can be undone; more than one message always previews first and runs only when confirmed, capped per turn. Undo never
 * guesses: a message that changed since the action is reported, not touched. Pure over the cache and the provider;
 * no node:* and no DOM imports, no LLM client.
 */

/** The most messages one turn may change. The single place this number lives. */
export const BULK_CEILING_PER_TURN = 200

export type EmailChange =
  | { type: 'move'; folderId: string }
  | { type: 'label'; folderId: string; add: boolean }
  | { type: 'flag'; starred: boolean }
  | { type: 'read'; read: boolean }

export interface MessageState {
  folderIds: string[]
  read: boolean
  starred: boolean
}

export interface ActionEntry {
  messageId: string
  /** State before the change: what undo restores. */
  before: MessageState
  /** State right after the change: undo only proceeds while the message still has it. */
  after: MessageState
}

export interface EmailAction {
  id: string
  accountId: string
  at: string
  change: EmailChange
  entries: ActionEntry[]
  undoneAt?: string
}

export interface PreviewRow {
  messageId: string
  subject: string
  before: MessageState
  after: MessageState
}

export interface BulkPreview {
  change: EmailChange
  /** Messages the change would alter. */
  rows: PreviewRow[]
  /** Requested messages the change would leave as they are. */
  unchanged: string[]
  /** Requested ids the mailbox does not know. */
  missing: string[]
  overCeiling: boolean
  /** True whenever more than one message is affected. */
  needsConfirmation: boolean
}

export type UndoConflict = { messageId: string; reason: 'changed_since' | 'not_found' }
export interface UndoResult {
  actionId: string
  restored: string[]
  conflicts: UndoConflict[]
}

export class EmailActionError extends Error {
  constructor(public readonly code: 'ceiling' | 'needs_confirmation' | 'not_found' | 'already_undone', message: string) {
    super(message)
    this.name = 'EmailActionError'
  }
}

/** Counts messages changed in one turn against the ceiling. */
export class TurnCeiling {
  private used = 0
  constructor(private readonly limit: number = BULK_CEILING_PER_TURN) {}
  remaining(): number {
    return Math.max(0, this.limit - this.used)
  }
  take(n: number): boolean {
    if (n > this.remaining()) return false
    this.used += n
    return true
  }
}

export class EmailActionLog {
  private actions: EmailAction[] = []
  private seq = 0
  append(a: Omit<EmailAction, 'id'>): EmailAction {
    const action: EmailAction = { ...a, id: `act-${++this.seq}` }
    this.actions.push(action)
    return structuredClone(action)
  }
  get(id: string): EmailAction | undefined {
    const a = this.actions.find((x) => x.id === id)
    return a ? structuredClone(a) : undefined
  }
  /** Newest first. */
  list(): EmailAction[] {
    return structuredClone([...this.actions].reverse())
  }
  /** The newest action not yet undone, for a bare undo. */
  latestUndoable(): EmailAction | undefined {
    return this.list().find((a) => !a.undoneAt)
  }
  markUndone(id: string, at: string): void {
    const a = this.actions.find((x) => x.id === id)
    if (a) a.undoneAt = at
  }
}

export interface ActionContext {
  cache: EmailCache
  provider: EmailProvider
  log: EmailActionLog
  /** Injected so tests are deterministic. */
  now?: () => string
  turn?: TurnCeiling
}

const stateOf = (m: Message): MessageState => ({ folderIds: [...m.folderIds], read: m.flags.read, starred: m.flags.starred })
const sameState = (a: MessageState, b: MessageState): boolean =>
  a.read === b.read && a.starred === b.starred && a.folderIds.length === b.folderIds.length &&
  [...a.folderIds].sort().every((f, i) => f === [...b.folderIds].sort()[i])

/** What a change does to a state (pure). */
export function applyToState(s: MessageState, change: EmailChange): MessageState {
  switch (change.type) {
    case 'move': return { ...s, folderIds: [change.folderId] }
    case 'label': {
      const has = s.folderIds.includes(change.folderId)
      if (change.add) return has ? s : { ...s, folderIds: [...s.folderIds, change.folderId] }
      return has ? { ...s, folderIds: s.folderIds.filter((f) => f !== change.folderId) } : s
    }
    case 'flag': return { ...s, starred: change.starred }
    case 'read': return { ...s, read: change.read }
  }
}

async function load(ctx: ActionContext, id: string): Promise<Message | undefined> {
  const cached = await ctx.cache.getMessage(id)
  if (cached) return cached
  try {
    return await ctx.provider.getMessage(id)
  } catch (e) {
    if (e instanceof EmailProviderError && e.code === 'not_found') return undefined
    throw e
  }
}

/** Lists exactly what a change would touch. Changes nothing. */
export async function previewChange(ctx: ActionContext, change: EmailChange, messageIds: string[]): Promise<BulkPreview> {
  const ids = [...new Set(messageIds)]
  const rows: PreviewRow[] = []
  const unchanged: string[] = []
  const missing: string[] = []
  for (const id of ids) {
    const m = await load(ctx, id)
    if (!m) { missing.push(id); continue }
    const before = stateOf(m)
    const after = applyToState(before, change)
    if (sameState(before, after)) unchanged.push(id)
    else rows.push({ messageId: id, subject: m.subject, before, after })
  }
  const remaining = (ctx.turn ?? new TurnCeiling()).remaining()
  return { change, rows, unchanged, missing, overCeiling: rows.length > Math.min(BULK_CEILING_PER_TURN, remaining), needsConfirmation: rows.length > 1 }
}

async function callProvider(provider: EmailProvider, change: EmailChange, ids: string[]): Promise<void> {
  switch (change.type) {
    case 'move': return provider.move(ids, change.folderId)
    case 'label': return provider.label(ids, change.folderId, change.add)
    case 'flag': return provider.flag(ids, change.starred)
    case 'read': return provider.markRead(ids, change.read)
  }
}

/** Mirror the provider's truth for these messages into the cache. */
async function refresh(ctx: ActionContext, ids: string[]): Promise<void> {
  const fresh: Message[] = []
  for (const id of ids) fresh.push(await ctx.provider.getMessage(id))
  await ctx.cache.upsertMessages(fresh)
}

/**
 * Applies a change and logs it with its pre-image. More than one affected message needs `confirmed: true` (the caller
 * gets the preview first from `previewChange`); more than the ceiling is refused outright, even when confirmed.
 * Returns undefined when nothing would change.
 */
export async function applyChange(
  ctx: ActionContext, change: EmailChange, messageIds: string[], opts: { confirmed?: boolean } = {},
): Promise<EmailAction | undefined> {
  const preview = await previewChange(ctx, change, messageIds)
  if (preview.rows.length === 0) return undefined
  if (preview.overCeiling) {
    throw new EmailActionError('ceiling', `${preview.rows.length} messages is more than the ${Math.min(BULK_CEILING_PER_TURN, (ctx.turn ?? new TurnCeiling()).remaining())} allowed in one turn`)
  }
  if (preview.needsConfirmation && !opts.confirmed) {
    throw new EmailActionError('needs_confirmation', `${preview.rows.length} messages: preview and confirm first`)
  }
  const ids = preview.rows.map((r) => r.messageId)
  if (ctx.turn && !ctx.turn.take(ids.length)) throw new EmailActionError('ceiling', 'turn ceiling reached')
  await callProvider(ctx.provider, change, ids)
  await refresh(ctx, ids)
  const entries: ActionEntry[] = []
  for (const r of preview.rows) {
    const now = await ctx.cache.getMessage(r.messageId)
    entries.push({ messageId: r.messageId, before: r.before, after: now ? stateOf(now) : r.after })
  }
  return ctx.log.append({ accountId: ctx.provider.account.id, at: (ctx.now ?? (() => new Date().toISOString()))(), change, entries })
}

/** Restores each message's pre-image, unless the message has changed since the action or is gone: those are reported. */
export async function undoAction(ctx: ActionContext, actionId: string): Promise<UndoResult> {
  const action = ctx.log.get(actionId)
  if (!action) throw new EmailActionError('not_found', `no action ${actionId}`)
  if (action.undoneAt) throw new EmailActionError('already_undone', `action ${actionId} was already undone`)
  const restored: string[] = []
  const conflicts: UndoConflict[] = []
  for (const e of action.entries) {
    let current: Message
    try {
      current = await ctx.provider.getMessage(e.messageId)
    } catch (err) {
      if (err instanceof EmailProviderError && err.code === 'not_found') { conflicts.push({ messageId: e.messageId, reason: 'not_found' }); continue }
      throw err
    }
    if (!sameState(stateOf(current), e.after)) { conflicts.push({ messageId: e.messageId, reason: 'changed_since' }); continue }
    const id = [e.messageId]
    const cur = stateOf(current)
    if (!sameState({ ...cur, read: e.before.read, starred: e.before.starred }, { ...e.before })) {
      const [first, ...rest] = e.before.folderIds
      if (first !== undefined) {
        await ctx.provider.move(id, first)
        for (const f of rest) await ctx.provider.label(id, f, true)
      }
    }
    if (cur.read !== e.before.read) await ctx.provider.markRead(id, e.before.read)
    if (cur.starred !== e.before.starred) await ctx.provider.flag(id, e.before.starred)
    restored.push(e.messageId)
  }
  await refresh(ctx, restored)
  if (restored.length > 0) ctx.log.markUndone(actionId, (ctx.now ?? (() => new Date().toISOString()))())
  return { actionId, restored, conflicts }
}
