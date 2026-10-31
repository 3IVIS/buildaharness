import { HarnessRunOptions } from '../harness-runtime.js';
export declare const HARNESS_BASELINE_VERSION = 1;
export interface HarnessRunRecord {
    scenario: string;
    category: string;
    status: string;
    finalResult: unknown;
    stepsUsed: number | null;
    nodeExecutionOrder: string[];
    layerActivity: Array<{
        layer: string;
        fired: boolean;
        reason: string;
    }>;
    callCounts: Record<string, number>;
    outputValidation: unknown;
    threw?: string;
}
export interface HarnessStaticBaseline {
    version: number;
    runs: HarnessRunRecord[];
}
interface Scenario {
    id: string;
    category: string;
    objective: string;
    criteria: string[];
    build: (counts: Record<string, number>) => Partial<HarnessRunOptions>;
    /** Pause after this many iterations, then resume from the checkpoint (multi-turn resume). */
    pauseAfter?: number;
}
export declare const HARNESS_SCENARIOS: Scenario[];
export declare function runHarnessStaticBaseline(): Promise<HarnessStaticBaseline>;
export declare function serializeHarnessBaseline(b: HarnessStaticBaseline): string;
/**
 * Decides what the golden script does. A differing baseline is only ever rewritten when
 * `update` (the explicit `--update-golden` flag) is set; otherwise it is reported as a mismatch.
 */
export declare function reconcileGolden(existing: string | undefined, actual: string, update: boolean): {
    ok: boolean;
    write: boolean;
};
export {};
