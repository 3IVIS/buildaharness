import { describe, it, expect } from 'vitest'
import { ImapEmailProvider, classifyFolders } from './imap.js'
import { ImapFixtureServer, type ImapFixtureOptions } from './imap-fixture-server.js'
import { TauriImapTransport, mapImapError } from './tauri-imap-transport.js'
import { IMAP_PRESETS, imapPreset } from './imap-presets.js'
import { decodeMailboxName, encodeMailboxName, fetchItems, imapDate, imapQuote, parseList, parseUntagged, responseCode, uidSet } from './imap-wire.js'
import { parseMail } from './imap-mime.js'
import { PROVIDER_CONFORMANCE_CHECKS } from '../provider-conformance.js'
import { generateSyntheticMailbox, type SyntheticMailbox } from '../synthetic-mailbox.js'
import { EmailProviderError } from '../provider.js'
import { SignInNeededError } from '../token-source.js'

function imap(mb: SyntheticMailbox = generateSyntheticMailbox({ seed: 2 }), opts: ImapFixtureOptions = {}, extra: { appendToSent?: boolean } = {}) {
  const server = new ImapFixtureServer(mb, opts)
  let n = 0
  const provider = new ImapEmailProvider({
    account: { ...mb.account, provider: 'imap' }, transport: server, newId: () => `t${++n}`, now: () => new Date('2026-11-02T10:00:00Z'), ...extra,
  })
  return { server, provider }
}

const VARIANTS: Array<[string, ImapFixtureOptions]> = [
  ['with SPECIAL-USE, MOVE and UIDPLUS', {}],
  ['without SPECIAL-USE (names only)', { specialUse: false }],
  ['without MOVE (copy and delete)', { move: false }],
  ['without UIDPLUS (plain EXPUNGE)', { uidplus: false }],
]
for (const [label, opts] of VARIANTS) {
  describe(`IMAP provider conformance ${label}`, () => {
    for (const c of PROVIDER_CONFORMANCE_CHECKS) it(c.name, () => c.run((mb) => imap(mb, opts).provider))
  })
}

