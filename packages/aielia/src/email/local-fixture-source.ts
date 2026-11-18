import { LocalSourceError, type LocalBody, type LocalDiscovery, type LocalMailboxRow, type LocalMailSource, type LocalMessageFilter, type LocalMessagePage, type LocalMessageRow, type LocalRecipientRow, type LocalRowState, type LocalStateMark } from './local-source.js'
import type { Message } from './model.js'
import type { SyntheticMailbox } from './synthetic-mailbox.js'
import { utf8ToBase64 } from './providers/mime.js'

/**
 * An in-memory `LocalMailSource` built from a synthetic mailbox, behaving like the Rust reader over Apple Mail's store: rows by ROWID, folders
 * as mailboxes, Mail's own conversation ids, bodies as raw RFC 822, deleted rows hidden, a few bodies "not downloaded". Used by the provider
 * conformance run, the capability tests and the first-run preview. Test hooks mutate it the way Mail would. No `node:*` and no DOM imports.
 */

export const FIXTURE_LOCAL_ACCOUNT = '11111111-2222-3333-4444-555555555555'

interface Row extends LocalMessageRow { to: Array<{ address: string; name?: string }>; cc: Array<{ address: string; name?: string }>; raw: string; bodyMissing: boolean }

const rfc = (iso: string): string => new Date(iso).toUTCString()
const addr = (a: { address: string; name?: string }): string => (a.name ? `"${a.name.replace(/["\\]/g, '')}" <${a.address}>` : a.address)

function rawOf(m: Message, id: string, refs?: string): string {
  const head = [
    `From: ${addr(m.from)}`, `To: ${m.to.map(addr).join(', ')}`, ...(m.cc.length ? [`Cc: ${m.cc.map(addr).join(', ')}`] : []),
    `Subject: ${m.subject}`, `Date: ${rfc(m.date)}`, `Message-ID: ${id}`,
    ...(refs ? [`In-Reply-To: ${refs}`, `References: ${refs}`] : []),
    ...Object.entries(m.headers).filter(([k]) => !['message-id', 'in-reply-to', 'references'].includes(k.toLowerCase())).map(([k, v]) => `${k}: ${v}`),
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
  ]
  return `${head.join('\r\n')}\r\n\r\n${utf8ToBase64(m.textBody).replace(/(.{76})/g, '$1\r\n')}`
}

export class FixtureLocalSource implements LocalMailSource {
  private boxes: LocalMailboxRow[]
  private rows = new Map<number, Row>()
  private recips: LocalRecipientRow[] = []
  private next = 1
  /** Counts of calls, for tests that check what was and was not read. */
  readonly calls = { body: 0, messages: 0 }
  unavailable: LocalDiscovery['reason'] | undefined

  constructor(mb: SyntheticMailbox, opts: { accountId?: string; partialEvery?: number } = {}) {
    const accountId = opts.accountId ?? FIXTURE_LOCAL_ACCOUNT
    const boxOf = new Map<string, number>()
    this.boxes = mb.folders.map((f, i) => {
      boxOf.set(f.id, i + 1)
      return { rowid: i + 1, accountId, scheme: 'imap', path: [f.name], total: 0, unread: 0 }
    })
    const convOf = new Map<string, number>()
    for (const t of mb.threads) convOf.set(t.id, convOf.size + 100)
    const sorted = [...mb.messages].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
    const firstOfThread = new Map<string, string>()
    for (const m of sorted) {
      const rowid = this.next++
      const id = m.headers['message-id'] ?? `<${m.id}@example.com>`
      const parent = firstOfThread.get(m.threadId)
      if (!parent) firstOfThread.set(m.threadId, id)
      this.rows.set(rowid, {
        rowid, messageIdHeader: id, conversationId: convOf.get(m.threadId) ?? 0, mailbox: boxOf.get(m.folderIds[0]!) ?? 1, subjectPrefix: null, subject: m.subject,
        sender: m.from.address, senderName: m.from.name ?? null, dateReceived: Math.floor(Date.parse(m.date) / 1000), dateSent: Math.floor(Date.parse(m.date) / 1000) - 5,
        read: m.flags.read, flagged: m.flags.starred, deleted: false, flags: 0, size: m.textBody.length, to: m.to, cc: m.cc,
        raw: rawOf(m, id, parent), bodyMissing: opts.partialEvery ? rowid % opts.partialEvery === 0 : false,
      })
      m.to.forEach((t, i) => this.recips.push({ message: rowid, address: t.address, name: t.name ?? null, kind: 0, position: i }))
      m.cc.forEach((t, i) => this.recips.push({ message: rowid, address: t.address, name: t.name ?? null, kind: 1, position: i }))
    }
    this.recount()
  }

  private recount(): void {
    for (const b of this.boxes) {
      const mine = [...this.rows.values()].filter((r) => r.mailbox === b.rowid && !r.deleted)
      b.total = mine.length
      b.unread = mine.filter((r) => !r.read).length
    }
  }

