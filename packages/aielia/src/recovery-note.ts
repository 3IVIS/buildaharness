/**
 * The failure-mode recovery bias (packages/harness's rollback-replan.ts's failureModeHint) only
 * changes bookkeeping — the chosen strategy is never read by any execution node, so nothing about
 * what the proposer actually tries next changes on its own. This is what turns a confident
 * failure-mode switch into something the proposer reads and can act on: a steering note under its
 * own header, drained the same way review-checker.ts's REVIEW_NOTE_PREFIX notes are (see
 * agent-loop.ts's createHarnessProposer).
 */
export const RECOVERY_NOTE_PREFIX = '[recovery] '

const STRATEGY_HINTS: Record<string, string> = {
  DIRECT_EDIT: 'try the direct fix again, more carefully',
  TRACE_EXEC: 'trace through what actually happened before trying again',
  BROADER_SEARCH: 'broaden the search — look beyond where you were looking',
  REIMPLEMENT: 'try a genuinely different approach rather than repeating the same call',
  MINIMAL_FIX: 'narrow the scope back down to the smallest fix that addresses the request',
  ESCALATE: 'this needs a different approach — explain the problem plainly rather than retrying again',
}

/**
 * The proposer-facing steering note for a failure-mode-biased strategy switch — what the
 * harness's own onFailureModeSwitch event turns into. Kept separate from reviewNoticeText's
 * user-facing text (see AssistantTurnResult.reviewNotice): this note is for the model, not shown
 * to the user directly.
 */
export function recoveryNoteText(failureClass: string, strategy: string): string {
  const hint = STRATEGY_HINTS[strategy] ?? 'try a different approach rather than repeating the same action'
  return `That failed with a recognized pattern (${failureClass}) — ${hint}.`
}
