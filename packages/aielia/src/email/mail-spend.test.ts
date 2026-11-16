import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient } from '@buildaharness/runtime'
import { createSpendMeter, SpendCapReachedError, type SettingsStore } from '../writer/write-permissions.js'
import { CALL_TYPES, CHAT_CALL } from '../writer/write-spend.js'
import { createCappedMailModel } from '../mail-spend-bridge.js'
import { generateSyntheticMailbox, SYNTHETIC_OWNER } from './synthetic-mailbox.js'
import { hostileMessages } from './hostile-set.js'
import { triageThreads, InMemoryTriageStore, TRIAGE_SYSTEM_PROMPT } from './triage.js'
import { VOICE_SYSTEM_PROMPT } from './voice.js'
import { DRAFT_SYSTEM_PROMPT } from './draft.js'
import { MAIL_INTENT_SYSTEM_PROMPT } from './mail-intent.js'
import { MAIL_SUMMARISE_SYSTEM_PROMPT } from './mail-tools.js'
import { RULE_PROPOSE_SYSTEM_PROMPT, RULE_JUDGE_SYSTEM_PROMPT } from './rules.js'
import { buildMailSystemPrompt } from './mail-chat.js'
import {
  MAIL_CALL_TYPES, classifyMailCall, mailCallTypeLabel, mailMirrorBundle, runMailJob, loadMailActivity, MAIL_ACTIVITY_KEY, mailJobRecord,
} from './mail-spend.js'
import type { Message } from './model.js'

const sys = (content: string): ChatMessage[] => [{ role: 'system', content }, { role: 'user', content: 'x' }]

function memStore(): SettingsStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return { data, getSetting: async (k) => data.get(k), setSetting: async (k, v) => { data.set(k, JSON.parse(JSON.stringify(v))) } }
}

/** A client that answers with the given text and reports a usage for each call, as a real one does. */
function client(answer: string, seen: string[] = []): ILLMClient {
  return {
    callChatSync: async (messages: ChatMessage[], o?: ChatOptions) => {
      seen.push(messages.find((m) => m.role === 'system')?.content.slice(0, 30) ?? '')
      o?.onUsage?.({ inputTokens: 100, outputTokens: 20 })
      return answer
    },
  } as unknown as ILLMClient
}

describe('mail call types', () => {
  const steps: Array<[string, string]> = [
    ['mail_triage', TRIAGE_SYSTEM_PROMPT],
    ['mail_summary', MAIL_SUMMARISE_SYSTEM_PROMPT],
    ['mail_intent', MAIL_INTENT_SYSTEM_PROMPT],
    ['mail_voice', VOICE_SYSTEM_PROMPT],
    ['mail_draft', DRAFT_SYSTEM_PROMPT],
    ['mail_rule_propose', RULE_PROPOSE_SYSTEM_PROMPT],
    ['mail_rule_match', RULE_JUDGE_SYSTEM_PROMPT],
    ['mail_chat', buildMailSystemPrompt()],
    ['mail_chat', buildMailSystemPrompt([{ id: 'n', target: { kind: 'thread', threadId: 't1' }, text: 'a note', at: 'x' } as never])],
  ]

  it('recognises every mail model step, so none is counted as chat by mistake', () => {
    for (const [id, prompt] of steps) expect(classifyMailCall(sys(prompt)).id, id).toBe(id)
    // Every declared mail type is exercised by some step.
    expect(new Set(steps.map(([id]) => id))).toEqual(new Set(MAIL_CALL_TYPES.map((t) => t.id)))
  })

  it('a reworded prompt is caught (negative control) and falls to chat', () => {
    expect(classifyMailCall(sys('Please triage these threads: ' + TRIAGE_SYSTEM_PROMPT))).toBe(CHAT_CALL)
  })

  it('recognises the writer steps used by the draft facts check, and keeps ids distinct from them', () => {
    expect(classifyMailCall(sys(CALL_TYPES[0].marker + ' more')).id).toBe('claims')
    const ids = [...MAIL_CALL_TYPES, ...CALL_TYPES].map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(mailCallTypeLabel('mail_draft')).toBe('Drafting a reply')
  })

  it('a prompt wrapper does not confuse markers: no two mail markers match the same prompt', () => {
    for (const [, prompt] of steps) expect(MAIL_CALL_TYPES.filter((t) => prompt.startsWith(t.marker))).toHaveLength(1)
  })
})

describe('the cap on mail model calls', () => {
  it('counts a mail call by its type and refuses once the cap is reached', async () => {
    const meter = await createSpendMeter(memStore(), { backend: 'proxy', model: 'claude-sonnet-5-5' })
    const model = createCappedMailModel(client('{}'), meter, () => 0.0000001)
    await model(TRIAGE_SYSTEM_PROMPT, 'u')
    expect(meter.byType().mail_triage?.calls).toBe(1)
    await expect(model(TRIAGE_SYSTEM_PROMPT, 'u')).rejects.toBeInstanceOf(SpendCapReachedError)
    expect(meter.byType().mail_triage?.calls).toBe(1)
  })

  it('a mail model step with no cap set is still counted', async () => {
    const meter = await createSpendMeter(memStore(), {})
    const model = createCappedMailModel(client('x'), meter, () => undefined)
    await model(DRAFT_SYSTEM_PROMPT, 'u')
    await model(RULE_JUDGE_SYSTEM_PROMPT, 'u')
    expect(Object.keys(meter.byType()).sort()).toEqual(['mail_draft', 'mail_rule_match'])
  })
})

