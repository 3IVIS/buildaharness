import type { EmailCache } from './cache.js'
import type { Account, Folder, Message, Thread, Triage } from './model.js'
import { triageThreads, type TriageModel, type TriageStore, type TriageThread } from './triage.js'

/**
 * The catch-up review (plans/aielia_email_capabilities_plan.html, C3): triage every thread in the review window that has no record yet,
 * newest first, in batches, and report what needs a response. It reads and records; it changes no mail. It is resumable (a thread that
 * already has a record is skipped, so running it again continues where it stopped), cancellable between batches, never overwrites a record
 * the user corrected, and says how much work it is before it starts (`estimateCatchUp`). All mail text reaches the model through
 * `triageThreads` and so through the F8 choke point. No `node:*` and no DOM imports; imports no LLM client.
 */

/** Folders whose threads are not "mail to review": what the user wrote, drafts, deleted and junk mail. */
const NOT_REVIEWED_KINDS = new Set<Folder['kind']>(['sent', 'drafts', 'trash', 'junk'])

export interface CatchUpDeps {
  account: Account
  cache: EmailCache
  store: TriageStore
  model: TriageModel
  /** ISO instant: only threads whose newest message is at or after it. Absent means every cached thread. */
  since?: string
  /** Threads per model call (default 20). */
  batchSize?: number
  now?: () => string
  /** Checked before every batch; true stops the run (`interrupted`). */
  shouldStop?: () => boolean
  /** Called after each batch. */
  onProgress?: (p: CatchUpProgress) => void
}

export interface CatchUpProgress { done: number; total: number }

export interface CatchUpEstimate {
  /** Threads in the window that are mail to review. */
  inWindow: number
  /** Of those, already carrying a record (they cost nothing). */
  alreadyReviewed: number
  /** Threads that would be sent to the model. */
  toReview: number
  /** Model calls that would be made. */
  calls: number
}

export interface CatchUpItem { threadId: string; subject: string; lastMessageAt: string; triage: Triage }

export interface CatchUpResult {
  status: 'complete' | 'interrupted'
  inWindow: number
  /** Threads that got a record this run. */
  reviewed: number
  /** Everything in the window (this run's and earlier records) that needs a response, most pressing first. */
  needsResponse: CatchUpItem[]
  /** Of `needsResponse`, how many are urgent now or have a deadline. */
  urgent: number
  /** Threads the model was not allowed to read (account off or excluded), which have no record. */
  withheld: number
  failedCalls: number
}

const BATCH = 20
const PAGE = 200
const URGENCY_RANK: Record<Triage['urgency'], number> = { now: 0, soon: 1, later: 2, none: 3 }
const PRIORITY_RANK: Record<Triage['priority'], number> = { high: 0, normal: 1, low: 2 }

/** The threads of this account that count as mail to review in the window, newest first. */
async function threadsToReview(deps: Pick<CatchUpDeps, 'account' | 'cache' | 'since'>): Promise<Thread[]> {
  const folders = await deps.cache.getFolders(deps.account.id)
  const skipIds = new Set(folders.filter((f) => NOT_REVIEWED_KINDS.has(f.kind)).map((f) => f.id))
  const out: Thread[] = []
  for (let offset = 0; ; offset += PAGE) {
    const page = await deps.cache.listThreads(undefined, { offset, limit: PAGE })
    for (const t of page.items) {
      if (t.accountId !== deps.account.id) continue
      if (deps.since && t.lastMessageAt < deps.since) continue
      // A thread that has any message outside the sent, drafts, trash and junk folders is mail to review.
      if (t.folderIds.length > 0 && t.folderIds.every((id) => skipIds.has(id))) continue
      out.push(t)
    }
    if (offset + PAGE >= page.total) break
    // listThreads is newest first: once a whole page is older than the window nothing later can be inside it.
    if (deps.since && page.items.length > 0 && page.items[page.items.length - 1]!.lastMessageAt < deps.since) break
  }
  return out
}

