import type { AssistantConfig, ConfigStore } from '@buildaharness/personal-assistant'
import { FileSystemAdapter, type FsBackend } from '@buildaharness/runtime'

const CONFIG_KEY = 'settings'

/**
 * Tauri-fs-backed ConfigStore for the desktop build. Reuses FileSystemAdapter — already
 * wired for transcripts/experience/checkpoints in App.tsx's createTauriBackedAssistant() —
 * under a new "config" namespace, rather than introducing a second persistence mechanism.
 * FileSystemAdapter.set() replaces the stored value wholesale (its default 'upsert' mode is
 * not a merge), so save() does its own read-merge-write, the same contract NodeConfigStore
 * and BrowserConfigStore both provide.
 */
export class TauriConfigStore implements ConfigStore {
  private readonly adapter: FileSystemAdapter

  constructor(opts: { backend: FsBackend; baseDir: string }) {
    this.adapter = new FileSystemAdapter({ backend: opts.backend, baseDir: opts.baseDir, namespace: 'config' })
  }

  async load(): Promise<Partial<AssistantConfig>> {
    const value = await this.adapter.get(CONFIG_KEY)
    return (value as Partial<AssistantConfig> | undefined) ?? {}
  }

  async save(patch: Partial<AssistantConfig>): Promise<void> {
    const existing = await this.load()
    await this.adapter.set(CONFIG_KEY, { ...existing, ...patch })
  }
}
