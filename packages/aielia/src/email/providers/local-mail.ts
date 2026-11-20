import type { Account, Folder, Message, Thread } from '../model.js'
type FolderKind = Folder['kind']
import { EmailProviderError, type ChangeSet, type DraftInput, type EmailProvider, type MessageChange, type Page, type PageOptions, type SearchQuery } from '../provider.js'
import {
  LocalSourceError, classifyLocalFolder, type LocalMailboxRow, type LocalMailSource, type LocalMessageFilter, type LocalMessageRow, type LocalRecipientRow, type LocalRowState,
} from '../local-source.js'
import { parseMail } from './imap-mime.js'
import { base64ToUtf8 } from './mime.js'

/**
 * An `EmailProvider` over the mail a desktop mail program has already downloaded (plans/aielia_email_capabilities_plan.html, section 8, D2).
 * It reads through a `LocalMailSource` (Rust over Apple Mail's local store), so no sign-in is needed. Honest limits, each visible to callers:
 *
 *  - It holds only what the program downloaded. There is no server to ask, so `search` covers subject and sender (what Mail's own index
 *    holds), and the shared search treats such an account as having no server (`isLocalOnlyAccount`).
 *  - Reading is the default. Changes (move, read, flag, drafts) go through an optional `LocalMailActions` (Mail's own automation); without it
 *    they are refused with a plain reason. Sending and deleting are never done here: the user does those in the mail program.
 *  - Ids: message `a<ROWID>`, folder `m<mailbox ROWID>`, thread `c<conversation id>`. The RFC Message-ID stays in the headers. (The plan
 *    said the Message-ID would be the id; one message can sit in several mailboxes as separate rows, so the row id is the safe key.)
 *
 * No `node:*` and no DOM imports.
 */

export interface LocalMessageRef { rowid: number; messageIdHeader?: string; accountId: string; mailboxPath: string[] }

export interface LocalMailActions {
  move(refs: LocalMessageRef[], destPath: string[]): Promise<void>
  setRead(refs: LocalMessageRef[], read: boolean): Promise<void>
  setFlagged(refs: LocalMessageRef[], flagged: boolean): Promise<void>
  /** Save a draft in the program's Drafts (never send). */
  createDraft(accountId: string, draft: DraftInput, fromAddress: string): Promise<void>
}

export interface LocalMailProviderOptions {
  /** Aielia's account record (`provider: 'apple_mail'`). */
  account: Account
  source: LocalMailSource
  /** The mail program's own id for the account (the UUID in its mailbox urls). Only its mailboxes are used. */
  localAccountId: string
  actions?: LocalMailActions
  /** Messages whose bodies are read at once (default 8). */
  concurrency?: number
  /** Folder kinds the name table did not know, decided once per account (`resolveFolderKinds`). Keyed by `path.join('/')`. */
  folderKinds?: ReadonlyMap<string, FolderKind>
}

const DEFAULT_LIMIT = 50
const KEPT_HEADERS = ['message-id', 'in-reply-to', 'references', 'list-unsubscribe', 'list-id', 'authentication-results', 'reply-to']

/** True for accounts read from a local mail program: they have no server to search. */
export const isLocalOnlyAccount = (a: Pick<Account, 'provider'>): boolean => a.provider === 'apple_mail'

const iso = (sec: number): string => new Date(sec * 1000).toISOString()
const epoch = (isoDate: string | undefined): number | undefined => {
  if (!isoDate) return undefined
  const t = Date.parse(isoDate)
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000)
}
const idOf = (rowid: number): string => `a${rowid}`
const rowOfId = (id: string): number | undefined => (/^a\d+$/.test(id) ? Number(id.slice(1)) : undefined)
const folderId = (rowid: number): string => `m${rowid}`
const threadIdOf = (r: Pick<LocalMessageRow, 'conversationId' | 'rowid'>): string => (r.conversationId > 0 ? `c${r.conversationId}` : `r${r.rowid}`)

const refused = (what: string): EmailProviderError =>
  new EmailProviderError('invalid_argument', `Aielia reads this account through your mail program and cannot ${what} yet. Do it in the mail program itself.`)

export class LocalMailProvider implements EmailProvider {
  readonly account: Account
  private readonly src: LocalMailSource
  private readonly acct: string
  private readonly actions?: LocalMailActions
  private readonly conc: number
  private readonly folderKinds: ReadonlyMap<string, FolderKind>
  private boxes: Promise<LocalMailboxRow[]> | undefined
  /** Per-message state at recent change tokens, so a later call can say what changed. Lost on restart, which asks for a resync (cheap, local). */
  private baselines = new Map<string, Map<number, string>>()

  constructor(o: LocalMailProviderOptions) {
    this.account = o.account
    this.src = o.source
    this.acct = o.localAccountId
    this.actions = o.actions
    this.conc = Math.max(1, o.concurrency ?? 8)
    this.folderKinds = o.folderKinds ?? new Map()
  }

