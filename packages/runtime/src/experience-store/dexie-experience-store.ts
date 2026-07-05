import Dexie, { type Table } from 'dexie'
import {
  InMemoryExperienceStore,
  type ExperienceStore,
  type ExperienceStoreData,
  type StrategyWeightKey,
  type DecompositionEntry,
  type ToolWorkflowEntry,
  type VerificationPlanEntry,
  type RecoverySequenceEntry,
} from '@buildaharness/harness'

interface SnapshotRow {
  id: 'snapshot'
  data: ExperienceStoreData
}

class ExperienceDB extends Dexie {
  snapshots!: Table<SnapshotRow, string>

  constructor(namespace: string) {
    super(`buildaharness-experience-${namespace}`)
    this.version(1).stores({ snapshots: 'id' })
  }
}

export interface DexieExperienceStoreOptions {
  namespace?: string
}

/**
 * Browser-persistent ExperienceStore, so cross-run learning (strategy weights,
 * decompositions, verification plans, recovery sequences) survives a page
 * reload instead of resetting every session like InMemoryExperienceStore.
 *
 * The harness's ExperienceStore interface is fully synchronous (HarnessRuntime
 * calls it mid-loop), but IndexedDB has no synchronous API. So this wraps an
 * InMemoryExperienceStore as the synchronous source of truth — reads/writes
 * never touch Dexie directly — and persists a full snapshot to Dexie in the
 * background after every mutation. A storage failure is swallowed (matching
 * the harness's own "unavailable store degrades to a silent no-op" contract)
 * so it never breaks a run.
 */
export class DexieExperienceStore implements ExperienceStore {
  private readonly inner: InMemoryExperienceStore
  private readonly db: ExperienceDB

  private constructor(inner: InMemoryExperienceStore, db: ExperienceDB) {
    this.inner = inner
    this.db = db
  }

  /** Async factory — loads any prior snapshot before the store is usable. */
  static async create(opts: DexieExperienceStoreOptions = {}): Promise<DexieExperienceStore> {
    const namespace = opts.namespace ?? 'default'
    const db = new ExperienceDB(namespace)
    const row = await db.snapshots.get('snapshot')
    const inner = row ? InMemoryExperienceStore.fromJSON(row.data) : new InMemoryExperienceStore()
    return new DexieExperienceStore(inner, db)
  }

  private persist(): void {
    void this.db.snapshots.put({ id: 'snapshot', data: this.inner.toJSON() }).catch(() => {})
  }

  get available(): boolean {
    return true
  }

  getStrategyWeights(): Record<StrategyWeightKey, number> {
    return this.inner.getStrategyWeights()
  }

  setStrategyWeight(key: StrategyWeightKey, weight: number): void {
    this.inner.setStrategyWeight(key, weight)
    this.persist()
  }

  getClassPriors(): Record<string, number> {
    return this.inner.getClassPriors()
  }

  setClassPrior(failureClass: string, prior: number): void {
    this.inner.setClassPrior(failureClass, prior)
    this.persist()
  }

  getDecompositions(): DecompositionEntry[] {
    return this.inner.getDecompositions()
  }

  addDecomposition(entry: DecompositionEntry): void {
    this.inner.addDecomposition(entry)
    this.persist()
  }

  getToolWorkflows(): ToolWorkflowEntry[] {
    return this.inner.getToolWorkflows()
  }

  addToolWorkflow(entry: ToolWorkflowEntry): void {
    this.inner.addToolWorkflow(entry)
    this.persist()
  }

  getVerificationPlans(): VerificationPlanEntry[] {
    return this.inner.getVerificationPlans()
  }

  addVerificationPlan(entry: VerificationPlanEntry): void {
    this.inner.addVerificationPlan(entry)
    this.persist()
  }

  getRecoverySequences(): RecoverySequenceEntry[] {
    return this.inner.getRecoverySequences()
  }

  addRecoverySequence(entry: RecoverySequenceEntry): void {
    this.inner.addRecoverySequence(entry)
    this.persist()
  }

  updateExperienceStore(runId: string, outcome: Record<string, unknown>): void {
    this.inner.updateExperienceStore(runId, outcome)
    this.persist()
  }

  toJSON(): ExperienceStoreData {
    return this.inner.toJSON()
  }
}
