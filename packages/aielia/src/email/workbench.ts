import type { Account, FilingRule, Folder, Message, Thread, Triage } from './model.js'
import type { EmailCache } from './cache.js'
import type { EmailProvider } from './provider.js'
import { InMemoryTriageStore, triageThreads, type TriageThread } from './triage.js'
import { InMemoryJunkStore, classifyJunk, learnJunkSignals, type JunkSignals, type JunkVerdict } from './junk.js'
import { catchUpParts, estimateCatchUp, runCatchUp, type CatchUpResult } from './catch-up.js'
import { REVIEW_WINDOWS, reviewWindowLabel, windowSince, type ReviewWindow } from './review-window.js'
import { buildTodoList, type ScoredTodo } from './todo.js'
import { RuleStore, exactMatch, learnExactRules } from './rules.js'
import { correspondentsOf, createRuleGate, eligibleMessageIds } from './rule-gate.js'
import { MAIL_READ_TOOLS, isMailReadTool, runMailReadTool, type MailToolDeps } from './mail-tools.js'
import { draftReply, type EmailReplyDraft } from './draft.js'
import { groupConversations } from './conversation.js'
import { MAIL_UNTRUSTED_PROMPT } from './untrusted.js'
import { parseModelJson } from '../model-json.js'

/**
 * The Email capabilities as one object a screen can drive (plans/aielia_email_capabilities_plan.html): catch up on a window, judge spam, propose
 * rules through the gate, build the to-do list, search, answer a question with the read-only mail tools, and draft a reply. It works over any
 * `EmailProvider` and an already-synced cache, so the desktop app (mail read from Apple Mail), the CLI and the sample use the same code.
 *
 * Read-only by construction: it never moves, flags, sends or saves anything. Spam and rule results are PROPOSALS. Every model call and tool call is
 * reported through `onEvent` (so the screen can show what is happening), with the prompt and the answer. Mail text is untrusted input throughout
 * (it reaches the model only through the shared wrapping). No `node:*` and no DOM imports.
 */

export type ModelFn = (system: string, user: string) => Promise<string>

export type WorkbenchEvent =
  | { kind: 'step' | 'result' | 'error' | 'progress'; text: string }
  | { kind: 'model_start'; n: number; label: string; userChars: number }
  | { kind: 'model_end'; n: number; label: string; ms: number; system: string; prompt: string; response: string }
  | { kind: 'model_error'; n: number; label: string; error: string }
  | { kind: 'tool'; name: string; args: string }
  | { kind: 'tool_result'; name: string; ok: boolean; chars: number; citations: number }

export interface WorkbenchOptions {
  provider: EmailProvider
  /** An already-synced cache of this account (see `syncForWindow`). */
  cache: EmailCache
  model: ModelFn
  window?: ReviewWindow
  now?: () => string
  onEvent?: (e: WorkbenchEvent) => void
}

export interface SpamRow { threadId: string; subject: string; sender: string; reason: string; basis: JunkVerdict['basis'] }
export interface RuleProposal { rule: FilingRule; folder: string; examples: number; inboxHits: number; heldByGate: number }
export interface CatchUpView { windowLabel: string; /** Set when the window held no mail. */ note?: string; summary: string[]; needsResponse: Array<{ threadId: string; subject: string; reason: string }> }
export interface SpamView { rows: SpamRow[]; windowDays: number; /** Set when there was nothing to judge, so a screen can say so instead of showing an empty result. */ note?: string; threads: number; unsure: number; notSpam: number; failedCalls: number; learned: { senders: number; domains: number; correspondents: number } }
export interface AskResult { reply: string; steps: number; cited: Array<{ threadId: string; subject: string }> }

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const MAX_TOOL_STEPS = 5

export class EmailWorkbench {
  readonly triage = new InMemoryTriageStore()
  readonly junk = new InMemoryJunkStore()
  private rules = new RuleStore()
  private label = 'idle'
  private calls = 0
  readonly stats = { calls: 0, failed: 0, ms: 0 }
  private items: TriageThread[] = []
  private all: Message[] = []
  private folders: Folder[] = []
  private kindOf = new Map<string, Folder['kind']>()
  private signals: JunkSignals = { junkSenders: [], junkDomains: [], correspondents: [] }
  private window: ReviewWindow

  constructor(private readonly o: WorkbenchOptions) {
    this.window = o.window ?? 30
  }

