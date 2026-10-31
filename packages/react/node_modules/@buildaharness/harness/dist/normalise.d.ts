export declare enum DimensionType {
    ratio = "ratio",
    composite = "composite",
    entropy = "entropy",
    match_confidence = "match_confidence"
}
export declare class NormalisationError extends Error {
    constructor(message: string);
}
export type CompositeInput = {
    components: number[];
    weights: number[];
};
export type NormaliseInput = number | CompositeInput | number[];
export declare function normalise(raw: NormaliseInput, type: DimensionType): number;
export declare function assertNormalised(value: number, label: string): void;
