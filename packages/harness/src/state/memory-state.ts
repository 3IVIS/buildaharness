import { z } from 'zod'

export const StructureSchema = z.object({
  id: z.string(),
  description: z.string(),
  token_count: z.number().int().nonnegative(),
})
export type Structure = z.infer<typeof StructureSchema>

export const PrunedRegionSchema = z.object({
  id: z.string(),
  description: z.string(),
  token_count: z.number().int().nonnegative(),
  pruned_at: z.string(),
})
export type PrunedRegion = z.infer<typeof PrunedRegionSchema>

export const CompressionRiskSchema = z.object({
  compressed_structures: z.array(StructureSchema),
  pruned_regions: z.array(PrunedRegionSchema),
  dependent_tasks: z.array(z.string()),
})
export type CompressionRisk = z.infer<typeof CompressionRiskSchema>

export const TokenBudgetSchema = z.object({
  total: z.number().int().positive(),
  used: z.number().int().nonnegative(),
})
export type TokenBudget = z.infer<typeof TokenBudgetSchema>

export const JournalEntrySchema = z.object({
  step: z.number().int().nonnegative(),
  action_class: z.string(),
  outcome: z.string(),
  verbatim: z.string().optional(),
  success: z.boolean(),
})
export type JournalEntry = z.infer<typeof JournalEntrySchema>

export const JournalRetentionPolicySchema = z.object({
  retain_failures_permanently: z.boolean(),
  max_passing_verbatim: z.number().int().nonnegative(),
  compress_older_passing: z.boolean(),
})
export type JournalRetentionPolicy = z.infer<typeof JournalRetentionPolicySchema>

export const RollbackPointSchema = z.object({
  id: z.string(),
  step: z.number().int().nonnegative(),
  description: z.string(),
  serialised_state: z.string(),
})
export type RollbackPoint = z.infer<typeof RollbackPointSchema>

export const MemoryStateSchema = z.object({
  token_budget: TokenBudgetSchema,
  compression_risk: CompressionRiskSchema,
  journal: z.array(JournalEntrySchema),
  journal_retention_policy: JournalRetentionPolicySchema,
  rollback_points: z.array(RollbackPointSchema),
  max_steps: z.number().int().positive(),
})
export type MemoryStateData = z.infer<typeof MemoryStateSchema>

export class MemoryState {
  token_budget: TokenBudget
  compression_risk: CompressionRisk
  journal: JournalEntry[]
  journal_retention_policy: JournalRetentionPolicy
  rollback_points: RollbackPoint[]
  max_steps: number

  constructor(data?: Partial<MemoryStateData>) {
    this.token_budget = data?.token_budget ?? { total: 200000, used: 0 }
    this.compression_risk = data?.compression_risk ?? {
      compressed_structures: [],
      pruned_regions: [],
      dependent_tasks: [],
    }
    this.journal = data?.journal ?? []
    this.journal_retention_policy = data?.journal_retention_policy ?? {
      retain_failures_permanently: true,
      max_passing_verbatim: 20,
      compress_older_passing: true,
    }
    this.rollback_points = data?.rollback_points ?? []
    this.max_steps = data?.max_steps ?? 100
  }

  action_dep_overlap(actionWriteDomains: string[]): boolean {
    const structureIds = new Set(this.compression_risk.compressed_structures.map(s => s.id))
    const prunedIds = new Set(this.compression_risk.pruned_regions.map(r => r.id))
    return actionWriteDomains.some(d => structureIds.has(d) || prunedIds.has(d))
  }

  toJSON(): MemoryStateData {
    return {
      token_budget: this.token_budget,
      compression_risk: this.compression_risk,
      journal: this.journal,
      journal_retention_policy: this.journal_retention_policy,
      rollback_points: this.rollback_points,
      max_steps: this.max_steps,
    }
  }

  static fromJSON(json: MemoryStateData): MemoryState {
    const parsed = MemoryStateSchema.parse(json)
    return new MemoryState(parsed)
  }
}
