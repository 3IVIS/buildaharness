import { describe, it, expect } from 'vitest'
import { groupConversations, normaliseSubject } from './conversation.js'
import type { Message } from './model.js'

let n = 0
type Opts = Partial<Omit<Message, 'from' | 'to'>> & { from?: string; to?: string; mid?: string; irt?: string }
const msg = (o: Opts): Message => ({
  id: o.id ?? `m${++n}`, accountId: 'a', threadId: o.threadId ?? `t${n}`, providerId: 'p', folderIds: ['fld-inbox'],
  from: { address: o.from ?? 'x@example.com' }, to: [{ address: o.to ?? 'owner@example.org' }], cc: [], subject: o.subject ?? 'hello world',
  date: o.date ?? '2026-11-01T10:00:00.000Z',
  headers: { ...(o.mid ? { 'message-id': `<${o.mid}>` } : {}), ...(o.irt ? { 'in-reply-to': `<${o.irt}>` } : {}) },
  textBody: '', attachments: [], flags: { read: true, starred: false, draft: false },
})

describe('groupConversations', () => {
  it('keeps messages that share a provider thread id together', () => {
    const g = groupConversations([msg({ id: 'a', threadId: 'T' }), msg({ id: 'b', threadId: 'T' })])
    expect(g.get('a')).toBe(g.get('b'))
  })
  it('joins a Sent copy that came back under another thread id through in-reply-to', () => {
    const g = groupConversations([
      msg({ id: 'in', threadId: 'T1', mid: 'one@x', subject: 'Budget plan' }),
      msg({ id: 'sent', threadId: 'T2', mid: 'two@x', irt: 'one@x', subject: 'Something else entirely', from: 'owner@example.org', to: 'x@example.com' }),
    ])
    expect(g.get('in')).toBe(g.get('sent'))
  })
  it('joins a header-less Re: reply by subject when a participant and the time fit', () => {
    const g = groupConversations([
      msg({ id: 'a', threadId: 'T1', subject: 'Offsite agenda', date: '2026-11-01T10:00:00.000Z' }),
      msg({ id: 'b', threadId: 'T2', subject: 'RE: Offsite agenda', from: 'owner@example.org', to: 'x@example.com', date: '2026-11-02T10:00:00.000Z' }),
    ])
    expect(g.get('a')).toBe(g.get('b'))
  })
  it('does not merge two strangers who both write "Re: invoice" or messages far apart', () => {
    const g = groupConversations([
      msg({ id: 'a', threadId: 'T1', subject: 'invoice', from: 'a@example.com' }),
      msg({ id: 'b', threadId: 'T2', subject: 'Re: invoice', from: 'b@example.net', to: 'someone@example.net' }),
      msg({ id: 'c', threadId: 'T3', subject: 'Offsite agenda', date: '2026-08-01T10:00:00.000Z' }),
      msg({ id: 'd', threadId: 'T4', subject: 'Re: Offsite agenda', date: '2026-11-01T10:00:00.000Z' }),
    ])
    expect(g.get('a')).not.toBe(g.get('b'))
    expect(g.get('c')).not.toBe(g.get('d'))
  })
  it('does not merge on subject alone when the second message has no Re: prefix, or when there is no shared participant', () => {
    const g = groupConversations([
      msg({ id: 'a', threadId: 'T1', subject: 'Weekly sync notes', from: 'a@example.com' }),
      msg({ id: 'b', threadId: 'T2', subject: 'Weekly sync notes', from: 'a@example.com' }),
      msg({ id: 'c', threadId: 'T3', subject: 'Re: Quarterly budget review', from: 'p@example.net', to: 'q@example.net' }),
      msg({ id: 'd', threadId: 'T4', subject: 'Quarterly budget review', from: 'r@example.net', to: 's@example.net', date: '2026-10-31T10:00:00.000Z' }),
    ])
    expect(g.get('a')).not.toBe(g.get('b'))
    expect(g.get('c')).not.toBe(g.get('d'))
  })
  it('never joins across accounts', () => {
    const a = msg({ id: 'a', threadId: 'T1', mid: 'one@x' })
    const b = { ...msg({ id: 'b', threadId: 'T2', irt: 'one@x' }), accountId: 'other' }
    const g = groupConversations([a, b])
    expect(g.get('a')).not.toBe(g.get('b'))
  })
  it('the id is stable as messages are added', () => {
    const a = msg({ id: 'a', threadId: 'T9', mid: 'one@x' })
    const b = msg({ id: 'b', threadId: 'T2', irt: 'one@x' })
    expect(groupConversations([a, b]).get('a')).toBe(groupConversations([b, a]).get('a'))
  })
  it('normalises prefixes', () => {
    expect(normaliseSubject('Re: RE: Fwd:  Hello   World')).toBe('hello world')
    expect(normaliseSubject('AW: Termin')).toBe('termin')
  })
})
