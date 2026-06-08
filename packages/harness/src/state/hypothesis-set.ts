import { z } from 'zod'

export const HypothesisSchema = z.object({
  id: z.string(),
  explanation: z.string(),
  confidence: z.number(),
  predicted_observations: z.array(z.string()),
  discriminating_evidence: z.array(z.string()),
  generation_sources: z.array(z.string()),
  diversity_score: z.number(),
})
export type Hypothesis = z.infer<typeof HypothesisSchema>

export const EliminationPolicySchema = z.object({
  conditions: z.array(z.string()),
  retention_k: z.number().int().positive(),
  floor: z.number(),
})
export type EliminationPolicy = z.infer<typeof EliminationPolicySchema>

export const HypothesisSetSchema = z.object({
  active: z.array(HypothesisSchema),
  eliminated: z.array(HypothesisSchema),
  elimination_policy: EliminationPolicySchema,
})
export type HypothesisSetData = z.infer<typeof HypothesisSetSchema>

export class HypothesisSet {
  active: Hypothesis[]
  eliminated: Hypothesis[]
  elimination_policy: EliminationPolicy

  constructor(data?: Partial<HypothesisSetData>) {
    this.active = data?.active ?? []
    this.eliminated = data?.eliminated ?? []
    this.elimination_policy = data?.elimination_policy ?? {
      conditions: ['contradicting_evidence', 'prediction_failure_count'],
      retention_k: 10,
      floor: 0.05,
    }
  }

  eliminate(hypothesis: Hypothesis): void {
    this.active = this.active.filter(h => h.id !== hypothesis.id)
    this.eliminated.push(hypothesis)
    if (this.eliminated.length > this.elimination_policy.retention_k) {
      this.eliminated.splice(0, this.eliminated.length - this.elimination_policy.retention_k)
    }
  }

  toJSON(): HypothesisSetData {
    return {
      active: this.active,
      eliminated: this.eliminated,
      elimination_policy: this.elimination_policy,
    }
  }

  static fromJSON(json: HypothesisSetData): HypothesisSet {
    const parsed = HypothesisSetSchema.parse(json)
    return new HypothesisSet(parsed)
  }
}