  private get account(): Account { return this.o.provider.account }
  private now = (): string => (this.o.now ?? (() => new Date().toISOString()))()
  private emit(e: WorkbenchEvent): void { this.o.onEvent?.(e) }

  /** The model, with every call reported. */
  private model: ModelFn = async (system, user) => {
    const n = ++this.calls; const label = this.label; const t = Date.now()
    this.emit({ kind: 'model_start', n, label, userChars: user.length })
    try {
      const text = await this.o.model(system, user)
      const ms = Date.now() - t
      this.stats.calls++; this.stats.ms += ms
      this.emit({ kind: 'model_end', n, label, ms, system: clip(system, 1500), prompt: clip(user, 4000), response: clip(text, 4000) })
      return text
    } catch (e) {
      this.stats.failed++
      this.emit({ kind: 'model_error', n, label, error: clip(e instanceof Error ? e.message : String(e), 300) })
      throw e
    }
  }

  /** Re-read the cache (call after a sync). */
  async refresh(): Promise<void> {
    this.folders = await this.o.cache.getFolders(this.account.id)
    this.all = (await this.o.cache.queryMessages({}, { offset: 0, limit: 200_000 })).items
    const threads = (await this.o.cache.listThreads(undefined, { offset: 0, limit: 200_000 })).items
    const byThread = new Map<string, Message[]>()
    for (const m of this.all) { const l = byThread.get(m.threadId) ?? []; l.push(m); byThread.set(m.threadId, l) }
    this.items = threads.map((thread: Thread) => ({ thread, messages: (byThread.get(thread.id) ?? []).sort((a, b) => a.date.localeCompare(b.date)) }))
    this.kindOf = new Map(this.folders.map((f) => [f.id, f.kind]))
    this.signals = learnJunkSignals(this.all, this.folders, [this.account.address])
  }

  private inInbox = (m: Message): boolean => m.folderIds.some((f) => this.kindOf.get(f) === 'inbox')
  inboxThreads(): TriageThread[] { return this.items.filter((i) => i.messages.some(this.inInbox)) }

  counts(): { messages: number; threads: number; conversations: number; inbox: number } {
    return { messages: this.all.length, threads: this.items.length, conversations: new Set(groupConversations(this.all).values()).size, inbox: this.inboxThreads().length }
  }

  /** Review the mail of a window and say what needs a response. Records the reviews; changes no mail. */
  async catchUp(days: ReviewWindow = 7): Promise<CatchUpView> {
    this.label = `catch-up ${days}`
    const since = windowSince(days, new Date(this.now()))
    const deps = { account: this.account, cache: this.o.cache, store: this.triage, model: this.model, ...(since ? { since } : {}), batchSize: 20, now: this.now, onProgress: (p: { done: number; total: number }) => this.emit({ kind: 'progress', text: `catch-up ${p.done}/${p.total}` }) }
    const est = await estimateCatchUp(deps)
    this.emit({ kind: 'step', text: `${reviewWindowLabel(days)}: ${est.inWindow} thread(s) in the window, ${est.toReview} to review in ${est.calls} model call(s)` })
    if (est.inWindow === 0) {
      const note = `There is no inbox mail in the ${reviewWindowLabel(days).toLowerCase()} in this account, so there is nothing to review. Try a wider window, or another account.`
      this.emit({ kind: 'result', text: note })
      return { windowLabel: reviewWindowLabel(days), note, summary: [], needsResponse: [] }
    }
    const r: CatchUpResult = await runCatchUp(deps)
    const p = catchUpParts(r, reviewWindowLabel(days))
    const view: CatchUpView = { windowLabel: reviewWindowLabel(days), summary: [...p.summary, ...p.closing], needsResponse: r.needsResponse.map((n) => ({ threadId: n.threadId, subject: clip(n.subject, 90), reason: n.triage.reason })) }
    this.emit({ kind: 'result', text: view.summary.join(' ') })
    return view
  }

  /** The to-do list from what has been reviewed. */
  async todo(): Promise<ScoredTodo[]> {
    const triage: Triage[] = []
    for (const i of this.items) { const t = await this.triage.get(i.thread.id); if (t) triage.push(t) }
    return buildTodoList({ triage, threads: this.items, userAddresses: [this.account.address], now: this.now })
  }

