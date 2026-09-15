/**
 * The minimal file-I/O seam FileSystemAdapter and FileSystemExperienceStore need.
 * Neither class imports a filesystem API directly — callers inject a backend built
 * on whatever's available in their environment (e.g. @tauri-apps/plugin-fs in a
 * Tauri webview, node:fs/promises in the CLI), so this package never has to depend
 * on either.
 */
export interface FsBackend {
  /** Resolves `undefined` if the file doesn't exist, rather than throwing. */
  readTextFile(path: string): Promise<string | undefined>
  writeTextFile(path: string, contents: string): Promise<void>
  /** No-op if the file doesn't exist. */
  removeFile(path: string): Promise<void>
  /** Recursive; no-op if the directory already exists. */
  mkdir(path: string): Promise<void>
  /** File names only, non-recursive. */
  readDir(path: string): Promise<string[]>
  /**
   * Resolves symlinks and returns the canonical path. Optional — only backends
   * that sit on a real filesystem (and callers that need to detect a symlink
   * escaping a sandboxed directory, e.g. personal-assistant's file-tools) need
   * to implement it. Should reject/throw if `path` doesn't exist, matching
   * node:fs/promises.realpath's behavior.
   */
  realpath?(path: string): Promise<string>
  /**
   * Optional — only backends that need a recursive directory walk (e.g.
   * personal-assistant's workspace-wide undo snapshot) have to implement it,
   * the same way `realpath` already is. Resolves `undefined` if `path`
   * doesn't exist, matching `readTextFile`'s "missing means undefined, not a
   * throw" convention rather than `realpath`'s "throw" one.
   */
  stat?(path: string): Promise<{ isDirectory: boolean; size: number } | undefined>
  /**
   * Renames/moves `from` to `to`, overwriting `to` if it already exists — the primitive a
   * write-tmp-then-rename atomic write needs. Optional, same "only backends that need it
   * implement it" convention as `realpath`/`stat`: a backend without it (e.g. a Tauri webview
   * with no atomic move, or a fake with no real disk) just means callers fall back to a plain,
   * non-atomic `writeTextFile` straight to the final path instead of failing outright.
   */
  rename?(from: string, to: string): Promise<void>
}
