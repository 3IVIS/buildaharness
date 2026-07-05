import type { MemoryAdapter, MemoryResult } from './adapter'
import type { FsBackend } from './fs-backend'
import { applyMode, scoreEntries } from './scoring'

function sanitize(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

interface FileEntry {
  key: string
  value: unknown
}

export interface FileSystemAdapterOptions {
  backend: FsBackend
  /** Directory the namespace lives under, e.g. an app's local data dir. */
  baseDir: string
  namespace?: string
}

/**
 * MemoryAdapter backed by real files — one JSON file per key under
 * `<baseDir>/<namespace>/`, keyed by a filesystem-safe slug of the key (the
 * original key is stored inside the file so `search()` can still report it
 * correctly even if two keys sanitize to the same slug — extremely unlikely
 * given this adapter's key space, but cheap to guard against).
 *
 * File I/O goes through an injected FsBackend rather than a direct dependency
 * on any specific filesystem API, so the same class serves both the Tauri
 * desktop app (@tauri-apps/plugin-fs) and the CLI (node:fs/promises) without
 * this package depending on either.
 */
export class FileSystemAdapter implements MemoryAdapter {
  private readonly backend: FsBackend
  private readonly dir: string
  private dirEnsured = false

  constructor(opts: FileSystemAdapterOptions) {
    this.backend = opts.backend
    this.dir = `${opts.baseDir}/${opts.namespace ?? 'default'}`
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return
    await this.backend.mkdir(this.dir)
    this.dirEnsured = true
  }

  private path(key: string): string {
    return `${this.dir}/${sanitize(key)}.json`
  }

  private async readEntry(key: string): Promise<FileEntry | undefined> {
    const raw = await this.backend.readTextFile(this.path(key))
    return raw === undefined ? undefined : (JSON.parse(raw) as FileEntry)
  }

  async get(key: string): Promise<unknown> {
    return (await this.readEntry(key))?.value
  }

  async set(key: string, value: unknown, mode = 'upsert'): Promise<void> {
    await this.ensureDir()
    const existing = await this.readEntry(key)
    const entry: FileEntry = { key, value: applyMode(existing?.value, value, mode) }
    await this.backend.writeTextFile(this.path(key), JSON.stringify(entry))
  }

  async search(query: string, topK = 5, minScore = 0.0): Promise<MemoryResult[]> {
    await this.ensureDir()
    const files = await this.backend.readDir(this.dir)
    const entries: [string, unknown][] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const raw = await this.backend.readTextFile(`${this.dir}/${file}`)
      if (raw === undefined) continue
      const parsed = JSON.parse(raw) as FileEntry
      entries.push([parsed.key, parsed.value])
    }
    return scoreEntries(entries, query, topK, minScore)
  }

  async delete(key: string): Promise<void> {
    await this.backend.removeFile(this.path(key))
  }
}