  /**
   * Judge the last 30 days of the inbox for spam: learned signals, then the model, then the guards. A thread is first reviewed for replies, because
   * spam may never be called on mail that needs one. Returns proposals; nothing moves.
   */
  async spam(days: 7 | 30 | 90 = 30): Promise<SpamView> {
    const since = Date.parse(this.now()) - days * 86_400_000
    const recent = this.inboxThreads().filter((i) => Date.parse(i.thread.lastMessageAt) >= since)
    const unreviewed: TriageThread[] = []
    for (const i of recent) if (!(await this.triage.get(i.thread.id))) unreviewed.push(i)
    if (recent.length === 0) {
      const note = `There is no inbox mail in the last ${days} days in this account, so there is nothing to check. Try a wider window, or another account.`
      this.emit({ kind: 'result', text: note })
      return { rows: [], windowDays: days, note, threads: 0, unsure: 0, notSpam: 0, failedCalls: 0, learned: { senders: this.signals.junkSenders.length, domains: this.signals.junkDomains.length, correspondents: this.signals.correspondents.length } }
    }
    this.emit({ kind: 'step', text: `Spam: ${recent.length} inbox thread(s) in ${days} days; ${unreviewed.length} not yet reviewed for replies are reviewed first` })
    this.label = 'review before spam'
    if (unreviewed.length) await triageThreads(unreviewed.slice(0, 150), { account: this.account, model: this.model, store: this.triage, now: this.now })
    this.label = 'spam judgement'
    const res = await classifyJunk(recent, {
      account: this.account, folders: this.folders, signals: this.signals, model: this.model, store: this.junk, triage: this.triage, now: this.now,
      junkExamples: this.all.filter((m) => this.kindOf.get(m.folderIds[0] ?? '') === 'junk').slice(0, 20),
      hamExamples: this.all.filter((m) => this.signals.correspondents.includes(m.from.address.toLowerCase())).slice(0, 20),
    })
    const vs = (await Promise.all(recent.map((i) => this.junk.get(i.thread.id)))).filter((v): v is JunkVerdict => !!v)
    const rows: SpamRow[] = vs.filter((v) => v.verdict === 'likely_spam').map((v) => {
      const it = recent.find((i) => i.thread.id === v.threadId)
      return { threadId: v.threadId, subject: clip(it?.thread.subject ?? v.threadId, 90), sender: it?.messages[0]?.from.address ?? '', reason: v.reason, basis: v.basis }
    })
    const view: SpamView = {
      rows, windowDays: days, threads: recent.length, unsure: vs.filter((v) => v.verdict === 'unsure').length, notSpam: vs.filter((v) => v.verdict === 'not_spam').length, failedCalls: res.failedCalls,
      learned: { senders: this.signals.junkSenders.length, domains: this.signals.junkDomains.length, correspondents: this.signals.correspondents.length },
    }
    this.emit({ kind: 'result', text: `Spam (last ${days} days): ${rows.length} probably spam, ${view.unsure} unsure, ${view.notSpam} not spam of ${recent.length}. Nothing was moved.` })
    return view
  }

  /** Rule proposals from how mail is already filed. Only mail that needs no real action may fall into a rule (the gate). Nothing is applied. */
  async ruleProposals(): Promise<{ proposals: RuleProposal[]; filed: number; sampled: number; eligible: number }> {
    const customIds = new Set(this.folders.filter((f) => f.kind === 'custom').map((f) => f.id))
    const filed = this.all.filter((m) => m.folderIds.some((f) => customIds.has(f)))
    this.emit({ kind: 'step', text: `Rules: ${customIds.size} folder(s), ${filed.length} filed message(s). Each filed thread is reviewed first so the gate can judge it` })
    const ids = [...new Set(filed.map((m) => m.threadId))].slice(0, 80)
    const need: TriageThread[] = []
    for (const id of ids) { const i = this.items.find((x) => x.thread.id === id); if (i && !(await this.triage.get(id))) need.push(i) }
    this.label = 'review for the rule gate'
    if (need.length) await triageThreads(need, { account: this.account, model: this.model, store: this.triage, now: this.now })
    const gate = createRuleGate(this.o.cache, { triage: this.triage, correspondents: await correspondentsOf(this.o.cache, this.account), ownAddresses: [this.account.address] })
    const sample = filed.filter((m) => ids.includes(m.threadId))
    const eligible = await eligibleMessageIds(sample, gate)
    this.rules = new RuleStore()
    const learned = learnExactRules(this.account, this.folders, sample, this.rules, { eligible: (m) => eligible.has(m.id) }, this.now)
    const proposals: RuleProposal[] = []
    for (const rule of learned) {
      const hits = this.all.filter((x) => exactMatch(rule.match, x) && this.inInbox(x))
      let held = 0
      for (const m of hits) if (!(await gate.check(m)).eligible) held++
      proposals.push({ rule, folder: this.folders.find((f) => f.id === rule.action.target)?.name ?? '', examples: rule.evidenceMessageIds.length, inboxHits: hits.length, heldByGate: held })
    }
    this.emit({ kind: 'result', text: `Rules: ${eligible.size} of ${sample.length} sampled filed messages are eligible; ${proposals.length} proposal(s), none applied` })
    return { proposals, filed: filed.length, sampled: sample.length, eligible: eligible.size }
  }

