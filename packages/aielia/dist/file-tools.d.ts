import { FsBackend, ToolDefinition } from '@buildaharness/runtime';
import { SendEmail, SendEmailResult } from './email.js';
/**
 * Thrown by resolveInWorkspace/assertRealPathInWorkspace instead of returning
 * a falsy value, so callers can't accidentally proceed past a rejected path.
 */
export declare class PathOutsideWorkspaceError extends Error {
    readonly requestedPath: string;
    constructor(requestedPath: string);
}
/**
 * Resolves `requestedPath` against `workspaceRoot` and rejects anything that
 * escapes it (`../` traversal, or an absolute path outside the root). Purely
 * string-based — no real filesystem access, no node:path — so this module has
 * no environment-specific dependency and stays safe to import from assistant.ts,
 * which is bundled into both the Node CLI and the browser (chat-ui) builds.
 *
 * This alone cannot catch a symlink *inside* the workspace that points outside
 * it; see assertRealPathInWorkspace for that (needs real I/O via FsBackend).
 */
export declare function resolveInWorkspace(workspaceRoot: string, requestedPath: string): string;
/**
 * Defense in depth beyond resolveInWorkspace's string-prefix check: resolves
 * symlinks (via the injected backend's optional `realpath`) on the nearest
 * existing ancestor of `resolvedPath` and re-verifies it's still under the
 * workspace root's real path. A no-op (best-effort only) if the backend
 * doesn't implement `realpath`.
 */
export declare function assertRealPathInWorkspace(backend: FsBackend, workspaceRoot: string, resolvedPath: string): Promise<void>;
/**
 * Reads a file's current on-disk content for building a diff preview against a proposed write
 * (see diff-format.ts's formatWriteDiff) — `undefined` if the file doesn't exist yet, the same
 * "nothing to diff against" signal `applyPendingAction`'s own `previousContent` uses.
 */
export declare function readCurrentFileContent(backend: FsBackend, workspaceRoot: string, requestedPath: string): Promise<string | undefined>;
/** A workspace file path in one comparable form: relative to the workspace root, no leading "./" or "/". Absolute paths inside the workspace and relative ones name the same file. */
export declare function workspaceRelative(workspaceRoot: string, requestedPath: string): string;
export declare const READ_FILE_TOOL: ToolDefinition;
export declare const LIST_DIRECTORY_TOOL: ToolDefinition;
export declare const WRITE_FILE_TOOL: ToolDefinition;
export declare const FILE_TOOLS: ToolDefinition[];
export interface FileToolsContext {
    backend: FsBackend;
    workspaceRoot: string;
}
export type FileToolResult = {
    kind: 'text';
    text: string;
} | {
    kind: 'staged_write';
    id: string;
    path: string;
    content: string;
};
export declare function requireStringArg(input: Record<string, unknown>, key: string): string;
/** A read that worked and found nothing there — an answer ("no such file"), not a tool fault. Typed so the turn's control plane can tell a probe from a broken tool without matching message text. */
export declare class ToolNotFoundError extends Error {
    constructor(message: string);
}
/** Executes one of the three file tools by name. Real I/O for read/list; write_file only stages (see T2). */
export declare function executeFileTool(ctx: FileToolsContext, toolName: string, input: Record<string, unknown>): Promise<FileToolResult>;
export type PendingActionPayload = {
    kind: 'write';
    path: string;
    content: string;
} | {
    kind: 'shell';
    command: string;
    cwd: string;
}
/**
 * An email the model has proposed via send_email (action-tools.ts). Staged like write/shell and
 * never delivered until a human approves — see applyPendingAction's email branch, which calls the
 * injected SendEmail transport. Deliberately not in the undo-log: a sent email is one-shot and
 * irreversible, the same reason `kind: 'revert'` below writes no undo entry either.
 */
 | {
    kind: 'email';
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
}
/**
 * Staged by /undo-action (T3), never by the model — reverts a previously-applied write/shell
 * action back to its pre-action state. `revertedEntryId` names the undo-log entry this reverts
 * (deleted once applied — see applyPendingAction's revert branch). `restore`/`remove` are the
 * concrete filesystem operations (see action-snapshot.ts's buildRevertPlan), computed once at
 * staging time so apply doesn't need to re-derive them from a (possibly since-pruned) undo-log
 * entry.
 */
 | {
    kind: 'revert';
    revertedEntryId: string;
    restore: {
        path: string;
        content: string;
    }[];
    remove: string[];
};
/**
 * `nextPendingActionId` chains a second (or later) approval-gated action staged from the same
 * originating turn — e.g. the claude-cli MCP server (file-tools-mcp-server.mjs) links
 * consecutive stagePendingAction calls within one `claude -p` subprocess this way, so
 * resolvePendingAction (assistant.ts) can surface the next one as its own needs_approval instead
 * of silently dropping it once the first resolves. Absent for a standalone staged action.
 *
 * `chainedFrom` marks a record as itself being the *target* of such a chain — i.e. a preceding
 * action from the same turn was already resolved (approved-and-applied, or declined) before this
 * one was ever shown for approval. resolvePendingAction's decline branch (assistant.ts) uses this
 * to avoid claiming "nothing was written or run" when something from earlier in the same chain
 * may already have been.
 */
