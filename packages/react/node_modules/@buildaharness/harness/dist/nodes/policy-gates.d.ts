import { WorldModel } from '../state/world-model.js';
import { Diagnostics } from '../state/diagnostics.js';
import { FailureDiagnostics } from '../state/failure-diagnostics.js';
import { OutputContract } from '../state/output-contract.js';
import { ControlState } from '../state/control-state.js';
import { ControlStateResolverFn } from '../generation-id.js';
export type ActionGateResult = 'PASS' | 'BLOCK' | 'ESCALATE';
export interface GatedAction {
    required_resources?: string[];
}
export interface VerificationSummary {
    has_critical_failure: boolean;
}
export interface ContractShadowCheckResult {
    passed: boolean;
    violations: string[];
}
export declare function contractShadowCheck(result: unknown, outputContract: OutputContract | null): ContractShadowCheckResult;
export declare function actionGate(action: GatedAction | null, controlState: ControlState, worldModel: WorldModel, diagnostics?: Diagnostics, failureDiagnostics?: FailureDiagnostics, resolver?: ControlStateResolverFn): ActionGateResult;
export declare function postExecGate(result: unknown, verification: VerificationSummary, controlState: ControlState, worldModel: WorldModel, diagnostics?: Diagnostics, failureDiagnostics?: FailureDiagnostics, outputContract?: OutputContract | null, resolver?: ControlStateResolverFn): boolean;
