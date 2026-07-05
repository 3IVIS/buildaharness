export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

export interface RiskClassification {
  riskLevel: RiskLevel
  requiresApproval: boolean
  reason: string
}

interface RiskPattern {
  pattern: RegExp
  reason: string
}

// Consequential, hard-to-undo actions — gated behind explicit approval before the
// harness is allowed to execute anything on the user's behalf.
const HIGH_RISK_PATTERNS: RiskPattern[] = [
  { pattern: /\bsend\b.{0,30}\b(email|e-mail|message|text|dm)\b/i, reason: "sends a message on the user's behalf" },
  { pattern: /\b(delete|remove|wipe|erase)\b/i, reason: 'deletes or removes something, possibly irreversibly' },
  { pattern: /\b(pay|purchase|buy|order|checkout|transfer money|wire)\b/i, reason: 'spends money or moves funds' },
  { pattern: /\b(post|publish|tweet|share publicly)\b/i, reason: 'publishes content publicly' },
  { pattern: /\b(cancel|unsubscribe)\b/i, reason: 'cancels a subscription or commitment' },
  { pattern: /\b(sign|submit|approve)\b.{0,30}\b(contract|form|application|agreement)\b/i, reason: 'signs or submits a binding document' },
]

// Reversible or low-stakes actions that still change state in the world —
// surfaced in diagnostics but not blocked on approval.
const MEDIUM_RISK_PATTERNS: RiskPattern[] = [
  { pattern: /\b(schedule|book|reserve)\b/i, reason: 'books or schedules something' },
  { pattern: /\b(remind me|set a reminder|create (a |an )?event)\b/i, reason: 'creates a calendar or reminder entry' },
]

export function classifyRisk(message: string): RiskClassification {
  for (const { pattern, reason } of HIGH_RISK_PATTERNS) {
    if (pattern.test(message)) {
      return { riskLevel: 'HIGH', requiresApproval: true, reason: `Request ${reason}.` }
    }
  }
  for (const { pattern, reason } of MEDIUM_RISK_PATTERNS) {
    if (pattern.test(message)) {
      return { riskLevel: 'MEDIUM', requiresApproval: false, reason: `Request ${reason}.` }
    }
  }
  return { riskLevel: 'LOW', requiresApproval: false, reason: 'Conversational request with no detected side effects.' }
}
