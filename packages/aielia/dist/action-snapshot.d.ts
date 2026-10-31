import { FsBackend } from '@buildaharness/runtime';
export type UndoLogEntry = {
    id: string;
    appliedActionId: string;
    kind: 'write';
    path: string;
    previousContent: string | null;
    appliedAt: string;
    undoable: true;
} | {
    id: string;
    appliedActionId: string;
    kind: 'write';
    path: string;
    appliedAt: string;
    undoable: false;
    reason: string;
} | {
    id: string;
    appliedActionId: string;
    kind: 'shell';
    command: string;
    appliedAt: string;
    undoable: true;
    added: string[];
    modified: {
        path: string;
        previousContent: string;
    }[];
    deleted: {
        path: string;
        previousContent: string;
    }[];
    unsnapshottableChanges: string[];
} | {
    id: string;
    appliedActionId: string;
    kind: 'shell';
    command: string;
    appliedAt: string;
    undoable: false;
    reason: string;
};
export type SnapshotBeforeWriteResult = {
    previousContent: string | null;
    undoable: true;
} | {
    previousContent?: undefined;
    undoable: false;
    reason: string;
};
/**
 * Reads a write_file target's current content before it gets overwritten, so an undo-log entry
 * can later restore it. `path` must already be resolved/verified against the workspace root by
 * the caller (file-tools.ts's applyPendingAction) — this does no path validation of its own.
 * `workspaceRoot` is accepted for signature parity with T2's snapshotWorkspaceTree, which does
 * need it for a recursive walk; a single-file read has no use for it.
 *
 * A read error other than "file doesn't exist" (FsBackend.readTextFile resolves `undefined` only
 * for that case) is intentionally left to propagate rather than caught here, so a genuine I/O
 * failure surfaces as a failed approval instead of silently producing a wrong/empty snapshot.
 */
export declare function snapshotBeforeWrite(backend: FsBackend, workspaceRoot: string, path: string): Promise<SnapshotBeforeWriteResult>;
/** One shared cap across every entry kind (write, and later shell/revert) — not a per-kind cap. */
export declare const UNDO_LOG_MAX_ENTRIES = 20;
/**
 * Persists an undo-log entry, then prunes the oldest entries once UNDO_LOG_MAX_ENTRIES is
 * exceeded — mirrors the "cap it, don't let it grow forever" convention already used elsewhere
 * in this package (e.g. the batch-budget plan's ABSOLUTE_TURN_CEILING).
 */
export declare function recordUndoLogEntry(backend: FsBackend, workspaceRoot: string, entry: UndoLogEntry): Promise<void>;
export declare function loadUndoLogEntry(backend: FsBackend, workspaceRoot: string, id: string): Promise<UndoLogEntry | undefined>;
/** Newest first (by appliedAt) — feeds /undo-action's no-argument listing view (T3). */
export declare function listUndoLogEntries(backend: FsBackend, workspaceRoot: string): Promise<UndoLogEntry[]>;
export declare function deleteUndoLogEntry(backend: FsBackend, workspaceRoot: string, id: string): Promise<void>;
/** Per-file cap — a file over this size is reported as skipped, never partially captured. */
export declare const UNDO_SNAPSHOT_MAX_FILE_BYTES = 1000000;
/** Overall file-count ceiling for one walk — hitting it truncates the whole snapshot (see
 * WorkspaceSnapshot.truncated), not just the files past the ceiling, since a walk that stops
 * partway through gives no reliable picture of "everything else is unchanged" either. */
export declare const UNDO_SNAPSHOT_MAX_FILES = 2000;
/**
 * Directory names skipped by default during a workspace walk — this feature's own bookkeeping
 * plus conventionally-heavy, rarely-hand-edited directories. Without this, a walk would blow
 * UNDO_SNAPSHOT_MAX_FILES on node_modules/ alone for any real npm-monorepo workspace.
 */
