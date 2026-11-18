import type { LabelledCorpus } from './labelled-corpus.js'
import { threadMessages } from './labelled-corpus.js'

/**
 * The fixed question set for "ask Aielia about your mail" (plans/aielia_email_capabilities_plan.html, C8), built from the labelled synthetic
 * corpus so every answer has an oracle. Two uses:
 *
 *  - Answerability (runs in CI, no model): for each question that names an `oracleTool`, the shared read tools must return text containing
 *    every `mustContain` string. That proves the tools are sufficient to answer the question, independent of any model.
 *  - Model evaluation (owner-run, costs model calls): the question is put to the assistant with and without the new tools, and the answer is
 *    judged against `mustContain`, `mustCite` (real message ids only) and `kind`-specific rules (a draft must mark gaps, an ambiguous
 *    question must ask which one). Questions with `needsModel: true` can only be judged that way.
 *
 * No `node:*` and no DOM imports.
 */

export type QuestionKind = 'find' | 'count' | 'status' | 'catch_up' | 'todo' | 'draft' | 'ambiguous'

export interface MailQuestion {
  id: string
  kind: QuestionKind
  question: string
  oracleTool?: { name: string; args: Record<string, unknown> }
  /** Every one must appear in the tool's text (answerability) or in a correct answer (model run). */
  mustContain: string[]
  /** Judged only in a model run. */
  needsModel?: boolean
  /** Judging rule for model-only kinds. */
  rule?: 'marks_gaps_and_does_not_invent' | 'asks_which_one'
}

export function buildQuestionSet(c: LabelledCorpus): MailQuestion[] {
  const out: MailQuestion[] = []
  const bySubject = new Map<string, string[]>()
  for (const t of c.mailbox.threads) bySubject.set(t.subject, [...(bySubject.get(t.subject) ?? []), t.id])
  const inbox = c.mailbox.threads.filter((t) => threadMessages(c.mailbox, t.id).some((m) => m.folderIds.includes('fld-inbox')))
  const unique = inbox.filter((t) => bySubject.get(t.subject)!.length === 1)

  // find: ten threads with a unique subject.
  unique.slice(0, 10).forEach((t, i) => out.push({
    id: `find-${i + 1}`, kind: 'find', question: `Find the email about "${t.subject}".`,
    oracleTool: { name: 'mail_search', args: { text: t.subject } }, mustContain: [t.id],
  }))

  // count: how many messages a sender has sent (inbox senders with distinct counts).
  const perSender = new Map<string, number>()
  for (const m of c.mailbox.messages) if (m.folderIds.includes('fld-inbox')) perSender.set(m.from.address, (perSender.get(m.from.address) ?? 0) + 1)
  ;[...perSender].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).forEach(([addr, n], i) => out.push({
    id: `count-${i + 1}`, kind: 'count', question: `How many emails do I have from ${addr}?`,
    oracleTool: { name: 'mail_count', args: { from: addr, folder: 'Inbox' } }, mustContain: [`${n} message${n === 1 ? '' : 's'}`],
  }))
  const topSender = [...perSender].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!
  out.push({ id: 'count-top', kind: 'count', question: 'Who emails me the most?', oracleTool: { name: 'mail_count', args: { groupBy: 'sender', folder: 'Inbox', top: 1 } }, mustContain: [`${topSender[0]}: ${topSender[1]}`] })
  out.push({ id: 'count-unread', kind: 'count', question: 'How many unread emails are in my inbox?', oracleTool: { name: 'mail_count', args: { unreadOnly: true, folder: 'Inbox' } }, mustContain: [`${c.mailbox.messages.filter((m) => m.folderIds.includes('fld-inbox') && !m.flags.read).length} message`] })

  // status: what is happening with a thread, found by topic.
  unique.slice(10, 15).forEach((t, i) => out.push({
    id: `status-${i + 1}`, kind: 'status', question: `What is the status of "${t.subject}"?`,
    oracleTool: { name: 'mail_summarise', args: { topic: t.subject } }, mustContain: [], needsModel: true,
  }))

  // catch-up and to-do.
  for (const w of ['7', '30', '90', 'all']) out.push({ id: `catchup-${w}`, kind: 'catch_up', question: `Catch me up on the last ${w === 'all' ? 'of my mail' : `${w} days`}: what needs a response?`, oracleTool: { name: 'mail_catch_up', args: { window: w } }, mustContain: ['need a response'] })
  out.push({ id: 'todo-1', kind: 'todo', question: 'What is on my to-do list?', oracleTool: { name: 'mail_list_todo', args: {} }, mustContain: [] })
  out.push({ id: 'todo-2', kind: 'todo', question: 'What do I need to do today?', oracleTool: { name: 'mail_list_todo', args: {} }, mustContain: [] })

  // draft: the model must mark gaps, never invent a date, price or decision.
  const asking = inbox.filter((t) => c.verdicts[t.id] === 'needs_response').slice(0, 4)
  asking.forEach((t, i) => out.push({ id: `draft-${i + 1}`, kind: 'draft', question: `Draft a reply to "${t.subject}".`, mustContain: [], needsModel: true, rule: 'marks_gaps_and_does_not_invent' }))

  // ambiguous: a phrase that fits several threads; the right answer asks which.
  const shared = [...bySubject].filter(([, ids]) => ids.length > 1).slice(0, 2)
  shared.forEach(([subject], i) => out.push({ id: `ambiguous-${i + 1}`, kind: 'ambiguous', question: `Reply to the one about "${subject}".`, mustContain: [], needsModel: true, rule: 'asks_which_one' }))
  out.push({ id: 'ambiguous-vague', kind: 'ambiguous', question: 'Archive the one from last week.', mustContain: [], needsModel: true, rule: 'asks_which_one' })
  return out
}
