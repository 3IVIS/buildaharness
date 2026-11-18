import { FakeEmailProvider } from './fake-provider.js'
import { generateSyntheticMailbox, type SyntheticMailbox, type SyntheticCategory } from './synthetic-mailbox.js'
import { InMemoryEmailCache } from './cache.js'
import { syncAccount } from './sync.js'
import { InMemoryTriageStore, triageThreads, type TriageModel } from './triage.js'
import { buildTodoList, groupTodo, type ScoredTodo } from './todo.js'
import { draftReply, saveReplyDraft, type DraftModel } from './draft.js'
import { SendCoordinator, type StagedSend } from './send.js'
import { parseEmailCommand, formatEmailCommand, type EmailCommand } from './email-command.js'
import type { Message, Thread, Triage } from './model.js'
import { catchUpSummary, estimateCatchUp, runCatchUp } from './catch-up.js'
import { InMemoryJunkStore, classifyJunk, learnJunkSignals, proposeJunkMoves, type JunkModel, type JunkVerdict } from './junk.js'
import { EmailActionLog, TurnCeiling } from './action-log.js'
import { OrganiseSession, SnoozeStore, confirmPending } from './organise-tools.js'
import { REVIEW_WINDOWS, reviewWindowLabel, windowSince, type ReviewWindow } from './review-window.js'

/**
 * `/email` over the fake provider and the invented sample mailbox, with no network and no model: the whole read, triage, to-do and draft
 * path runs through the same shared code a connected account uses, so it can be driven by piped input. Models are injectable; the defaults
 * are fixed stand-ins for the sample (they answer from the generator's own category labels), never a real model. Sending is never done
 * here without an explicit `approve` of the fingerprint the user was shown. No `node:*` and no DOM imports.
 */

const TRIAGE_FOR: Record<SyntheticCategory, { category: Triage['category']; needsReply: boolean; priority: Triage['priority']; urgency: Triage['urgency'] }> = {
  newsletter: { category: 'newsletter', needsReply: false, priority: 'low', urgency: 'none' },
  receipt: { category: 'receipt', needsReply: false, priority: 'low', urgency: 'none' },
  direct_question: { category: 'person', needsReply: true, priority: 'high', urgency: 'soon' },
  waiting_on_other: { category: 'person', needsReply: false, priority: 'normal', urgency: 'later' },
  deadline: { category: 'person', needsReply: true, priority: 'high', urgency: 'now' },
  spoofed_sender: { category: 'other', needsReply: false, priority: 'low', urgency: 'none' },
}

/** The sample triage stand-in: answers by the generator's labels; any thread it does not know is "other, low". It reads no mail text. */
export function sampleTriageModel(labels: Record<string, SyntheticCategory>): TriageModel {
  return async (_system, user) => {
    // The prompt lists each thread on its own line as `Thread "<json-string id>" ...`; read the quoted id.
    const ids: string[] = []
    for (const line of user.split('\n')) {
      if (!line.startsWith('Thread "')) continue
      let end = 8
      while (end < line.length && line[end] !== '"') end += line[end] === '\\' ? 2 : 1
      ids.push(JSON.parse(line.slice(7, end + 1)) as string)
    }
    const triage = ids.map((threadId) => {
      const label = labels[threadId]
      const t = label ? TRIAGE_FOR[label] : { category: 'other' as const, needsReply: false, priority: 'low' as const, urgency: 'none' as const }
      return { threadId, ...t, reason: label ? `Sample mailbox: ${label.replace(/_/g, ' ')}.` : 'Sample mailbox: not a known thread.' }
    })
    return JSON.stringify({ triage })
  }
}

/** The sample draft stand-in: a short fixed acknowledgement with a gap the user must fill. It reads no mail text. */
export const sampleDraftModel: DraftModel = async () =>
  JSON.stringify({ body: 'Thanks for your message. I will get back to you on the details by [[GAP:the date you can commit to]].', statesDatePriceOrCommitment: false })

/** The sample junk stand-in: calls a thread spam only when the generator labelled it a spoofed sender, otherwise unsure. It reads no mail text. */
export function sampleJunkModel(labels: Record<string, SyntheticCategory>): JunkModel {
  return async (_system, user) => {
    const ids: string[] = []
    for (const line of user.split('\n')) {
      if (!line.startsWith('Thread "')) continue
      let end = 8
      while (end < line.length && line[end] !== '"') end += line[end] === '\\' ? 2 : 1
      ids.push(JSON.parse(line.slice(7, end + 1)) as string)
    }
    return JSON.stringify({ junk: ids.map((threadId) => ({ threadId, verdict: labels[threadId] === 'spoofed_sender' ? 'likely_spam' : 'unsure', reason: labels[threadId] === 'spoofed_sender' ? 'Sample mailbox: a spoofed sender.' : 'Sample mailbox: not clearly junk.' })) })
  }
}

