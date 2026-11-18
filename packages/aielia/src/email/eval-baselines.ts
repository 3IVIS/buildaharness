import type { FilingMatch, Message } from './model.js'
import { exactMatch } from './rules.js'
import { SYNTHETIC_OWNER } from './synthetic-mailbox.js'
import type { LabelledCorpus, Verdict } from './labelled-corpus.js'
import { threadMessages } from './labelled-corpus.js'

/**
 * CONTROL ARMS for the email capabilities plan (phase C0). These are deliberately crude and exist only so the real mechanisms can be
 * compared with something: they are never used by the product. The question-mark rule below is lexical on purpose, because a lexical
 * guess is exactly the baseline the semantic judgement has to beat; product code must not copy it (standing rule: no lexical intent reading).
 * No `node:*` and no DOM imports.
 */

/** Control 1: "needs a response" = the newest message is not the owner's and its text contains a question mark. */
export function unansweredQuestionBaseline(corpus: LabelledCorpus): Record<string, Verdict> {
  const out: Record<string, Verdict> = {}
  for (const t of corpus.mailbox.threads) {
    const msgs = threadMessages(corpus.mailbox, t.id)
    const last = msgs[msgs.length - 1]
    out[t.id] = last && last.from.address !== SYNTHETIC_OWNER.address && last.textBody.includes('?') ? 'needs_response' : 'no_action'
  }
  return out
}

/** Control 2: the base model's job done by the provider's own flag alone: spam = sitting in the Junk folder, nothing else. */
export function junkFolderOnlyBaseline(corpus: LabelledCorpus): Record<string, Verdict> {
  const junkId = corpus.mailbox.folders.find((f) => f.kind === 'junk')?.id
  const out: Record<string, Verdict> = {}
  for (const t of corpus.mailbox.threads) out[t.id] = t.folderIds.includes(junkId ?? '') ? 'spam' : 'no_action'
  return out
}

/** The ungated "file everything that carries an unsubscribe header" rule set: one exact sender rule per bulk sender. */
export function ungatedBulkSenderRules(messages: readonly Message[]): FilingMatch[] {
  const senders = new Set<string>()
  for (const m of messages) if (m.headers['list-unsubscribe'] || m.headers['list-id']) senders.add(m.from.address.toLowerCase())
  return [...senders].map((address) => ({ kind: 'sender', address }))
}

/** Threads that need a response which any of these rules would match: what an ungated rule would swallow. */
export function ruleLeaks(rules: readonly FilingMatch[], corpus: LabelledCorpus): string[] {
  const leaks: string[] = []
  for (const [tid, v] of Object.entries(corpus.verdicts)) {
    if (v !== 'needs_response') continue
    if (threadMessages(corpus.mailbox, tid).some((m) => rules.some((r) => exactMatch(r, m)))) leaks.push(tid)
  }
  return leaks
}
