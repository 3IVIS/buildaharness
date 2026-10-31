import { ReviewerVerdict } from '@buildaharness/harness';
/** Marks a proposer-facing note that carries a reviewer finding to revise the answer against (see AgentLoop.createHarnessProposer). */
export declare const REVISION_NOTE_PREFIX = "[revision] ";
/**
 * `AUDIT_REVIEWER_REVISION` gate. Default **OFF**: the reviewer pass's verdict only feeds the resolver's next call, exactly as
 * before. A truthy value (`1` / `true` / `on` / `yes` / `enabled`) lets a finding at the END of a run send the last answer back
 * to the proposer once, with the finding in front of it. It also stops the implementer lens reporting the generic default
 * criterion as "not covered" — which it does on nearly every turn, since no belief can ever state a meta-instruction. It changes
 * what the assistant says and costs a second answer when it fires, so it ships off until a benchmark shows it helps. Read at
 * one site: harness-bridge.ts.
 */
export declare function reviewerRevisionEnabled(env?: Record<string, string | undefined>): boolean;
/** A success criterion a belief could state or paraphrase — everything except the generic "respond helpfully" default. */
export declare function isCheckableCriterion(criterion: string): boolean;
/**
 * Which verdicts are worth a second answer. HIGH always (an unresolved contradiction, a contradicted high-reliability belief).
 * MEDIUM only from the implementer lens — a real success criterion no belief covers at the end of the run. The reviewer and
 * adversarial lens's MEDIUM findings ("most beliefs are low confidence", "high prior for a failure class") say something about the
 * run's state, not about what the answer should say, so they are not acted on.
 */
export declare function reviewerRevisionNote(verdict: ReviewerVerdict): string | null;
/** The user turn the proposer sees for a revision note (the note text without its prefix). */
export declare function revisionContextMessage(noteBody: string): string;
