import {
  EmailActionError, applyChange, previewChange, undoAction,
  type ActionContext, type BulkPreview, type EmailAction, type EmailChange, type UndoResult,
} from './action-log.js'
import type { Account, Folder } from './model.js'
import type { MailToolDefinition } from './mail-tools.js'
import { evaluateToolPolicy, mailToolClass, type ToolPolicyControlState, type ToolPolicyResult } from '../tool-policy.js'

/**
 * Reversible organising tools (A7, plan section 6, second class): move, label, archive, mark read or unread, flag, snooze,
 * on top of the action log (F10). One message runs at once and carries an action id the user can undo; more than one message
 * is never run by the model: it becomes a pending preview, and only `confirmPending` (called by the surface when the user
 * accepts) runs it. The confirmation is a separate function the model cannot reach, never a tool argument, so a tricked tool
 * call has nothing to flip. A turn that already ran one change previews the next, so splitting a bulk change into single calls
 * does not get round the preview. A call proposed after the turn read mail text is staged with its origin, as the policy says.
 * Results shown to the model carry counts and ids, never subjects. No `node:*`, no DOM imports, no LLM client.
 */

export const MAIL_ORGANISE_TOOL_NAMES = ['mail_move', 'mail_label', 'mail_archive', 'mail_mark_read', 'mail_flag', 'mail_snooze'] as const
export type MailOrganiseToolName = (typeof MAIL_ORGANISE_TOOL_NAMES)[number]

const IDS = { type: 'array', items: { type: 'string' }, description: 'Message ids.' }
export const MAIL_ORGANISE_TOOLS: MailToolDefinition[] = [
  { name: 'mail_move', description: 'Move messages so their only folder is the given folder. Cannot move to Trash (deleting always asks). One message runs with an Undo; several are shown to the user as a preview first.', input_schema: { type: 'object', properties: { messageIds: IDS, folder: { type: 'string', description: 'Folder name or id.' } }, required: ['messageIds', 'folder'] } },
  { name: 'mail_label', description: 'Add or remove a label (folder membership) on messages. Several messages are previewed to the user first.', input_schema: { type: 'object', properties: { messageIds: IDS, folder: { type: 'string' }, add: { type: 'boolean', description: 'Default true.' } }, required: ['messageIds', 'folder'] } },
  { name: 'mail_archive', description: 'Move messages to the archive. Several messages are previewed to the user first.', input_schema: { type: 'object', properties: { messageIds: IDS }, required: ['messageIds'] } },
  { name: 'mail_mark_read', description: 'Mark messages read or unread. Several messages are previewed to the user first.', input_schema: { type: 'object', properties: { messageIds: IDS, read: { type: 'boolean', description: 'Default true.' } }, required: ['messageIds'] } },
  { name: 'mail_flag', description: 'Star or unstar messages. Several messages are previewed to the user first.', input_schema: { type: 'object', properties: { messageIds: IDS, starred: { type: 'boolean', description: 'Default true.' } }, required: ['messageIds'] } },
  { name: 'mail_snooze', description: 'Hide messages from the inbox until a time (ISO timestamp), then bring them back. Several messages are previewed to the user first.', input_schema: { type: 'object', properties: { messageIds: IDS, until: { type: 'string', description: 'ISO timestamp.' } }, required: ['messageIds', 'until'] } },
]

export function isMailOrganiseTool(name: string): name is MailOrganiseToolName {
  return (MAIL_ORGANISE_TOOL_NAMES as readonly string[]).includes(name)
}

export interface SnoozeRecord { messageId: string; until: string; actionId: string; returnFolderId: string }

/** Snoozes the provider has no native call for: kept here, woken by `wakeDueSnoozes`. */
export class SnoozeStore {
  private rows: SnoozeRecord[] = []
  add(r: SnoozeRecord): void { this.rows.push(structuredClone(r)) }
  list(): SnoozeRecord[] { return structuredClone(this.rows) }
  due(now: string): SnoozeRecord[] { return structuredClone(this.rows.filter((r) => r.until <= now)) }
  remove(messageId: string): void { this.rows = this.rows.filter((r) => r.messageId !== messageId) }
}

/** What waits for the user: a bulk change, or one staged because the turn had read mail text. */
export interface PendingChange {
  id: string
  tool: MailOrganiseToolName
  change: EmailChange
  messageIds: string[]
  /** For the user's preview (rows carry subjects). Never put in model-facing text. */
  preview: BulkPreview
  reason: 'bulk' | 'untrusted_origin' | 'second_change_in_turn'
  snoozeUntil?: string
}

