import { ControlState } from './state/control-state.js';
import { WorldModel } from './state/world-model.js';
import { Diagnostics } from './state/diagnostics.js';
import { FailureDiagnostics } from './state/failure-diagnostics.js';
export interface GateContext {
    subStepA: number;
    subStepB: number;
}
export declare class StalenessError extends Error {
    constructor(message: string);
}
export type ControlStateResolverFn = (diagnostics: Diagnostics, worldModel: WorldModel, failureDiagnostics: FailureDiagnostics) => ControlState;
export declare function _maybeResolve(controlState: ControlState, worldModel: WorldModel, diagnostics?: Diagnostics, failureDiagnostics?: FailureDiagnostics, resolver?: ControlStateResolverFn): void;
export declare function computeElevationFactor(subDims: number[]): number;
