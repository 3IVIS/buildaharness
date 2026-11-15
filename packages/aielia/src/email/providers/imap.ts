import type { Account, Folder, FolderKind, Message, Thread } from '../model.js'
import {
  EmailProviderError, type ChangeSet, type DraftInput, type EmailProvider, type MessageChange, type Page, type PageOptions, type SearchQuery,
} from '../provider.js'
import { buildRawMessage, type ParsedAddress } from './mime.js'
import { parseHeaders, parseMail } from './imap-mime.js'
import {
  decodeMailboxName, encodeMailboxName, fetchItems, imapDate, imapQuote, parseList, parseUntagged, responseCode, uidSet, type ImapToken,
} from './imap-wire.js'

/**
 * An `EmailProvider` over IMAP and SMTP (Email, phase H6a). The transport (Rust on the desktop, a fixture server in
 * tests) owns the connection, TLS and credentials; this class owns what the protocol means:
 * - Folder roles come from the SPECIAL-USE attribute, with name fallbacks. IMAP has folders, not labels: `label` copies
 *   a message into a folder and removing a label removes the copy.
 * - A message's id is its Message-ID header, so it stays the same when a message moves between folders (UIDs do not).
 * - A thread id is the first Message-ID in References (else In-Reply-To, else the message's own id): threads are built
 *   from headers because most servers have no THREAD extension.
 * - A changed UIDVALIDITY for a folder makes `listChanges` ask for a full resync. The sync token carries the (uid, flag,
 *   id) triples of the newest `windowSize` messages per folder so that deletions can be reported with their ids.
 * Every operation opens one or two short connections; a server that rate-limits logins will need a session pool later.
 */

export interface ImapCommand { command: string; literal?: string }
export interface ImapTransport {
  /** Log in, run the commands in order on one connection, return one raw response per command. */
  run(commands: ImapCommand[]): Promise<string[]>
  /** Submit a message over SMTP. `data` has no Bcc header; `recipients` includes the blind copies. */
  sendMail(m: { from: string; recipients: string[]; data: string }): Promise<void>
}

export interface ImapProviderOptions {
  account: Account
  transport: ImapTransport
  /** File a copy in Sent after SMTP (servers that do it themselves, like Gmail, set this false). Default true. */
  appendToSent?: boolean
  /** Newest messages per folder considered for threads and sync tokens. Default 500. */
  windowSize?: number
  now?: () => Date
  newId?: () => string
}

const DEFAULT_LIMIT = 50
const HEADER_FIELDS = 'MESSAGE-ID REFERENCES IN-REPLY-TO SUBJECT FROM TO CC DATE LIST-UNSUBSCRIBE LIST-ID AUTHENTICATION-RESULTS REPLY-TO'
const KEEP_HEADERS = ['message-id', 'in-reply-to', 'references', 'list-unsubscribe', 'list-id', 'authentication-results', 'reply-to']
const FLAG_BITS = { seen: 1, flagged: 2, draft: 4 }

const bare = (s: string): string => s.trim().replace(/^<+|>+$/g, '')

interface FolderRec { path: string; raw: string; delimiter: string | null; kind: FolderKind; name: string }
interface Entry { path: string; uid: number; validity: string; bits: number; head: string; internalDate?: string }

function bitsOf(flags: ImapToken | undefined): number {
  if (!Array.isArray(flags)) return 0
  const f = flags.map((x) => String(x).toLowerCase())
  return (f.includes('\\seen') ? FLAG_BITS.seen : 0) | (f.includes('\\flagged') ? FLAG_BITS.flagged : 0) | (f.includes('\\draft') ? FLAG_BITS.draft : 0)
}

const SPECIAL_USE: Record<string, FolderKind> = { '\\sent': 'sent', '\\drafts': 'drafts', '\\trash': 'trash', '\\archive': 'archive', '\\all': 'archive' }
const NAME_FALLBACK: Record<string, FolderKind> = {
  sent: 'sent', 'sent items': 'sent', 'sent mail': 'sent', 'sent messages': 'sent',
  drafts: 'drafts', draft: 'drafts',
  trash: 'trash', 'deleted items': 'trash', 'deleted messages': 'trash', bin: 'trash',
  archive: 'archive', archives: 'archive',
}

