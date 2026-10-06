import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import type { AssistantConfig, ConfigStore } from './config.js'

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/**
 * JSON-file-backed ConfigStore for the CLI, at a single `config.json` path (typically
 * `<dataDir>/config.json`). Deliberately not exported from this package's index — only cli.ts
 * imports it, same reasoning as node-fs-backend.ts — so a browser build never pulls in
 * node:fs/promises.
 *
 * save() merges the patch onto whatever's already persisted (never a blind overwrite of
 * unrelated keys) and writes through a temp-file-then-rename so a crash mid-write can never
 * leave a half-written config.json behind — the same failure mode file-tools.ts's
 * .pending-actions staging already avoids the same way. Setting a key to `undefined` in a
 * patch removes it from the persisted file (JSON.stringify drops undefined-valued
 * properties), which is what /config reset relies on.
 *
 * Concurrent save() calls on the same instance are serialized through an internal queue —
 * cli.ts's readline 'line' handler doesn't wait for one command to finish before dispatching
 * the next (e.g. piped stdin with two /config set lines back to back), so without this a
 * second save()'s load-modify-write could race the first's: reading stale state before the
 * first's write lands and silently clobbering it, or (with a timestamp-only temp filename)
 * colliding on the exact same temp path within the same millisecond.
 */
export class NodeConfigStore implements ConfigStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  async load(): Promise<Partial<AssistantConfig>> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf-8')
    } catch (err) {
      if (isEnoent(err)) return {}
      throw err
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      // `null`, a number or an array parses fine but is not a config object; treat it like corrupt JSON.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
      return parsed as Partial<AssistantConfig>
    } catch {
      console.error(`Warning: ${this.path} is not valid JSON — ignoring it and falling back to defaults.`)
      return {}
    }
  }

  save(patch: Partial<AssistantConfig>): Promise<void> {
    const task = this.queue.then(() => this.writePatch(patch))
    // A failed save must not poison the queue for saves queued after it.
    this.queue = task.catch(() => {})
    return task
  }

  private async writePatch(patch: Partial<AssistantConfig>): Promise<void> {
    const existing = await this.load()
    const merged = { ...existing, ...patch }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const tempPath = `${this.path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
    // The file holds API keys and the SMTP password in plain text: owner-only, never world-readable (the temp file is
    // new on every save, so the mode always applies and the rename carries it over the old, possibly 0644, file).
    await writeFile(tempPath, JSON.stringify(merged, null, 2), { encoding: 'utf-8', mode: 0o600 })
    await rename(tempPath, this.path)
  }
}