export interface OfflineEmailSessionOptions {
  mailbox?: SyntheticMailbox
  triageModel?: TriageModel
  draftModel?: DraftModel
  junkModel?: JunkModel
  now?: () => string
}

export class OfflineEmailSession {
  readonly provider: FakeEmailProvider
  readonly sender: SendCoordinator
  private readonly cache = new InMemoryEmailCache()
  private readonly store = new InMemoryTriageStore()
  private readonly triageModel: TriageModel
  private readonly draftModel: DraftModel
  private readonly junkModel: JunkModel
  private readonly junk = new InMemoryJunkStore()
  private readonly session = new OrganiseSession()
  private readonly actionLog = new EmailActionLog()
  private readonly now: () => string
  private readonly staged = new Map<string, StagedSend>()
  private synced = false

  constructor(opts: OfflineEmailSessionOptions = {}) {
    const mailbox = opts.mailbox ?? generateSyntheticMailbox()
    this.provider = new FakeEmailProvider(mailbox)
    this.sender = new SendCoordinator(this.provider)
    this.triageModel = opts.triageModel ?? sampleTriageModel(mailbox.categoryByThread)
    this.draftModel = opts.draftModel ?? sampleDraftModel
    this.junkModel = opts.junkModel ?? sampleJunkModel(mailbox.categoryByThread)
    this.now = opts.now ?? (() => new Date().toISOString())
  }

  /** Staged sends still waiting for a decision. */
  pending(): StagedSend[] { return [...this.staged.values()] }

  private async threads(): Promise<Array<{ thread: Thread; messages: Message[] }>> {
    if (!this.synced) {
      await syncAccount(this.provider, this.cache)
      this.synced = true
    }
    const threads = await this.cache.listThreads(undefined, { offset: 0, limit: 500 })
    const out: Array<{ thread: Thread; messages: Message[] }> = []
    for (const t of threads.items) out.push({ thread: t, messages: (await this.cache.queryMessages({ threadId: t.id }, { offset: 0, limit: 100 })).items })
    return out
  }

  /** Triage every thread. Returns how many records were written. */
  async review(): Promise<{ written: number; lines: string[] }> {
    const items = await this.threads()
    const res = await triageThreads(items, { account: this.provider.account, model: this.triageModel, store: this.store, now: this.now })
    const lines = [`Reviewed ${items.length} thread(s): ${res.written.length} triaged, ${res.skipped.length} skipped, ${res.unanswered.length} unanswered.`]
    for (const w of res.written) {
      const subject = items.find((i) => i.thread.id === w.threadId)?.thread.subject ?? w.threadId
      lines.push(`  ${w.category}${w.needsReply ? ' (reply needed)' : ''} — ${subject}: ${w.reason}`)
    }
    for (const [id, flags] of Object.entries(res.flags)) lines.push(`  ! ${id}: ${flags.map((f) => f.kind).join(', ')}`)
    return { written: res.written.length, lines }
  }

  /** Review the mail of a window (default 30 days) and say what needs a response. Reads and records; changes no mail. */
  async catchUp(arg?: string): Promise<{ lines: string[]; needsResponse: number }> {
    const window = (arg === undefined ? 30 : REVIEW_WINDOWS.find((w) => String(w) === arg.toLowerCase())) as ReviewWindow | undefined
    if (window === undefined) return { lines: [`Unknown window "${arg}". Use one of: ${REVIEW_WINDOWS.join(', ')}.`], needsResponse: 0 }
    await this.threads()
    const since = windowSince(window, new Date(this.now()))
    const deps = { account: this.provider.account, cache: this.cache, store: this.store, model: this.triageModel, ...(since ? { since } : {}), now: this.now }
    const est = await estimateCatchUp(deps)
    const r = await runCatchUp(deps)
    return { lines: [`${reviewWindowLabel(window)}: ${est.inWindow} thread(s), ${est.toReview} to review in ${est.calls} model call(s).`, ...catchUpSummary(r, reviewWindowLabel(window))], needsResponse: r.needsResponse.length }
  }

