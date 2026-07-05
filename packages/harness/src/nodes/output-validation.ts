import type { OutputContract } from '../state/output-contract.js'
import type { CallerState } from '../state/caller-state.js'

export class OutputContractError extends Error {
  violatedDimension: string
  violations: string[]

  constructor(violatedDimension: string, violations: string[]) {
    super(`Output contract violation in "${violatedDimension}": ${violations.join('; ')}`)
    this.name = 'OutputContractError'
    this.violatedDimension = violatedDimension
    this.violations = violations
  }
}

export interface OutputValidationResult {
  passed: boolean
  violations: string[]
}

export function outputValidation(
  finalResult: unknown,
  outputContract: OutputContract,
  callerState: CallerState,
): OutputValidationResult {
  const violations: string[] = []

  const result = (typeof finalResult === 'object' && finalResult !== null)
    ? finalResult as Record<string, unknown>
    : {}

  // Check format requirements
  if (outputContract.format && outputContract.format !== 'any') {
    if (typeof finalResult === 'string' && outputContract.format === 'json') {
      try {
        JSON.parse(finalResult)
      } catch {
        violations.push(`format: expected JSON, got non-parseable string`)
      }
    }
  }

  // Check required_sections — authoritative pass supersedes contract_shadow_check()
  for (const section of outputContract.required_sections) {
    if (!(section in result)) {
      violations.push(`required_sections: missing field "${section}"`)
    }
  }

  // Check interface_constraints
  for (const [key, expected] of Object.entries(outputContract.interface_constraints)) {
    if (key in result && result[key] !== expected) {
      violations.push(`interface_constraints: field "${key}" expected ${String(expected)}, got ${String(result[key])}`)
    }
  }

  // Check validation_rules (string predicates — check field presence by convention)
  for (const rule of outputContract.validation_rules) {
    // Rules expressed as "field:condition" or plain field names
    const colonIdx = rule.indexOf(':')
    if (colonIdx > 0) {
      const field = rule.slice(0, colonIdx).trim()
      if (!(field in result)) {
        violations.push(`validation_rules: rule "${rule}" references missing field "${field}"`)
      }
    }
  }

  // Check caller_specific_constraints against the live caller_state.current_constraints
  // (may differ from init if updated mid-run) — matches output_contract.py's
  // check_caller_specific_constraints(): a "must not/never/no/without/exclude" constraint
  // is violated when its subject (the words following the negation keyword) shows up in the result.
  const NEGATION_KEYWORDS = ['not', 'never', 'no', 'without', 'exclude', 'must not']
  const resultText = (
    (typeof finalResult === 'string' ? finalResult : '') + ' ' +
    Object.values(result).map(v => String(v)).join(' ')
  ).toLowerCase()

  for (const constraint of callerState.current_constraints) {
    const constraintLower = constraint.toLowerCase()
    const constraintTokens = new Set(constraintLower.split(/\s+/))
    if (![...constraintTokens].some(t => NEGATION_KEYWORDS.includes(t))) continue

    for (const kw of NEGATION_KEYWORDS) {
      const idx = constraintLower.indexOf(kw)
      if (idx === -1) continue
      const subject = constraintLower.slice(idx + kw.length).trim()
      const subjectTokens = subject.split(/\s+/).slice(0, 4).filter(t => t.length > 3)
      if (subjectTokens.length > 0 && subjectTokens.some(t => resultText.includes(t))) {
        violations.push(`caller_specific_constraints: constraint violated: "${constraint}"`)
        break
      }
    }
  }

  if (violations.length > 0) {
    // Identify the first violated dimension for the error
    const violatedDimension = violations[0].split(':')[0]
    throw new OutputContractError(violatedDimension, violations)
  }

  return { passed: true, violations: [] }
}