  private async myBoxes(): Promise<LocalMailboxRow[]> {
    this.boxes ??= this.src.mailboxes().then((all) => all.filter((b) => b.accountId === this.acct))
    this.boxes.catch(() => { this.boxes = undefined })
    return this.boxes
  }
  /** A mailbox list is cheap to re-read and its counts change; the cache is dropped on every folder listing. */
  private async freshBoxes(): Promise<LocalMailboxRow[]> {
    this.boxes = undefined
    return this.myBoxes()
  }

  private async requireBox(id: string): Promise<LocalMailboxRow> {
    const n = /^m(\d+)$/.exec(id)
    const box = n ? (await this.myBoxes()).find((b) => b.rowid === Number(n[1])) : undefined
    if (!box) throw new EmailProviderError('not_found', `No folder ${id}.`)
    return box
  }

  private kindOf(path: readonly string[]): FolderKind {
    const k = classifyLocalFolder(path)
    return k === 'custom' ? (this.folderKinds.get(path.join('/')) ?? 'custom') : k
  }

  private toFolder(b: LocalMailboxRow): Folder {
    return { id: folderId(b.rowid), accountId: this.account.id, providerId: b.path.join('/'), name: b.path[b.path.length - 1] ?? '', kind: this.kindOf(b.path), unreadCount: Math.max(0, b.unread) }
  }

  async listFolders(): Promise<Folder[]> {
    return (await this.freshBoxes()).filter((b) => b.scheme === 'imap' || b.scheme === 'local').map((b) => this.toFolder(b))
  }

  /** Rows to messages: headers from the row, everything else from the program's own copy of the message. A body Mail never downloaded shows headers only. */
  private async build(rows: LocalMessageRow[]): Promise<Message[]> {
    const boxes = await this.myBoxes()
    const boxById = new Map(boxes.map((b) => [b.rowid, b]))
    let recips: LocalRecipientRow[] = []
    const out: Message[] = new Array(rows.length)
    for (let i = 0; i < rows.length; i += this.conc) {
      const chunk = rows.slice(i, i + this.conc)
      const done = await Promise.all(chunk.map(async (r) => {
        try { return { raw: await this.src.body(r.rowid), error: undefined } } catch (e) { return { raw: undefined, error: e } }
      }))
      for (let k = 0; k < chunk.length; k++) {
        const r = chunk[k]!, d = done[k]!
        if (d.error && !(d.error instanceof LocalSourceError && (d.error.code === 'body_not_on_this_computer' || d.error.code === 'message_not_found'))) throw d.error
        const parsed = d.raw ? parseMail(base64ToUtf8(d.raw.rawBase64)) : undefined
        const missing = !d.raw || d.raw.partial
        if (!parsed && recips.length === 0) recips = await this.src.recipients(rows.map((x) => x.rowid))
        const own = recips.filter((x) => x.message === r.rowid)
        const box = boxById.get(r.mailbox)
        const headers: Record<string, string> = {}
        for (const h of KEPT_HEADERS) if (parsed?.headers[h]) headers[h] = parsed.headers[h]!
        if (!headers['message-id'] && r.messageIdHeader) headers['message-id'] = r.messageIdHeader
        if (missing) headers['x-aielia-body'] = 'not-downloaded'
        const kind = box ? this.kindOf(box.path) : 'custom'
        out[i + k] = {
          id: idOf(r.rowid), accountId: this.account.id, threadId: threadIdOf(r), providerId: String(r.rowid), folderIds: [folderId(r.mailbox)],
          from: parsed && parsed.from.address !== 'unknown@invalid' ? parsed.from : { address: r.sender ?? 'unknown@invalid', ...(r.senderName ? { name: r.senderName } : {}) },
          to: parsed?.to.length ? parsed.to : own.filter((x) => x.kind === 0).map((x) => ({ address: x.address, ...(x.name ? { name: x.name } : {}) })),
          cc: parsed?.cc.length ? parsed.cc : own.filter((x) => x.kind === 1).map((x) => ({ address: x.address, ...(x.name ? { name: x.name } : {}) })),
          subject: `${r.subjectPrefix ?? ''}${r.subject}`, date: iso(r.dateReceived), headers, textBody: missing ? (parsed?.textBody ?? '') : parsed!.textBody,
          attachments: parsed?.attachments ?? [], flags: { read: r.read, starred: r.flagged, draft: kind === 'drafts' },
        }
      }
    }
    return out
  }