export class OrganiseSession {
  private pending = new Map<string, PendingChange>()
  private seq = 0
  /** Changes this turn already ran on their own. */
  singlesRun = 0
  add(p: Omit<PendingChange, 'id'>): PendingChange {
    const full = { ...p, id: `pending-${++this.seq}` }
    this.pending.set(full.id, structuredClone(full))
    return structuredClone(full)
  }
  get(id: string): PendingChange | undefined { const p = this.pending.get(id); return p ? structuredClone(p) : undefined }
  list(): PendingChange[] { return structuredClone([...this.pending.values()]) }
  drop(id: string): boolean { return this.pending.delete(id) }
  /** Call at the start of each turn. */
  newTurn(): void { this.singlesRun = 0 }
}

export interface OrganiseDeps {
  account: Account
  action: ActionContext
  session: OrganiseSession
  snoozes: SnoozeStore
  controlState?: ToolPolicyControlState
  origin?: 'user' | 'untrusted_mail'
}

export type OrganiseStatus = 'applied' | 'preview' | 'staged' | 'denied' | 'error'
export interface OrganiseResult {
  status: OrganiseStatus
  /** For the model: counts and ids only, never subjects. */
  text: string
  actionId?: string
  pending?: PendingChange
  gate: ToolPolicyResult
}

const nowOf = (d: OrganiseDeps): string => (d.action.now ?? (() => new Date().toISOString()))()
const err = (gate: ToolPolicyResult, text: string): OrganiseResult => ({ status: 'error', text, gate })

async function folderByRef(d: OrganiseDeps, ref: unknown): Promise<Folder | undefined> {
  if (typeof ref !== 'string' || !ref.trim()) return undefined
  const folders = await d.action.cache.getFolders(d.account.id)
  return folders.find((f) => f.id === ref) ?? folders.find((f) => f.name.toLowerCase() === ref.trim().toLowerCase())
}

function idsOf(args: Record<string, unknown>): string[] {
  return Array.isArray(args.messageIds) ? [...new Set(args.messageIds.filter((x): x is string => typeof x === 'string' && x.length > 0))] : []
}

export async function runMailOrganiseTool(name: string, args: Record<string, unknown>, d: OrganiseDeps): Promise<OrganiseResult> {
  const gate = evaluateToolPolicy({ toolName: name, riskHint: 'LOW', controlState: d.controlState, origin: d.origin })
  if (mailToolClass(name) !== 'reversible' || !isMailOrganiseTool(name)) return err(gate, `${name} is not a reversible organising tool`)
  if (gate.decision === 'DENY') return { status: 'denied', text: `${name} was not run: ${gate.reason}`, gate }
  // `confirmed` and similar arguments are ignored on purpose: only confirmPending can run a previewed change.
  const ids = idsOf(args)
  if (ids.length === 0) return err(gate, 'No message ids given.')

  let change: EmailChange
  let snoozeUntil: string | undefined
  const folders = await d.action.cache.getFolders(d.account.id)
  switch (name) {
    case 'mail_move': case 'mail_label': {
      const f = await folderByRef(d, args.folder)
      if (!f) return err(gate, `No folder "${String(args.folder ?? '')}".`)
      if (f.kind === 'trash') return err(gate, 'Moving to Trash is a delete, which always asks the user; it is not available here.')
      change = name === 'mail_move' ? { type: 'move', folderId: f.id } : { type: 'label', folderId: f.id, add: args.add !== false }
      break
    }
    case 'mail_archive': {
      const f = folders.find((x) => x.kind === 'archive')
      if (!f) return err(gate, 'This account has no archive folder.')
      change = { type: 'move', folderId: f.id }
      break
    }
    case 'mail_mark_read': change = { type: 'read', read: args.read !== false }; break
    case 'mail_flag': change = { type: 'flag', starred: args.starred !== false }; break
    case 'mail_snooze': {
      const until = typeof args.until === 'string' ? args.until : ''
      if (!until || Number.isNaN(Date.parse(until))) return err(gate, 'mail_snooze needs `until` as an ISO timestamp.')
      if (Date.parse(until) <= Date.parse(nowOf(d))) return err(gate, '`until` must be in the future.')
      const f = folders.find((x) => x.kind === 'archive') ?? folders.find((x) => x.kind === 'custom')
      if (!f) return err(gate, 'This account has no folder to hold snoozed mail.')
      change = { type: 'move', folderId: f.id }
      snoozeUntil = until
      break
    }
  }

  const preview = await previewChange(d.action, change, ids)
  if (preview.rows.length === 0) {
    return { status: 'applied', text: `Nothing to change: ${preview.unchanged.length} already as asked, ${preview.missing.length} not found.`, gate }
  }
  if (preview.overCeiling) return err(gate, `${preview.rows.length} messages is more than one turn may change; narrow the request.`)

  const reason: PendingChange['reason'] | undefined =
    gate.decision === 'REQUIRE_APPROVAL' ? 'untrusted_origin'
      : preview.needsConfirmation ? 'bulk'
        : d.session.singlesRun >= 1 ? 'second_change_in_turn' : undefined
  if (reason) {
    const pending = d.session.add({ tool: name, change, messageIds: preview.rows.map((r) => r.messageId), preview, reason, ...(snoozeUntil ? { snoozeUntil } : {}) })
    const why = reason === 'untrusted_origin' ? 'it was proposed after reading mail, so it needs approval' : 'it needs the user to look at the preview first'
    return { status: reason === 'untrusted_origin' ? 'staged' : 'preview', pending, gate, text: `${preview.rows.length} message(s) are waiting for the user (${pending.id}): ${why}. Nothing has changed yet.` }
  }
  return runNow(d, name, change, preview.rows.map((r) => r.messageId), snoozeUntil, gate)
}

