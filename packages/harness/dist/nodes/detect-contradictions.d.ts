import { WorldModel, Contradiction, BeliefDepGraph } from '../state/world-model.js';
import { EvidenceStore } from '../state/evidence-store.js';
import { HypothesisSet } from '../state/hypothesis-set.js';
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'SYSTEM_BREAKING';
export interface AbstractionContext {
    abstraction_level?: string;
}
/**
 * Matches detect_contradictions(): orchestrates all four detection functions,
 * upgrades system-breaking severity, stores every result via add_contradiction(),
 * and applies the resolution policy. Never raises — SYSTEM_BREAKING contradictions
 * flow into world_model.contradictions[] the same way LOW ones do; Control State's
 * Tier 1 is what actually reacts to them.
 */
export declare function detectContradictions(worldModel: WorldModel, _evidenceStore: EvidenceStore, hypothesisSet: HypothesisSet, abstractionContext?: AbstractionContext | null, beliefDepGraph?: BeliefDepGraph): void;
export interface ExternalContradictionInput {
    beliefIds: string[];
    description: string;
    severity?: Severity;
}
/**
 * Records a contradiction found by an external (e.g. LLM-based semantic) check — not one this
 * file's own lexical/negation-pair detectors found. Goes through the same push +
 * apply_resolution_policy pipeline as a lexically-detected one, so it gets identical treatment
 * (confidence decay, invalidation frontier, SYSTEM_BREAKING handling). Skips a group already
 * recorded (same involved_belief_ids, order-independent) so re-checking a belief set that
 * hasn't changed doesn't double-apply confidence decay for the same underlying conflict.
 */
export declare function recordExternalContradiction(worldModel: WorldModel, input: ExternalContradictionInput, beliefDepGraph?: BeliefDepGraph): Contradiction | null;
