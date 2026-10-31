/**
 * G-1 — StrategyBlendEngine
 *
 * Configurable, momentum-bounded strategy weight distribution engine.
 * Port of adapter/harness/blend_engine.py. No domain vocabulary.
 */
export interface BlendRule {
    condition: (state: Record<string, unknown>) => boolean;
    adjustments: Record<string, number>;
    redistributeTo?: string[];
    styleOverride?: string;
}
export declare function normalizeBlend(blend: Record<string, number>): Record<string, number>;
export declare function makeBlendAdjuster(rules: BlendRule[], blendKey?: string, momentumCap?: number): (state: Record<string, unknown>) => Record<string, unknown>;