  /** Judge the mail for spam (learned signals, then the model, then the guards) and propose ONE move to Junk. Nothing moves until `move` is true. */
  async spam(move = false): Promise<{ likely: JunkVerdict[]; lines: string[] }> {
    const items = await this.threads()
    const folders = await this.provider.listFolders()
    const all = (await this.cache.queryMessages({}, { offset: 0, limit: 100_000 })).items
    const account = this.provider.account
    const signals = learnJunkSignals(all, folders, [account.address])
    const kinds = new Map(folders.map((f) => [f.id, f.kind]))
    // By the messages (a local move updates them at once; the thread record's folder list follows on the next sync).
    const inbox = items.filter((i) => i.messages.some((m) => m.folderIds.some((f) => kinds.get(f) === 'inbox')))
    await classifyJunk(inbox, {
      account, folders, signals, model: this.junkModel, store: this.junk, triage: this.store, now: this.now,
      junkExamples: all.filter((m) => m.folderIds.some((f) => kinds.get(f) === 'junk')), hamExamples: all.filter((m) => signals.correspondents.includes(m.from.address.toLowerCase())),
    })
    const likely = (await Promise.all(inbox.map((i) => this.junk.get(i.thread.id)))).filter((v): v is JunkVerdict => v?.verdict === 'likely_spam')
    const lines: string[] = []
    if (likely.length === 0) return { likely, lines: ['No mail looks like spam. (Review first with /email review so nothing real is mistaken for it.)'] }
    for (const v of likely) lines.push(`  - ${items.find((i) => i.thread.id === v.threadId)?.thread.subject ?? v.threadId}: ${v.reason}`)
    const ctx = { account, action: { cache: this.cache, provider: this.provider, log: this.actionLog, now: this.now, turn: new TurnCeiling() }, session: this.session }
    const prop = await proposeJunkMoves(likely, ctx)
    if (!prop.pending) return { likely, lines: [`${likely.length} thread(s) look like spam, but there is nothing to move (${prop.reason ?? 'no change'}).`, ...lines] }
    if (!move) return { likely, lines: [`${likely.length} thread(s) look like spam. Moving them to Junk would change ${prop.pending.messageIds.length} message(s); nothing has moved. Run /email spam move to do it (it can be undone).`, ...lines] }
    const done = await confirmPending({ account, action: ctx.action, session: this.session, snoozes: new SnoozeStore() }, prop.pending.id)
    return { likely, lines: [done.text, ...lines] }
  }

  async todo(): Promise<{ items: ScoredTodo[]; lines: string[] }> {
    const items = await this.threads()
    const triage: Triage[] = []
    for (const i of items) { const t = await this.store.get(i.thread.id); if (t) triage.push(t) }
    const list = buildTodoList({ triage, threads: items, userAddresses: [this.provider.account.address], now: this.now })
    const lines: string[] = triage.length === 0 ? ['Nothing has been reviewed yet; run /email review first.'] : []
    for (const g of groupTodo(list)) {
      if (g.items.length === 0) continue
      lines.push(`${g.label}:`)
      for (const it of g.items) lines.push(`  - ${it.title}`)
    }
    if (triage.length > 0 && list.length === 0) lines.push('Your to-do list is empty.')
    return { items: list, lines }
  }

  /** Draft a reply, save it to Drafts and stage it for approval. Never sends. */
  async reply(threadId?: string): Promise<{ staged?: StagedSend; lines: string[] }> {
    const items = await this.threads()
    let target = threadId ? items.find((i) => i.thread.id === threadId) : undefined
    if (!target) {
      for (const i of items) if ((await this.store.get(i.thread.id))?.needsReply) { target = i; break }
    }
    if (!target) return { lines: [threadId ? `No thread ${threadId}.` : 'No thread needs a reply (run /email review first).'] }
    const folders = await this.provider.listFolders()
    const messages = [...target.messages].sort((a, b) => a.date.localeCompare(b.date))
    const r = await draftReply({ account: this.provider.account, folders, thread: messages, model: this.draftModel, now: this.now })
    if (!r.ok) return { lines: [r.reason] }
    await saveReplyDraft(this.provider, r.draft, this.now)
    const staged = await this.sender.stage({ threadId: r.draft.threadId, to: r.draft.to, cc: [], bcc: [], subject: r.draft.subject, textBody: r.draft.body })
    this.staged.set(staged.id, staged)
    return { staged, lines: ['Draft staged. Nothing is sent until you approve:', staged.approvalText, `Approve with the fingerprint ${staged.fingerprint}.`] }
  }

  /** Send a staged message the user approved, by the fingerprint they saw. */
  async approve(id: string, fingerprint: string): Promise<string[]> {
    const r = await this.sender.approve(id, fingerprint)
    this.staged.delete(id)
    return [`Message ${r.status}.`]
  }

  /** Run one parsed `/email` line. Subcommands this offline session does not implement say so. */
  async run(args: readonly string[]): Promise<string[]> {
    const cmd: EmailCommand = parseEmailCommand(args)
    if (cmd.kind !== 'run') return formatEmailCommand(cmd, true)
    const head = formatEmailCommand(cmd, true)
    switch (cmd.sub) {
      case 'review': return [...head, ...(await this.review()).lines]
      case 'catchup': return [...head, ...(await this.catchUp(cmd.args[0])).lines]
      case 'spam': return [...head, ...(await this.spam(cmd.args[0] === 'move')).lines]
      case 'todo': return [...head, ...(await this.todo()).lines]
      case 'reply': return [...head, ...(await this.reply(cmd.args[0])).lines]
      default: return [...head, 'This part is not available in the sample mailbox.']
    }
  }
}