  private toolDeps(): MailToolDeps {
    return {
      account: this.account, cache: this.o.cache, context: { chips: [] }, provider: this.o.provider, windowSince: windowSince(this.window, new Date(this.now())),
      summarise: (s, u) => { this.label = 'summarise'; return this.model(s, u) },
      listTodo: () => this.todo(),
      catchUp: async (w) => {
        const days = (w === undefined ? 30 : REVIEW_WINDOWS.find((x) => String(x) === w) ?? 30) as ReviewWindow
        const v = await this.catchUp(days)
        return { summary: v.summary, details: [], needsResponse: v.needsResponse.map((n) => ({ threadId: n.threadId, subject: n.subject })) }
      },
    }
  }

  /** Answer a question about the mailbox. The model picks read-only mail tools; they run through the same gate and wrapping as everywhere else. */
  async ask(question: string): Promise<AskResult> {
    this.label = 'chat'
    const tools = MAIL_READ_TOOLS.map((t) => `- ${t.name}: ${t.description}\n  arguments: ${JSON.stringify(t.input_schema.properties)}`).join('\n')
    const system = `You answer questions about the user's own mailbox. Tools you can call (read-only):\n${tools}\n\n` +
      `Each turn reply with JSON only: either {"tool":"<name>","args":{...}} to look something up, or {"answer":"<your answer to the user, naming the subjects you drew on>"} when you have enough. At most ${MAX_TOOL_STEPS} tool calls. ${MAIL_UNTRUSTED_PROMPT}`
    const transcript = [`Question: ${question}`]
    const cited = new Map<string, string>()
    for (let step = 0; step <= MAX_TOOL_STEPS; step++) {
      const text = await this.model(system, transcript.join('\n\n'))
      let j: { tool?: unknown; args?: unknown; answer?: unknown }
      try { j = (parseModelJson(text) ?? {}) as typeof j } catch { j = { answer: text } }
      if (typeof j.answer === 'string') return { reply: j.answer, steps: step, cited: [...cited].map(([threadId, subject]) => ({ threadId, subject })) }
      const name = String(j.tool ?? '')
      if (!isMailReadTool(name)) { transcript.push(`There is no tool ${JSON.stringify(name)}.`); continue }
      const args = (j.args && typeof j.args === 'object' ? j.args : {}) as Record<string, unknown>
      this.emit({ kind: 'tool', name, args: clip(JSON.stringify(args), 200) })
      const r = await runMailReadTool(name, args, this.toolDeps())
      this.emit({ kind: 'tool_result', name, ok: r.ok, chars: r.text.length, citations: r.citations.length })
      for (const c of r.citations) cited.set(c.threadId, c.subject)
      transcript.push(`Tool ${name} ${JSON.stringify(args)} returned:\n${clip(r.text, 6000)}`)
    }
    return { reply: `I could not settle that within ${MAX_TOOL_STEPS} lookups. Try a narrower question.`, steps: MAX_TOOL_STEPS, cited: [...cited].map(([threadId, subject]) => ({ threadId, subject })) }
  }

  /** A reply draft for one thread, for the user to read. It is not saved or sent. */
  async draft(threadId: string, told = 'Keep it short and polite.'): Promise<{ ok: true; draft: EmailReplyDraft } | { ok: false; reason: string }> {
    const item = this.items.find((i) => i.thread.id === threadId)
    if (!item) return { ok: false, reason: 'That thread is not in the loaded mail.' }
    this.label = 'draft reply'
    return draftReply({ account: this.account, folders: this.folders, thread: item.messages, model: this.model, told, factsCheck: 'off', now: this.now })
  }
}