export declare const UNDO_SNAPSHOT_EXCLUDED_DIRS: string[];
export interface WorkspaceSnapshot {
    files: Map<string, string>;
    skipped: {
        path: string;
        reason: string;
        size?: number;
    }[];
    truncated: boolean;
    truncationReason?: string;
    /**
     * Deviation from the plan's summary interface (which lists only files/skipped/truncated/
     * truncationReason): a cheap, non-recursive immediate-child-name listing taken once per
     * excluded directory encountered, keyed by that directory's path. Excluded directories are
     * never walked into (that's the whole point — see UNDO_SNAPSHOT_EXCLUDED_DIRS's doc comment),
     * so there is no per-file record of their contents to diff. This one-level signature is the
     * cheapest available signal that lets diffSnapshots notice "something was added to or removed
     * from node_modules/ directly" without paying to walk its full subtree. It's necessarily
     * best-effort — a content-only change to a file already inside an excluded directory, or a
     * change nested more than one level deep inside it, isn't detected by this signature alone.
     */
    excludedDirSignatures: Map<string, string>;
}
/**
 * Recursively snapshots every text file under `workspaceRoot`, for diffing before/after a
 * run_shell_command execution (T2 step 6) since a shell command has no single known target path
 * the way write_file does. Skips default-excluded directories, oversized files, and binary
 * files (see the exported constants above) rather than either blowing past a sane cost ceiling
 * or silently corrupting a binary file via a lossy UTF-8 round-trip.
 *
 * Requires `backend.stat` (optional on FsBackend — only backends doing a recursive walk need
 * it). A backend without it can't distinguish a file from a directory, so this returns
 * immediately with `truncated: true` rather than attempting an unreliable walk.
 */
export declare function snapshotWorkspaceTree(backend: FsBackend, workspaceRoot: string): Promise<WorkspaceSnapshot>;
export interface WorkspaceDiff {
    added: string[];
    modified: {
        path: string;
        previousContent: string;
    }[];
    deleted: {
        path: string;
        previousContent: string;
    }[];
    unsnapshottableChanges: string[];
}
/**
 * Diffs two workspace snapshots taken before/after a shell command ran. Only the actual diff is
 * meant to be persisted to an undo-log entry, not two full tree copies.
 */
export declare function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceDiff;
/**
 * Builds the undo-log entry for a completed run_shell_command approval from its before/after
 * workspace snapshots (T2 step 7).
 *
 * Deviation / judgment call: step 7's prose says a non-empty `unsnapshottableChanges` escalates
 * the whole entry to `undoable: false`, but the Files tab's own type-level doc comment on the
 * `undoable: true` shell variant says the opposite ("non-empty here still means undoable: true
 * for the paths that WERE captured"), and the Test Plan tab's cases for node_modules-only and
 * binary-file changes describe the command "executing normally" with the change merely
 * "reported in unsnapshottableChanges" — neither test expects undoable: false for those cases.
 * Following the type comment and the Test Plan tab (the more precise, mutually-consistent
 * sources) over the summary prose: only a *truncated* tree walk — meaning the before/after
 * picture itself is unreliable, not just a subset of paths within it — escalates to
 * `undoable: false`. A non-empty `unsnapshottableChanges` on an otherwise-complete walk keeps
 * `undoable: true`, offering a partial revert for the paths that were captured, with the
 * incompleteness surfaced on the entry for a later /undo-action to warn about (T3).
 */
export declare function buildShellUndoLogEntry(appliedActionId: string, command: string, before: WorkspaceSnapshot, after: WorkspaceSnapshot): UndoLogEntry;
/**
 * The concrete filesystem operations a revert needs to perform, derived from one undo-log
 * entry: every path in `restore` gets its `content` written back; every path in `remove` gets
 * deleted (it didn't exist, or wasn't created, before the original action ran). Kept as its own
 * plain-data shape (rather than handing the raw UndoLogEntry to applyPendingAction) so the
 * staged `kind: 'revert'` PendingActionPayload carries exactly what it needs to apply, the same
 * way `kind: 'write'`/`kind: 'shell'` already carry their own complete, self-sufficient payload.
 */
export interface RevertPlan {
    restore: {
        path: string;
        content: string;
    }[];
    remove: string[];
}
/** `undefined` when `entry.undoable` is false — an undoable:false entry has nothing to revert. */
export declare function buildRevertPlan(entry: UndoLogEntry): RevertPlan | undefined;
