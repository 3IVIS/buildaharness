import { ExperienceStore, ExperienceStoreData, StrategyWeightKey, StrategyEvidence, DecompositionEntry, ToolWorkflowEntry, VerificationPlanEntry, RecoverySequenceEntry } from '../../../harness/src/index.ts';
import { FsBackend } from '../memory/fs-backend';
export interface FileSystemExperienceStoreOptions {
    backend: FsBackend;
    baseDir: string;
    namespace?: string;
}
/**
 * Filesystem-backed ExperienceStore — same sync-wrapper pattern as
 * DexieExperienceStore (see that file for the full rationale): the harness's
 * ExperienceStore interface is synchronous, so an InMemoryExperienceStore is
 * the real source of truth and a full snapshot is written to disk in the
 * background after every mutation via the injected FsBackend, instead of a
 * Dexie table.
 */
export declare class FileSystemExperienceStore implements ExperienceStore {
    private readonly inner;
    private readonly backend;
    private readonly path;
    private constructor();
    /** Async factory — loads any prior snapshot before the store is usable. */
    static create(opts: FileSystemExperienceStoreOptions): Promise<FileSystemExperienceStore>;
    private writeChain;
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
