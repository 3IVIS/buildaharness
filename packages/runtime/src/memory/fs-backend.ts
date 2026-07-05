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
}