describe('ImapEmailProvider specifics', () => {
  it('never sends LOGIN, AUTHENTICATE or STARTTLS: the transport owns the login', async () => {
    const { server, provider } = imap()
    await provider.listFolders()
    await provider.search({ text: 'report' })
    expect(server.commandLog.some((c) => /^(LOGIN|AUTHENTICATE|STARTTLS)/i.test(c))).toBe(false)
  })

  it('reads folder roles from SPECIAL-USE and falls back to names', async () => {
    const rich = classifyFolders([
      { attrs: ['\\hasnochildren', '\\sent'], delimiter: '/', path: 'Gesendet' },
      { attrs: ['\\drafts'], delimiter: '/', path: 'Entw&APw-rfe' },
      { attrs: ['\\all'], delimiter: '/', path: '[Gmail]/All Mail' },
      { attrs: [], delimiter: '/', path: 'INBOX' },
      { attrs: ['\\noselect'], delimiter: '/', path: '[Gmail]' },
      { attrs: [], delimiter: '/', path: 'Sent' },
      { attrs: [], delimiter: '/', path: 'Deleted Items' },
    ])
    const kind = (p: string) => rich.find((r) => r.path === p)?.kind
    expect(kind('Gesendet')).toBe('sent')
    expect(kind('Entwürfe')).toBe('drafts')
    expect(kind('[Gmail]/All Mail')).toBe('archive')
    expect(kind('INBOX')).toBe('inbox')
    expect(kind('Sent')).toBe('custom') // sent is already claimed by SPECIAL-USE, the name does not steal it
    expect(kind('Deleted Items')).toBe('trash')
    expect(rich.find((r) => r.path === '[Gmail]')).toBeUndefined()
  })

  it('asks for a full resync when a folder UIDVALIDITY changes, and not otherwise', async () => {
    const { server, provider } = imap()
    const start = await provider.listChanges()
    expect((await provider.listChanges(start.syncToken)).fullResyncNeeded).toBe(false)
    server.bumpUidValidity('INBOX')
    const r = await provider.listChanges(start.syncToken)
    expect(r.fullResyncNeeded).toBe(true)
    expect(r.changes).toEqual([])
    expect((await provider.listChanges(r.syncToken)).fullResyncNeeded).toBe(false)
  })

  it('keeps a message id when it moves folders (UIDs change, the Message-ID does not)', async () => {
    const { provider } = imap()
    const folders = await provider.listFolders()
    const inbox = folders.find((f) => f.kind === 'inbox')!
    const dest = folders.find((f) => f.kind === 'archive')!
    const m = (await provider.listMessages(inbox.id)).items[0]
    await provider.move([m.id], dest.id)
    const after = await provider.getMessage(m.id)
    expect(after.id).toBe(m.id)
    expect(after.providerId).not.toBe(m.providerId)
  })

  it('builds threads from References and In-Reply-To when the server has no THREAD support', async () => {
    const { provider } = imap()
    const inbox = (await provider.listFolders()).find((f) => f.kind === 'inbox')!
    const root = (await provider.listMessages(inbox.id)).items[0]
    const d1 = await provider.createDraft({ threadId: root.threadId, to: [root.from], subject: `Re: ${root.subject}`, textBody: 'one' })
    const d2 = await provider.createDraft({ threadId: root.threadId, to: [root.from], subject: `Re: ${root.subject}`, textBody: 'two' })
    expect(d1.threadId).toBe(root.threadId)
    expect(d2.threadId).toBe(root.threadId)
    expect(d2.headers['in-reply-to']).toBeTruthy()
    const { thread, messages } = await provider.getThread(root.threadId)
    expect(new Set(thread.messageIds)).toEqual(new Set([root.id, d1.id, d2.id]))
    expect(messages).toHaveLength(3)
    const threads = await provider.listThreads(inbox.id, { limit: 50 })
    expect(threads.items.filter((t) => t.id === root.threadId)).toHaveLength(1)
  })

  it('sends over SMTP with the blind copies as recipients but no Bcc header, then files the copy in Sent', async () => {
    const { server, provider } = imap()
    const d = await provider.createDraft({ to: [{ address: 'a@example.com' }], cc: [{ address: 'c@example.com' }], bcc: [{ address: 'hidden@example.com' }], subject: 'Hi', textBody: 'Body' })
    expect(d.headers['bcc']).toBeUndefined()
    const sent = await provider.send(d.id)
    expect(server.sentMail).toHaveLength(1)
    expect(server.sentMail[0].recipients.sort()).toEqual(['a@example.com', 'c@example.com', 'hidden@example.com'])
    expect(server.sentMail[0].from).toBe(server.boxes.get('INBOX') ? 'owner@example.org' : '')
    expect(/^bcc:/im.test(server.sentMail[0].data)).toBe(false)
    expect(sent.folderIds).toEqual(['Sent'])
    expect(server.boxes.get('Drafts')!.msgs).toHaveLength(0)
  })

  it('does not report a failure for housekeeping after SMTP accepted the message, and skips the Sent copy when asked', async () => {
    const { server, provider } = imap(undefined, {}, { appendToSent: false })
    const d = await provider.createDraft({ to: [{ address: 'a@example.com' }], subject: 'Hi', textBody: 'Body' })
    const sent = await provider.send(d.id)
    expect(sent.flags.draft).toBe(false)
    expect(server.boxes.get('Sent')!.msgs.filter((m) => m.raw.includes('Subject: Hi'))).toHaveLength(0)
  })

  it('leaves the draft alone when SMTP refuses', async () => {
    const { server, provider } = imap()
    const d = await provider.createDraft({ to: [{ address: 'a@example.com' }], subject: 'Hi', textBody: 'Body' })
    server.failSend = new EmailProviderError('unavailable', '554 refused')
    await expect(provider.send(d.id)).rejects.toMatchObject({ code: 'unavailable' })
    expect((await provider.getMessage(d.id)).flags.draft).toBe(true)
  })

  it('refuses non-ASCII search text and bad page tokens with invalid_argument', async () => {
    const { provider } = imap()
    await expect(provider.search({ text: 'Grüße' })).rejects.toMatchObject({ code: 'invalid_argument' })
    const inbox = (await provider.listFolders()).find((f) => f.kind === 'inbox')!
    await expect(provider.listMessages(inbox.id, { pageToken: 'bogus' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(provider.listMessages(inbox.id, { pageToken: 'u1:3' })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('uses a stable fallback id for a message without a Message-ID', async () => {
    const { server, provider } = imap()
    const inbox = server.boxes.get('INBOX')!
    inbox.msgs.push({ uid: inbox.nextUid++, flags: new Set(), raw: 'From: x@example.com\r\nSubject: no id\r\nDate: Mon, 02 Nov 2026 08:00:00 +0000\r\n\r\nbody', internalDate: '2026-11-02T08:00:00Z' })
    const m = (await provider.listMessages('INBOX', { limit: 100 })).items.find((x) => x.subject === 'no id')!
    expect(m.id).toMatch(/^imap:INBOX:1000:\d+$/)
    await provider.markRead([m.id], true)
    expect((await provider.getMessage(m.id)).flags.read).toBe(true)
  })
})

describe('IMAP wire helpers', () => {
  it('quotes arguments and refuses control characters', () => {
    expect(imapQuote('a"b\\c')).toBe('"a\\"b\\\\c"')
    expect(() => imapQuote('x\r\nA9 LOGIN a b')).toThrow()
  })
  it('round-trips modified UTF-7 and compresses UID sets', () => {
    for (const n of ['Entwürfe', 'Sent & Co', '日本語/受信', 'plain']) expect(decodeMailboxName(encodeMailboxName(n))).toBe(n)
    expect(encodeMailboxName('Entwürfe')).toBe('Entw&APw-rfe')
    expect(uidSet([5, 1, 2, 3, 9, 3])).toBe('1:3,5,9')
    expect(imapDate('2026-11-05T12:00:00Z')).toBe('5-Nov-2026')
  })
  it('parses LIST, STATUS and FETCH with literals counted in bytes', () => {
    const list = parseList('* LIST (\\HasNoChildren \\Sent) "/" "Sent Items"\r\n* LIST () "." INBOX\r\nA1 OK done\r\n')
    expect(list).toEqual([{ attrs: ['\\hasnochildren', '\\sent'], delimiter: '/', path: 'Sent Items' }, { attrs: [], delimiter: '.', path: 'INBOX' }])
    const body = 'Subject: Grüße\r\n\r\nschön ✓'
    const raw = `* 3 FETCH (UID 9 FLAGS (\\Seen \\Flagged) BODY[] {${new TextEncoder().encode(body).length}}\r\n${body})\r\nA2 OK done\r\n`
    const f = parseUntagged(raw).find((u) => u.name === 'FETCH')!
    const items = fetchItems(f)
    expect(items.get('UID')).toBe('9')
    expect(items.get('FLAGS')).toEqual(['\\Seen', '\\Flagged'])
    expect(items.get('BODY[]')).toBe(body)
    expect(responseCode('* OK [UIDVALIDITY 3857529045] ok', 'UIDVALIDITY')).toBe('3857529045')
    expect(parseUntagged('* STATUS "INBOX" (MESSAGES 4 UNSEEN 2)\r\n')[0].rest[1]).toEqual(['MESSAGES', '4', 'UNSEEN', '2'])
  })
  it('does not let a literal that looks like a tagged line end the response', () => {
    const lit = 'A1 OK fake\r\n* 9 EXISTS'
    const out = parseUntagged(`* 1 FETCH (BODY[] {${lit.length}}\r\n${lit})\r\n`)
    expect(out).toHaveLength(1)
    expect(fetchItems(out[0]).get('BODY[]')).toBe(lit)
  })
})

describe('IMAP MIME reader', () => {
  it('reads multipart/alternative, quoted-printable, a Latin-1 part and an attachment', () => {
    const raw = [
      'From: =?UTF-8?B?QW5uYSBLw7ZobGVy?= <anna@example.com>', 'To: Sam <owner@example.org>', 'Subject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=',
      'Content-Type: multipart/mixed; boundary="outer"', '', '--outer', 'Content-Type: multipart/alternative; boundary="inner"', '',
      '--inner', 'Content-Type: text/plain; charset=ISO-8859-1', 'Content-Transfer-Encoding: quoted-printable', '', 'Gr=FC=DFe =\r\nweiter', '--inner',
      'Content-Type: text/html; charset=UTF-8', '', '<p>ignored when text exists</p>', '--inner--', '--outer',
      'Content-Type: application/pdf; name="report.pdf"', 'Content-Disposition: attachment; filename="report.pdf"', 'Content-Transfer-Encoding: base64', '', 'AAAA', '--outer--', '',
    ].join('\r\n')
    const m = parseMail(raw)
    expect(m.from).toEqual({ address: 'anna@example.com', name: 'Anna Köhler' })
    expect(m.subject).toBe('Grüße')
    expect(m.textBody.trim()).toBe('Grüße weiter')
    expect(m.attachments).toEqual([{ id: '1.2', filename: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 3 }])
  })
  it('turns an HTML-only message into plain text without scripts', () => {
    const m = parseMail('Content-Type: text/html\r\n\r\n<style>x{}</style><p>Hello &amp; <b>bye</b></p><script>alert(1)</script>')
    expect(m.textBody).toBe('Hello & bye')
  })
})

describe('TauriImapTransport', () => {
  function transport(handler: (cmd: string, args: Record<string, unknown>) => unknown) {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = []
    const invoke = async <T,>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ command, args })
      const r = handler(command, args)
      if (typeof r === 'string' && r.startsWith('!')) throw r.slice(1)
      return r as T
    }
    return { calls, t: new TauriImapTransport(invoke, 'acct-1', { host: 'imap.fastmail.com', port: 993 }, { host: 'smtp.fastmail.com', port: 465 }, { kind: 'password', user: 'me@example.org' }) }
  }
  it('passes only the user name and kind of sign-in, never a secret, and registers both hosts', async () => {
    const { calls, t } = transport((c) => (c === 'mail_imap_run' ? { responses: ['A OK'] } : undefined))
    await t.registerHosts()
    await t.run([{ command: 'NOOP' }])
    await t.sendMail({ from: 'a@b.c', recipients: ['x@y.z'], data: 'Subject: x' })
    expect(calls.filter((c) => c.command === 'mail_register_host').map((c) => c.args.host)).toEqual(['imap.fastmail.com', 'smtp.fastmail.com'])
    for (const c of calls.filter((x) => x.command !== 'mail_imap_set_password')) expect(Object.keys((c.args.auth as object | undefined) ?? {}).sort().join()).toMatch(/^(kind,user|)$/)
    expect(calls[2].args.auth).toEqual({ kind: 'password', user: 'me@example.org' })
    await t.setPassword('app-pass')
    expect(calls[calls.length - 1]).toMatchObject({ command: 'mail_imap_set_password', args: { password: 'app-pass' } })
  })
  it('maps Rust error codes', async () => {
    expect(mapImapError('sign_in_needed: x')).toBeInstanceOf(SignInNeededError)
    expect(mapImapError('sign_in_failed: x')).toMatchObject({ code: 'unauthorized' })
    expect(mapImapError('host_rejected: x')).toMatchObject({ code: 'invalid_argument' })
    expect(mapImapError('provider_error: NO [NONEXISTENT] gone')).toMatchObject({ code: 'not_found' })
    expect(mapImapError('network_error: down')).toMatchObject({ code: 'unavailable' })
    const { t } = transport(() => '!provider_error: NO [THROTTLED] slow down')
    await expect(t.run([{ command: 'NOOP' }])).rejects.toMatchObject({ code: 'rate_limited' })
  })
  it('runs the shared conformance suite through the invoke layer (fake invoke backed by the fixture server)', async () => {
    const make = (mb: SyntheticMailbox) => {
      const server = new ImapFixtureServer(mb)
      const invoke = async <T,>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
        if (command === 'mail_imap_run') return { responses: await server.run((args.commands as Array<{ command: string; literal?: string | null }>).map((c) => ({ command: c.command, literal: c.literal ?? undefined }))) } as T
        if (command === 'mail_smtp_send') return (await server.sendMail({ from: args.from as string, recipients: args.recipients as string[], data: args.data as string })) as T
        return undefined as T
      }
      return new ImapEmailProvider({ account: { ...mb.account, provider: 'imap' }, transport: new TauriImapTransport(invoke, 'acct-1', { host: 'imap.example.net', port: 993 }, { host: 'smtp.example.net', port: 465 }, { kind: 'password', user: 'owner@example.org' }) })
    }
    for (const c of PROVIDER_CONFORMANCE_CHECKS) await c.run(make)
  })
})

describe('IMAP presets', () => {
  it('are plain data on the TLS ports and all marked untested until H6b', () => {
    expect(IMAP_PRESETS.length).toBeGreaterThanOrEqual(3)
    for (const p of IMAP_PRESETS) {
      expect(p.imapPort).toBe(993)
      expect(p.smtpPort).toBe(465)
      expect(p.status).toBe('untested')
      expect(p.imapHost).toMatch(/^[a-z0-9.-]+\.[a-z]+$/)
    }
    expect(imapPreset('yahoo')?.imapHost).toBe('imap.mail.yahoo.com')
    expect(imapPreset('nope')).toBeUndefined()
  })
})
