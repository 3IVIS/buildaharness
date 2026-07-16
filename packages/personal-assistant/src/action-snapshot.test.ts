import { describe, it, expect } from 'vitest'
import type { FsBackend } from '@buildaharness/runtime'
import {
  snapshotBeforeWrite,
  recordUndoLogEntry,
  loadUndoLogEntry,
  listUndoLogEntries,
  UNDO_LOG_MAX_ENTRIES,
  type UndoLogEntry,
} from './action-snapshot.js'

const ROOT = '/workspace'

/** In-memory FsBackend, standing in for a real disk — mirrors file-tools.test.ts's fake backend. */
function makeFakeBackend(opts: { failReadPaths?: Set<string> } = {}): FsBackend {
  const files = new Map<string, string>()
  const dirs = new Set<string>([ROOT])
  const failReadPaths = opts.failReadPaths ?? new Set<string>()

  return {
    async readTextFile(path) {
      if (failReadPaths.has(path)) throw new Error(`EIO: simulated read failure at ${path}`)
      return files.get(path)
    },
    async writeTextFile(path, contents) {
      files.set(path, contents)
    },
    async removeFile(path) {
      files.delete(path)
    },
    async mkdir(path) {
      dirs.add(path)
    },
    async readDir(dir) {
      const prefix = `${dir}/`
      const names: string[] = []
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) names.push(key.slice(prefix.length))
      }
      return names
    },
  }
}

function makeWriteEntry(overrides: Partial<UndoLogEntry> = {}): UndoLogEntry {
  return {
    id: crypto.randomUUID(),
    appliedActionId: crypto.randomUUID(),
    kind: 'write',
    path: 'notes.txt',
    previousContent: 'old content',
    appliedAt: new Date().toISOString(),
    undoable: true,
    ...overrides,
  } as UndoLogEntry
}

describe('snapshotBeforeWrite', () => {
  it('captures the exact prior content of an existing text file', async () => {
    const backend = makeFakeBackend()
    await backend.writeTextFile(`${ROOT}/notes.txt`, 'the original text')

    const result = await snapshotBeforeWrite(backend, ROOT, `${ROOT}/notes.txt`)

    expect(result).toEqual({ previousContent: 'the original text', undoable: true })
  })

  it('records previousContent: null for a not-yet-existing path', async () => {
    const backend = makeFakeBackend()

    const result = await snapshotBeforeWrite(backend, ROOT, `${ROOT}/new-file.txt`)

    expect(result).toEqual({ previousContent: null, undoable: true })
  })

  it('returns undoable: false with a clear reason for an existing binary file, never a corrupted capture', async () => {
    const backend = makeFakeBackend()
    // Simulates what readTextFile would decode a binary file's bytes to — a replacement character.
    await backend.writeTextFile(`${ROOT}/image.png`, 'PNG��rest-of-binary-bytes')

    const result = await snapshotBeforeWrite(backend, ROOT, `${ROOT}/image.png`)

    expect(result.undoable).toBe(false)
    expect((result as { reason: string }).reason).toMatch(/binary/i)
    expect(result).not.toHaveProperty('previousContent')
  })

  it('surfaces a read error unrelated to "file doesn\'t exist" rather than swallowing it', async () => {
    const backend = makeFakeBackend({ failReadPaths: new Set([`${ROOT}/locked.txt`]) })

    await expect(snapshotBeforeWrite(backend, ROOT, `${ROOT}/locked.txt`)).rejects.toThrow(/simulated read failure/)
  })
})

describe('undo-log read/write', () => {
  it('recordUndoLogEntry writes an entry that loadUndoLogEntry can read back', async () => {
    const backend = makeFakeBackend()
    const entry = makeWriteEntry({ path: 'a.txt', previousContent: 'before' })

    await recordUndoLogEntry(backend, ROOT, entry)

    expect(await loadUndoLogEntry(backend, ROOT, entry.id)).toEqual(entry)
  })

  it('listUndoLogEntries returns entries newest-first by appliedAt', async () => {
    const backend = makeFakeBackend()
    const older = makeWriteEntry({ appliedAt: '2026-01-01T00:00:00.000Z' })
    const newer = makeWriteEntry({ appliedAt: '2026-01-02T00:00:00.000Z' })

    await recordUndoLogEntry(backend, ROOT, older)
    await recordUndoLogEntry(backend, ROOT, newer)

    const entries = await listUndoLogEntries(backend, ROOT)
    expect(entries.map((e) => e.id)).toEqual([newer.id, older.id])
  })

  it('prunes the oldest entry once the shared retention cap is exceeded, regardless of kind', async () => {
    const backend = makeFakeBackend()
    const entries: UndoLogEntry[] = []
    for (let i = 0; i < UNDO_LOG_MAX_ENTRIES + 1; i++) {
      const entry = makeWriteEntry({ appliedAt: new Date(2026, 0, 1, 0, 0, i).toISOString() })
      entries.push(entry)
      await recordUndoLogEntry(backend, ROOT, entry)
    }

    const remaining = await listUndoLogEntries(backend, ROOT)
    expect(remaining).toHaveLength(UNDO_LOG_MAX_ENTRIES)
    // The very first (oldest) entry recorded should have been pruned.
    expect(remaining.some((e) => e.id === entries[0].id)).toBe(false)
    // The most recently recorded entry must survive the prune.
    expect(remaining.some((e) => e.id === entries[entries.length - 1].id)).toBe(true)
  })
})
