import { ChatMessage, TokenUsage } from '@buildaharness/runtime';
import { PendingActionRecord } from './file-tools.js';
/**
 * Synthetic tool name a claude-cli-backed ILLMClient uses to signal "an action was already
 * staged by the file-tools MCP server during this call" — distinct from `write_file`/
 * `run_shell_command` so assistant.ts's tool loop adopts the already-staged id instead of
 * staging a second, redundant pending action. Shared across every backend that wires that
 * MCP server into a `claude -p` call (claude-cli-llm-client.ts today; a Tauri desktop
 * bridge tomorrow) so assistant.ts's `call.name === '__staged_action'` check has exactly
 * one producer to stay in sync with.
 */
export declare const ALREADY_STAGED_ACTION_TOOL = "__staged_action";
/**
 * Reduces a staged record down to the synthetic __staged_action tool call's input shape. Shared
 * for the same reason ALREADY_STAGED_ACTION_TOOL above is. `kind: 'revert'` is never passed here
 * — a revert is only ever staged directly (assistant.ts's stageUndoAction, driven by
 * /undo-action), never proposed by the model through the claude-cli MCP server's staging path.
 */
export declare function stagedActionInput(record: PendingActionRecord): {
    id: string;
    kind: 'write' | 'shell' | 'email';
} & Record<string, unknown>;
/**
 * Converts a ChatMessage[] transcript into the `--system-prompt`/trailing-prompt-argument
 * pair a `claude -p` invocation expects. Pure and environment-agnostic (no node:child_process
 * import) so it can be shared by every backend that shells out to the Claude CLI — today
 * that's claude-cli-llm-client.ts (spawns `claude` directly via node:child_process, used by
 * the CLI front end) and chat-ui's TauriClaudeCliLLMClient (invokes a Tauri Rust command that
 * spawns `claude`, used by the desktop front end) — without the two drifting apart.
 *
 * Every call to `claude -p` is a fresh, stateless subprocess (`--no-session-persistence`) —
 * there is no real prior turn from the underlying API's point of view, only whatever text we
 * hand it in this one prompt argument. When there's more than one prior turn to carry, the
 * history is explicitly framed as a labeled, delimited block ("verbatim conversation so far
 * ... never doubt, deny, or second-guess it") clearly separated from the current message,
 * rather than just interleaved as bare lines — found via live testing (conv150/conv166's
 * re-probe) that a flat, unframed interleaving occasionally led the model to treat its own
 * prior "Assistant:" line as fabricated/untrustworthy and explicitly disclaim it to the user,
 * on perfectly ordinary turns, not just the synthetic decline-notice line that first surfaced
 * this. A single-message call (the common case — most turns have no history yet) is left
 * exactly as before: the bare content, no framing overhead.
 */
export declare function buildClaudePrompt(messages: ChatMessage[]): {
    systemPrompt: string;
    prompt: string;
};
export interface ParsedClaudeCliOutput {
    reply: string;
    /** Real usage/cost from Claude's own accounting — absent when stdout wasn't valid JSON (e.g. a plain-text error). See ClaudeCliLLMClient's doc comment for the Pro/Max-subscription caveat on costUsd. */
    usage?: TokenUsage;
    /** The concrete model id the CLI reported running against (`model` field of the result event), not the `--model` alias. Absent when the CLI didn't report one. */
    model?: string;
}
/**
 * Parses `claude --output-format json`'s stdout into the reply text plus usage, falling back
 * to just the raw stdout as the reply if it isn't valid JSON (e.g. the CLI printed a
 * plain-text error before reaching --output-format handling). Shared for the same reason
 * buildClaudePrompt above is.
 */
/**
 * The claude-cli backend has no schema-constrained "structured output" mode of its own —
 * callChatStructured's schema is only ever a system-prompt instruction ("Respond with JSON
 * only, no prose") the model can, and routinely does, still wrap in a markdown code fence
 * (```json ... ```). Every caller (classifyTurnIntent, checkForContradictions,
 * reframeTaskDescriptionWithLLM, buildPlanFromTemplate, review-checker.ts, trust-tagging.ts,
 * failure-mode-matcher.ts) does a
 * bare `JSON.parse(response.content)` and falls back to its own "nothing structured" default on
 * any parse failure — a fenced reply silently looked exactly like the model declining to
 * decompose/flag/reframe anything, rather than a parsing bug. Only strips a fence that wraps the
 * *entire* trimmed reply (leading and trailing) — never touches an ordinary conversational reply
 * that legitimately contains a code block, since this is only ever applied to the
 * structured-output path, not plain callChat/callChatSync results.
 */
export declare function stripJsonCodeFence(content: string): string;
/**
 * The `claude` CLI (2.1.x) reports no top-level `model` on a `--output-format json`/`stream-json`
 * result — only a `modelUsage` map, and it routinely has **two** entries: the model that actually
 * ran the turn (per `--model`) plus a small internal Haiku call the CLI makes for its own
 * bookkeeping. `Object.keys(modelUsage)[0]` was picking that auxiliary Haiku, which is why every
 * audit report on disk says `claude-haiku-4-5-20251001` even though `--model=sonnet` was honoured.
 *
 * The primary turn always carries the full prompt + cached context, so it has by far the most
 * input tokens — pick the entry with the largest `input + cacheRead + cacheCreation`.
 */
export declare function primaryModelFromUsage(modelUsage: Record<string, unknown> | undefined): string | undefined;
export declare function parseClaudeCliOutput(stdout: string): ParsedClaudeCliOutput;
/**
 * What to say when `claude` exits with a failure. The CLI prints its own error on stderr for some failures, but with `--output-format json`
 * it reports others (a logged-out session: "Not logged in · Please run /login") as `{"is_error":true,"result":"..."}` on stdout and leaves
 * stderr empty, so reading stderr alone lost the reason and left only "exited with code 1". The desktop shell's Rust twin
 * (`claude_failure_message` in lib.rs) follows the same order.
 */
export declare function claudeFailureMessage(stdout: string, stderr: string, code: number | string | null): string;
