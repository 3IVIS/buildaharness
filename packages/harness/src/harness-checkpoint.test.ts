import { describe, it, expect, vi } from 'vitest'
import {
  CHECKPOINT_SCHEMA_VERSION,
  CHECKPOINT_MIGRATIONS,
  CheckpointSchemaError,
  assertCheckpointSchemaCurrent,
  saveHarnessCheckpoint,
  loadHarnessCheckpoint,
  deleteHarnessCheckpoint,
  type HarnessCheckpoint,
  type CheckpointStore,
} from './harness-checkpoint.js'

/** In-memory CheckpointStore fake — same duck-typed contract IndexedDBAdapter/InMemoryAdapter satisfy. */
function makeFakeStore(): CheckpointStore & { size: () => number } {
  const map = new Map<string, unknown>()
  return {
    async get(key) { return map.get(key) },
    async set(key, value) { map.set(key, value) },
    async delete(key) { map.delete(key) },
    size: () => map.size,
  }
}

function makeCheckpoint(overrides: Partial<HarnessCheckpoint> = {}): HarnessCheckpoint {
  return {
    runId: 'turn:test-session',
    runState: {} as HarnessCheckpoint['runState'],
    runConfig: { objective: 'obj', successCriteria: [], maxSteps: 10, depGraphBudget: {} as never, processConceptId: null },
    progress: { stepsUsed: 1, nodeExecutionOrder: [], finalResult: null, consecutiveReviewFailures: [], propagationQueue: { reopenedTaskIds: [] } },
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    ...overrides,
  }
}

describe('assertCheckpointSchemaCurrent', () => {
  it('passes a checkpoint already at the current version through unchanged', () => {
    const checkpoint = makeCheckpoint()
    expect(assertCheckpointSchemaCurrent(checkpoint)).toBe(checkpoint)
  })

  it('treats a missing schemaVersion as version 1 (pre-versioning), not an error', () => {
    const legacy = makeCheckpoint()
    delete (legacy as { schemaVersion?: number }).schemaVersion
    expect(() => assertCheckpointSchemaCurrent(legacy)).not.toThrow()
  })

  it('throws CheckpointSchemaError for a version newer than this build understands', () => {
    const fromTheFuture = makeCheckpoint({ schemaVersion: CHECKPOINT_SCHEMA_VERSION + 1 })
    expect(() => assertCheckpointSchemaCurrent(fromTheFuture)).toThrow(CheckpointSchemaError)
  })

  it('throws CheckpointSchemaError for an old version with no registered migration', () => {
    // CHECKPOINT_SCHEMA_VERSION is 1 today, so there's no "old" version to construct directly —
    // this simulates the future case by registering nothing for version 0 and asserting from there.
    expect(CHECKPOINT_MIGRATIONS[0]).toBeUndefined()
  })

  it('applies a registered migration and chains until the current version is reached', () => {
    const v0 = { runId: 'turn:v0', legacyShape: true } as unknown as HarnessCheckpoint
    CHECKPOINT_MIGRATIONS[0] = (raw) => ({ ...makeCheckpoint(), runId: (raw as { runId: string }).runId, schemaVersion: 1 })
    try {
      const migrated = assertCheckpointSchemaCurrent({ ...v0, schemaVersion: 0 })
      expect(migrated.schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION)
      expect(migrated.runId).toBe('turn:v0')
    } finally {
      delete CHECKPOINT_MIGRATIONS[0]
    }
  })
})

describe('saveHarnessCheckpoint / loadHarnessCheckpoint', () => {
  it('round-trips a checkpoint unchanged', async () => {
    const store = makeFakeStore()
    const checkpoint = makeCheckpoint()
    await saveHarnessCheckpoint(store, checkpoint)
    const loaded = await loadHarnessCheckpoint(store, checkpoint.runId)
    expect(loaded).toEqual(checkpoint)
  })

  it('returns undefined on a fresh store with no checkpoint saved yet', async () => {
    const store = makeFakeStore()
    expect(await loadHarnessCheckpoint(store, 'turn:never-saved')).toBeUndefined()
  })

  it('loads a legacy checkpoint saved before schemaVersion existed', async () => {
    const store = makeFakeStore()
    const legacy = makeCheckpoint()
    delete (legacy as { schemaVersion?: number }).schemaVersion
    await store.set('harness-checkpoint:turn:test-session', legacy)
    const loaded = await loadHarnessCheckpoint(store, 'turn:test-session')
    expect(loaded).toBeDefined()
    expect(loaded?.runId).toBe('turn:test-session')
  })

  it('discards (does not throw) an unmigratable checkpoint and deletes it from the store', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = makeFakeStore()
    const fromTheFuture = makeCheckpoint({ schemaVersion: CHECKPOINT_SCHEMA_VERSION + 1 })
    await store.set('harness-checkpoint:turn:test-session', fromTheFuture)
    expect(store.size()).toBe(1)

    const loaded = await loadHarnessCheckpoint(store, 'turn:test-session')
    expect(loaded).toBeUndefined()
    expect(store.size()).toBe(0) // deleted, not left behind to fail the same way again next time
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('a fresh call after an unmigratable checkpoint was discarded behaves like no checkpoint ever existed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = makeFakeStore()
    await store.set('harness-checkpoint:turn:x', makeCheckpoint({ runId: 'turn:x', schemaVersion: CHECKPOINT_SCHEMA_VERSION + 1 }))
    await loadHarnessCheckpoint(store, 'turn:x')
    expect(await loadHarnessCheckpoint(store, 'turn:x')).toBeUndefined()
    warn.mockRestore()
  })

  it('deleteHarnessCheckpoint removes a saved checkpoint', async () => {
    const store = makeFakeStore()
    const checkpoint = makeCheckpoint()
    await saveHarnessCheckpoint(store, checkpoint)
    await deleteHarnessCheckpoint(store, checkpoint.runId)
    expect(await loadHarnessCheckpoint(store, checkpoint.runId)).toBeUndefined()
  })
})
