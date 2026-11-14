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

export interface OfflineEmailSessionOptions {
  mailbox?: SyntheticMailbox
  triageModel?: TriageModel
  draftModel?: DraftModel
  now?: () => string
}

export class OfflineEmailSession {
  readonly provider: FakeEmailProvider
  readonly sender: SendCoordinator
  private readonly cache = new InMemoryEmailCache()
  private readonly store = new InMemoryTriageStore()
  private readonly triageModel: TriageModel
  private readonly draftModel: DraftModel
  private readonly now: () => string
  private readonly staged = new Map<string, StagedSend>()
  private synced = false

  constructor(opts: OfflineEmailSessionOptions = {}) {
    const mailbox = opts.mailbox ?? generateSyntheticMailbox()
    this.provider = new FakeEmailProvider(mailbox)
    this.sender = new SendCoordinator(this.provider)
    this.triageModel = opts.triageModel ?? sampleTriageModel(mailbox.categoryByThread)
    this.draftModel = opts.draftModel ?? sampleDraftModel
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
      case 'todo': return [...head, ...(await this.todo()).lines]
      case 'reply': return [...head, ...(await this.reply(cmd.args[0])).lines]
      default: return [...head, 'This part is not available in the sample mailbox.']
    }
  }
}
