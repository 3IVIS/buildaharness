import { z } from 'zod'

export type RiskState = 'NORMAL' | 'CAUTIOUS' | 'BLOCKED'

export const BlockEntrySchema = z.object({
  dimension: z.string(),
  value: z.number(),
  recovery_action_class: z.string(),
})
export type BlockEntry = z.infer<typeof BlockEntrySchema>

export const ControlStateSchema = z.object({
  generation_id: z.number().int().nonnegative(),
  risk_state: z.enum(['NORMAL', 'CAUTIOUS', 'BLOCKED']),
  escalation_reason: z.string().nullable(),
  block_mask: z.array(BlockEntrySchema),
  notes: z.array(z.string()),
})
export type ControlStateData = z.infer<typeof ControlStateSchema>

export class ControlState {
  generation_id: number
  risk_state: RiskState
  escalation_reason: string | null
  block_mask: BlockEntry[]
  notes: string[]

  constructor(data?: Partial<ControlStateData>) {
    this.generation_id = data?.generation_id ?? 0
    this.risk_state = data?.risk_state ?? 'NORMAL'
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
      risk_state: this.risk_state,
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