describe('mail activity record', () => {
  it('records the kind, outcome, time and spend of a job', async () => {
    const store = memStore()
    let t = 1000
    let usd = 0
    let calls = 0
    await runMailJob({ store, kind: 'triage', now: () => (t += 500), spend: () => ({ usd, calls }) }, async () => { usd += 0.02; calls += 2 })
    await expect(runMailJob({ store, kind: 'draft', now: () => (t += 10), spend: () => ({ usd, calls }) }, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    const rs = await loadMailActivity(store)
    expect(rs.map((r) => [r.kind, r.outcome])).toEqual([['mail:triage', 'done'], ['mail:draft', 'failed']])
    expect(rs[0]).toMatchObject({ usd: 0.02, calls: 2, ms: 500 })
  })

  it('a kind outside the known list cannot carry free text into the record', () => {
    const r = mailJobRecord({ at: 'now', kind: 'Invoice from Dana' as never, outcome: 'done', ms: 1, usd: 0, calls: 0 })
    expect(r.kind).toBe('mail:other')
  })
})

describe('no mail text outside the model call', () => {
  const mb = generateSyntheticMailbox({ seed: 5, perCategory: 2 })
  const all: Message[] = [...mb.messages, ...hostileMessages()]
  /** Strings that identify the synthetic mailbox: if one shows up in an activity record, a mirror bundle or an error, mail text leaked. */
  const secrets = [...new Set(all.flatMap((m) => [m.subject, m.from.address, m.from.name, m.textBody.slice(0, 60), ...m.to.map((a) => a.address)]))]
    .filter((s): s is string => typeof s === 'string' && s.length >= 6)
  const leaks = (text: string): string[] => secrets.filter((s) => text.includes(s))

  it('the check has something to look for', () => {
    expect(secrets.length).toBeGreaterThan(10)
    expect(secrets).toContain(SYNTHETIC_OWNER.address)
    expect(leaks(`x ${mb.messages[0].subject} y`)).toContain(mb.messages[0].subject) // negative control
  })

  it('activity records, the mirror bundle and error text from mail jobs hold none', async () => {
    const store = memStore()
    const meter = await createSpendMeter(memStore(), { backend: 'proxy' })
    const mirror: unknown[] = []
    // Each counted call is sent to the dev mirror the way the Write hook does, but only through the safe bundle.
    const record = meter.record
    meter.record = async (usage, type, model) => { mirror.push(mailMirrorBundle(type ?? 'chat', model, usage)); return record(usage, type, model) }
    const answer = JSON.stringify({ triage: [] })
    const model = createCappedMailModel(client(answer), meter, () => 1)
    const errors: string[] = []
    const items = mb.threads.map((thread) => ({ thread, messages: mb.messages.filter((m) => m.threadId === thread.id) }))
    const account = { aieliaMayRead: true, excludedFolders: [] as string[], excludedSenders: [] as string[] }
    await runMailJob({ store, kind: 'triage', spend: () => meter.snapshot() }, () => triageThreads(items, { account, model, store: new InMemoryTriageStore(), now: () => '2026-11-13T10:00:00.000Z' }))
    // A failing job: the cap is reached while mail text is in the prompt; the error must not carry that text.
    const capped = createCappedMailModel(client(answer), meter, () => 0)
    try {
      await runMailJob({ store, kind: 'triage', spend: () => meter.snapshot() }, () => capped(TRIAGE_SYSTEM_PROMPT, `${mb.messages[0].subject}\n${mb.messages[0].textBody}`))
    } catch (e) { errors.push(String((e as Error).message)) }
    expect(errors).toHaveLength(1)
    const records = await loadMailActivity(store)
    expect(records.length).toBe(2)
    expect(mirror.length).toBeGreaterThan(0)
    expect(leaks(JSON.stringify(store.data.get(MAIL_ACTIVITY_KEY)))).toEqual([])
    expect(leaks(JSON.stringify(mirror))).toEqual([])
    expect(leaks(errors.join('\n'))).toEqual([])
    expect(JSON.stringify(Object.fromEntries(store.data))).not.toContain(SYNTHETIC_OWNER.address)
  })

  it('the mirror bundle drops an unknown type and any extra field', () => {
    const b = mailMirrorBundle('Invoice from Dana', 'm', { inputTokens: 1, outputTokens: 2, ...({ subject: 'secret subject line' } as object) })
    expect(b.callType).toBe('other')
    expect(JSON.stringify(b)).not.toContain('secret subject line')
  })
})
