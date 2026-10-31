import { OutputContract } from '../state/output-contract.js';
import { CallerState } from '../state/caller-state.js';
export declare class OutputContractError extends Error {
    violatedDimension: string;
    violations: string[];
    constructor(violatedDimension: string, violations: string[]);
}
export interface OutputValidationResult {
    passed: boolean;
    violations: string[];
}
export interface OutputValidationOptions {
    /**
     * Skip the lexical `caller_specific_constraints` word match. Set when the host judges the constraints itself
     * (`semanticConstraintJudge`): that match fires on a reply that merely mentions the constraint's subject
     * ("I will not use tabs" against "do not use tabs"), and it throws.
     */
    skipCallerConstraints?: boolean;
}
export declare function outputValidation(finalResult: unknown, outputContract: OutputContract, callerState: CallerState, options?: OutputValidationOptions): OutputValidationResult;