/** Folder roles: SPECIAL-USE first, then names for the roles no folder claimed. Exported for tests. */
export function classifyFolders(entries: Array<{ attrs: string[]; delimiter: string | null; path: string }>): FolderRec[] {
  const recs: FolderRec[] = []
  for (const e of entries) {
    if (e.attrs.includes('\\noselect') || e.attrs.includes('\\nonexistent')) continue
    const path = decodeMailboxName(e.path)
    const name = e.delimiter ? path.split(e.delimiter).pop() || path : path
    let kind: FolderKind | undefined = path.toUpperCase() === 'INBOX' ? 'inbox' : undefined
    for (const a of e.attrs) kind ??= SPECIAL_USE[a]
    recs.push({ path, raw: e.path, delimiter: e.delimiter, kind: kind ?? 'custom', name })
  }
  const claimed = new Set(recs.filter((r) => r.kind !== 'custom').map((r) => r.kind))
  for (const r of recs) {
    if (r.kind !== 'custom') continue
    const k = NAME_FALLBACK[r.name.toLowerCase()]
    if (k && !claimed.has(k)) {
      r.kind = k
      claimed.add(k)
    }
  }
  return recs
}

export class ImapEmailProvider implements EmailProvider {
  readonly account: Account
  private t: ImapTransport
  private appendToSent: boolean
  private windowSize: number
  private now: () => Date
  private newId: () => string
  private folderCache?: FolderRec[]
  private capCache?: Set<string>

  constructor(o: ImapProviderOptions) {
    this.account = structuredClone(o.account)
    this.t = o.transport
    this.appendToSent = o.appendToSent ?? true
    this.windowSize = o.windowSize ?? 500
    this.now = o.now ?? (() => new Date())
    this.newId = o.newId ?? (() => `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`)
  }

  // ---- folders and capabilities ------------------------------------------------------------------------------------

  private async folderRecs(refresh = false): Promise<FolderRec[]> {
    if (!this.folderCache || refresh) {
      const [r] = await this.t.run([{ command: 'LIST "" "*"' }])
      this.folderCache = classifyFolders(parseList(r))
    }
    return this.folderCache
  }

  private async requireFolder(id: string): Promise<FolderRec> {
    let f = (await this.folderRecs()).find((x) => x.path === id)
    if (!f) f = (await this.folderRecs(true)).find((x) => x.path === id)
    if (!f) throw new EmailProviderError('not_found', `no such folder: ${id}`)
    return f
  }

  private async kindFolder(kind: FolderKind): Promise<FolderRec> {
    const f = (await this.folderRecs()).find((x) => x.kind === kind)
    if (!f) throw new EmailProviderError('unavailable', `this account has no ${kind} folder`)
    return f
  }

  private async caps(): Promise<Set<string>> {
    if (!this.capCache) {
      const [r] = await this.t.run([{ command: 'CAPABILITY' }])
      const u = parseUntagged(r).find((x) => x.name === 'CAPABILITY')
      this.capCache = new Set((u?.rest ?? []).filter((x): x is string => typeof x === 'string').map((x) => x.toUpperCase()))
    }
    return this.capCache
  }

  private q(path: string): string {
    return imapQuote(encodeMailboxName(path))
  }

  async listFolders(): Promise<Folder[]> {
    const recs = await this.folderRecs(true)
    const res = recs.length ? await this.t.run(recs.map((r) => ({ command: `STATUS ${this.q(r.path)} (UNSEEN)` }))) : []
    return recs.map((r, i) => {
      const st = parseUntagged(res[i] ?? '').find((u) => u.name === 'STATUS')
      const list = st?.rest[1]
      let unread = 0
      if (Array.isArray(list)) for (let k = 0; k + 1 < list.length; k += 2) if (String(list[k]).toUpperCase() === 'UNSEEN') unread = Number(list[k + 1]) || 0
      const parent = r.delimiter && r.path.includes(r.delimiter) ? r.path.slice(0, r.path.lastIndexOf(r.delimiter)) : undefined
      return { id: r.path, accountId: this.account.id, providerId: r.raw, name: r.name, kind: r.kind, ...(parent ? { parentId: parent } : {}), unreadCount: unread }
    })
  }

  // ---- low-level reads ---------------------------------------------------------------------------------------------

