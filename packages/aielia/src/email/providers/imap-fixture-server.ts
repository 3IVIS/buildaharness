import type { Message } from '../model.js'
import { EmailProviderError } from '../provider.js'
import type { SyntheticMailbox } from '../synthetic-mailbox.js'
import type { ImapCommand, ImapTransport } from './imap.js'
import { encodeHeaderValue, formatAddress } from './mime.js'
import { encodeMailboxName, decodeMailboxName } from './imap-wire.js'

/**
 * A small fake IMAP and SMTP server for tests (Email, phase H6a). It speaks the command subset the provider and
 * `mail_imap.rs` use, over a synthetic mailbox only, and is the `ImapTransport` the conformance suite runs against. It
 * has no network and no credential. Options switch off SPECIAL-USE, MOVE and UIDPLUS so the fallbacks are exercised.
 */

export interface ImapFixtureOptions {
  specialUse?: boolean
  move?: boolean
  uidplus?: boolean
}

interface Stored { uid: number; flags: Set<string>; raw: string; internalDate: string }
interface Box { name: string; validity: number; nextUid: number; msgs: Stored[]; attr?: string }

const FOLDER_NAMES: Record<string, { name: string; attr?: string }> = {
  'fld-inbox': { name: 'INBOX' },
  'fld-sent': { name: 'Sent', attr: '\\Sent' },
  'fld-drafts': { name: 'Drafts', attr: '\\Drafts' },
  'fld-archive': { name: 'Archive', attr: '\\Archive' },
  'fld-trash': { name: 'Trash', attr: '\\Trash' },
  'fld-projects': { name: 'Projects' },
}

function rawOf(m: Message): string {
  const lines = [
    `From: ${formatAddress(m.from)}`,
    `To: ${m.to.map(formatAddress).join(', ')}`,
    ...(m.cc.length ? [`Cc: ${m.cc.map(formatAddress).join(', ')}`] : []),
    `Subject: ${encodeHeaderValue(m.subject)}`,
    `Date: ${new Date(m.date).toUTCString()}`,
    ...Object.entries(m.headers).map(([k, v]) => `${k}: ${v}`),
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit',
  ]
  return `${lines.join('\r\n')}\r\n\r\n${m.textBody}`
}

function tokens(s: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2])
  return out
}