  // ---- test hooks: what Mail does while we are reading ----
  markRead(rowid: number, read: boolean): void { this.rows.get(rowid)!.read = read }
  moveTo(rowid: number, mailbox: number): void { this.rows.get(rowid)!.mailbox = mailbox; this.recount() }
  remove(rowid: number): void { this.rows.get(rowid)!.deleted = true; this.recount() }
  deliver(o: { mailbox: number; subject: string; from: string; text: string; conversationId?: number; dateReceived?: number }): number {
    const rowid = this.next++
    const id = `<delivered-${rowid}@example.net>`
    const m = { from: { address: o.from }, to: [{ address: 'owner@example.org' }], cc: [], subject: o.subject, date: new Date((o.dateReceived ?? 1_800_000_000) * 1000).toISOString(), headers: {}, textBody: o.text } as unknown as Message
    this.rows.set(rowid, {
      rowid, messageIdHeader: id, conversationId: o.conversationId ?? rowid + 10_000, mailbox: o.mailbox, subjectPrefix: null, subject: o.subject, sender: o.from, senderName: null,
      dateReceived: o.dateReceived ?? 1_800_000_000, dateSent: null, read: false, flagged: false, deleted: false, flags: 0, size: o.text.length, to: [{ address: 'owner@example.org' }], cc: [],
      raw: rawOf(m, id), bodyMissing: false,
    })
    this.recount()
    return rowid
  }
  boxByName(name: string): number { return this.boxes.find((b) => b.path[b.path.length - 1] === name)!.rowid }
  rowidOfHeader(header: string): number | undefined { return [...this.rows.values()].find((r) => r.messageIdHeader === header)?.rowid }

  // ---- the port ----
  async discover(): Promise<LocalDiscovery> {
    if (this.unavailable) return { available: false, reason: this.unavailable, accounts: [], messageCount: 0 }
    const live = [...this.rows.values()].filter((r) => !r.deleted)
    return { available: true, layout: 'V10', accounts: [{ id: this.boxes[0]!.accountId, scheme: 'imap', mailboxes: this.boxes.length, messages: live.length }], messageCount: live.length }
  }
  async mailboxes(): Promise<LocalMailboxRow[]> { return structuredClone(this.boxes) }
  private page(f: LocalMessageFilter): LocalMessagePage {
    let r = [...this.rows.values()].filter((x) => !x.deleted)
    if (f.mailboxIds) r = r.filter((x) => f.mailboxIds!.includes(x.mailbox))
    if (f.conversationId !== undefined) r = r.filter((x) => x.conversationId === f.conversationId)
    if (f.since !== undefined) r = r.filter((x) => x.dateReceived >= f.since!)
    if (f.before !== undefined) r = r.filter((x) => x.dateReceived < f.before!)
    if (f.afterRowid !== undefined) r = r.filter((x) => x.rowid > f.afterRowid!)
    if (f.unreadOnly) r = r.filter((x) => !x.read)
    const t = f.text?.trim().toLowerCase()
    if (t) r = r.filter((x) => `${x.subject}\n${x.sender ?? ''}\n${x.senderName ?? ''}`.toLowerCase().includes(t))
    const fr = f.from?.trim().toLowerCase()
    if (fr) r = r.filter((x) => `${x.sender ?? ''} ${x.senderName ?? ''}`.toLowerCase().includes(fr))
    r.sort((a, b) => b.dateReceived - a.dateReceived || b.rowid - a.rowid)
    const offset = Math.max(0, f.offset ?? 0), limit = Math.min(2000, Math.max(1, f.limit ?? 100))
    const strip = ({ to: _t, cc: _c, raw: _r, bodyMissing: _b, ...row }: Row): LocalMessageRow => row
    return { items: r.slice(offset, offset + limit).map(strip), total: r.length }
  }
  async messages(f: LocalMessageFilter): Promise<LocalMessagePage> { this.calls.messages++; return structuredClone(this.page(f)) }
  async message(rowid: number): Promise<LocalMessageRow | null> {
    const r = this.rows.get(rowid)
    if (!r) return null
    const { to: _t, cc: _c, raw: _r, bodyMissing: _b, ...row } = r
    return structuredClone(row)
  }
  async recipients(rowids: number[]): Promise<LocalRecipientRow[]> { return structuredClone(this.recips.filter((x) => rowids.includes(x.message))) }
  async state(): Promise<LocalStateMark> {
    const all = [...this.rows.values()]
    return { count: all.length, maxRowid: Math.max(0, ...all.map((r) => r.rowid)), fingerprint: all.reduce((s, r) => s + ((r.read ? 1 : 0) + 1) * 3 + ((r.flagged ? 1 : 0) + 1) * 5 + ((r.deleted ? 1 : 0) + 1) * 7 + r.mailbox * 11, 0) }
  }
  async states(): Promise<LocalRowState[]> { return [...this.rows.values()].map((r) => [r.rowid, r.read ? 1 : 0, r.flagged ? 1 : 0, r.deleted ? 1 : 0, r.mailbox] as LocalRowState).sort((a, b) => a[0] - b[0]) }
  async body(rowid: number): Promise<LocalBody> {
    this.calls.body++
    const r = this.rows.get(rowid)
    if (!r) throw new LocalSourceError('message_not_found')
    if (r.bodyMissing) {
      const head = r.raw.slice(0, r.raw.indexOf('\r\n\r\n') + 4)
      return { rawBase64: utf8ToBase64(head), partial: true }
    }
    return { rawBase64: utf8ToBase64(r.raw), partial: false }
  }
}
