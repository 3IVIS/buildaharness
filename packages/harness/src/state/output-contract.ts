import { z } from 'zod'

export const OutputContractSchema = z.object({
  format: z.string(),
  required_sections: z.array(z.string()),
  interface_constraints: z.record(z.unknown()),
  validation_rules: z.array(z.string()),
  caller_specific_constraints: z.record(z.unknown()),
})
export type OutputContractData = z.infer<typeof OutputContractSchema>

export class OutputContract {
  format: string
  required_sections: string[]
  interface_constraints: Record<string, unknown>
  validation_rules: string[]
  caller_specific_constraints: Record<string, unknown>

  constructor(data?: Partial<OutputContractData>) {
    this.format = data?.format ?? 'text'
    this.required_sections = data?.required_sections ?? []
    this.interface_constraints = data?.interface_constraints ?? {}
    this.validation_rules = data?.validation_rules ?? []
    this.caller_specific_constraints = data?.caller_specific_constraints ?? {}
  }

  toJSON(): OutputContractData {
    return {
      format: this.format,
      required_sections: this.required_sections,
      interface_constraints: this.interface_constraints,
      validation_rules: this.validation_rules,
      caller_specific_constraints: this.caller_specific_constraints,
    }
  }

  static fromJSON(json: OutputContractData): OutputContract {
    const parsed = OutputContractSchema.parse(json)
    return new OutputContract(parsed)
  }
}
