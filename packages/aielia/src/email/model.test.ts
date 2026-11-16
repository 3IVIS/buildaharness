import { describe, it, expect } from 'vitest'
import type { z } from 'zod'
import {
  AccountSchema, FolderSchema, ThreadSchema, MessageSchema, TriageSchema, TodoItemSchema, FilingRuleSchema, ReplyDraftSchema, EmailActionSchema,
  parseAccount, parseFolder, parseThread, parseMessage, parseTriage, parseTodoItem, parseFilingRule, parseReplyDraft, parseEmailAction, parseRecord,
  type ParseResult,
} from './model.js'

const NOW = '2026-11-13T10:00:00.000Z'
const ann = { address: 'ann@example.com', name: 'Ann Example' }

const samples: Array<{ name: string; schema: z.ZodObject<z.ZodRawShape>; parse: (r: unknown) => ParseResult<unknown>; value: Record<string, unknown>; optional: string[] }> = [
  { name: 'account', schema: AccountSchema, parse: parseAccount, optional: ['syncToken', 'lastSyncAt'],
    value: { id: 'a1', provider: 'fake', address: 'me@example.org', displayName: 'Me', syncToken: 't1', lastSyncAt: NOW, aieliaMayRead: true, excludedFolders: [], excludedSenders: [] } },
  { name: 'folder', schema: FolderSchema, parse: parseFolder, optional: ['parentId'],
    value: { id: 'f1', accountId: 'a1', providerId: 'INBOX', name: 'Inbox', kind: 'inbox', parentId: 'f0', unreadCount: 3 } },
  { name: 'thread', schema: ThreadSchema, parse: parseThread, optional: [],
    value: { id: 't1', accountId: 'a1', providerId: 'pt1', subject: 'Hello', messageIds: ['m1'], folderIds: ['f1'], participants: [ann], lastMessageAt: NOW, unread: true } },
  { name: 'message', schema: MessageSchema, parse: parseMessage, optional: ['htmlBody'],
    value: { id: 'm1', accountId: 'a1', threadId: 't1', providerId: 'pm1', folderIds: ['f1'], from: ann, to: [{ address: 'me@example.org' }], cc: [], subject: 'Hello', date: NOW,
      headers: { 'message-id': '<x@example.com>' }, textBody: 'Hi', htmlBody: '<p>Hi</p>', attachments: [{ id: 'at1', filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 4 }],
      flags: { read: false, starred: false, draft: false } } },
  { name: 'triage', schema: TriageSchema, parse: parseTriage, optional: ['dueDate', 'waitingOn'],
    value: { threadId: 't1', category: 'person', needsReply: true, priority: 'high', urgency: 'soon', dueDate: NOW, reason: 'A direct question.', waitingOn: ann, userOverridden: false, triagedAt: NOW } },
  { name: 'todo', schema: TodoItemSchema, parse: parseTodoItem, optional: ['threadId', 'snoozeUntil', 'dueDate', 'completedAt'],
    value: { id: 'td1', threadId: 't1', title: 'Reply to Ann', origin: 'triage', status: 'open', snoozeUntil: NOW, dueDate: NOW, group: 'do_now', reason: 'Due soon.', createdAt: NOW, completedAt: NOW } },
  { name: 'filing rule', schema: FilingRuleSchema, parse: parseFilingRule, optional: [],
    value: { id: 'r1', accountId: 'a1', match: { kind: 'domain', domain: 'news.example.net' }, action: { type: 'move', target: 'f2' }, evidenceMessageIds: ['m1'], state: 'proposed', origin: 'learned', createdAt: NOW } },
  { name: 'reply draft', schema: ReplyDraftSchema, parse: parseReplyDraft, optional: [],
    value: { id: 'd1', threadId: 't1', text: 'Thanks.', status: 'suggested', points: ['confirm'], edits: [{ at: NOW, by: 'user', text: 'Thanks!' }], createdAt: NOW, updatedAt: NOW } },
  { name: 'email action', schema: EmailActionSchema, parse: parseEmailAction, optional: ['ruleId'],
    value: { id: 'e1', accountId: 'a1', type: 'move', targetIds: ['m1'], status: 'applied', actor: 'aielia', preImages: [{ folderIds: ['f1'] }], ruleId: 'r1', at: NOW } },
]

describe('email model records', () => {
  for (const s of samples) {
    describe(s.name, () => {
      it('round-trips through JSON', () => {
        const r = s.parse(JSON.parse(JSON.stringify(s.value)))
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.value).toEqual(s.value)
      })
      const required = Object.keys(s.value).filter((k) => !s.optional.includes(k))
      for (const key of required) {
        it(`refuses a record without ${key}, naming it`, () => {
          const { [key]: _drop, ...rest } = s.value
          const r = s.parse(rest)
          expect(r.ok).toBe(false)
          if (!r.ok) expect(r.reason).toContain(key)
        })
      }
      for (const key of s.optional) {
        it(`accepts a record without optional ${key}`, () => {
          const { [key]: _drop, ...rest } = s.value
          expect(s.parse(rest).ok).toBe(true)
        })
      }
    })
  }

  it('refuses non-objects with a reason', () => {
    for (const bad of [null, 'x', 3, [], undefined]) {
      const r = parseAccount(bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/not an object/)
    }
  })

  it('refuses a wrong enum value and an unknown filing-match kind', () => {
    expect(parseFolder({ ...samples[1].value, kind: 'spam' }).ok).toBe(false)
    expect(parseFilingRule({ ...samples[6].value, match: { kind: 'regex', pattern: 'x' } }).ok).toBe(false)
  })

  it('refuses an email action with no targets (undo needs something to undo)', () => {
    expect(parseEmailAction({ ...samples[8].value, targetIds: [] }).ok).toBe(false)
  })

  it('refuses a negative unread count and an empty reason', () => {
    expect(parseFolder({ ...samples[1].value, unreadCount: -1 }).ok).toBe(false)
    expect(parseTriage({ ...samples[4].value, reason: '' }).ok).toBe(false)
  })

  it('parseRecord names the path of the first problem', () => {
    const r = parseRecord(MessageSchema, { ...samples[3].value, flags: { read: 'yes', starred: false, draft: false } }, 'message')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('flags.read')
  })
})
