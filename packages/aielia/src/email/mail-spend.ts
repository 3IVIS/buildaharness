import type { SettingsStore as KeyValueStore } from '../writer/write-permissions.js'
import { CALL_TYPES, CHAT_CALL, type CallType } from '../writer/write-spend.js'
import { MAX_ACTIVITY_RECORDS, addRecord, isJobRecord, type JobOutcome, type JobRecord } from '../writer/write-activity.js'

/**
 * What a mail model call was for, so the spend badge can show where the money went (plans/aielia_email_plan.html, gap on spend).
 * Same method as `write-spend.ts`: the type is read from the opening words of the call's system prompt. A test runs every mail
 * prompt through `classifyMailCall` and fails if one is not recognised, so a reworded prompt cannot silently move its cost to
 * "chat". The claim check behind a reply draft uses the writer's own steps, so those types are recognised here too.
 * Imports no LLM client (the F8 source scan); `withMailSpendCap` in `../mail-spend-bridge.ts` joins this to the cap.
 */

export const MAIL_CALL_TYPES: readonly CallType[] = [
  { id: 'mail_triage', label: 'Sorting new threads', marker: 'You triage email threads for their owner' },
  { id: 'mail_summary', label: 'Summarising mail', marker: 'You summarise email for their owner' },
  { id: 'mail_intent', label: 'Reading what a message asks for', marker: 'You read a user\'s newest message to their mail assistant' },
  { id: 'mail_voice', label: 'Learning how you write', marker: 'You describe how an email writer writes' },
  { id: 'mail_draft', label: 'Drafting a reply', marker: 'You write an email reply for its owner' },
  { id: 'mail_rule_propose', label: 'Proposing filing rules', marker: 'You look at how the owner of a mailbox files their mail' },
  { id: 'mail_rule_match', label: 'Matching mail to filing rules', marker: 'You decide which email messages match which filing rules' },
  { id: 'mail_chat', label: 'Mail chat', marker: 'You help the user with their email' },
]

/** Mail chat is a loop that sends the same conversation again at each step, so it is cached like the writer's chat. */
export const MAIL_CACHED_TYPES: readonly string[] = ['chat', 'mail_chat']

export interface PromptMessage { role: string; content: string }

/** A mail step, else one of the writer's steps (the draft's claim check), else the plain chat. */
export function classifyMailCall(messages: readonly PromptMessage[]): CallType {
  const text = messages.find((m) => m.role === 'system')?.content ?? ''
  return MAIL_CALL_TYPES.find((t) => text.startsWith(t.marker)) ?? CALL_TYPES.find((t) => text.startsWith(t.marker)) ?? CHAT_CALL
}

export function mailCallTypeLabel(id: string): string {
  return [...MAIL_CALL_TYPES, ...CALL_TYPES, CHAT_CALL].find((t) => t.id === id)?.label ?? id
}

/**
 * The only things the dev mirror may be sent about a mail call: the type, the model and the token counts. Never a prompt, a
 * reply, a subject, a sender or an address. The mirror hook for Email builds its bundle through this.
 */
export function mailMirrorBundle(callType: string, model: string | undefined, usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; estimated?: boolean }): Record<string, unknown> {
  return {
    callType: MAIL_CALL_TYPES.some((t) => t.id === callType) || CALL_TYPES.some((t) => t.id === callType) || callType === 'chat' ? callType : 'other',
    ...(model ? { model } : {}),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(usage.estimated ? { estimated: true } : {}),
  }
}

/** Kinds of mail job; the activity record holds one of these and never a name from the mailbox. */
export const MAIL_JOB_KINDS = ['triage', 'summarise', 'voice', 'draft', 'rules', 'rule_match', 'chat'] as const
export type MailJobKind = (typeof MAIL_JOB_KINDS)[number]

export const MAIL_ACTIVITY_KEY = 'mail:activity'

/** One record for a mail job: the kind, how it ended, the time and the cost. The kind is checked against the known list, so free text cannot get in. */
export function mailJobRecord(input: { at: string; kind: MailJobKind; outcome: JobOutcome; ms: number; usd: number; calls: number }): JobRecord {
  const kind = (MAIL_JOB_KINDS as readonly string[]).includes(input.kind) ? input.kind : 'other'
  const num = (n: number): number => (Number.isFinite(n) ? n : 0)
  return { at: input.at, kind: `mail:${kind}`, outcome: input.outcome, ms: num(input.ms), usd: num(input.usd), calls: num(input.calls) }
}

export async function loadMailActivity(store: KeyValueStore): Promise<JobRecord[]> {
  const raw = await store.getSetting(MAIL_ACTIVITY_KEY)
  return Array.isArray(raw) ? raw.filter(isJobRecord).slice(-MAX_ACTIVITY_RECORDS) : []
}

export async function recordMailJob(store: KeyValueStore, record: JobRecord): Promise<void> {
  await store.setSetting(MAIL_ACTIVITY_KEY, addRecord(await loadMailActivity(store), record))
}

/**
 * Runs one mail job and records it: the kind, outcome, time and the spend it caused (read from `spend` before and after). An error
 * is recorded as 'failed' and rethrown unchanged; nothing about its text is stored.
 */
export async function runMailJob<T>(
  o: { store: KeyValueStore; kind: MailJobKind; now?: () => number; spend: () => { usd: number; calls: number } },
  job: () => Promise<T>,
): Promise<T> {
  const now = o.now ?? Date.now
  const t0 = now()
  const before = o.spend()
  const finish = async (outcome: JobOutcome): Promise<void> => {
    const after = o.spend()
    await recordMailJob(o.store, mailJobRecord({ at: new Date(t0).toISOString(), kind: o.kind, outcome, ms: now() - t0, usd: after.usd - before.usd, calls: after.calls - before.calls }))
  }
  try {
    const r = await job()
    await finish('done')
    return r
  } catch (e) {
    await finish('failed')
    throw e
  }
}
