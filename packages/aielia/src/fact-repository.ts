// Storage seam for memory lists. `MemoryService` reads and writes its fact lists (durable, session,
// pending, rejected, retired, archived, events, audit, proposals) only through a `FactRepository`;
// `KeyValueFactRepository` maps them onto today's `MemoryAdapter` keys, so the on-disk layout does not change.
// A SQLite or Dexie repository is done when it passes `runFactRepositoryContract` (fact-repository.contract.ts).
import type { MemoryAdapter } from '@buildaharness/runtime'

/** One list to replace. `value: null` removes the list (distinct from an empty list, so an undo can restore "absent"). */
export interface FactChange {
  key: string
  value: unknown[] | null
}

/** Thrown by `apply()` when `expectedVersion` is not the repository's current version. */
export class VersionConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`fact repository version conflict: expected ${expected}, found ${actual}`)
    this.name = 'VersionConflictError'
  }
}

export interface FactQuery<T> {
  /** Keep only rows for which this returns true (status, tier, attribute key and project are all row predicates). */
  where?: (row: T) => boolean
}

export interface FactRepository {
  /** Monotonic counter, bumped by every successful `apply`/`put`/`remove`/`appendEvents`. */
  version(): number
  /** The whole list stored under `key`, `[]` when absent. */
  list<T>(key: string, query?: FactQuery<T>): Promise<T[]>
  /** The first row under `key` whose id (from `idOf`) equals `id`. */
  get<T>(key: string, id: string, idOf: (row: T) => string): Promise<T | undefined>
  /** Replace several lists as one commit: all land or none do. Throws `VersionConflictError` if `expectedVersion` is stale. */
  apply(changes: FactChange[], expectedVersion?: number): Promise<number>
  /** Single-list shorthands for `apply`. */
  put(key: string, value: unknown[]): Promise<void>
  remove(key: string): Promise<void>
  /** Append to an ordered event list in one step, then let `trim` bound it. Order of appends is preserved. */
  appendEvents<T>(key: string, events: T[], trim?: (all: T[]) => T[]): Promise<T[]>
}

/** Today's behaviour: each list lives under its own `MemoryAdapter` key. The version is per instance (one process). */
export class KeyValueFactRepository implements FactRepository {
  private ver = 0
  constructor(private readonly store: MemoryAdapter) {}

  version(): number {
    return this.ver
  }

  async list<T>(key: string, query?: FactQuery<T>): Promise<T[]> {
    const rows = ((await this.store.get(key)) as T[] | undefined) ?? []
    return query?.where ? rows.filter(query.where) : rows
  }

  async get<T>(key: string, id: string, idOf: (row: T) => string): Promise<T | undefined> {
    return (await this.list<T>(key)).find((r) => idOf(r) === id)
  }

  async apply(changes: FactChange[], expectedVersion?: number): Promise<number> {
    if (expectedVersion !== undefined && expectedVersion !== this.ver) throw new VersionConflictError(expectedVersion, this.ver)
    const before = new Map<string, unknown>()
    for (const c of changes) if (!before.has(c.key)) before.set(c.key, await this.store.get(c.key))
    const done: string[] = []
    try {
      for (const c of changes) {
        if (c.value === null) await this.store.delete(c.key)
        else await this.store.set(c.key, c.value)
        done.push(c.key)
      }
    } catch (err) {
      for (const key of done.reverse()) {
        const prior = before.get(key)
        if (prior === undefined) await this.store.delete(key)
        else await this.store.set(key, prior)
      }
      throw err
    }
    return ++this.ver
  }

  async put(key: string, value: unknown[]): Promise<void> {
    await this.apply([{ key, value }])
  }

  async remove(key: string): Promise<void> {
    await this.apply([{ key, value: null }])
  }

  async appendEvents<T>(key: string, events: T[], trim: (all: T[]) => T[] = (all) => all): Promise<T[]> {
    const next = trim([...(await this.list<T>(key)), ...events])
    await this.apply([{ key, value: next }])
    return next
  }
}
