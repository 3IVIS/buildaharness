import { parseAddressList, type EmailReplyDraft, type StagedMessage, type Suggestion } from '@buildaharness/aielia'

/** The pending suggestions on a draft, the ones the user still has to accept or reject. */
export function pendingSuggestions(draft: EmailReplyDraft): Suggestion[] {
  return draft.meta.suggestions.filter((s) => s.state === 'pending')
}

/** What the draft would become if this suggestion were accepted, for the before/after display. */
export function suggestionPreview(s: Suggestion): { before: string; after: string } {
  return { before: s.span.quote, after: s.replacement || '(removed)' }
}

/** The message to stage from an open reply: the draft's To, any Cc/Bcc the user typed, subject and the current text. Throws EmailSendError('bad_address') on a bad address. */
export function stagedFromDraft(draft: EmailReplyDraft, extra: { cc?: string; bcc?: string; to?: string } = {}): StagedMessage {
  return {
    threadId: draft.threadId,
    to: extra.to !== undefined ? parseAddressList(extra.to) : draft.to,
    cc: parseAddressList(extra.cc),
    bcc: parseAddressList(extra.bcc),
    subject: draft.subject,
    textBody: draft.body,
  }
}
