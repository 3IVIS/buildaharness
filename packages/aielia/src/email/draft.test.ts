import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { createScriptedLLMClient } from '../scripted-llm-client.js'
import { FakeEmailProvider } from './fake-provider.js'
import { generateSyntheticMailbox } from './synthetic-mailbox.js'
import { acceptDraftEdit, draftReply, DRAFT_SYSTEM_PROMPT, findGaps, rejectDraftEdit, saveReplyDraft, suggestDraftEdit, type DraftModel } from './draft.js'
import { editVoice, emptyVoiceProfile } from './voice.js'

const provider = new FakeEmailProvider(generateSyntheticMailbox({ seed: 3, perCategory: 2 }))
const account = provider.account
const base = { account: { ...account, excludedFolders: [] as string[], excludedSenders: [] as string[] } }

async function thread() {
  const m = provider.deliver({ from: { address: 'pat@example.com', name: 'Pat Example' }, subject: 'Handover meeting', textBody: 'Can we meet on 3 March to talk about the handover? The fee is 400 euro.' })
  const t = await provider.getThread(m.threadId)
  return { messages: t.messages, folders: await provider.listFolders() }
}

const modelOf = (answer: unknown, seen: string[] = []): DraftModel => {
  const client = createScriptedLLMClient()
  return async (system, user) => {
    seen.push(user)
    const r = await client.callChatStructured([{ role: 'system', content: system }, { role: 'user', content: user }])
    expect(r.content).toBe('{"body":""}') // the draft prompt has an inert default marker
    return typeof answer === 'string' ? answer : JSON.stringify(answer)
  }
}

/** A writer-side client: lists the given claim quotes, and judges each by a table keyed on the quote. */
function claimsClient(quotes: string[], verdicts: Record<string, string>, calls: string[] = []): ILLMClient {
  return {
    callChatStructured: async (messages: { role: string; content: string }[]) => {
      const system = messages.find((m) => m.role === 'system')!.content
      const user = JSON.parse(messages.find((m) => m.role === 'user')!.content) as Record<string, unknown>
      if (system.startsWith('You read parts of an article')) {
        calls.push('claims')
        return { content: JSON.stringify({ claims: quotes.map((q) => ({ quote: q, kind: 'factual', matchesId: null, sure: false })) }) }
      }
      calls.push('support')
      const verdict = verdicts[String(user.claim)] ?? 'supported'
      return { content: JSON.stringify({ verdict, reason: `scripted ${verdict}` }) }
    },
  } as unknown as ILLMClient
}

