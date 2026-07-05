import { z } from 'zod'
import type { CallerState } from './caller-state.js'

export const OutputContractSchema = z.object({
  format: z.string(),
  required_sections: z.array(z.string()),
  required_interface_fields: z.array(z.string()),
  interface_constraints: z.record(z.unknown()),
  validation_rules: z.array(z.string()),
  caller_specific_constraints: z.array(z.string()),
})
export type OutputContractData = z.infer<typeof OutputContractSchema>

export class OutputContract {
  format: string
  required_sections: string[]
  required_interface_fields: string[]
  interface_constraints: Record<string, unknown>
  validation_rules: string[]
  caller_specific_constraints: string[]

  constructor(data?: Partial<OutputContractData>) {
    this.format = data?.format ?? 'text'
    this.required_sections = data?.required_sections ?? []
    this.required_interface_fields = data?.required_interface_fields ?? []
    this.interface_constraints = data?.interface_constraints ?? {}
    this.validation_rules = data?.validation_rules ?? []
    this.caller_specific_constraints = data?.caller_specific_constraints ?? []
  }

  toJSON(): OutputContractData {
    return {
      format: this.format,
      required_sections: this.required_sections,
      required_interface_fields: this.required_interface_fields,
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

/**
 * Matches adapter/harness/output_contract.py's update_output_contract(): re-derives
 * caller_specific_constraints from the caller's current constraints, and re-derives
 * required_interface_fields from any "required: <field>" constraint syntax.
 * Returns a new OutputContract (immutable update).
 */
export function updateOutputContract(callerState: CallerState, outputContract: OutputContract): OutputContract {
  const newConstraints = [...callerState.current_constraints]

  const requiredFields = [...outputContract.required_interface_fields]
  for (const constraint of newConstraints) {
    const lower = constraint.toLowerCase()
    if (lower.includes('required:')) {
      const parts = constraint.split(':')
      if (parts.length > 1) {
        const rest = parts.slice(1).join(':').trim()
        const fieldCandidate = rest.split(/\s+/)[0]?.replace(/^['"]|['"]$/g, '')
        if (fieldCandidate && !requiredFields.includes(fieldCandidate)) {
          requiredFields.push(fieldCandidate)
        }
      }
    }
  }

  return new OutputContract({
    format: outputContract.format,
    required_sections: [...outputContract.required_sections],
    required_interface_fields: requiredFields,
    interface_constraints: { ...outputContract.interface_constraints },
    validation_rules: [...outputContract.validation_rules],
    caller_specific_constraints: newConstraints,
  })
}