export type PendingActionRecord = {
    id: string;
    stagedAt: string;
    nextPendingActionId?: string;
    chainedFrom?: boolean;
} & PendingActionPayload;
/** Result of actually running a previously staged shell command — see shell-executor.ts. */
export interface ShellExecutionResult {
    /** Combined stdout+stderr, truncated to a byte cap. */
    output: string;
    exitCode: number | null;
    timedOut: boolean;
}
export type ApplyPendingActionResult = ({
    kind: 'write';
} & PendingActionRecord & {
    previousContent?: string;
}) | ({
    kind: 'shell';
} & PendingActionRecord & {
    execution: ShellExecutionResult;
}) | ({
    kind: 'revert';
} & PendingActionRecord) | ({
    kind: 'email';
} & PendingActionRecord & {
    delivery: SendEmailResult;
});
/**
 * Stages an action for later approval. `id` is a random UUID, not derived from the session — see
 * T4 of the file-tools plan.
 *
 * Structural hardening principle (the internal plan Phase 4 step 1):
 * this gate runs unconditionally on the tool call's own concrete arguments (the literal path/
 * content or command/cwd being proposed), independent of whatever risk-classifier.ts's pre-flight
 * text patterns concluded about the user's phrasing. That's deliberate — it's the same "gate on
 * the concrete tool call, not the free text" pattern Claude Code and Codex CLI use (matching
 * literal tool-call/command strings, not classifying natural-language risk). Any future
 * consequential tool (an MCP-provided send_email, a payments API, a social-posting integration)
 * must get this same unconditional stagePendingAction-style gate on its own call arguments — it
 * must not rely solely on risk-classifier.ts catching the request first, since a classifier can
 * always miss a phrasing it wasn't built to recognize.
 */
export declare function stagePendingAction(backend: FsBackend, workspaceRoot: string, payload: PendingActionPayload): Promise<{
    id: string;
}>;
export declare function loadPendingAction(backend: FsBackend, workspaceRoot: string, id: string): Promise<PendingActionRecord | undefined>;
/**
 * Applies a previously staged action for real, then deletes its staging record. Throws if `id`
 * isn't staged. `kind: 'write'` is applied directly (pure FsBackend I/O, safe in any environment
 * this package runs in). `kind: 'shell'` requires an injected `executeShell` callback instead of
 * this module spawning a process itself — file-tools.ts has no Node dependency of its own (it's
 * bundled into the browser build via assistant.ts/index.ts), so the real child_process.spawn call
 * lives in shell-executor.ts and is only ever wired in by Node-only callers (cli.ts).
 */
export declare function applyPendingAction(backend: FsBackend, workspaceRoot: string, id: string, options?: {
    executeShell?: (command: string, cwd: string) => Promise<ShellExecutionResult>;
    sendEmail?: SendEmail;
}): Promise<ApplyPendingActionResult>;
/** Deletes a staged action without applying it. Used when the user declines. No-op if `id` isn't staged. */
export declare function discardPendingAction(backend: FsBackend, workspaceRoot: string, id: string): Promise<void>;
/**
 * A staged action left behind by a crashed or abandoned turn is harmless (never applied without
 * its matching id — see applyPendingAction) but, left unswept, accumulates forever. Records older
 * than this are considered abandoned rather than legitimately pending — mirrors the naming
 * convention of action-snapshot.ts's UNDO_LOG_MAX_ENTRIES (T12 of the gap-coverage plan).
 */
export declare const PENDING_ACTION_MAX_AGE_MS: number;
/**
 * Deletes `.pending-actions/` records older than `PENDING_ACTION_MAX_AGE_MS`. Called from
 * PersonalAssistant's startup sweep (see assistant.ts), which is itself responsible for first
 * confirming no session has a checkpoint still eligible for resume — this function only applies
 * the age cutoff and has no knowledge of checkpoints itself. `now` is a parameter (not read
 * directly from Date.now()) so tests can pin a fixed reference time. Corrupt records are left in
 * place rather than swept — not this function's job to repair malformed JSON.
 */
export declare function sweepAbandonedPendingActions(backend: FsBackend, workspaceRoot: string, now?: number): Promise<{
    swept: string[];
}>;
