export type ReliabilityLevel = 'HIGH' | 'MEDIUM' | 'LOW';
export interface BranchConfig {
    stateKey: string;
    sourceLabel: string;
    reliability: ReliabilityLevel;
    internalOnly?: boolean;
    reliabilityFn?: (item: unknown) => ReliabilityLevel;
}
export declare function jaccardSimilarity(textA: string, textB: string): number;
export declare function makeMultiSourceReducer(branches: BranchConfig[], itemTextFn: (item: unknown) => string, options?: {
    similarityThreshold?: number;
    minDiversityCount?: number;
    outputKey?: string;
    diversityWarningKey?: string;
}): (branchStates: Record<string, unknown>[]) => Record<string, unknown>;
