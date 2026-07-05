import { z } from 'zod'

export const CallerStateSchema = z.object({
  current_constraints: z.array(z.string()),
  clarification_history: z.array(z.record(z.unknown())),
  last_update: z.string(),
  output_preferences: z.record(z.unknown()),
  success_criteria: z.array(z.string()),
  constraints_changed: z.boolean(),
  escalation_pending: z.boolean(),
  pending_clarification: z.record(z.unknown()).nullable(),
})
export type CallerStateData = z.infer<typeof CallerStateSchema>

export class CallerState {
  current_constraints: string[]
  clarification_history: Record<string, unknown>[]
  last_update: string
  output_preferences: Record<string, unknown>
  success_criteria: string[]
  constraints_changed: boolean
  escalation_pending: boolean
  pending_clarification: Record<string, unknown> | null

  constructor(data?: Partial<CallerStateData>) {
    this.current_constraints = data?.current_constraints ?? []
    this.clarification_history = data?.clarification_history ?? []
    this.last_update = data?.last_update ?? new Date().toISOString()
    this.output_preferences = data?.output_preferences ?? {}
    this.success_criteria = data?.success_criteria ?? []
    this.constraints_changed = data?.constraints_changed ?? false
    this.escalation_pending = data?.escalation_pending ?? false
    this.pending_clarification = data?.pending_clarification ?? null
  }

  /**
   * Matches adapter/harness/caller_state.py's inject_clarification(): the single write
   * path for caller updates. Always appends the raw update to clarification_history
   * (never truncated); current_constraints/success_criteria are replaced wholesale
   * when present, output_preferences is merged.
   */
  updateConstraints(update: Record<string, unknown>): void {
    this.clarification_history.push({ ...update })

    if ('current_constraints' in update) {
      this.current_constraints = [...(update.current_constraints as string[])]
    }
    if ('output_preferences' in update) {
      this.output_preferences = { ...this.output_preferences, ...(update.output_preferences as Record<string, unknown>) }
    }
    if ('success_criteria' in update) {
      this.success_criteria = [...(update.success_criteria as string[])]
    }

    this.last_update = new Date().toISOString()
    this.constraints_changed = true
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
      escalation_pending: this.escalation_pending,
      pending_clarification: this.pending_clarification,
    }
  }

  static fromJSON(json: CallerStateData): CallerState {
    const parsed = CallerStateSchema.parse(json)
    return new CallerState(parsed)
  }
}

interface BeliefLike {
  id: string
  statement: string
}

interface WorldModelLike {
  beliefs: BeliefLike[]
  stale_flags: Record<string, boolean>
}

/**
 * Matches adapter/harness/caller_state.py's update_success_criteria(): flags beliefs
 * stale (never deletes) when their statement shares no token with any success criterion.
 */
export function updateSuccessCriteria(callerState: CallerState, worldModel: WorldModelLike): void {
  if (callerState.success_criteria.length === 0) return

  const criteriaTokens = new Set<string>()
  for (const criterion of callerState.success_criteria) {
    for (const tok of criterion.toLowerCase().split(/\s+/)) criteriaTokens.add(tok)
  }

  for (const belief of worldModel.beliefs) {
    const statementTokens = new Set(belief.statement.toLowerCase().split(/\s+/))
    const overlaps = [...statementTokens].some(t => criteriaTokens.has(t))
    if (!overlaps) {
      worldModel.stale_flags[belief.id] = true
    }
  }
}
