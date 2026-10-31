import { z } from 'zod';
import { CallerState } from './caller-state.js';
export declare const OutputContractSchema: z.ZodObject<{
    format: z.ZodString;
    required_sections: z.ZodArray<z.ZodString, "many">;
    required_interface_fields: z.ZodArray<z.ZodString, "many">;
    interface_constraints: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    validation_rules: z.ZodArray<z.ZodString, "many">;
    caller_specific_constraints: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    format: string;
    required_sections: string[];
    required_interface_fields: string[];
    interface_constraints: Record<string, unknown>;
    validation_rules: string[];
    caller_specific_constraints: string[];
}, {
    format: string;
    required_sections: string[];
    required_interface_fields: string[];
    interface_constraints: Record<string, unknown>;
    validation_rules: string[];
    caller_specific_constraints: string[];
}>;
export type OutputContractData = z.infer<typeof OutputContractSchema>;
export declare class OutputContract {
    format: string;
    required_sections: string[];
    required_interface_fields: string[];
    interface_constraints: Record<string, unknown>;
    validation_rules: string[];
    caller_specific_constraints: string[];
    constructor(data?: Partial<OutputContractData>);
    toJSON(): OutputContractData;
    static fromJSON(json: OutputContractData): OutputContract;
}
/**
 * Matches adapter/harness/output_contract.py's update_output_contract(): re-derives
 * caller_specific_constraints from the caller's current constraints, and re-derives
 * required_interface_fields from any "required: <field>" constraint syntax.
 * Returns a new OutputContract (immutable update).
 *
 * Accepted as-is (the internal plan Phase 3 step 4): the "required:"
 * convention parsed here is a flow-designer-authored DSL syntax embedded in a constraint string,
 * not open-ended conversational input, so it's out of scope for this plan's actual concern
 * (understanding free-form human phrasing in any language).
 */
export declare function updateOutputContract(callerState: CallerState, outputContract: OutputContract): OutputContract;
