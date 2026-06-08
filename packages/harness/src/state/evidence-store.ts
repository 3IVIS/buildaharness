import { z } from 'zod'

export const EvidenceTypeSchema = z.enum(['OBSERVATION', 'INFERENCE', 'SYSTEM_ERROR'])
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>

export const ReliabilitySchema = z.enum(['HIGH', 'MEDIUM', 'LOW'])
export type Reliability = z.infer<typeof ReliabilitySchema>

export const EvidenceSchema = z.object({
  id: z.string(),
  obs: z.string(),
  reliability: ReliabilitySchema,
  source: z.string(),
  evidence_type: EvidenceTypeSchema,
  freshness: z.string(),
})
export type Evidence = z.infer<typeof EvidenceSchema>

export const ToolReliabilityEnvelopeSchema = z.object({
  tool: z.string(),
  max_observation_reliability: ReliabilitySchema,
  max_conclusion_reliability: ReliabilitySchema,
})
export type ToolReliabilityEnvelope = z.infer<typeof ToolReliabilityEnvelopeSchema>

export const ToolAvailabilitySchema = z.object({
  available: z.boolean(),
  fallback_tool: z.string().nullable(),
})
export type ToolAvailability = z.infer<typeof ToolAvailabilitySchema>

export const EvidenceStoreSchema = z.object({
  observations: z.array(EvidenceSchema),
  tool_reliability_envelopes: z.record(ToolReliabilityEnvelopeSchema),
  tool_availability_manifest: z.record(ToolAvailabilitySchema),
})
export type EvidenceStoreData = z.infer<typeof EvidenceStoreSchema>

export class EvidenceStore {
  observations: Evidence[]
  tool_reliability_envelopes: Record<string, ToolReliabilityEnvelope>
  tool_availability_manifest: Record<string, ToolAvailability>

  constructor(data?: Partial<EvidenceStoreData>) {
    this.observations = data?.observations ?? []
    this.tool_reliability_envelopes = data?.tool_reliability_envelopes ?? {}
    this.tool_availability_manifest = data?.tool_availability_manifest ?? {}
  }

  addObservation(evidence: Evidence): void {
    this.observations.push(evidence)
  }

  isToolAvailable(toolName: string): boolean {
    return this.tool_availability_manifest[toolName]?.available ?? false
  }

  toJSON(): EvidenceStoreData {
    return {
      observations: this.observations,
      tool_reliability_envelopes: this.tool_reliability_envelopes,
      tool_availability_manifest: this.tool_availability_manifest,
    }
  }

  static fromJSON(json: EvidenceStoreData): EvidenceStore {
    const parsed = EvidenceStoreSchema.parse(json)
    return new EvidenceStore(parsed)
  }
}
