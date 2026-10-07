import type { MemoryAdapter, MemoryResult } from './adapter'
import type { FsBackend } from './fs-backend'
import { applyMode, scoreEntries } from './scoring'

function sanitize(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

/** Short deterministic suffix (FNV-1a, 32 bit) used only when two distinct keys sanitize to the same slug. */
function shortHash(key: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
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

  private collisionPath(key: string): string {
    return `${this.dir}/${sanitize(key)}~${shortHash(key)}.json`
  }

  private async readFile(path: string): Promise<FileEntry | undefined> {
    const raw = await this.backend.readTextFile(path)
    if (raw === undefined) return undefined
    try {
      return JSON.parse(raw) as FileEntry
    } catch {
      return undefined // a corrupt file reads as absent rather than failing every call
    }
  }

  /**
   * Two different keys can sanitize to the same slug (e.g. "a:b" and "a_b"); the slug file belongs to
   * whichever wrote it first, and a later colliding key is stored under a hash-suffixed name instead of
   * silently reading or overwriting the other key's entry.
   */
  private async locate(key: string): Promise<{ path: string; entry: FileEntry | undefined }> {
    const primary = this.path(key)
    const primaryEntry = await this.readFile(primary)
    if (primaryEntry && (primaryEntry.key === key || primaryEntry.key === undefined)) return { path: primary, entry: primaryEntry }
    const secondary = this.collisionPath(key)
    const secondaryEntry = await this.readFile(secondary)
    if (secondaryEntry) return { path: secondary, entry: secondaryEntry }
    return { path: primaryEntry ? secondary : primary, entry: undefined }
  }

  async get(key: string): Promise<unknown> {
    return (await this.locate(key)).entry?.value
  }

  private writeQueue: Promise<unknown> = Promise.resolve()

  async set(key: string, value: unknown, mode = 'upsert'): Promise<void> {
    // Serialized: set() is read-modify-write (append mode), so overlapping calls would lose updates.
    const run = this.writeQueue.then(async () => {
      await this.ensureDir()
      const { path, entry: existing } = await this.locate(key)
      const entry: FileEntry = { key, value: applyMode(existing?.value, value, mode) }
      await this.backend.writeTextFile(path, JSON.stringify(entry))
    })
    this.writeQueue = run.catch(() => {})
    return run
  }

  async search(query: string, topK = 5, minScore = 0.0): Promise<MemoryResult[]> {
    await this.ensureDir()
    const files = await this.backend.readDir(this.dir)
    const entries: [string, unknown][] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const raw = await this.backend.readTextFile(`${this.dir}/${file}`)
      if (raw === undefined) continue
      let parsed: FileEntry
      try {
        parsed = JSON.parse(raw) as FileEntry
      } catch {
        continue // skip a corrupt file instead of failing the whole search
      }
      entries.push([parsed.key, parsed.value])
    }
    return scoreEntries(entries, query, topK, minScore)
  }

  async delete(key: string): Promise<void> {
    const { path, entry } = await this.locate(key)
    if (entry) await this.backend.removeFile(path)
  }
}
