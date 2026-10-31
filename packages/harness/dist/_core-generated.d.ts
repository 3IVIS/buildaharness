export declare const CRITICAL_THRESHOLD = 0.2;
export declare const CAUTION_THRESHOLD = 0.4;
export declare const EXECUTION_RATIO_MIN_ATTEMPTS = 3;
export declare const RECOVERY_ACTION_DEPENDENCIES: Record<string, string[]>;
export declare const DIMENSION_RECOVERY: Record<string, string>;
export declare const SUB_DIMENSION_ORDER: readonly string[];
export declare const CONFIDENCE_DIMENSIONS: ReadonlySet<string>;
export declare const RISK_DIMENSIONS: ReadonlySet<string>;
export type LayerTier = 'mechanical' | 'environmental' | 'model';
export declare const LAYER_TIER: Record<string, LayerTier>;
export declare const DEP_CLASS_GAP_NOTE_PREFIX = "dep_class_gap: ";
export declare const MODEL_PROVENANCE_NOTE_PREFIX = "provenance: uncalibrated model-derived value drove block on ";
export interface RecoveryClassification {
    policy: string;
    action: string;
}
export declare const RECOVERY_CLASSIFICATION_TABLE: Record<string, RecoveryClassification>;
