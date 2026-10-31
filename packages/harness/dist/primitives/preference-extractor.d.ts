export interface PreferenceSignal {
    patterns: string[];
    field: string;
    value?: unknown;
    delta?: number;
    minValue?: number;
    maxValue?: number;
}
export declare function makePreferenceExtractor(signals: PreferenceSignal[], options?: {
    inputKey?: string;
    outputKey?: string;
    processedFlagKey?: string;
}): (state: Record<string, unknown>) => Record<string, unknown>;
