import { z } from 'zod';
export type RiskState = 'NORMAL' | 'CAUTIOUS' | 'BLOCKED';
export type PermissionDecision = 'ALLOW' | 'DENY';
export type ExecutionMode = 'NORMAL' | 'CAUTIOUS' | 'RECOVERY';
export type EscalationDecision = 'NONE' | 'HUMAN_REQUIRED' | 'SYSTEM_BREAKING';
export declare const BlockEntrySchema: z.ZodObject<{
    dimension: z.ZodString;
    value: z.ZodNumber;
    recovery_action_class: z.ZodString;
}, "strip", z.ZodTypeAny, {
    value: number;
    dimension: string;
    recovery_action_class: string;
}, {
    value: number;
    dimension: string;
    recovery_action_class: string;
}>;
export type BlockEntry = z.infer<typeof BlockEntrySchema>;
export declare const ControlStateSchema: z.ZodObject<{
    generation_id: z.ZodNumber;
    permission: z.ZodEnum<["ALLOW", "DENY"]>;
    execution_mode: z.ZodEnum<["NORMAL", "CAUTIOUS", "RECOVERY"]>;
    escalation: z.ZodEnum<["NONE", "HUMAN_REQUIRED", "SYSTEM_BREAKING"]>;
    risk_estimate: z.ZodNumber;
    confidence_estimate: z.ZodNumber;
    escalation_reason: z.ZodNullable<z.ZodString>;
    block_mask: z.ZodArray<z.ZodObject<{
        dimension: z.ZodString;
        value: z.ZodNumber;
        recovery_action_class: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        value: number;
        dimension: string;
        recovery_action_class: string;
    }, {
        value: number;
        dimension: string;
        recovery_action_class: string;
    }>, "many">;
    notes: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    generation_id: number;
    permission: "ALLOW" | "DENY";
    execution_mode: "NORMAL" | "CAUTIOUS" | "RECOVERY";
    escalation: "SYSTEM_BREAKING" | "NONE" | "HUMAN_REQUIRED";
    risk_estimate: number;
    confidence_estimate: number;
    escalation_reason: string | null;
    block_mask: {
        value: number;
        dimension: string;
        recovery_action_class: string;
    }[];
    notes: string[];
}, {
    generation_id: number;
    permission: "ALLOW" | "DENY";
    execution_mode: "NORMAL" | "CAUTIOUS" | "RECOVERY";
    escalation: "SYSTEM_BREAKING" | "NONE" | "HUMAN_REQUIRED";
    risk_estimate: number;
    confidence_estimate: number;
    escalation_reason: string | null;
    block_mask: {
        value: number;
        dimension: string;
        recovery_action_class: string;
    }[];
    notes: string[];
}>;
export type ControlStateData = z.infer<typeof ControlStateSchema>;
export declare class ControlState {
    generation_id: number;
    permission: PermissionDecision;
    execution_mode: ExecutionMode;
    escalation: EscalationDecision;
    risk_estimate: number;
    confidence_estimate: number;
    escalation_reason: string | null;
    block_mask: BlockEntry[];
    notes: string[];
    constructor(data?: Partial<ControlStateData>);
    stampGenerationId(worldModelGenerationId: number): void;
    toJSON(): ControlStateData;
    static fromJSON(json: ControlStateData): ControlState;
}
/** Derives the old three-way NORMAL/CAUTIOUS/BLOCKED reading from the split fields — used
 * only where a caller still genuinely needs that shape (today: strategyState.risk_state_history's
 * oscillation-detection proxy). Mirrors control_state.py's risk_summary() exactly. */
export declare function riskSummary(cs: ControlState): RiskState;
