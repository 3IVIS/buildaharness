import type { HarnessRunStateData } from './harness-run-state.js'
import type { DepGraphBudgetData } from './state/world-model.js'

export interface HarnessRunConfigData {
  objective: string
  successCriteria: string[]
  maxSteps: number
  depGraphBudget: DepGraphBudgetData
  processConceptId: string | null
}

export interface HarnessRunProgressData {
  stepsUsed: number
  nodeExecutionOrder: string[]
  finalResult: unknown
  consecutiveReviewFailures: [string, number][]
  propagationQueue: { reopenedTaskIds: string[] }
}

/**
 * A fully serializable snapshot of an in-progress or completed harness run.
 * Everything needed to reconstruct the 13 state structures and resume the
 * main loop lives here — except experienceStore/updateChannel/toolExecutors,
 * which are live objects the caller must re-supply to resume() (same as the
 * Python state_store: "callers must re-attach a session factory after loading").
 */
export interface HarnessCheckpoint {
  runId: string
  runState: HarnessRunStateData
  runConfig: HarnessRunConfigData
  progress: HarnessRunProgressData
}

/**
 * Minimal structural contract for a key-value store that can persist a
 * HarnessCheckpoint. Deliberately duck-typed (not imported) against
 * @buildaharness/runtime's MemoryAdapter so this package keeps zero
 * runtime/browser dependencies — any object with this shape works,
 * including an IndexedDBAdapter or InMemoryAdapter passed in from the caller.
 */
export interface CheckpointStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

const checkpointKey = (runId: string): string => `harness-checkpoint:${runId}`

export async function saveHarnessCheckpoint(store: CheckpointStore, checkpoint: HarnessCheckpoint): Promise<void> {
  await store.set(checkpointKey(checkpoint.runId), checkpoint)
}

export async function loadHarnessCheckpoint(store: CheckpointStore, runId: string): Promise<HarnessCheckpoint | undefined> {
  const value = await store.get(checkpointKey(runId))
  return value as HarnessCheckpoint | undefined
}

export async function deleteHarnessCheckpoint(store: CheckpointStore, runId: string): Promise<void> {
  await store.delete(checkpointKey(runId))
}
