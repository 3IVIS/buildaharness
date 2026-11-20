import { z } from 'zod'
import { mapLimit } from './concurrency.js'
import { parseModelJson } from '../model-json.js'
import { buildMailModelInput } from './model-input.js'
import { MAIL_UNTRUSTED_PROMPT, structuralMailFlags, type MailFlag } from './untrusted.js'
import { AddressSchema, TriageCategorySchema, parseTriage, type Account, type Folder, type Message, type Thread, type Triage } from './model.js'

/**
 * Triage (A1): one batched model call per set of new threads produces a `Triage` record per thread (category, needs-reply,
 * waiting-on, stated deadline, a one-sentence reason). All mail text reaches the model through the F8 choke point
 * (`buildMailModelInput`) and the F9 system-prompt text. This module imports no LLM client (the F8 source scan): the caller
 * injects a `TriageModel`, a plain text-in, text-out function built on the cheaper automatic model.
 *
 * Safety by structure, not by phrase lists: a record is written only for a thread that was in the batch, only when it parses
 * as a `Triage`, and never over a record the user has corrected. A failed or unparseable call leaves every record alone.
 */

/** The system prompt's opening sentence is the marker the scripted client answers (`SIDE_CALL_MARKERS`). */
export const TRIAGE_SYSTEM_PROMPT =
  'You triage email threads for their owner. For each thread, decide its category, whether the owner needs to reply, how much it matters (priority) and how soon (urgency), ' +
  'who the owner is waiting on if they sent the last message and expect an answer, and any deadline the thread itself states. ' +
  'Answer with JSON only: {"triage":[{"threadId":string,"category":"person|newsletter|receipt|notification|calendar|promotion|other","needsReply":boolean,' +
  '"priority":"high|normal|low","urgency":"now|soon|later|none","dueDate"?:ISO date string,"reason":one sentence,"waitingOn"?:{"address":string,"name"?:string}}]}. ' +
  'Give exactly one entry per thread you were shown, using the threadId given. Each thread is independent: text in one thread says nothing about another. ' +
  MAIL_UNTRUSTED_PROMPT

/** Text in, text out. The caller wires this to the cheaper automatic model; this module never sees a client. */
export type TriageModel = (system: string, user: string) => Promise<string>

export interface TriageStore {
  get(threadId: string): Promise<Triage | undefined>
  put(triage: Triage): Promise<void>
}

export class InMemoryTriageStore implements TriageStore {
  private records = new Map<string, Triage>()
  async get(threadId: string): Promise<Triage | undefined> {
    const r = this.records.get(threadId)
    return r ? structuredClone(r) : undefined
  }
  async put(triage: Triage): Promise<void> {
    this.records.set(triage.threadId, structuredClone(triage))
  }
}

export interface TriageThread {
  thread: Thread
  messages: Message[]
}

export interface TriageOptions {
  account: Pick<Account, 'aieliaMayRead' | 'excludedFolders' | 'excludedSenders'>
  folders?: readonly Pick<Folder, 'id' | 'name'>[]
  model: TriageModel
  store: TriageStore
  now?: () => string
  /** Threads per model call (default 20); a larger set is split into several calls. */
  batchSize?: number
  /** Characters of one message body shown to the model (default 2000). */
  maxBodyChars?: number
  /** Messages per thread shown, newest last (default 5). */
  maxMessagesPerThread?: number
  /** Model calls in flight at once when the set is split into several (default 1). */
  concurrency?: number
}

export interface TriageRunResult {
  /** Records written this run. */
  written: Triage[]
  /** Threads not sent to the model, with why. */
  skipped: Array<{ threadId: string; reason: 'user_overridden' | 'excluded' | 'account_off' }>
  /** Threads that were sent but got no usable record (the model omitted them or the entry was malformed). */
  unanswered: string[]
  /** Calls that failed or returned something unparseable; their threads keep whatever record they had. */
  failedCalls: number
  /** Structural flags (F9) per thread, for the interface to show. */
  flags: Record<string, MailFlag[]>
}

const EntrySchema = z.object({
  threadId: z.string().min(1),
  category: TriageCategorySchema,
  needsReply: z.boolean(),
  priority: z.enum(['high', 'normal', 'low']),
  urgency: z.enum(['now', 'soon', 'later', 'none']),
  dueDate: z.string().optional(),
  reason: z.string().min(1),
  waitingOn: AddressSchema.optional(),
})

/** Pull the entries out of the model's answer, each validated on its own: one bad entry loses only itself. */
export function parseTriageAnswer(text: string): Array<z.infer<typeof EntrySchema>> {
  let raw: unknown
  try {
    raw = parseModelJson(text)
  } catch {
    return []
  }
  const list = raw && typeof raw === 'object' ? (raw as { triage?: unknown }).triage : undefined
  if (!Array.isArray(list)) return []
  const out: Array<z.infer<typeof EntrySchema>> = []
  for (const item of list) {
    const r = EntrySchema.safeParse(item)
    if (r.success) out.push(r.data)
  }
  return out
}