  /** All UIDs in a folder, newest first, plus its UIDVALIDITY. */
  private async uidsOf(f: FolderRec, criteria = 'ALL'): Promise<{ uids: number[]; validity: string }> {
    const [sel, res] = await this.t.run([{ command: `EXAMINE ${this.q(f.path)}` }, { command: `UID SEARCH ${criteria}` }])
    const s = parseUntagged(res).find((u) => u.name === 'SEARCH')
    const uids = (s?.rest ?? []).map((x) => Number(x)).filter((n) => Number.isFinite(n)).sort((a, b) => b - a)
    return { uids, validity: responseCode(sel, 'UIDVALIDITY') ?? '0' }
  }

  private async fetchEntries(f: FolderRec, uids: number[], items: string): Promise<Array<Entry & { raw?: string }>> {
    if (!uids.length) return []
    const [sel, res] = await this.t.run([{ command: `EXAMINE ${this.q(f.path)}` }, { command: `UID FETCH ${uidSet(uids)} (UID FLAGS INTERNALDATE ${items})` }])
    const validity = responseCode(sel, 'UIDVALIDITY') ?? '0'
    const out: Array<Entry & { raw?: string }> = []
    for (const u of parseUntagged(res)) {
      if (u.name !== 'FETCH') continue
      const m = fetchItems(u)
      const uid = Number(m.get('UID'))
      if (!uid) continue
      const body = [...m.entries()].find(([k]) => k.startsWith('BODY['))?.[1]
      const text = typeof body === 'string' ? body : ''
      out.push({ path: f.path, uid, validity, bits: bitsOf(m.get('FLAGS')), head: items.includes('HEADER.FIELDS') ? text : text.split(/\r?\n\r?\n/)[0], internalDate: typeof m.get('INTERNALDATE') === 'string' ? (m.get('INTERNALDATE') as string) : undefined, raw: items.includes('HEADER.FIELDS') ? undefined : text })
    }
    return out
  }

  private fetchHeaders(f: FolderRec, uids: number[]): Promise<Entry[]> {
    return this.fetchEntries(f, uids, `BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})]`)
  }

  private idOf(e: Entry): string {
    const mid = parseHeaders(e.head)['message-id']
    return mid ? bare(mid) : `imap:${e.path}:${e.validity}:${e.uid}`
  }
  private rootOf(e: Entry): string {
    const h = parseHeaders(e.head)
    const first = (v?: string) => /<([^<>\s]+)>/.exec(v ?? '')?.[1]
    return first(h['references']) ?? first(h['in-reply-to']) ?? this.idOf(e)
  }

  /** Search every folder with each criterion in one connection, then confirm the hits by their headers. */
  private async findEntries(criteria: string[], only?: FolderRec[]): Promise<Entry[][]> {
    const recs = only ?? (await this.folderRecs())
    const cmds: ImapCommand[] = []
    for (const r of recs) {
      cmds.push({ command: `EXAMINE ${this.q(r.path)}` })
      for (const c of criteria) cmds.push({ command: `UID SEARCH ${c}` })
    }
    const res = cmds.length ? await this.t.run(cmds) : []
    const hits = new Map<string, number[]>() // path -> uids
    const perCrit: Array<Array<{ path: string; uid: number }>> = criteria.map(() => [])
    let k = 0
    for (const r of recs) {
      k++
      criteria.forEach((_c, ci) => {
        const s = parseUntagged(res[k++] ?? '').find((u) => u.name === 'SEARCH')
        for (const x of s?.rest ?? []) {
          const uid = Number(x)
          if (!Number.isFinite(uid)) continue
          perCrit[ci].push({ path: r.path, uid })
          hits.set(r.path, [...(hits.get(r.path) ?? []), uid])
        }
      })
    }
    const entries = new Map<string, Entry>()
    for (const r of recs) {
      const uids = hits.get(r.path)
      if (uids?.length) for (const e of await this.fetchHeaders(r, [...new Set(uids)])) entries.set(`${e.path}\n${e.uid}`, e)
    }
    return perCrit.map((list) => list.map((h) => entries.get(`${h.path}\n${h.uid}`)).filter((e): e is Entry => !!e))
  }

  private idCriterion(id: string): string {
    return `HEADER Message-ID ${imapQuote(id)}`
  }

