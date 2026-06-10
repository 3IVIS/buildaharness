import { z } from 'zod'

export const StrategyTypeSchema = z.enum([
  'DIRECT_EDIT', 'TRACE_EXEC', 'BROADER_SEARCH', 'REIMPLEMENT', 'MINIMAL_FIX', 'ESCALATE',
])
export type StrategyType = z.infer<typeof StrategyTypeSchema>

export const DEFAULT_STRATEGY_ORDER: StrategyType[] = [
  'DIRECT_EDIT', 'TRACE_EXEC', 'BROADER_SEARCH', 'REIMPLEMENT', 'MINIMAL_FIX', 'ESCALATE',
]

function makeFlatWeights(): Record<string, number> {
  const w = 1 / DEFAULT_STRATEGY_ORDER.length
  return Object.fromEntries(DEFAULT_STRATEGY_ORDER.map(s => [s, w]))
}

export const StrategyStateSchema = z.object({
  current_strategy: StrategyTypeSchema,
  switch_triggers: z.array(z.string()),
  prior_strategy_weights: z.record(z.number()),
  recovery_strategy_order: z.array(StrategyTypeSchema),
  switch_count: z.number().int().nonnegative(),
  stall_reason: z.string().nullable(),
  completion_history: z.array(z.number().int().nonnegative()),
  risk_state_history: z.array(z.string()),
})
export type StrategyStateData = z.infer<typeof StrategyStateSchema>

export class StrategyState {
  current_strategy: StrategyType
  switch_triggers: string[]
  prior_strategy_weights: Record<string, number>
  recovery_strategy_order: StrategyType[]
  switch_count: number
  stall_reason: string | null
  /** Running count of completed tasks recorded each iteration — used by cannot_make_progress() proxy 1. */
  completion_history: number[]
  /** Risk state string recorded each iteration — used by cannot_make_progress() proxy 4. */
  risk_state_history: string[]

  constructor(data?: Partial<StrategyStateData>) {
    this.current_strategy = data?.current_strategy ?? 'DIRECT_EDIT'
    this.switch_triggers = data?.switch_triggers ?? []
    this.prior_strategy_weights = data?.prior_strategy_weights ?? makeFlatWeights()
    this.recovery_strategy_order = data?.recovery_strategy_order ?? [...DEFAULT_STRATEGY_ORDER]
    this.switch_count = data?.switch_count ?? 0
    this.stall_reason = data?.stall_reason ?? null
    this.completion_history = data?.completion_history ?? []
    this.risk_state_history = data?.risk_state_history ?? []
  }

  toJSON(): StrategyStateData {
    return {
      current_strategy: this.current_strategy,
      switch_triggers: this.switch_triggers,
      prior_strategy_weights: this.prior_strategy_weights,
      recovery_strategy_order: this.recovery_strategy_order,
      switch_count: this.switch_count,
      stall_reason: this.stall_reason,
      completion_history: this.completion_history,
      risk_state_history: this.risk_state_history,
    }
  }

  static fromJSON(json: StrategyStateData): StrategyState {
    const parsed = StrategyStateSchema.parse(json)
    return new StrategyState(parsed)
  }
}