describe('draftReply', () => {
  it('writes in the voice, from the thread, memory and what the user told, and addresses the other party', async () => {
    const t = await thread()
    const seen: string[] = []
    let voice = emptyVoiceProfile()
    voice = editVoice(voice, 'stranger', 'voice', 'Short and polite.')
    const r = await draftReply({ ...base, folders: t.folders, thread: t.messages, memory: ['Prefers mornings'], told: 'Say yes', voice, model: modelOf({ body: 'Hi Pat, yes, see you then.', statesDatePriceOrCommitment: false }, seen), factsCheck: 'off' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft.to[0]!.address).toBe('pat@example.com')
    expect(r.draft.subject).toBe('Re: Handover meeting')
    expect(seen[0]).toContain('Prefers mornings')
    expect(seen[0]).toContain('Short and polite.')
    expect(seen[0]).toContain('<untrusted_external_content>')
    expect(DRAFT_SYSTEM_PROMPT).toContain('[[GAP:')
  })

  it('leaves a marked gap where information is missing', async () => {
    const t = await thread()
    const r = await draftReply({ ...base, folders: t.folders, thread: t.messages, model: modelOf({ body: 'Hi Pat, I can come. [[GAP: What time suits you?]] Thanks.' }), factsCheck: 'off' })
    expect(r.ok && r.draft.gaps.map((g) => g.question)).toEqual(['What time suits you?'])
    expect(findGaps('no markers here')).toEqual([])
    expect(findGaps('[[GAP: never closed')).toEqual([])
  })

  it('flags a fabricated date the thread does not back, in the text the user sees', async () => {
    const t = await thread()
    const calls: string[] = []
    const body = 'Yes, I will be there on 3 March. The fee is fine. I can also start on 9 May.'
    const r = await draftReply({
      ...base, folders: t.folders, thread: t.messages, model: modelOf({ body, statesDatePriceOrCommitment: true }),
      claimsClient: claimsClient(['Yes, I will be there on 3 March.', 'I can also start on 9 May.'], { 'I can also start on 9 May.': 'not_supported' }, calls),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft.facts.state).toBe('checked')
    expect(r.draft.flags.map((f) => [f.quote, f.verdict])).toEqual([['I can also start on 9 May.', 'not_supported']])
    expect(r.draft.body).toContain('I can also start on 9 May. [unverified:')
    expect(r.draft.body).not.toContain('on 3 March. [unverified')
  })

  it('negative control: a backed claim is not marked', async () => {
    const t = await thread()
    const r = await draftReply({ ...base, folders: t.folders, thread: t.messages, model: modelOf({ body: 'See you on 3 March.', statesDatePriceOrCommitment: true }), claimsClient: claimsClient(['See you on 3 March.'], {}) })
    expect(r.ok && r.draft.flags).toEqual([])
    expect(r.ok && r.draft.body).toBe('See you on 3 March.')
  })

  it('runs only for a draft that states a date, price or commitment, unless turned on', async () => {
    const t = await thread()
    const calls: string[] = []
    const mk = (factsCheck: 'auto' | 'on' | 'off', stated: boolean) =>
      draftReply({ ...base, folders: t.folders, thread: t.messages, model: modelOf({ body: 'Thanks, Pat.', statesDatePriceOrCommitment: stated }), claimsClient: claimsClient(['Thanks, Pat.'], {}, calls), factsCheck })
    expect((await mk('auto', false) as { draft: { facts: { state: string } } }).draft.facts.state).toBe('skipped')
    expect(calls).toEqual([])
    expect((await mk('auto', true) as { draft: { facts: { state: string } } }).draft.facts.state).toBe('checked')
    expect(calls.length).toBeGreaterThan(0)
    calls.length = 0
    expect((await mk('on', false) as { draft: { facts: { state: string } } }).draft.facts.state).toBe('checked')
    expect(calls.length).toBeGreaterThan(0)
  })

  it('behind the spend cap: no calls, and the draft says it was not checked', async () => {
    const t = await thread()
    const calls: string[] = []
    const r = await draftReply({ ...base, folders: t.folders, thread: t.messages, model: modelOf({ body: 'Fee: 400 euro.', statesDatePriceOrCommitment: true }), claimsClient: claimsClient(['Fee: 400 euro.'], {}, calls), spendAllowed: false })
    expect(calls).toEqual([])
    expect(r.ok && r.draft.facts.state).toBe('not_checked')
  })

  it('a check that cannot run is never a pass', async () => {
    const t = await thread()
    const broken = { callChatStructured: async () => { throw new Error('down') } } as unknown as ILLMClient
    const r = await draftReply({ ...base, folders: t.folders, thread: t.messages, model: modelOf({ body: 'Fee: 400 euro.', statesDatePriceOrCommitment: true }), claimsClient: broken })
    expect(r.ok && r.draft.facts.state).toBe('not_checked')
  })

  it('refuses when the account is off, and reports an unreadable answer', async () => {
    const t = await thread()
    const off = await draftReply({ ...base, account: { ...base.account, aieliaMayRead: false }, folders: t.folders, thread: t.messages, model: modelOf({ body: 'x' }) })
    expect(off.ok).toBe(false)
    const bad = await draftReply({ ...base, folders: t.folders, thread: t.messages, model: modelOf('not json at all') })
    expect(bad.ok).toBe(false)
  })
})

describe('draft edits and saving', () => {
  it('edits are suggestions: nothing changes until accepted; rejecting leaves the text', async () => {
    const t = await thread()
    const r = await draftReply({ ...base, folders: t.folders, thread: t.messages, model: modelOf({ body: 'Hi Pat, see you soon.' }), factsCheck: 'off' })
    if (!r.ok) throw new Error('no draft')
    const s = suggestDraftEdit(r.draft, { quote: 'see you soon', replacement: 'looking forward to it', reason: 'warmer' })
    if (!s.ok) throw new Error('no suggestion')
    expect(s.draft.body).toBe('Hi Pat, see you soon.')
    expect(s.draft.meta.suggestions[0]!.state).toBe('pending')
    const rej = rejectDraftEdit(s.draft, 'sg1')
    expect(rej.ok && rej.draft.body).toBe('Hi Pat, see you soon.')
    const acc = acceptDraftEdit(s.draft, 'sg1')
    expect(acc.ok && acc.draft.body).toBe('Hi Pat, looking forward to it.')
    expect(suggestDraftEdit(r.draft, { quote: 'not in the text', replacement: 'x', reason: 'y' }).ok).toBe(false)
  })

  it('saves to the Drafts folder with the gap marked, and never sends', async () => {
    const t = await thread()
    const r = await draftReply({ ...base, folders: t.folders, thread: t.messages, model: modelOf({ body: 'Hi. [[GAP: Which day?]]' }), factsCheck: 'off' })
    if (!r.ok) throw new Error('no draft')
    const saved = await saveReplyDraft(provider, r.draft)
    expect(saved.savedAs).toBeTruthy()
    const m = await provider.getMessage(saved.savedAs!)
    expect(m.flags.draft).toBe(true)
    expect(m.folderIds).toContain('fld-drafts')
    expect(m.textBody).toContain('[[GAP: Which day?]]')
  })
})