async function runNow(d: OrganiseDeps, tool: MailOrganiseToolName, change: EmailChange, ids: string[], snoozeUntil: string | undefined, gate: ToolPolicyResult, confirmed = false): Promise<OrganiseResult> {
  let action: EmailAction | undefined
  let returnFolderId = 'inbox'
  try {
    if (snoozeUntil) {
      const m = await d.action.cache.getMessage(ids[0]!)
      returnFolderId = m?.folderIds[0] ?? returnFolderId
    }
    action = await applyChange(d.action, change, ids, { confirmed })
  } catch (e) {
    if (e instanceof EmailActionError) return err(gate, e.message)
    throw e
  }
  if (!action) return { status: 'applied', text: 'Nothing to change.', gate }
  if (!confirmed) d.session.singlesRun++
  if (snoozeUntil) for (const e of action.entries) d.snoozes.add({ messageId: e.messageId, until: snoozeUntil, actionId: action.id, returnFolderId: e.before.folderIds[0] ?? returnFolderId })
  return { status: 'applied', actionId: action.id, gate, text: `${tool} changed ${action.entries.length} message(s) (action ${action.id}). The user can undo it.` }
}

/** The user accepted a preview or staged change in the surface. The only way a pending change runs. */
export async function confirmPending(d: OrganiseDeps, pendingId: string): Promise<OrganiseResult> {
  const p = d.session.get(pendingId)
  const gate: ToolPolicyResult = { decision: 'ALLOW', reason: 'approved by the user' }
  if (!p) return err(gate, `No pending change ${pendingId}.`)
  d.session.drop(pendingId)
  // Re-preview: mail may have changed since the user looked; only what still changes is applied.
  const result = await runNow(d, p.tool, p.change, p.messageIds, p.snoozeUntil, gate, true)
  return result
}

export function rejectPending(session: OrganiseSession, pendingId: string): boolean {
  return session.drop(pendingId)
}

/** Brings snoozed mail back to where it was. Logged like any change, so it can be undone. */
export async function wakeDueSnoozes(d: Pick<OrganiseDeps, 'action' | 'snoozes'>): Promise<EmailAction[]> {
  const out: EmailAction[] = []
  const now = (d.action.now ?? (() => new Date().toISOString()))()
  for (const s of d.snoozes.due(now)) {
    const a = await applyChange(d.action, { type: 'move', folderId: s.returnFolderId }, [s.messageId])
    d.snoozes.remove(s.messageId)
    if (a) out.push(a)
  }
  return out
}

/** `/email undo [id]` (shared): undoes one action, or the newest not yet undone. Also forgets snoozes the undo reverses. */
export async function runEmailUndo(d: Pick<OrganiseDeps, 'action' | 'snoozes'>, actionId?: string): Promise<{ lines: string[]; result?: UndoResult }> {
  const target = actionId ? d.action.log.get(actionId) : d.action.log.latestUndoable()
  if (!target) return { lines: [actionId ? `No change ${actionId}.` : 'Nothing to undo.'] }
  try {
    const result = await undoAction(d.action, target.id)
    for (const m of result.restored) if (d.snoozes.list().some((s) => s.messageId === m && s.actionId === target.id)) d.snoozes.remove(m)
    const lines = [`Undid ${target.id}: ${result.restored.length} message(s) restored.`]
    if (result.conflicts.length) lines.push(`${result.conflicts.length} left alone because they changed since or are gone.`)
    return { lines, result }
  } catch (e) {
    if (e instanceof EmailActionError) return { lines: [e.message] }
    throw e
  }
}
