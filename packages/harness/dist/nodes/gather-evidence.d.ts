import { Evidence, EvidenceStore, Reliability } from '../state/evidence-store.js';
export interface GatherEvidenceInput {
    id: string;
    obs: string;
    source: string;
    evidence_type: 'OBSERVATION' | 'INFERENCE' | 'SYSTEM_ERROR';
    freshness?: string;
    reliability?: Reliability;
}
export declare function gatherEvidence(input: GatherEvidenceInput, evidenceStore: EvidenceStore, onWarning?: (message: string) => void): Evidence | undefined;
