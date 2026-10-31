/**
 * The failure-mode recovery bias (packages/harness's rollback-replan.ts's failureModeHint) only
 * changes bookkeeping — the chosen strategy is never read by any execution node, so nothing about
 * what the proposer actually tries next changes on its own. This is what turns a confident
 * failure-mode switch into something the proposer reads and can act on: a steering note under its
 * own header, drained the same way review-checker.ts's REVIEW_NOTE_PREFIX notes are (see
 * agent-loop.ts's createHarnessProposer).
 */
export declare const RECOVERY_NOTE_PREFIX = "[recovery] ";
/**
 * The proposer-facing steering note for a failure-mode-biased strategy switch — what the
 * harness's own onFailureModeSwitch event turns into. Kept separate from reviewNoticeText's
 * user-facing text (see AssistantTurnResult.reviewNotice): this note is for the model, not shown
 * to the user directly.
 */
export declare function recoveryNoteText(failureClass: string, strategy: string): string;
/**
 * The proposer-facing note for a switch the experience-learning feed picked (AUDIT_EXPERIENCE_LEARNING): the same hint as a
 * failure-mode switch, but it says why this approach — it is the one that worked after this kind of failure in earlier runs.
 * `failureClass` is empty for a failure no curated pattern matched.
 */
export declare function learnedRecoveryNoteText(failureClass: string, strategy: string): string;