  private async page(filter: LocalMessageFilter, opts: PageOptions): Promise<Page<LocalMessageRow>> {
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, 500))
    const offset = opts.pageToken?.startsWith('o') ? Number(opts.pageToken.slice(1)) : 0
    if (!Number.isInteger(offset) || offset < 0) throw new EmailProviderError('invalid_argument', 'unknown page token')
    const since = epoch(opts.since)
    const p = await this.src.messages({ ...filter, ...(since !== undefined ? { since: Math.max(since, filter.since ?? 0) } : {}), limit, offset })
    return { items: p.items, ...(offset + limit < p.total ? { nextPageToken: `o${offset + limit}` } : {}) }
  }

  async listMessages(folder: string, opts: PageOptions = {}): Promise<Page<Message>> {
    const box = await this.requireBox(folder)
    const p = await this.page({ mailboxIds: [box.rowid] }, opts)
    return { items: await this.build(p.items), ...(p.nextPageToken ? { nextPageToken: p.nextPageToken } : {}) }
  }

  private threadOf(rows: LocalMessageRow[]): Thread {
    const sorted = [...rows].sort((a, b) => a.dateReceived - b.dateReceived || a.rowid - b.rowid)
    const people = new Map<string, { address: string; name?: string }>()
    for (const r of sorted) if (r.sender && !people.has(r.sender.toLowerCase())) people.set(r.sender.toLowerCase(), { address: r.sender, ...(r.senderName ? { name: r.senderName } : {}) })
    const last = sorted[sorted.length - 1]!
    return {
      id: threadIdOf(last), accountId: this.account.id, providerId: String(last.conversationId), subject: `${sorted[0]!.subjectPrefix ?? ''}${sorted[0]!.subject}`,
      messageIds: sorted.map((r) => idOf(r.rowid)), folderIds: [...new Set(sorted.map((r) => folderId(r.mailbox)))], participants: [...people.values()],
      lastMessageAt: iso(last.dateReceived), unread: sorted.some((r) => !r.read),
    }
  }

  async listThreads(folder: string, opts: PageOptions = {}): Promise<Page<Thread>> {
    const box = await this.requireBox(folder)
    const since = epoch(opts.since)
    const all = await this.src.messages({ mailboxIds: [box.rowid], ...(since !== undefined ? { since } : {}), limit: 2000 })
    const groups = new Map<string, LocalMessageRow[]>()
    for (const r of all.items) groups.set(threadIdOf(r), [...(groups.get(threadIdOf(r)) ?? []), r])
    const threads = [...groups.values()].map((g) => this.threadOf(g)).sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : a.lastMessageAt > b.lastMessageAt ? -1 : a.id < b.id ? -1 : 1))
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, 500))
    const start = opts.pageToken?.startsWith('o') ? Number(opts.pageToken.slice(1)) : 0
    if (!Number.isInteger(start) || start < 0) throw new EmailProviderError('invalid_argument', 'unknown page token')
    return { items: threads.slice(start, start + limit), ...(start + limit < threads.length ? { nextPageToken: `o${start + limit}` } : {}) }
  }

  async getMessage(messageId: string): Promise<Message> {
    const rowid = rowOfId(messageId)
    const row = rowid === undefined ? null : await this.src.message(rowid)
    if (!row || row.deleted || !(await this.myBoxes()).some((b) => b.rowid === row.mailbox)) throw new EmailProviderError('not_found', `No message ${messageId}.`)
    return (await this.build([row]))[0]!
  }

  async getThread(threadId: string): Promise<{ thread: Thread; messages: Message[] }> {
    let rows: LocalMessageRow[] = []
    const conv = /^c(\d+)$/.exec(threadId), single = /^r(\d+)$/.exec(threadId)
    if (conv) rows = (await this.src.messages({ conversationId: Number(conv[1]), limit: 2000 })).items
    else if (single) { const r = await this.src.message(Number(single[1])); if (r && !r.deleted) rows = [r] }
    const mine = new Set((await this.myBoxes()).map((b) => b.rowid))
    rows = rows.filter((r) => mine.has(r.mailbox))
    if (rows.length === 0) throw new EmailProviderError('not_found', `No thread ${threadId}.`)
    const messages = (await this.build(rows)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
    return { thread: this.threadOf(rows), messages }
  }

  /** Subject and sender (what the program's own index holds); the body is not searched here. */
  async search(q: SearchQuery, opts: PageOptions = {}): Promise<Page<Message>> {
    const box = q.folderId ? await this.requireBox(q.folderId) : undefined
    const mine = (await this.myBoxes()).map((b) => b.rowid)
    const after = epoch(q.after), before = epoch(q.before)
    const p = await this.page({
      mailboxIds: box ? [box.rowid] : mine, ...(q.text ? { text: q.text } : {}), ...(q.from ? { from: q.from } : {}), ...(q.unreadOnly ? { unreadOnly: true } : {}),
      ...(after !== undefined ? { since: after } : {}), ...(before !== undefined ? { before: before + 1 } : {}),
    }, opts)
    return { items: await this.build(p.items), ...(p.nextPageToken ? { nextPageToken: p.nextPageToken } : {}) }
  }

  // ---- changes go through the program's own automation, or are refused ----
  private async refs(messageIds: string[]): Promise<LocalMessageRef[]> {
    const boxes = await this.myBoxes()
    const out: LocalMessageRef[] = []
    for (const id of messageIds) {
      const rowid = rowOfId(id)
      const row = rowid === undefined ? null : await this.src.message(rowid)
      const box = row ? boxes.find((b) => b.rowid === row.mailbox) : undefined
      if (!row || !box || row.deleted) throw new EmailProviderError('not_found', `No message ${id}.`)
      out.push({ rowid: row.rowid, ...(row.messageIdHeader ? { messageIdHeader: row.messageIdHeader } : {}), accountId: this.acct, mailboxPath: box.path })
    }
    return out
  }

  async move(messageIds: string[], folder: string): Promise<void> {
    if (!this.actions) throw refused('move mail')
    const box = await this.requireBox(folder)
    await this.actions.move(await this.refs(messageIds), box.path)
  }
  async label(_messageIds: string[], _folder: string, _add: boolean): Promise<void> {
    throw refused('add labels (folders hold a message in one place here: use move)')
  }
  async flag(messageIds: string[], starred: boolean): Promise<void> {
    if (!this.actions) throw refused('flag mail')
    await this.actions.setFlagged(await this.refs(messageIds), starred)
  }
  async markRead(messageIds: string[], read: boolean): Promise<void> {
    if (!this.actions) throw refused('mark mail read')
    await this.actions.setRead(await this.refs(messageIds), read)
  }
  async createDraft(draft: DraftInput): Promise<Message> {
    if (!this.actions) throw refused('save drafts')
    await this.actions.createDraft(this.acct, draft, this.account.address)
    // The program writes the draft into its own store a moment later; this is what was asked for, not a stored message.
    const now = new Date().toISOString()
    return {
      id: `draft:${now}`, accountId: this.account.id, threadId: draft.threadId ?? `draft:${now}`, providerId: 'draft', folderIds: [], from: { address: this.account.address, name: this.account.displayName },
      to: draft.to, cc: draft.cc ?? [], subject: draft.subject, date: now, headers: {}, textBody: draft.textBody, attachments: [], flags: { read: true, starred: false, draft: true },
    }
  }
  async send(_draftId: string): Promise<Message> {
    throw new EmailProviderError('invalid_argument', 'Aielia does not send from your mail program. The draft is saved there: open it and send it yourself.')
  }
  async delete(_messageIds: string[]): Promise<void> {
    throw new EmailProviderError('invalid_argument', 'Deleting is always done in your mail program itself.')
  }

  // ---- change detection ----
  private tokenOf(m: { count: number; maxRowid: number; fingerprint: number }): string {
    return `L1:${m.count}:${m.maxRowid}:${m.fingerprint}`
  }
  private async remember(token: string): Promise<void> {
    this.baselines.set(token, new Map((await this.src.states()).map((s: LocalRowState) => [s[0], s.slice(1).join(',')])))
    while (this.baselines.size > 3) this.baselines.delete(this.baselines.keys().next().value as string)
  }

  async listChanges(syncToken?: string): Promise<ChangeSet> {
    const token = this.tokenOf(await this.src.state())
    if (syncToken === undefined) {
      await this.remember(token)
      return { changes: [], syncToken: token, fullResyncNeeded: false }
    }
    const base = this.baselines.get(syncToken)
    if (!/^L1:\d+:\d+:-?\d+$/.test(syncToken) || (!base && syncToken !== token)) {
      await this.remember(token)
      return { changes: [], syncToken: token, fullResyncNeeded: true }
    }
    if (syncToken === token) return { changes: [], syncToken: token, fullResyncNeeded: false }
    const boxes = new Set((await this.myBoxes()).map((b) => b.rowid))
    const now = new Map((await this.src.states()).map((s: LocalRowState) => [s[0], s]))
    const changes: MessageChange[] = []
    for (const [rowid, s] of now) {
      const mine = boxes.has(s[4])
      const before = base!.get(rowid)
      const cur = s.slice(1).join(',')
      if (!mine) { if (before !== undefined) changes.push({ type: 'delete', messageId: idOf(rowid) }); continue }
      if (s[3] === 1) { if (before !== undefined) changes.push({ type: 'delete', messageId: idOf(rowid) }); continue }
      if (before !== cur) changes.push({ type: 'upsert', messageId: idOf(rowid) })
    }
    for (const rowid of base!.keys()) if (!now.has(rowid)) changes.push({ type: 'delete', messageId: idOf(rowid) })
    await this.remember(token)
    return { changes, syncToken: token, fullResyncNeeded: false }
  }
}
