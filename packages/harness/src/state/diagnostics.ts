import { z } from 'zod'

export const BeliefHealthSchema = z.object({
  freshness: z.number(),
  consistency: z.number(),
  support: z.number(),
})
export type BeliefHealth = z.infer<typeof BeliefHealthSchema>

export const CoverageHealthSchema = z.object({
  symptom_coverage: z.number(),
  explanation_coverage: z.number(),
})
export type CoverageHealth = z.infer<typeof CoverageHealthSchema>

export const VerificationHealthSchema = z.object({
  strength: z.number(),
  feasibility: z.number(),
})
export type VerificationHealth = z.infer<typeof VerificationHealthSchema>

export const ExecutionHealthSchema = z.object({
  progress_rate: z.number(),
  failure_recurrence: z.number(),
  oscillation_score: z.number(),
})
export type ExecutionHealth = z.infer<typeof ExecutionHealthSchema>

export const DiagnosticsSchema = z.object({
  belief_health: BeliefHealthSchema,
  coverage_health: CoverageHealthSchema,
  verification_health: VerificationHealthSchema,
  execution_health: ExecutionHealthSchema,
  dep_class_gap_annotation: z.string(),
})
export type DiagnosticsData = z.infer<typeof DiagnosticsSchema>

export class Diagnostics {
  belief_health: BeliefHealth
  coverage_health: CoverageHealth
  verification_health: VerificationHealth
  execution_health: ExecutionHealth
  dep_class_gap_annotation: string

  constructor(data?: Partial<DiagnosticsData>) {
    this.belief_health = data?.belief_health ?? { freshness: 1.0, consistency: 1.0, support: 1.0 }
    this.coverage_health = data?.coverage_health ?? { symptom_coverage: 0.5, explanation_coverage: 0.5 }
    this.verification_health = data?.verification_health ?? { strength: 1.0, feasibility: 1.0 }
    // failure_recurrence and oscillation_score: 0=healthy (inverted in resolveControlState)
    this.execution_health = data?.execution_health ?? { progress_rate: 1.0, failure_recurrence: 0.0, oscillation_score: 0.0 }
    this.dep_class_gap_annotation = data?.dep_class_gap_annotation ?? ''
  }

  toJSON(): DiagnosticsData {
    return {
      belief_health: this.belief_health,
      coverage_health: this.coverage_health,
      verification_health: this.verification_health,
      execution_health: this.execution_health,
      dep_class_gap_annotation: this.dep_class_gap_annotation,
    }
  }

  static fromJSON(json: DiagnosticsData): Diagnostics {
    const parsed = DiagnosticsSchema.parse(json)
    return new Diagnostics(parsed)
  }
}
