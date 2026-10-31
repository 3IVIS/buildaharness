import { ILLMClient, LLMStructuredResponse } from '@buildaharness/runtime';
/**
 * A deterministic, network-free {@link ILLMClient} for tests and demos — the one publicly
 * supported way to drive a real `PersonalAssistant` turn end to end without a proxy, an API key,
 * or a live model. Built for the internal plan phase B1 (the browser-e2e lane
 * that unblocks the `ASSISTANT_ONE_LOOP` default-flip), and reusable by chat-ui's `demo-seed.ts`.
 *
 * It mirrors the shape of the internal `ScriptedToolLLMClient` that `assistant.test.ts` has used
 * for a long time: every turn spends exactly one mandatory `classifyTurnIntent` call up front,
 * which this client recognises (by a distinctive phrase from that classifier's system prompt) and
 * answers on its own from a lightweight, deterministic default — so `responses` only has to
 * script the *tool loop / one-loop proposer's* own calls, not that bookkeeping call.
 *
 * `responses` entries are consumed in order, one per non-classifier, non-side-call
 * `callChatStructured` call:
 *   - a plain `string` → `{ content: string }` (a final answer, no tool calls)
 *   - an `LLMStructuredResponse` → use as-is (set `toolCalls` to simulate the model calling a tool)
 *
 * A handful of other calls are auxiliary semantic escalations (the change reviewer, the failure
 * matcher, the LLM injection classifier) that a tool-using turn can trigger without any script
 * author asking for them — with lexicalMode's default now `disabled`, the lexical checks these
 * sit on top of never short-circuit them, so they fire on every qualifying call, not just ones a
 * scenario is specifically testing. Answered from a safe, inert default (see SIDE_CALL_MARKERS)
 * so they never silently consume a `responses` slot meant for the real tool loop — the exact
 * silent-consumption bug that broke chat-ui's W5 proxy e2e test when the default flipped. Override
 * or add to this list via `sideResponses` for a test that specifically wants one of these calls to
 * answer something else (e.g. a genuine injection flag).
 *
 * `callChat`/`callChatSync` (the no-tools reply path, and post-approval synthesis) stream
 * `streamChunks` (default: `['']`).
 */
export interface ScriptedLLMClientScript {
    /** Ordered structured responses for the tool loop / one-loop proposer. A bare string is shorthand for a final answer with no tool calls. */
    responses?: Array<string | LLMStructuredResponse>;
    /** Chunks streamed from `callChat`/`callChatSync`. Defaults to `['']`. */
    streamChunks?: string[];
    /**
     * Per-user-message override of the auto-answered `classifyTurnIntent` JSON fields (e.g.
     * `{ isTrivial: true }`, `{ riskLevel: 'HIGH' }`, `{ decomposedTasks: [...] }`). Return
     * `undefined` to keep the derived default for that message.
     */
    classify?: (userMessage: string) => Record<string, unknown> | undefined;
    /**
     * Overrides/extends SIDE_CALL_MARKERS' default answers for a system-prompt substring — checked
     * before the built-in defaults, so a test can make the change reviewer/failure matcher/injection
     * classifier answer something other than "nothing to see here" without it consuming a
     * `responses` slot either way. `[marker, rawJsonContent]` pairs, same shape as the built-ins.
     */
    sideResponses?: Array<[string, string]>;
}
/**
 * Known auxiliary semantic-escalation system prompts and their safe, inert default answer — see
 * ScriptedLLMClientScript's doc comment. Kept in sync by hand with each check's own system prompt
 * (review-checker.ts, failure-mode-matcher.ts, trust-tagging.ts, grounding-check.ts, task-completion-check.ts, constraint-check.ts, semantic-compaction.ts, source-reliability.ts, semantic-hypotheses.ts, episodic-digest.ts, memory-consolidation.ts, memory-reviewer.ts, writer/writer-chat-capture.ts) since there's no shared constant
 * to import without a circular dependency back into this package's own public surface.
 */
export declare const SIDE_CALL_MARKERS: Array<[string, string]>;
/**
 * Builds a scripted {@link ILLMClient}. See {@link ScriptedLLMClientScript}. The returned value
 * is a plain `ILLMClient` — pass it straight to `PersonalAssistant.create({ llmClient })`.
 */
export declare function createScriptedLLMClient(script?: ScriptedLLMClientScript): ILLMClient;