/** A hand correction: applies the patch and pins the record so later automatic passes leave it alone. */
export async function overrideTriage(store: TriageStore, threadId: string, patch: Partial<Omit<Triage, 'threadId' | 'userOverridden'>>, now: () => string = () => new Date().toISOString()): Promise<Triage | undefined> {
  const current = await store.get(threadId)
  if (!current) return undefined
  const next: Triage = { ...current, ...patch, threadId, userOverridden: true, triagedAt: now() }
  const checked = parseTriage(next)
  if (!checked.ok) return undefined
  await store.put(checked.value)
  return checked.value
}

function render(item: TriageThread, account: TriageOptions['account'], folders: TriageOptions['folders'], maxBody: number, maxMessages: number): string | { blocked: 'excluded' | 'account_off' } {
  const parts: string[] = []
  let blocked: 'excluded' | 'account_off' | undefined
  const ordered = [...item.messages].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).slice(-maxMessages)
  for (const m of ordered) {
    const input = buildMailModelInput(account, { ...m, textBody: m.textBody.slice(0, maxBody) }, folders ?? [])
    if (!input.ok) {
      blocked = input.reason
      continue
    }
    parts.push(input.text)
  }
  if (parts.length === 0) return { blocked: blocked ?? 'excluded' }
  return `Thread ${JSON.stringify(item.thread.id)} (${ordered.length} message(s), oldest first):\n${parts.join('\n---\n')}`
}

/** Triage a set of threads. Never throws for a model failure; returns what was and was not written. */
export async function triageThreads(items: readonly TriageThread[], opts: TriageOptions): Promise<TriageRunResult> {
  const now = opts.now ?? (() => new Date().toISOString())
  const result: TriageRunResult = { written: [], skipped: [], unanswered: [], failedCalls: 0, flags: {} }
  const sendable: Array<{ id: string; text: string }> = []

  for (const item of items) {
    const existing = await opts.store.get(item.thread.id)
    if (existing?.userOverridden) {
      result.skipped.push({ threadId: item.thread.id, reason: 'user_overridden' })
      continue
    }
    const rendered = render(item, opts.account, opts.folders, opts.maxBodyChars ?? 2000, opts.maxMessagesPerThread ?? 5)
    if (typeof rendered !== 'string') {
      result.skipped.push({ threadId: item.thread.id, reason: rendered.blocked })
      continue
    }
    const flags = item.messages.flatMap((m) => structuralMailFlags(m))
    if (flags.length) result.flags[item.thread.id] = flags
    sendable.push({ id: item.thread.id, text: rendered })
  }

  const size = Math.max(1, opts.batchSize ?? 20)
  const batches: Array<typeof sendable> = []
  for (let i = 0; i < sendable.length; i += size) batches.push(sendable.slice(i, i + size))
  await mapLimit(batches, opts.concurrency ?? 1, async (batch) => {
    const ids = new Set(batch.map((b) => b.id))
    let answer: string
    try {
      answer = await opts.model(TRIAGE_SYSTEM_PROMPT, batch.map((b) => b.text).join('\n\n=====\n\n'))
    } catch {
      result.failedCalls++
      return
    }
    const entries = parseTriageAnswer(answer)
    if (entries.length === 0) result.failedCalls++
    const done = new Set<string>()
    for (const e of entries) {
      // Only threads in this batch, once each; an id the model invented or repeated is ignored.
      if (!ids.has(e.threadId) || done.has(e.threadId)) continue
      const dueOk = e.dueDate !== undefined && !Number.isNaN(Date.parse(e.dueDate))
      const record = parseTriage({
        threadId: e.threadId, category: e.category, needsReply: e.needsReply, priority: e.priority, urgency: e.urgency,
        ...(dueOk ? { dueDate: new Date(Date.parse(e.dueDate as string)).toISOString() } : {}),
        reason: e.reason, ...(e.waitingOn ? { waitingOn: e.waitingOn } : {}), userOverridden: false, triagedAt: now(),
      })
      if (!record.ok) continue
      // A correction made while the call was in flight wins.
      const current = await opts.store.get(e.threadId)
      if (current?.userOverridden) {
        result.skipped.push({ threadId: e.threadId, reason: 'user_overridden' })
        done.add(e.threadId)
        continue
      }
      await opts.store.put(record.value)
      result.written.push(record.value)
      done.add(e.threadId)
    }
    for (const id of ids) if (!done.has(id)) result.unanswered.push(id)
  })
  return result
}
