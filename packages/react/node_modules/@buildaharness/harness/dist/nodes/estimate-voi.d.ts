import { WorldModel } from '../state/world-model.js';
import { Diagnostics } from '../state/diagnostics.js';
import { HypothesisSet } from '../state/hypothesis-set.js';
import { ToolAvailability } from '../state/evidence-store.js';
export type ToolAvailabilityManifest = Record<string, ToolAvailability>;
export interface VOIResult {
    voi: number;
    should_gather_evidence: boolean;
    adequacy_shortfall: number;
    adequacy_unresolvable: boolean;
    updated_verification_strength: number | null;
}
export declare function estimateVOI(diagnostics: Diagnostics, _worldModel: WorldModel, hypothesisSet: HypothesisSet, toolAvailabilityManifest: ToolAvailabilityManifest): VOIResult;
