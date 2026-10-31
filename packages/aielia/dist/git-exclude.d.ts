/** Directories Aielia keeps inside the workspace for its own state. */
export declare const AIELIA_STATE_DIRS: readonly [".pending-actions", ".undo-log", ".buildaharness"];
/**
 * Keeps Aielia's own state directories out of version control when the workspace is inside a git repo, by adding them to
 * `<gitdir>/info/exclude` — the per-clone ignore file git itself provides for this. The user's tracked `.gitignore` is never
 * touched, and a non-git directory is left exactly as it was. Idempotent and best-effort: returns the entries it added and
 * never throws (a read-only .git must not stop the assistant from starting).
 */
export declare function excludeAieliaStateFromGit(workspaceRoot: string): string[];
