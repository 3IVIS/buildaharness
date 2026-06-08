import { z } from 'zod'

export const ClarificationEntrySchema = z.object({
  timestamp: z.string(),
  question: z.string(),
  answer: z.string(),
})
export type ClarificationEntry = z.infer<typeof ClarificationEntrySchema>

export const CallerStateSchema = z.object({
  current_constraints: z.record(z.unknown()),
  clarification_history: z.array(ClarificationEntrySchema),
  last_update: z.string(),
  output_preferences: z.record(z.unknown()),
  success_criteria: z.array(z.string()),
  constraints_changed: z.boolean(),
})
export type CallerStateData = z.infer<typeof CallerStateSchema>

export class CallerState {
  current_constraints: Record<string, unknown>
  clarification_history: ClarificationEntry[]
  last_update: string
  output_preferences: Record<string, unknown>
  success_criteria: string[]
  constraints_changed: boolean

  constructor(data?: Partial<CallerStateData>) {
    this.current_constraints = data?.current_constraints ?? {}
    this.clarification_history = data?.clarification_history ?? []
    this.last_update = data?.last_update ?? new Date().toISOString()
    this.output_preferences = data?.output_preferences ?? {}
    this.success_criteria = data?.success_criteria ?? []
    this.constraints_changed = data?.constraints_changed ?? false
  }

  updateConstraints(newConstraints: Record<string, unknown>): void {
    this.current_constraints = { ...this.current_constraints, ...newConstraints }
    this.constraints_changed = true
    this.last_update = new Date().toISOString()
  }

  resetConstraintsChanged(): void {
    this.constraints_changed = false
  }

  toJSON(): CallerStateData {
    return {
      current_constraints: this.current_constraints,
      clarification_history: this.clarification_history,
      last_update: this.last_update,
      output_preferences: this.output_preferences,
      success_criteria: this.success_criteria,
      constraints_changed: this.constraints_changed,
    }
  }

  static fromJSON(json: CallerStateData): CallerState {
    const parsed = CallerStateSchema.parse(json)
    return new CallerState(parsed)
  }
}
