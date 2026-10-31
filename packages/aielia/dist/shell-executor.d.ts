import { ShellCommandExecutor } from './shell-tools.js';
/**
 * Actually runs a previously staged, already-sandboxed command — the real child_process.spawn call,
 * invoked only at approval time via file-tools.ts's applyPendingAction(..., { executeShell }). `cwd`
 * is pinned to the staged (already-validated) path; `env` is reduced to an explicit allowlist so a
 * secret like ASSISTANT_PROXY_TOKEN/ANTHROPIC_API_KEY can't leak into the command's environment,
 * plus network-containment.ts's loopback-only proxy forced via HTTP(S)_PROXY (Decision 6 — see
 * networkContainmentEnv's doc comment). A hard timeout SIGKILLs the whole process group (not just
 * the immediate child — `detached: true` + a negative-pid kill reaches anything the shell itself
 * spawned) rather than leaving it running. A non-zero exit code is not a thrown error — it's
 * reported normally, same as a real shell; only a spawn failure (e.g. the shell itself couldn't
 * start) throws.
 */
export declare const runApprovedShellCommand: ShellCommandExecutor;