export async function estimateCatchUp(deps: Pick<CatchUpDeps, 'account' | 'cache' | 'store' | 'since' | 'batchSize'>): Promise<CatchUpEstimate> {
  const threads = await threadsToReview(deps)
  let already = 0
  for (const t of threads) if (await deps.store.get(t.id)) already++
  const toReview = threads.length - already
  return { inWindow: threads.length, alreadyReviewed: already, toReview, calls: Math.ceil(toReview / Math.max(1, deps.batchSize ?? BATCH)) }
}

async function load(cache: EmailCache, t: Thread, accountId: string): Promise<TriageThread> {
  const msgs: Message[] = []
  for (let offset = 0; ; offset += PAGE) {
    const page = await cache.queryMessages({ threadId: t.id }, { offset, limit: PAGE })
    msgs.push(...page.items.filter((m) => m.accountId === accountId))
    if (offset + PAGE >= page.total) break
  }
  return { thread: t, messages: msgs }
}

export async function runCatchUp(deps: CatchUpDeps): Promise<CatchUpResult> {
  const threads = await threadsToReview(deps)
  const folders = await deps.cache.getFolders(deps.account.id)
  const pending: Thread[] = []
  for (const t of threads) if (!(await deps.store.get(t.id))) pending.push(t)
  const size = Math.max(1, deps.batchSize ?? BATCH)
  let reviewed = 0, failedCalls = 0
  let status: CatchUpResult['status'] = 'complete'
  for (let i = 0; i < pending.length; i += size) {
    if (deps.shouldStop?.()) { status = 'interrupted'; break }
    const batch = pending.slice(i, i + size)
    const items = await Promise.all(batch.map((t) => load(deps.cache, t, deps.account.id)))
    const r = await triageThreads(items, { account: deps.account, folders, model: deps.model, store: deps.store, batchSize: size, ...(deps.now ? { now: deps.now } : {}) })
    reviewed += r.written.length
    failedCalls += r.failedCalls
    deps.onProgress?.({ done: Math.min(pending.length, i + batch.length), total: pending.length })
  }

  const needs: CatchUpItem[] = []
  let withheld = 0
  for (const t of threads) {
    const tr = await deps.store.get(t.id)
    if (!tr) { withheld++; continue }
    if (tr.needsReply) needs.push({ threadId: t.id, subject: t.subject, lastMessageAt: t.lastMessageAt, triage: tr })
  }
  needs.sort((a, b) => URGENCY_RANK[a.triage.urgency] - URGENCY_RANK[b.triage.urgency] || PRIORITY_RANK[a.triage.priority] - PRIORITY_RANK[b.triage.priority] || (a.lastMessageAt < b.lastMessageAt ? 1 : -1))
  const urgent = needs.filter((n) => n.triage.urgency === 'now' || n.triage.dueDate !== undefined).length
  return { status, inWindow: threads.length, reviewed, needsResponse: needs, urgent, withheld, failedCalls }
}

/** Plain words for the chat column and the CLI. */
export function catchUpSummary(r: CatchUpResult, windowLabel?: string): string[] {
  const where = windowLabel ? ` (${windowLabel.toLowerCase()})` : ''
  const head = r.inWindow === 0 ? `No mail to review${where}.`
    : `${r.needsResponse.length} of ${r.inWindow} thread${r.inWindow === 1 ? '' : 's'}${where} need a response${r.urgent > 0 ? `, ${r.urgent} urgent` : ''}.`
  const lines = [head]
  for (const n of r.needsResponse.slice(0, 10)) lines.push(`  - ${n.subject}: ${n.triage.reason}`)
  if (r.needsResponse.length > 10) lines.push(`  …and ${r.needsResponse.length - 10} more, all on your To do list.`)
  if (r.status === 'interrupted') lines.push('The review was stopped before it finished; run it again to continue.')
  if (r.failedCalls > 0) lines.push(`${r.failedCalls} model call${r.failedCalls === 1 ? '' : 's'} failed; those threads were left unreviewed.`)
  if (r.withheld > 0) lines.push(`${r.withheld} thread${r.withheld === 1 ? ' was' : 's were'} not reviewed (excluded from Aielia, or not answered).`)
  return lines
}
