import { describe, it, expect } from 'vitest'
import type { FsBackend } from '@buildaharness/runtime'
import {
  snapshotBeforeWrite,
  snapshotWorkspaceTree,
  diffSnapshots,
  buildShellUndoLogEntry,
  recordUndoLogEntry,
  loadUndoLogEntry,
  listUndoLogEntries,
  UNDO_LOG_MAX_ENTRIES,
  UNDO_SNAPSHOT_MAX_FILE_BYTES,
  UNDO_SNAPSHOT_MAX_FILES,
  type UndoLogEntry,
} from './action-snapshot.js'

const ROOT = '/workspace'

/**
 * In-memory FsBackend, standing in for a real disk — mirrors file-tools.test.ts's fake backend,
 * extended with `stat`/directory tracking so a recursive workspace walk (T2) can tell a file
 * from a directory the way a real filesystem would.
 */
function makeFakeBackend(opts: { failReadPaths?: Set<string>; noStat?: boolean } = {}): FsBackend {
  const files = new Map<string, string>()
  const dirs = new Set<string>([ROOT])
  const failReadPaths = opts.failReadPaths ?? new Set<string>()

  function ensureParentDirs(path: string): void {
    let parent = path.slice(0, path.lastIndexOf('/'))
    while (parent && parent.length >= ROOT.length) {
      dirs.add(parent)
      parent = parent.slice(0, parent.lastIndexOf('/'))
    }
  }

  const backend: FsBackend = {
    async readTextFile(path) {
      if (failReadPaths.has(path)) throw new Error(`EIO: simulated read failure at ${path}`)
      return files.get(path)
    },
    async writeTextFile(path, contents) {
      ensureParentDirs(path)
      files.set(path, contents)
    },
    async removeFile(path) {
      files.delete(path)
    },
    async mkdir(path) {
      dirs.add(path)
    },
    async readDir(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      const names = new Set<string>()
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0])
      }
      for (const key of dirs) {
        if (key !== dir && key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) names.add(key.slice(prefix.length))
      }
      return [...names]
    },
  }

  if (!opts.noStat) {
    backend.stat = async (path: string) => {
      if (files.has(path)) return { isDirectory: false, size: files.get(path)!.length }
      if (dirs.has(path)) return { isDirectory: true, size: 0 }
      return undefined
    }
  }

  return backend
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

