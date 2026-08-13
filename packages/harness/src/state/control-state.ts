import { z } from 'zod'

// Phase 3 of plans/harness_and_assistant_architecture_remediation_plan.html ports Python's
// Phase 1a split (adapter/harness/control_state.py) forward: the old single
// `risk_state: NORMAL/CAUTIOUS/BLOCKED` field is replaced by five distinct concepts —
// permission (authoritative ALLOW/DENY), execution_mode (a caution label independent of
// permission), escalation (a structured category distinct from the free-text
// escalation_reason detail string), and two continuous [0,1] scores (risk_estimate,
// confidence_estimate) computed from disjoint sub-dimension pools. See control_state.py's
// module docstring for the full rationale — this is a field-for-field port, not a
// reinterpretation.
export type RiskState = 'NORMAL' | 'CAUTIOUS' | 'BLOCKED'
export type PermissionDecision = 'ALLOW' | 'DENY'
export type ExecutionMode = 'NORMAL' | 'CAUTIOUS' | 'RECOVERY'
export type EscalationDecision = 'NONE' | 'HUMAN_REQUIRED' | 'SYSTEM_BREAKING'

export const BlockEntrySchema = z.object({
  dimension: z.string(),
  value: z.number(),
  recovery_action_class: z.string(),
})
export type BlockEntry = z.infer<typeof BlockEntrySchema>

export const ControlStateSchema = z.object({
  generation_id: z.number().int().nonnegative(),
  permission: z.enum(['ALLOW', 'DENY']),
  execution_mode: z.enum(['NORMAL', 'CAUTIOUS', 'RECOVERY']),
  escalation: z.enum(['NONE', 'HUMAN_REQUIRED', 'SYSTEM_BREAKING']),
  risk_estimate: z.number().min(0).max(1),
  confidence_estimate: z.number().min(0).max(1),
  escalation_reason: z.string().nullable(),
  block_mask: z.array(BlockEntrySchema),
  notes: z.array(z.string()),
})
export type ControlStateData = z.infer<typeof ControlStateSchema>

export class ControlState {
  generation_id: number
  permission: PermissionDecision
  execution_mode: ExecutionMode
  escalation: EscalationDecision
  risk_estimate: number
  confidence_estimate: number
  escalation_reason: string | null
  block_mask: BlockEntry[]
  notes: string[]

  constructor(data?: Partial<ControlStateData>) {
    this.generation_id = data?.generation_id ?? 0
    this.permission = data?.permission ?? 'ALLOW'
    this.execution_mode = data?.execution_mode ?? 'NORMAL'
    this.escalation = data?.escalation ?? 'NONE'
    this.risk_estimate = data?.risk_estimate ?? 0.0
    this.confidence_estimate = data?.confidence_estimate ?? 1.0
    this.escalation_reason = data?.escalation_reason ?? null
    this.block_mask = data?.block_mask ?? []
    this.notes = data?.notes ?? []
  }

  stampGenerationId(worldModelGenerationId: number): void {
    this.generation_id = worldModelGenerationId
  }

  toJSON(): ControlStateData {
    return {
      generation_id: this.generation_id,
      permission: this.permission,
      execution_mode: this.execution_mode,
      escalation: this.escalation,
      risk_estimate: this.risk_estimate,
      confidence_estimate: this.confidence_estimate,
      escalation_reason: this.escalation_reason,
      block_mask: this.block_mask,
      notes: this.notes,
    }
  }

  static fromJSON(json: ControlStateData): ControlState {
    const parsed = ControlStateSchema.parse(json)
    return new ControlState(parsed)
  }
}

/** Derives the old three-way NORMAL/CAUTIOUS/BLOCKED reading from the split fields — used
 * only where a caller still genuinely needs that shape (today: strategyState.risk_state_history's
 * oscillation-detection proxy). Mirrors control_state.py's risk_summary() exactly. */
export function riskSummary(cs: ControlState): RiskState {
  if (cs.permission === 'DENY') return 'BLOCKED'
  if (cs.execution_mode === 'CAUTIOUS') return 'CAUTIOUS'
  return 'NORMAL'
}
