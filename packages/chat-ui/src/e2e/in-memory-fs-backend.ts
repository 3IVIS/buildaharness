import type { FsBackend } from '@buildaharness/runtime'

/**
 * A tiny in-memory {@link FsBackend} for E2E / jsdom tests — the `makeFsBackend` an
 * {@link import('../assistant-test-hooks').AssistantTestHooks} installs so a plain-browser
 * assistant turn has `fileTools` configured and actually runs the tool loop. No real files.
 *
 * `seed` pre-populates it (keys are absolute paths under the `/workspace` root
 * `buildAssistant()` passes). Built for plans/chat_ui_browser_e2e_plan.html phase B1.
 */
export function createInMemoryFsBackend(seed: Record<string, string> = {}): FsBackend {
  const files = new Map<string, string>(Object.entries(seed))
  return {
    async readTextFile(path) {
      return files.get(path)
    },
    async writeTextFile(path, contents) {
      files.set(path, contents)
    },
    async removeFile(path) {
      files.delete(path)
    },
    async mkdir() {
      // No real directories to create.
    },
    async readDir(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      const names: string[] = []
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) names.push(key.slice(prefix.length))
      }
      return names
    },
  }
}