describe('snapshotWorkspaceTree / diffSnapshots / buildShellUndoLogEntry', () => {
  it('captures files and skips default-excluded directories, recording an excluded-dir signature', async () => {
    const backend = makeFakeBackend()
    await backend.writeTextFile(`${ROOT}/notes.txt`, 'hello')
    await backend.writeTextFile(`${ROOT}/node_modules/pkg/index.js`, 'module.exports = {}')

    const snap = await snapshotWorkspaceTree(backend, ROOT)

    expect(snap.files.get(`${ROOT}/notes.txt`)).toBe('hello')
    expect(snap.files.has(`${ROOT}/node_modules/pkg/index.js`)).toBe(false)
    expect(snap.skipped.some((s) => s.path === `${ROOT}/node_modules`)).toBe(true)
    expect(snap.excludedDirSignatures.has(`${ROOT}/node_modules`)).toBe(true)
  })

  it('skips a binary file rather than capturing it lossily', async () => {
    const backend = makeFakeBackend()
    await backend.writeTextFile(`${ROOT}/image.png`, 'PNG��binary')

    const snap = await snapshotWorkspaceTree(backend, ROOT)

    expect(snap.files.has(`${ROOT}/image.png`)).toBe(false)
    expect(snap.skipped.find((s) => s.path === `${ROOT}/image.png`)?.reason).toMatch(/binary/i)
  })

  it('marks truncated once the file-count ceiling is hit', async () => {
    const backend = makeFakeBackend()
    for (let i = 0; i < UNDO_SNAPSHOT_MAX_FILES + 5; i++) {
      await backend.writeTextFile(`${ROOT}/file${i}.txt`, 'x')
    }

    const snap = await snapshotWorkspaceTree(backend, ROOT)

    expect(snap.truncated).toBe(true)
    expect(snap.truncationReason).toMatch(/too large/i)
  })

  it('marks truncated when the backend has no stat()', async () => {
    const backend = makeFakeBackend({ noStat: true })

    const snap = await snapshotWorkspaceTree(backend, ROOT)

    expect(snap.truncated).toBe(true)
    expect(snap.truncationReason).toMatch(/does not support recursive/i)
  })

  it('diffSnapshots classifies added/modified/deleted correctly', async () => {
    const backend = makeFakeBackend()
    await backend.writeTextFile(`${ROOT}/a.txt`, 'one')
    await backend.writeTextFile(`${ROOT}/b.txt`, 'two')
    const before = await snapshotWorkspaceTree(backend, ROOT)

    await backend.writeTextFile(`${ROOT}/a.txt`, 'one-modified')
    await backend.removeFile(`${ROOT}/b.txt`)
    await backend.writeTextFile(`${ROOT}/c.txt`, 'three')
    const after = await snapshotWorkspaceTree(backend, ROOT)

    const diff = diffSnapshots(before, after)
    expect(diff.added).toEqual([`${ROOT}/c.txt`])
    expect(diff.modified).toEqual([{ path: `${ROOT}/a.txt`, previousContent: 'one' }])
    expect(diff.deleted).toEqual([{ path: `${ROOT}/b.txt`, previousContent: 'two' }])
    expect(diff.unsnapshottableChanges).toEqual([])
  })

  it('flags a change inside an excluded directory in unsnapshottableChanges instead of reporting nothing changed', async () => {
    const backend = makeFakeBackend()
    await backend.writeTextFile(`${ROOT}/node_modules/pkg/index.js`, 'v1')
    const before = await snapshotWorkspaceTree(backend, ROOT)

    await backend.writeTextFile(`${ROOT}/node_modules/pkg2/index.js`, 'v2')
    const after = await snapshotWorkspaceTree(backend, ROOT)

    const diff = diffSnapshots(before, after)
    expect(diff.unsnapshottableChanges).toContain(`${ROOT}/node_modules`)
  })

  it('buildShellUndoLogEntry stays undoable: true with a non-empty unsnapshottableChanges (excluded-dir case)', async () => {
    const backend = makeFakeBackend()
    const before = await snapshotWorkspaceTree(backend, ROOT)
    await backend.writeTextFile(`${ROOT}/node_modules/pkg/index.js`, 'v1')
    const after = await snapshotWorkspaceTree(backend, ROOT)

    const entry = buildShellUndoLogEntry('action-1', 'npm install pkg', before, after)
    expect(entry.undoable).toBe(true)
    if (entry.kind === 'shell' && entry.undoable) expect(entry.unsnapshottableChanges).toContain(`${ROOT}/node_modules`)
  })

  it('buildShellUndoLogEntry marks undoable: false with a clear reason when the walk was truncated', async () => {
    const backend = makeFakeBackend()
    for (let i = 0; i < UNDO_SNAPSHOT_MAX_FILES + 5; i++) {
      await backend.writeTextFile(`${ROOT}/file${i}.txt`, 'x')
    }
    const before = await snapshotWorkspaceTree(backend, ROOT)
    const after = await snapshotWorkspaceTree(backend, ROOT)

    const entry = buildShellUndoLogEntry('action-1', 'touch newfile', before, after)
    expect(entry.undoable).toBe(false)
    if (!entry.undoable) expect(entry.reason).toMatch(/too large/i)
  })

  it('a file over the size cap is skipped, not partially captured', async () => {
    const backend = makeFakeBackend()
    await backend.writeTextFile(`${ROOT}/big.txt`, 'x'.repeat(UNDO_SNAPSHOT_MAX_FILE_BYTES + 1))

    const snap = await snapshotWorkspaceTree(backend, ROOT)

    expect(snap.files.has(`${ROOT}/big.txt`)).toBe(false)
    expect(snap.skipped.find((s) => s.path === `${ROOT}/big.txt`)?.reason).toMatch(/size cap/i)
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
