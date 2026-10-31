import { ExperienceStore, ExperienceStoreData, StrategyWeightKey, StrategyEvidence, DecompositionEntry, ToolWorkflowEntry, VerificationPlanEntry, RecoverySequenceEntry } from '../../../harness/src/index.ts';
export interface DexieExperienceStoreOptions {
    namespace?: string;
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
 *
 * Storage-taxonomy note (personal-assistant's Phase 5b): this is the Experience tier ("what
 * worked before"), distinct from Knowledge (a UserFact belief) or State (a Plan's current
 * status) — see packages/aielia/README.md's "Memory, Knowledge, and the other four"
 * section for the full six-tier map this store fits into.
 */
export declare class DexieExperienceStore implements ExperienceStore {
    private readonly inner;
    private readonly db;
    private constructor();
    /** Async factory — loads any prior snapshot before the store is usable. */
    static create(opts?: DexieExperienceStoreOptions): Promise<DexieExperienceStore>;
    private persist;
    get available(): boolean;
    getStrategyWeights(): Record<StrategyWeightKey, number>;
    setStrategyWeight(key: StrategyWeightKey, weight: number): void;
    getClassPriors(): Record<string, number>;
    getStrategyEvidence(): Record<StrategyWeightKey, StrategyEvidence>;
    setStrategyEvidence(key: StrategyWeightKey, evidence: StrategyEvidence): void;
    setClassPrior(failureClass: string, prior: number): void;
    getDecompositions(): DecompositionEntry[];
    addDecomposition(entry: DecompositionEntry): void;
    getToolWorkflows(): ToolWorkflowEntry[];
    addToolWorkflow(entry: ToolWorkflowEntry): void;
    getVerificationPlans(): VerificationPlanEntry[];
    addVerificationPlan(entry: VerificationPlanEntry): void;
    getRecoverySequences(): RecoverySequenceEntry[];
    addRecoverySequence(entry: RecoverySequenceEntry): void;
    updateExperienceStore(runId: string, outcome: Record<string, unknown>): void;
    toJSON(): ExperienceStoreData;
}