  /** Every copy of each message, by id. A missing id is `undefined` in its slot. */
  private async locate(ids: string[]): Promise<Array<Entry[] | undefined>> {
    const out: Array<Entry[] | undefined> = ids.map(() => undefined)
    const real = ids.map((id, i) => ({ id, i })).filter((x) => !x.id.startsWith('imap:'))
    if (real.length) {
      const found = await this.findEntries(real.map((x) => this.idCriterion(x.id)))
      real.forEach((x, n) => {
        const exact = found[n].filter((e) => this.idOf(e) === x.id)
        if (exact.length) out[x.i] = exact
      })
    }
    for (const [i, id] of ids.entries()) {
      if (!id.startsWith('imap:')) continue
      const [, path, validity, uid] = /^imap:(.*):(\d+):(\d+)$/.exec(id) ?? []
      if (!path) continue
      const f = (await this.folderRecs()).find((r) => r.path === path)
      if (!f) continue
      const e = (await this.fetchHeaders(f, [Number(uid)])).find((x) => x.validity === validity)
      if (e) out[i] = [e]
    }
    return out
  }

  private async locateAll(ids: string[]): Promise<Entry[][]> {
    const r = await this.locate(ids)
    const miss = r.findIndex((x) => !x)
    if (miss >= 0) throw new EmailProviderError('not_found', `no such message: ${ids[miss]}`)
    return r as Entry[][]
  }

  // ---- record building ---------------------------------------------------------------------------------------------

  private toMessage(e: Entry & { raw?: string }, folderIds: string[]): Message {
    const mail = parseMail(e.raw ?? e.head)
    const id = this.idOf(e)
    const h = mail.headers
    const headers: Record<string, string> = {}
    for (const k of KEEP_HEADERS) if (h[k]) headers[k] = h[k]
    const dated = new Date(h['date'] ?? '')
    const internal = new Date(e.internalDate ?? '')
    const date = !Number.isNaN(dated.getTime()) ? dated : !Number.isNaN(internal.getTime()) ? internal : new Date(0)
    return {
      id, accountId: this.account.id, threadId: this.rootOf(e), providerId: `${e.path}|${e.validity}|${e.uid}`, folderIds,
      from: mail.from, to: mail.to, cc: mail.cc, subject: mail.subject, date: date.toISOString(), headers,
      textBody: mail.textBody, attachments: mail.attachments, flags: { read: !!(e.bits & FLAG_BITS.seen), starred: !!(e.bits & FLAG_BITS.flagged), draft: !!(e.bits & FLAG_BITS.draft) },
    }
  }

  private async fullMessages(entries: Entry[], folderIdsFor: (id: string) => string[]): Promise<Message[]> {
    const byPath = new Map<string, Entry[]>()
    for (const e of entries) byPath.set(e.path, [...(byPath.get(e.path) ?? []), e])
    const out: Message[] = []
    for (const [path, list] of byPath) {
      const f = await this.requireFolder(path)
      for (const e of await this.fetchEntries(f, list.map((x) => x.uid), 'BODY.PEEK[]')) out.push(this.toMessage(e, folderIdsFor(this.idOf(e))))
    }
    const order = new Map(entries.map((e, i) => [`${e.path}\n${e.uid}`, i]))
    return out.sort((a, b) => (order.get(`${a.providerId.split('|')[0]}\n${a.providerId.split('|')[2]}`) ?? 0) - (order.get(`${b.providerId.split('|')[0]}\n${b.providerId.split('|')[2]}`) ?? 0))
  }

  private threadOf(root: string, msgs: Array<{ id: string; entry: Entry }>, folderIds: string[]): Thread {
    const sorted = [...msgs].sort((a, b) => dateOf(a.entry) - dateOf(b.entry))
    const first = parseMail(sorted[0].entry.head)
    const people: ParsedAddress[] = []
    for (const m of sorted) {
      const p = parseMail(m.entry.head)
      for (const a of [p.from, ...p.to]) if (!people.some((x) => x.address.toLowerCase() === a.address.toLowerCase())) people.push(a)
    }
    const last = sorted[sorted.length - 1].entry
    return {
      id: root, accountId: this.account.id, providerId: root, subject: first.subject, messageIds: sorted.map((m) => m.id), folderIds,
      participants: people.slice(0, 8), lastMessageAt: new Date(dateOf(last)).toISOString(), unread: sorted.some((m) => !(m.entry.bits & FLAG_BITS.seen)),
    }
  }

