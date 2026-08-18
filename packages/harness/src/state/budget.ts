import { z } from 'zod'

/**
 * Phase 7 of plans/harness_and_assistant_architecture_remediation_plan.html: a generic,
 * reusable resource budget, mirroring adapter/harness/recovery.py's RecoveryBudget shape
 * (four max_* caps + four *_used counters, isExhausted() as OR-of-thresholds, immutable —
 * consume() returns a new instance rather than mutating in place, so a caller can't
 * accidentally share/alias a budget across two unrelated objectives). Unlike RecoveryBudget,
 * which is scoped to the recovery layer specifically (tool calls/cost/time/plan revisions),
 * this type is deliberately domain-neutral (calls/cost/time/parallelism) so any caller —
 * batch-research today, other future harness consumers — can reuse it instead of hand-rolling
 * its own ad-hoc counter-plus-constant pair. Domain-specific calibration knobs (e.g.
 * batch-research's slack factor or large-projection threshold) have no analog here by design;
 * they stay as separate config passed alongside a Budget, not squeezed into it.
 */
export const BudgetSchema = z.object({
  maxCalls: z.number().nonnegative(),
  maxCost: z.number().nonnegative(),
  maxTime: z.number().nonnegative(),
  maxParallelism: z.number().nonnegative(),
  callsUsed: z.number().nonnegative(),
  costUsed: z.number().nonnegative(),
  timeUsed: z.number().nonnegative(),
  parallelismUsed: z.number().nonnegative(),
})
export type BudgetData = z.infer<typeof BudgetSchema>

export interface BudgetConsumption {
  calls?: number
  cost?: number
  time?: number
  parallelism?: number
}

export class Budget {
  readonly maxCalls: number
  readonly maxCost: number
  readonly maxTime: number
  readonly maxParallelism: number
  readonly callsUsed: number
  readonly costUsed: number
  readonly timeUsed: number
  readonly parallelismUsed: number

  constructor(data?: Partial<BudgetData>) {
    this.maxCalls = data?.maxCalls ?? Infinity
    this.maxCost = data?.maxCost ?? Infinity
    this.maxTime = data?.maxTime ?? Infinity
    this.maxParallelism = data?.maxParallelism ?? Infinity
    this.callsUsed = data?.callsUsed ?? 0
    this.costUsed = data?.costUsed ?? 0
    this.timeUsed = data?.timeUsed ?? 0
    this.parallelismUsed = data?.parallelismUsed ?? 0
  }

  /** Any single exhausted dimension exhausts the whole budget — same OR-of-thresholds rule
   * as RecoveryBudget.is_exhausted(), for the same reason: a budget generous on cost but out
   * of calls shouldn't be treated as still usable. */
  isExhausted(): boolean {
    return (
      this.callsUsed >= this.maxCalls ||
      this.costUsed >= this.maxCost ||
      this.timeUsed >= this.maxTime ||
      this.parallelismUsed >= this.maxParallelism
    )
  }

  /** Remaining room on one dimension, floored at 0 (never negative). */
  remaining(dimension: 'calls' | 'cost' | 'time' | 'parallelism'): number {
    switch (dimension) {
      case 'calls':
        return Math.max(0, this.maxCalls - this.callsUsed)
      case 'cost':
        return Math.max(0, this.maxCost - this.costUsed)
      case 'time':
        return Math.max(0, this.maxTime - this.timeUsed)
      case 'parallelism':
        return Math.max(0, this.maxParallelism - this.parallelismUsed)
    }
  }

  /** Returns a new Budget with the given deltas added to the used counters — immutable, like
   * RecoveryBudget.consume(). */
  consume(delta: BudgetConsumption): Budget {
    return new Budget({
      maxCalls: this.maxCalls,
      maxCost: this.maxCost,
      maxTime: this.maxTime,
      maxParallelism: this.maxParallelism,
      callsUsed: this.callsUsed + (delta.calls ?? 0),
      costUsed: this.costUsed + (delta.cost ?? 0),
      timeUsed: this.timeUsed + (delta.time ?? 0),
      parallelismUsed: this.parallelismUsed + (delta.parallelism ?? 0),
    })
  }

  toJSON(): BudgetData {
    return {
      maxCalls: this.maxCalls,
      maxCost: this.maxCost,
      maxTime: this.maxTime,
      maxParallelism: this.maxParallelism,
      callsUsed: this.callsUsed,
      costUsed: this.costUsed,
      timeUsed: this.timeUsed,
      parallelismUsed: this.parallelismUsed,
    }
  }

  static fromJSON(json: Partial<BudgetData>): Budget {
    return new Budget(json)
  }
}