function parseSet(set: string, max: number): Set<number> {
  const out = new Set<number>()
  for (const part of set.split(',')) {
    const [a, b] = part.split(':')
    const lo = a === '*' ? max : Number(a)
    const hi = b === undefined ? lo : b === '*' ? max : Number(b)
    for (let i = Math.min(lo, hi); i <= Math.max(lo, hi); i++) out.add(i)
  }
  return out
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
function parseImapDate(s: string): number {
  const [d, m, y] = s.split('-')
  return Date.UTC(Number(y), MONTHS.indexOf(m.toLowerCase()), Number(d))
}

function headerOf(raw: string, name: string): string {
  const head = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ')
  const m = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(head)
  return m ? m[1] : ''
}

export class ImapFixtureServer implements ImapTransport {
  readonly boxes = new Map<string, Box>()
  readonly sentMail: Array<{ from: string; recipients: string[]; data: string }> = []
  readonly commandLog: string[] = []
  /** Test hook: the next `run` rejects with this error. */
  failNext?: Error
  failSend?: Error
  private selected?: Box
  private opts: Required<ImapFixtureOptions>

  constructor(mailbox: SyntheticMailbox, opts: ImapFixtureOptions = {}) {
    this.opts = { specialUse: opts.specialUse ?? true, move: opts.move ?? true, uidplus: opts.uidplus ?? true }
    for (const f of mailbox.folders) {
      const n = FOLDER_NAMES[f.id] ?? { name: f.name }
      this.boxes.set(n.name, { name: n.name, validity: 1000, nextUid: 1, msgs: [], attr: n.attr })
    }
    for (const m of structuredClone(mailbox.messages)) {
      const box = this.boxes.get(FOLDER_NAMES[m.folderIds[0]]?.name ?? 'INBOX')!
      const flags = new Set<string>()
      if (m.flags.read) flags.add('\\Seen')
      if (m.flags.starred) flags.add('\\Flagged')
      if (m.flags.draft) flags.add('\\Draft')
      box.msgs.push({ uid: box.nextUid++, flags, raw: rawOf(m), internalDate: m.date })
    }
  }

  /** Test hook: a folder that was rebuilt on the server. */
  bumpUidValidity(name: string): void {
    this.boxes.get(name)!.validity += 1
  }

  async sendMail(m: { from: string; recipients: string[]; data: string }): Promise<void> {
    if (this.failSend) throw this.failSend
    if (/^bcc:/im.test(m.data.split(/\r?\n\r?\n/)[0])) throw new Error('fixture: a Bcc header reached SMTP')
    this.sentMail.push(structuredClone(m))
  }

  async run(commands: ImapCommand[]): Promise<string[]> {
    if (this.failNext) {
      const e = this.failNext
      this.failNext = undefined
      throw e
    }
    this.selected = undefined
    return commands.map((c) => this.exec(c))
  }

  private box(name: string): Box {
    const b = this.boxes.get(decodeMailboxName(name))
    if (!b) throw new EmailProviderError('not_found', `NO [NONEXISTENT] no such mailbox: ${name}`)
    return b
  }
  private sel(): Box {
    if (!this.selected) throw new EmailProviderError('invalid_argument', 'BAD no mailbox selected')
    return this.selected
  }

  private exec(c: ImapCommand): string {
    this.commandLog.push(c.command)
    if (/\r|\n/.test(c.command) || /^(LOGIN|AUTHENTICATE|STARTTLS)\b/i.test(c.command)) throw new Error('fixture: the page may not send this command')
    const t = tokens(c.command)
    const verb = t[0].toUpperCase()
    switch (verb) {
      case 'CAPABILITY':
        return `* CAPABILITY IMAP4rev1 ${this.opts.uidplus ? 'UIDPLUS ' : ''}${this.opts.move ? 'MOVE ' : ''}SPECIAL-USE\r\nA OK done\r\n`
      case 'LIST':
        return [...this.boxes.values()].map((b) => `* LIST (${this.opts.specialUse && b.attr ? b.attr : '\\HasNoChildren'}) "/" "${encodeMailboxName(b.name)}"\r\n`).join('') + 'A OK done\r\n'
      case 'STATUS': {
        const b = this.box(t[1])
        return `* STATUS "${encodeMailboxName(b.name)}" (UNSEEN ${b.msgs.filter((m) => !m.flags.has('\\Seen')).length})\r\nA OK done\r\n`
      }
      case 'SELECT':
      case 'EXAMINE': {
        const b = this.box(t[1])
        this.selected = b
        return `* ${b.msgs.length} EXISTS\r\n* OK [UIDVALIDITY ${b.validity}] ok\r\n* OK [UIDNEXT ${b.nextUid}] ok\r\nA OK [READ-WRITE] done\r\n`
      }
      case 'APPEND': {
        const b = this.box(t[1])
        const flags = new Set((/\(([^)]*)\)/.exec(c.command)?.[1] ?? '').split(/\s+/).filter(Boolean))
        b.msgs.push({ uid: b.nextUid++, flags, raw: c.literal ?? '', internalDate: new Date().toISOString() })
        return 'A OK appended\r\n'
      }
      case 'EXPUNGE':
        return this.expunge(this.sel(), undefined)
      case 'NOOP':
      case 'CLOSE':
        return 'A OK done\r\n'
      case 'UID':
        return this.uidCommand(t[1].toUpperCase(), c.command, t)
      default:
        throw new Error(`fixture: unsupported command ${verb}`)
    }
  }

  private expunge(b: Box, set: Set<number> | undefined): string {
    b.msgs = b.msgs.filter((m) => !(m.flags.has('\\Deleted') && (!set || set.has(m.uid))))
    return 'A OK expunged\r\n'
  }

  private uidCommand(sub: string, line: string, t: string[]): string {
    const b = this.sel()
    const max = b.nextUid - 1
    switch (sub) {
      case 'SEARCH': {
        let rest = t.slice(2)
        if (rest[0]?.toUpperCase() === 'CHARSET') rest = rest.slice(2)
        const pred = this.parseCriteria(rest, max)
        return `* SEARCH ${b.msgs.filter(pred).map((m) => m.uid).join(' ')}\r\nA OK done\r\n`.replace('SEARCH \r', 'SEARCH\r')
      }
      case 'FETCH': {
        const set = parseSet(t[2], max)
        const wantBody = /BODY\.PEEK\[\]/.test(line)
        const fields = /HEADER\.FIELDS \(([^)]*)\)/.exec(line)?.[1].split(/\s+/).map((x) => x.toLowerCase())
        let out = ''
        b.msgs.forEach((m, i) => {
          if (!set.has(m.uid)) return
          const flags = [...m.flags].join(' ')
          let body = ''
          if (wantBody) body = ` BODY[] {${new TextEncoder().encode(m.raw).length}}\r\n${m.raw}`
          else if (fields) {
            const head = m.raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).filter((l) => fields.includes(l.split(':')[0].toLowerCase())).join('\r\n')
            const blob = `${head}\r\n\r\n`
            body = ` BODY[HEADER.FIELDS (${fields.join(' ').toUpperCase()})] {${new TextEncoder().encode(blob).length}}\r\n${blob}`
          }
          out += `* ${i + 1} FETCH (UID ${m.uid} FLAGS (${flags}) INTERNALDATE "${new Date(m.internalDate).toUTCString()}"${body})\r\n`
        })
        return `${out}A OK done\r\n`
      }
      case 'STORE': {
        const set = parseSet(t[2], max)
        const sign = t[3][0]
        const flags = (/\(([^)]*)\)/.exec(line)?.[1] ?? '').split(/\s+/).filter(Boolean)
        for (const m of b.msgs) if (set.has(m.uid)) for (const f of flags) { if (sign === '-') m.flags.delete(f); else m.flags.add(f) }
        return 'A OK stored\r\n'
      }
      case 'COPY':
      case 'MOVE': {
        if (sub === 'MOVE' && !this.opts.move) throw new Error('fixture: MOVE not offered')
        const set = parseSet(t[2], max)
        const dest = this.box(t[3])
        for (const m of b.msgs) if (set.has(m.uid)) dest.msgs.push({ uid: dest.nextUid++, flags: new Set(m.flags), raw: m.raw, internalDate: m.internalDate })
        if (sub === 'MOVE') b.msgs = b.msgs.filter((m) => !set.has(m.uid))
        return 'A OK done\r\n'
      }
      case 'EXPUNGE':
        if (!this.opts.uidplus) throw new Error('fixture: UIDPLUS not offered')
        return this.expunge(b, parseSet(t[2], max))
      default:
        throw new Error(`fixture: unsupported UID command ${sub}`)
    }
  }

  private parseCriteria(t: string[], max: number): (m: Stored) => boolean {
    let i = 0
    const key = (): ((m: Stored) => boolean) => {
      const k = t[i++].toUpperCase()
      switch (k) {
        case 'ALL': return () => true
        case 'UNSEEN': return (m) => !m.flags.has('\\Seen')
        case 'SEEN': return (m) => m.flags.has('\\Seen')
        case 'FLAGGED': return (m) => m.flags.has('\\Flagged')
        case 'TEXT': { const v = t[i++].toLowerCase(); return (m) => m.raw.toLowerCase().includes(v) }
        case 'FROM': { const v = t[i++].toLowerCase(); return (m) => headerOf(m.raw, 'from').toLowerCase().includes(v) }
        case 'HEADER': { const n = t[i++]; const v = t[i++].toLowerCase(); return (m) => headerOf(m.raw, n).toLowerCase().includes(v) }
        case 'SINCE': { const d = parseImapDate(t[i++]); return (m) => Date.parse(m.internalDate) >= d }
        case 'BEFORE': { const d = parseImapDate(t[i++]); return (m) => Date.parse(m.internalDate) < d }
        case 'UID': { const s = parseSet(t[i++], max); return (m) => s.has(m.uid) }
        case 'OR': { const a = key(); const b = key(); return (m) => a(m) || b(m) }
        default: throw new Error(`fixture: unsupported search key ${k}`)
      }
    }
    const preds: Array<(m: Stored) => boolean> = []
    while (i < t.length) preds.push(key())
    return (m) => preds.every((p) => p(m))
  }
}