  // ---- reads -------------------------------------------------------------------------------------------------------

  private pageStart(token: string | undefined, prefix: string): string | undefined {
    if (token === undefined) return undefined
    if (!token.startsWith(prefix)) throw new EmailProviderError('invalid_argument', 'unknown page token')
    return token.slice(prefix.length)
  }

  async listMessages(folderId: string, opts: PageOptions = {}): Promise<Page<Message>> {
    const f = await this.requireFolder(folderId)
    const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT)
    const { uids, validity } = await this.uidsOf(f)
    let rest = uids
    const cur = this.pageStart(opts.pageToken, 'u')
    if (cur !== undefined) {
      const [v, last] = cur.split(':')
      if (v !== validity || !/^\d+$/.test(last ?? '')) throw new EmailProviderError('invalid_argument', 'the page token is out of date')
      rest = uids.filter((u) => u < Number(last))
    }
    const take = rest.slice(0, limit)
    const items = (await this.fetchEntries(f, take, 'BODY.PEEK[]')).sort((a, b) => b.uid - a.uid).map((e) => this.toMessage(e, [f.path]))
    return { items, ...(rest.length > take.length ? { nextPageToken: `u${validity}:${take[take.length - 1]}` } : {}) }
  }

  async listThreads(folderId: string, opts: PageOptions = {}): Promise<Page<Thread>> {
    const f = await this.requireFolder(folderId)
    const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT)
    const { uids } = await this.uidsOf(f)
    const heads = await this.fetchHeaders(f, uids.slice(0, this.windowSize))
    const groups = new Map<string, Array<{ id: string; entry: Entry }>>()
    for (const e of heads) {
      const root = this.rootOf(e)
      groups.set(root, [...(groups.get(root) ?? []), { id: this.idOf(e), entry: e }])
    }
    const threads = [...groups].map(([root, msgs]) => this.threadOf(root, msgs, [f.path])).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt) || a.id.localeCompare(b.id))
    const start = Number(this.pageStart(opts.pageToken, 'o') ?? 0)
    if (!Number.isInteger(start) || start < 0) throw new EmailProviderError('invalid_argument', 'unknown page token')
    const items = threads.slice(start, start + limit)
    return { items, ...(start + limit < threads.length ? { nextPageToken: `o${start + limit}` } : {}) }
  }

  async getMessage(messageId: string): Promise<Message> {
    const [locs] = await this.locateAll([messageId])
    const [m] = await this.fullMessages([locs[0]], () => [...new Set(locs.map((l) => l.path))])
    return m
  }

  private async threadMembers(threadId: string): Promise<Array<{ id: string; entries: Entry[] }>> {
    const q = imapQuote(threadId)
    const [hits] = await this.findEntries([`OR OR HEADER Message-ID ${q} HEADER References ${q} HEADER In-Reply-To ${q}`])
    const byId = new Map<string, Entry[]>()
    for (const e of hits) if (this.rootOf(e) === threadId) byId.set(this.idOf(e), [...(byId.get(this.idOf(e)) ?? []), e])
    return [...byId].map(([id, entries]) => ({ id, entries }))
  }

  async getThread(threadId: string): Promise<{ thread: Thread; messages: Message[] }> {
    const members = await this.threadMembers(threadId)
    if (!members.length) throw new EmailProviderError('not_found', `no such thread: ${threadId}`)
    const folderIds = [...new Set(members.flatMap((m) => m.entries.map((e) => e.path)))]
    const messages = await this.fullMessages(members.map((m) => m.entries[0]), (id) => [...new Set(members.find((m) => m.id === id)!.entries.map((e) => e.path))])
    messages.sort((a, b) => a.date.localeCompare(b.date))
    const thread = this.threadOf(threadId, members.map((m) => ({ id: m.id, entry: m.entries[0] })), folderIds)
    return { thread, messages }
  }

  async search(query: SearchQuery, opts: PageOptions = {}): Promise<Page<Message>> {
    const parts: string[] = []
    const text = (s: string) => {
      if (!/^[\x20-\x7e]*$/.test(s)) throw new EmailProviderError('invalid_argument', 'search text must be plain ASCII for IMAP')
      return imapQuote(s)
    }
    if (query.text) parts.push(`TEXT ${text(query.text)}`)
    if (query.from) parts.push(`FROM ${text(query.from)}`)
    if (query.unreadOnly) parts.push('UNSEEN')
    if (query.after) parts.push(`SINCE ${imapDate(query.after)}`)
    if (query.before) parts.push(`BEFORE ${imapDate(new Date(Date.parse(query.before) + 86_400_000).toISOString())}`)
    const only = query.folderId ? [await this.requireFolder(query.folderId)] : undefined
    const [hits] = await this.findEntries([parts.length ? parts.join(' ') : 'ALL'], only)
    const byId = new Map<string, Entry[]>()
    for (const e of hits) byId.set(this.idOf(e), [...(byId.get(this.idOf(e)) ?? []), e])
    const ordered = [...byId].sort((a, b) => dateOf(b[1][0]) - dateOf(a[1][0]) || a[0].localeCompare(b[0]))
    const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT)
    const start = Number(this.pageStart(opts.pageToken, 'o') ?? 0)
    if (!Number.isInteger(start) || start < 0) throw new EmailProviderError('invalid_argument', 'unknown page token')
    const slice = ordered.slice(start, start + limit)
    const items = await this.fullMessages(slice.map(([, es]) => es[0]), (id) => [...new Set(byId.get(id)!.map((e) => e.path))])
    return { items, ...(start + limit < ordered.length ? { nextPageToken: `o${start + limit}` } : {}) }
  }

  // ---- writes ------------------------------------------------------------------------------------------------------

  private groupByPath(entries: Entry[]): Map<string, number[]> {
    const m = new Map<string, number[]>()
    for (const e of entries) m.set(e.path, [...(m.get(e.path) ?? []), e.uid])
    return m
  }

  private async storeFlag(ids: string[], flag: string, on: boolean): Promise<void> {
    const locs = (await this.locateAll(ids)).flat()
    const cmds: ImapCommand[] = []
    for (const [path, uids] of this.groupByPath(locs)) cmds.push({ command: `SELECT ${this.q(path)}` }, { command: `UID STORE ${uidSet(uids)} ${on ? '+' : '-'}FLAGS.SILENT (${flag})` })
    if (cmds.length) await this.t.run(cmds)
  }

  flag(messageIds: string[], starred: boolean): Promise<void> {
    return this.storeFlag(messageIds, '\\Flagged', starred)
  }
  markRead(messageIds: string[], read: boolean): Promise<void> {
    return this.storeFlag(messageIds, '\\Seen', read)
  }

  private async removeCmds(path: string, uids: number[]): Promise<ImapCommand[]> {
    const set = uidSet(uids)
    const uidplus = (await this.caps()).has('UIDPLUS')
    return [
      { command: `SELECT ${this.q(path)}` },
      { command: `UID STORE ${set} +FLAGS.SILENT (\\Deleted)` },
      { command: uidplus ? `UID EXPUNGE ${set}` : 'EXPUNGE' },
    ]
  }

  private async moveCmds(path: string, uids: number[], dest: FolderRec): Promise<ImapCommand[]> {
    const set = uidSet(uids)
    if ((await this.caps()).has('MOVE')) return [{ command: `SELECT ${this.q(path)}` }, { command: `UID MOVE ${set} ${this.q(dest.path)}` }]
    return [{ command: `SELECT ${this.q(path)}` }, { command: `UID COPY ${set} ${this.q(dest.path)}` }, ...(await this.removeCmds(path, uids)).slice(1)]
  }

  /** Make `dest` hold the message and nothing else: the first copy moves, the others are removed. */
  private async relocate(copies: Entry[][], dest: FolderRec): Promise<void> {
    const moves: Entry[] = []
    const removes: Entry[] = []
    for (const cs of copies) {
      const inDest = cs.some((c) => c.path === dest.path)
      const others = cs.filter((c) => c.path !== dest.path)
      if (!inDest && others.length) moves.push(others[0])
      removes.push(...(inDest ? others : others.slice(1)))
    }
    const cmds: ImapCommand[] = []
    for (const [p, u] of this.groupByPath(moves)) cmds.push(...(await this.moveCmds(p, u, dest)))
    for (const [p, u] of this.groupByPath(removes)) cmds.push(...(await this.removeCmds(p, u)))
    if (cmds.length) await this.t.run(cmds)
  }

  async move(messageIds: string[], folderId: string): Promise<void> {
    const dest = await this.requireFolder(folderId)
    await this.relocate(await this.locateAll(messageIds), dest)
  }

  async label(messageIds: string[], folderId: string, add: boolean): Promise<void> {
    const f = await this.requireFolder(folderId)
    const copies = await this.locateAll(messageIds)
    const cmds: ImapCommand[] = []
    if (add) {
      const todo = copies.filter((cs) => !cs.some((c) => c.path === f.path)).map((cs) => cs[0])
      for (const [p, u] of this.groupByPath(todo)) cmds.push({ command: `SELECT ${this.q(p)}` }, { command: `UID COPY ${uidSet(u)} ${this.q(f.path)}` })
    } else {
      const todo = copies.flat().filter((c) => c.path === f.path)
      for (const [p, u] of this.groupByPath(todo)) cmds.push(...(await this.removeCmds(p, u)))
    }
    if (cmds.length) await this.t.run(cmds)
  }

  async delete(messageIds: string[]): Promise<void> {
    const trash = await this.kindFolder('trash')
    const copies = await this.locateAll(messageIds)
    const inTrash = copies.filter((cs) => cs.some((c) => c.path === trash.path))
    const rest = copies.filter((cs) => !cs.some((c) => c.path === trash.path))
    const cmds: ImapCommand[] = []
    for (const [p, u] of this.groupByPath(inTrash.flat())) cmds.push(...(await this.removeCmds(p, u)))
    await this.relocate(rest, trash)
    if (cmds.length) await this.t.run(cmds)
  }

  private composeRaw(d: DraftInput, id: string, inReplyTo?: string, references?: string): string {
    const from: ParsedAddress = { address: this.account.address, ...(this.account.displayName ? { name: this.account.displayName } : {}) }
    const raw = buildRawMessage({ to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, textBody: d.textBody, from, inReplyTo, references })
    return `Message-ID: <${id}>\r\nDate: ${this.now().toUTCString()}\r\n${raw}`
  }

  async createDraft(draft: DraftInput): Promise<Message> {
    if (!draft.to.length || draft.to.some((a) => !/^[^\s<>,]+@[^\s<>,]+$/.test(a.address))) throw new EmailProviderError('invalid_argument', 'a draft needs at least one valid recipient')
    let inReplyTo: string | undefined
    let references: string | undefined
    if (draft.threadId) {
      const members = await this.threadMembers(draft.threadId)
      if (!members.length) throw new EmailProviderError('not_found', `no such thread: ${draft.threadId}`)
      const last = [...members].sort((a, b) => dateOf(b.entries[0]) - dateOf(a.entries[0]))[0]
      inReplyTo = `<${last.id}>`
      references = `<${draft.threadId}>`
    }
    const drafts = await this.kindFolder('drafts')
    const id = `${this.newId()}@aielia.local`
    await this.t.run([{ command: `APPEND ${this.q(drafts.path)} (\\Draft \\Seen)`, literal: this.composeRaw(draft, id, inReplyTo, references) }])
    return this.getMessage(id)
  }

  async send(draftId: string): Promise<Message> {
    const [copies] = await this.locateAll([draftId])
    const drafts = await this.kindFolder('drafts')
    const copy = copies.find((c) => c.path === drafts.path && c.bits & FLAG_BITS.draft)
    if (!copy) throw new EmailProviderError('invalid_argument', 'only a draft can be sent')
    const [full] = await this.fetchEntries(drafts, [copy.uid], 'BODY.PEEK[]')
    const raw = full?.raw ?? ''
    const mail = parseMail(raw)
    const bcc = parseAddressesOf(raw, 'bcc')
    const recipients = [...mail.to, ...mail.cc, ...bcc].map((a) => a.address)
    if (!recipients.length) throw new EmailProviderError('invalid_argument', 'the draft has no recipients')
    const data = raw.replace(/^(bcc:[^\r\n]*(\r?\n[ \t][^\r\n]*)*\r?\n)/im, '')
    try {
      await this.t.sendMail({ from: this.account.address, recipients, data })
    } catch (e) {
      if (e instanceof EmailProviderError) throw e
      throw new EmailProviderError('unavailable', 'the mail server did not accept the message')
    }
    // From here the mail is out: never report a failure for the bookkeeping that follows.
    try {
      if (this.appendToSent) {
        const sent = await this.kindFolder('sent')
        await this.t.run([{ command: `APPEND ${this.q(sent.path)} (\\Seen)`, literal: raw }])
        await this.t.run(await this.removeCmds(drafts.path, [copy.uid]))
        return await this.getMessage(draftId)
      }
      await this.t.run(await this.removeCmds(drafts.path, [copy.uid]))
    } catch {
      /* the message was sent; the copy in Sent or the draft clean-up is retried on the next sync */
    }
    return this.toMessage({ ...copy, bits: FLAG_BITS.seen, raw }, [])
  }

  // ---- changes -----------------------------------------------------------------------------------------------------

  private async snapshot(): Promise<Snapshot> {
    const recs = await this.folderRecs(true)
    const snap: Snapshot = {}
    if (!recs.length) return snap
    const cmds: ImapCommand[] = []
    for (const r of recs) cmds.push({ command: `EXAMINE ${this.q(r.path)}` }, { command: `UID FETCH 1:* (UID FLAGS BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])` })
    const res = await this.t.run(cmds)
    recs.forEach((r, i) => {
      const validity = responseCode(res[i * 2], 'UIDVALIDITY') ?? '0'
      const e: Array<[number, number, string]> = []
      for (const u of parseUntagged(res[i * 2 + 1])) {
        if (u.name !== 'FETCH') continue
        const m = fetchItems(u)
        const uid = Number(m.get('UID'))
        if (!uid) continue
        const body = [...m.entries()].find(([k]) => k.startsWith('BODY['))?.[1]
        const mid = typeof body === 'string' ? parseHeaders(body)['message-id'] : undefined
        e.push([uid, bitsOf(m.get('FLAGS')), mid ? bare(mid) : `imap:${r.path}:${validity}:${uid}`])
      }
      e.sort((a, b) => b[0] - a[0])
      snap[r.path] = { v: validity, e: e.slice(0, this.windowSize) }
    })
    return snap
  }

  async listChanges(syncToken?: string): Promise<ChangeSet> {
    const fresh = await this.snapshot()
    const token = (s: Snapshot) => TOKEN_PREFIX + JSON.stringify(s)
    if (syncToken === undefined) return { changes: [], syncToken: token(fresh), fullResyncNeeded: false }
    let old: Snapshot | undefined
    try {
      if (syncToken.startsWith(TOKEN_PREFIX)) old = JSON.parse(syncToken.slice(TOKEN_PREFIX.length)) as Snapshot
    } catch {
      old = undefined
    }
    if (!old || typeof old !== 'object') return { changes: [], syncToken: token(fresh), fullResyncNeeded: true }
    for (const [path, o] of Object.entries(old)) if (fresh[path] && fresh[path].v !== o.v) return { changes: [], syncToken: token(fresh), fullResyncNeeded: true }
    const sig = (s: Snapshot) => {
      const m = new Map<string, string[]>()
      for (const [path, f] of Object.entries(s)) for (const [uid, bits, id] of f.e) m.set(id, [...(m.get(id) ?? []), `${path}:${uid}:${bits}`].sort())
      return m
    }
    const before = sig(old)
    const after = sig(fresh)
    const changes: MessageChange[] = []
    for (const [id, s] of after) if (before.get(id)?.join('|') !== s.join('|')) changes.push({ type: 'upsert', messageId: id })
    for (const id of before.keys()) if (!after.has(id)) changes.push({ type: 'delete', messageId: id })
    return { changes, syncToken: token(fresh), fullResyncNeeded: false }
  }
}

const TOKEN_PREFIX = 'imap1:'
type Snapshot = Record<string, { v: string; e: Array<[number, number, string]> }>

function dateOf(e: Entry): number {
  const d = Date.parse(parseHeaders(e.head)['date'] ?? '')
  if (!Number.isNaN(d)) return d
  const i = Date.parse(e.internalDate ?? '')
  return Number.isNaN(i) ? 0 : i
}

function parseAddressesOf(raw: string, header: string): ParsedAddress[] {
  const head = raw.split(/\r?\n\r?\n/)[0]
  const v = parseHeaders(head)[header]
  return v ? v.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const m = /<([^<>]+)>/.exec(x); return { address: (m ? m[1] : x).trim() } }) : []
}

