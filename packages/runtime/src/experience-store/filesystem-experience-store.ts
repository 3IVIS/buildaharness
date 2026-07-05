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
import type { FsBackend } from '../memory/fs-backend'

export interface FileSystemExperienceStoreOptions {
  backend: FsBackend
  baseDir: string
  namespace?: string
}

/**
 * Filesystem-backed ExperienceStore — same sync-wrapper pattern as
 * DexieExperienceStore (see that file for the full rationale): the harness's
 * ExperienceStore interface is synchronous, so an InMemoryExperienceStore is
 * the real source of truth and a full snapshot is written to disk in the
 * background after every mutation via the injected FsBackend, instead of a
 * Dexie table.
 */
export class FileSystemExperienceStore implements ExperienceStore {
  private readonly inner: InMemoryExperienceStore
  private readonly backend: FsBackend
  private readonly path: string

  private constructor(inner: InMemoryExperienceStore, backend: FsBackend, path: string) {
    this.inner = inner
    this.backend = backend
    this.path = path
  }

  /** Async factory — loads any prior snapshot before the store is usable. */
  static async create(opts: FileSystemExperienceStoreOptions): Promise<FileSystemExperienceStore> {
    const dir = `${opts.baseDir}/${opts.namespace ?? 'default'}`
    await opts.backend.mkdir(dir)
    const path = `${dir}/experience.json`
    const raw = await opts.backend.readTextFile(path)
    const inner = raw ? InMemoryExperienceStore.fromJSON(JSON.parse(raw) as ExperienceStoreData) : new InMemoryExperienceStore()
    return new FileSystemExperienceStore(inner, opts.backend, path)
  }

  private persist(): void {
    void this.backend.writeTextFile(this.path, JSON.stringify(this.inner.toJSON())).catch(() => {})
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
