import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
/**
 * A reply can say things the turn did not do (benchmark scenarios 13, 15 and 10): "Done, I added the type hints"
 * with no write behind it, "let me fix all of it" followed by nothing, or facts about a changelog the assistant
 * never read because the network was unavailable. The reply is already on screen when this runs (it is streamed),
 * so the result is a separate notice, like `reviewNotice`.
 */
export interface ReplyAuditInput {
    userMessage: string;
    reply: string;
    /** What the system recorded as carried out this turn (write/shell/email), see describeAppliedAction. */
    actions: string[];
    /** Parallel to `actions`: for a write, what it changed (a short diff), so a reply's account of the file can be checked against it. */
    actionDetails?: string[];
    /** What it recorded in earlier turns of this session (most recent last), so restating old results is not mistaken for new work. */
    earlierActions?: string[];
    /** Recent shell commands with the start and end of their output (most recent last). */
    recentCommandOutputs?: {
        command: string;
        output: string;
    }[];
    /** Files and pages the turn read (tool and target). */
    sourcesRead: string[];
    /** Files, directories and pages read in EARLIER turns of this session (most recent last): an answer about them is not an outside fact, and a statement about which tools were used must be checked against them too. */
    earlierSourcesRead?: string[];
    /** A command this session already got the network-containment refusal for. */
    lookupUnavailable: boolean;
}
export interface ReplyAudit {
    claimsUnrecordedWork: boolean;
    promisesWorkNotDone: boolean;
    unverifiedOutsideFacts: boolean;
    contradictsCommandOutput: boolean;
    /** The reply denies or contradicts what the system recorded: says it did not touch, run or use something that a recorded write, command or read shows it did (benchmark scenarios 12 and 08). */
    contradictsRecordedWork: boolean;
    /** The reply thinks aloud: it starts a statement, then corrects or retracts it inside the answer, instead of one clean answer (benchmark scenarios 08 and 14). */
    leaksSelfCorrection: boolean;
    /** The reply does not respond to the user's message at all: placeholder text, a stray JSON object, an unrelated topic (benchmark scenario 13 turn 3: the whole reply was `{"favorite_marble":"... the response ..."}`). */
    nonAnswer: boolean;
}
export declare const CLEAN_AUDIT: Readonly<ReplyAudit>;
/** Replies longer than this are never checked for being a non-answer: junk such as a stray JSON object or placeholder text is short, and the extra calls are not worth making for a long reply. */
export declare const NON_ANSWER_CHECK_MAX_CHARS = 300;
/**
 * Two audit calls at once, and a third only when they disagree about a category: a category stands when at least two of the calls
 * raise it. One sample of a classifier is noisy both ways: a false flag costs the user a pointless correction turn, a miss lets an
 * invented claim stand (benchmark scenario 10 turn 2: the same reply was flagged by 6 of 8 production audits and passed by the
 * rest). Asking the second call only after a flag made a miss on the first call final; asking both together also takes less time
 * when the endpoint is slow. Fewer than two usable answers (an error or unparseable reply) returns a clean audit: a failed check
 * must never flag a reply.
 */
export declare function auditReply(input: ReplyAuditInput, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void, options?: {
    checkNonAnswer?: boolean;
}): Promise<ReplyAudit>;
/** The user-facing lines for what the audit found; undefined when it found nothing. */
export declare function replyAuditNotice(audit: ReplyAudit, actions: string[]): string | undefined;
/**
 * `AIELIA_REPLY_AUDIT` gate. Default ON outside vitest (one extra bounded LLM call per successful turn); `0`/`false`/`off`/`no`/`disabled`
 * turns it off. Same shape as `semanticGroundingEnabled()`.
 */
export declare function replyAuditEnabled(env?: Record<string, string | undefined>): boolean;
/** Every automatic retry message starts with this; it is the system talking to the model, never something the user said. */
export declare const AUDIT_NUDGE_PREFIX = "[automatic reply check]";
/**
 * The message for the one automatic retry, or undefined when the reply needs none. A claim or promise of work the system
 * did not record asks for the work to be done now or the claim withdrawn; details that disagree with the command output
 * or outside facts stated as verified ask for a corrected answer.
 */
export declare function auditRetryNudge(audit: ReplyAudit, recorded: string[], userMessage?: string): string | undefined;
