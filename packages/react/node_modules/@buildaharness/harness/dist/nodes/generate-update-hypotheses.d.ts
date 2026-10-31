import { WorldModel } from '../state/world-model.js';
import { EvidenceStore } from '../state/evidence-store.js';
import { HypothesisSet } from '../state/hypothesis-set.js';
import { FailureDiagnostics } from '../state/failure-diagnostics.js';
import { MemoryState } from '../state/memory-state.js';
export declare function generateUpdateHypotheses(worldModel: WorldModel, evidenceStore: EvidenceStore, hypothesisSet: HypothesisSet, failureDiagnostics: FailureDiagnostics, memoryState: MemoryState): void;
export declare function computeSourceEntropy(hypothesisSet: HypothesisSet): number;
