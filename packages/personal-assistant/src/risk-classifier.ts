import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'

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

// Deliberately looser than HIGH_RISK_PATTERNS/MEDIUM_RISK_PATTERNS — this only decides
// whether a message classifyRisk already called LOW is worth a second, LLM-backed look,
// not a risk verdict itself. A false positive here just spends one extra LLM call; a false
// negative means a paraphrased risky request (e.g. "get rid of my old invoices") never gets
// the second look. Deliberately excludes generic phrases like "for me"/"on my behalf" —
// those show up in totally ordinary requests ("read this for me", "look this up for me")
// far more often than in actually consequential ones, which is exactly the false-positive
// failure mode this needs to avoid (see assistant.test.ts's "for me"-phrased tool-loop
// tests, which is what caught this the first time around).
const ACTION_SHAPE = /\b(go ahead and|please (go ahead|handle|take care of)|get rid of|hand over|reach out to|follow up with|renew|finalize|confirm the)\b|\$\d/i

export function looksActionOriented(message: string): boolean {
  return ACTION_SHAPE.test(message)
}

const RISK_SCHEMA = {
  type: 'object',
  properties: {
    riskLevel: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    reason: { type: 'string' },
  },
  required: ['riskLevel', 'reason'],
}

const RISK_SYSTEM_PROMPT =
  "Classify how consequential the user's request is if acted on literally, on a personal-assistant " +
  'that can send messages, delete files, spend money, publish content, and manage subscriptions/bookings ' +
  'on the user\'s behalf. HIGH: sends a message on the user\'s behalf, deletes/removes something possibly ' +
  'irreversibly, spends money or moves funds, publishes content publicly, cancels a subscription or ' +
  'commitment, or signs/submits a binding document. MEDIUM: books, schedules, reserves, or creates a ' +
  'calendar/reminder entry. LOW: everything else — conversational or informational, no real-world side ' +
  'effects. Respond with JSON only: {"riskLevel": "LOW"|"MEDIUM"|"HIGH", "reason": string}'

/**
 * Second opinion for a message classifyRisk already called LOW but looksActionOriented flagged
 * as worth double-checking — only ever called for that narrow slice, so ordinary conversational
 * turns never pay for it. Falls back to the same LOW result classifyRisk would have given on any
 * parse failure or LLM error, rather than blocking the turn.
 */
export async function classifyRiskWithLLM(
  message: string,
  llmClient: ILLMClient,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<RiskClassification> {
  const fallback: RiskClassification = { riskLevel: 'LOW', requiresApproval: false, reason: 'Conversational request with no detected side effects.' }
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: RISK_SYSTEM_PROMPT },
        { role: 'user', content: message },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: RISK_SCHEMA } },
    )
    const parsed = JSON.parse(response.content) as { riskLevel?: unknown; reason?: unknown }
    if (parsed.riskLevel !== 'HIGH' && parsed.riskLevel !== 'MEDIUM' && parsed.riskLevel !== 'LOW') return fallback
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason : `LLM classified this as ${parsed.riskLevel} risk.`
    return { riskLevel: parsed.riskLevel, requiresApproval: parsed.riskLevel === 'HIGH', reason }
  } catch {
    return fallback
  }
}
