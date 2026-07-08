import { invoke } from '@tauri-apps/api/core'
import type { FsBackend } from '@buildaharness/runtime'

/**
 * Workspace-root-scoped FsBackend for the desktop build's file/shell tools (read_file/
 * list_directory/write_file/run_shell_command, and the `.pending-actions` staging both
 * share) — backed by new Rust commands (src-tauri/src/lib.rs's workspace_* family) that do
 * raw std::fs I/O with their own path-containment check, not @tauri-apps/plugin-fs.
 *
 * tauri-fs-backend.ts (createTauriFsBackend) stays correctly scoped to $APPLOCALDATA via a
 * static capability grant, for transcripts/config/experience — that scope can never cover
 * `workspaceRoot` too, since it's a runtime-chosen path (the dev fallback, or a directory a
 * user picks later via Settings) with no way to declare it in advance. Using
 * createTauriFsBackend() for fileTools/shellTools against a workspaceRoot path used to fail
 * with a "forbidden path" error on every write_file/run_shell_command call — invisible as
 * long as claude-cli was the desktop build's only backend (its file tools run inside a
 * Rust-spawned Node subprocess via file-tools-mcp-server.mjs, never touching this JS
 * backend), but live the moment desktop could use the anthropic/openai/openrouter backends
 * too, which route file tools through PersonalAssistant's own generic JS-side dispatch.
 */
export function createTauriWorkspaceFsBackend(workspaceRoot: string): FsBackend {
  return {
    async readTextFile(path) {
      const contents = await invoke<string | null>('workspace_read_text_file', { workspaceRoot, path })
      return contents ?? undefined
    },
    async writeTextFile(path, contents) {
      await invoke('workspace_write_text_file', { workspaceRoot, path, contents })
    },
    async removeFile(path) {
      await invoke('workspace_remove_file', { workspaceRoot, path })
    },
    async mkdir(path) {
      await invoke('workspace_mkdir', { workspaceRoot, path })
    },
    async readDir(path) {
      return await invoke<string[]>('workspace_read_dir', { workspaceRoot, path })
    },
    async realpath(path) {
      return await invoke<string>('workspace_realpath', { workspaceRoot, path })
    },
  }
}
