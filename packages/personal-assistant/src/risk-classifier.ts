import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import { looksLikeEnumeratedItems } from './decomposition-classifier.js'

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

// "order" alone is ambiguous between the purchase verb ("order me a pizza") and the noun
// describing an existing/preferred item ("my coffee order is an oat milk cortado", "my usual
// order was a cortado", "in order to finish this", "the order arrived yesterday") — only the verb
// usage is a purchase request. Found via live testing: a stated coffee-order preference tripped
// the bare \border\b match and got silently auto-declined (fails-closed, no live approver) as a
// HIGH-risk money-spending request, with the fact never making it into the transcript at all.
// The lookbehind originally only excluded a possessive pronoun before "order" — a definite/
// indefinite article or demonstrative ("the order arrived", "an order came in", "that order was
// wrong") is just as clearly a noun usage and was still slipping through. Bare quantifiers
// (no/any/some/every/each) are the same noun-signaling shape ("every order I've placed", "there's
// no order confirmation yet") and were still missing from the list.
const ORDER_VERB_PATTERN =
  /(?<!\b(?:my|his|her|their|our|your|the|this|that|an?|no|any|some|every|each)\b(?:\s+\w+){0,2}\s)\border\b(?!\s+(?:is|was|to)\b)/i

// "email"/"text" used as VERBS ("email the landlord", "text my sister") are the same
// send-a-message action as "send an email/text", but the send-message pattern above requires
// the literal word "send" and misses these entirely. Both words are also common NOUNS ("check my
// email", "reply to that text", "an email came in", "the text message says..."), so — same
// approach as ORDER_VERB_PATTERN above — exclude the noun-signaling contexts: preceded by a
// possessive/article/demonstrative, a bare quantifier (no/any/some/every/each — "there's no text
// from him yet" is exactly this shape, same gap as ORDER_VERB_PATTERN), or a receive-shaped verb
// (check/read/reply to/got/get/received/see/saw), or followed by "message"/"address" (a
// noun-compound, not a direct object).
const EMAIL_TEXT_VERB_PATTERN =
  /(?<!\b(?:my|his|her|their|our|your|the|this|that|an?|no|any|some|every|each|check|read|reply to|got|get|received|see|saw)\b(?:\s+\w+){0,2}\s)\b(?:email|text)\b(?!\s+(?:message|messages|address|addresses|is|was)\b)/i

// Consequential, hard-to-undo actions — gated behind explicit approval before the
// harness is allowed to execute anything on the user's behalf.
const HIGH_RISK_PATTERNS: RiskPattern[] = [
  { pattern: /\bsend\b.{0,30}\b(email|e-mail|message|text|dm)\b/i, reason: "sends a message on the user's behalf" },
  { pattern: EMAIL_TEXT_VERB_PATTERN, reason: "sends a message on the user's behalf" },
  { pattern: /\b(delete|remove|wipe|erase)\b/i, reason: 'deletes or removes something, possibly irreversibly' },
  { pattern: /\b(pay|purchase|buy|checkout|transfer money|wire)\b/i, reason: 'spends money or moves funds' },
  { pattern: ORDER_VERB_PATTERN, reason: 'spends money or moves funds' },
  { pattern: /\b(post|publish|tweet|share publicly)\b/i, reason: 'publishes content publicly' },
  { pattern: /\b(cancel|unsubscribe)\b/i, reason: 'cancels a subscription or commitment' },
  { pattern: /\b(sign|submit|approve)\b.{0,30}\b(contract|form|application|agreement)\b/i, reason: 'signs or submits a binding document' },
]

// A reminder/event request names what to be reminded about, not an action to carry out right
// now — checked before HIGH_RISK_PATTERNS below so "remind me to buy milk" or "remind me to
// delete the old invoices" reads as creating a reminder, not as buying/deleting on the user's
// behalf this instant (found via live testing: this false positive blocked an everyday reminder
// behind an unnecessary HIGH-risk approval gate).
// Plural phrasing ("set reminders for X, Y, and Z") is just as much a reminder request as the
// singular "set a reminder" — but the fixed-phrase list originally required the singular
// article, so a plural-phrased bulk request never matched this pattern at all and fell through
// classifyRisk entirely as LOW, skipping both ordinary MEDIUM classification and the
// looksLikeEnumeratedItems bulk-confirmation gate below (which only runs once this pattern
// already matched). Found via live testing: "Set reminders for calling the bank, emailing the
// landlord, and picking up dry cleaning" silently bulk-created 3 reminders with zero approval.
const REMINDER_PATTERN: RiskPattern = { pattern: /\b(remind me|set (?:a |)reminders?|create (a |an )?events?)\b/i, reason: 'creates a calendar or reminder entry' }

// "remind me what my job is?" / "remind me again what the first item was?" ask the assistant to
// RECALL something already stated in the conversation — they contain "remind me" but aren't a
// create-reminder request at all, and REMINDER_PATTERN's bare match doesn't distinguish the two.
// Found via live testing: no reminder is actually (mis)created and no approval gate fires
// incorrectly, but the reply still surfaced a misleading [risk: MEDIUM] tag. A WH-word (what/who/
// when/where/why/how) after "remind me", plus a trailing "?" (same fails-closed shape
// PAST_TENSE_QUESTION already uses, so an oddly-phrased genuine create-reminder request still
// gates normally by default), is the recall-question shape.
const REMINDER_RECALL_QUESTION = /\bremind me\b.{0,20}\b(what|who|when|where|why|how)\b.*\?\s*$/i

// A reminder-shaped request that ALSO looks enumerated (see looksLikeEnumeratedItems) risks the
// model silently bulk-creating several reminders in one turn with no chance to confirm first —
// prompt-level nudges for this exact class of behavior have not reliably held across past testing
// (see conv12/conv21's shell-reuse wording attempts, and conv28/conv51's bulk-reminder finding),
// so this gates deterministically instead, via the same simple message-level approval flow
// HIGH-risk requests already use (requiresApproval, resolved by a later approved:true re-entry —
// see assistant.ts's runTurn). A false positive here just costs one extra confirmation for a
// single wordy reminder that happens to look enumerated — same tradeoff decomposition-classifier.ts
// already accepts for its own enumeration signals.
const BULK_REMINDER_REASON = 'creates a calendar or reminder entry and looks like it may create more than one in a single turn — confirm before proceeding'

// Reversible or low-stakes actions that still change state in the world —
// surfaced in diagnostics but not blocked on approval.
const MEDIUM_RISK_PATTERNS: RiskPattern[] = [
  { pattern: /\b(schedule|book|reserve)\b/i, reason: 'books or schedules something' },
  REMINDER_PATTERN,
]

// A question about whether/how an action already happened or happens automatically ("did that
// send?", "was it deleted?", "does this cancel automatically?") is asking ABOUT the action, not
// requesting it now — only a leading auxiliary paired with a trailing "?" counts, so an
// imperative phrased as a question ("Could you delete these?") still gates normally. Found via
// live testing: "Did that actually send a real email just now?" (a follow-up question, not a
// request) tripped the send-a-message HIGH pattern and forced an approval prompt for a question
// with no side effects. The auxiliary list originally only covered past-tense/completed
// auxiliaries (did/was/were/has/have) — "Does this subscription cancel automatically after the
// 30-day trial?" is the same question shape in the present tense and was still missing.
const PAST_TENSE_QUESTION = /^\s*(did|was|were|has|have|does|do)\b.*\?\s*$/i

// A message can report a THIRD PARTY's action/threat/plan rather than ask the assistant to do
// anything — "my landlord said he will cancel my lease if I don't pay rent" contains "cancel" and
// "pay", but the acting subject in both cases is someone else, relayed as reported speech, not a
// live instruction from the user. Narrow and modeled on PAST_TENSE_QUESTION: a speech-report verb
// (said/told me/mentioned/warned/threatened) followed reasonably closely by a third-person
// subject (he/she/they/it) and a future/conditional auxiliary OR an equivalent "plans to"/"is
// going to"/"intends to"/"wants to" continuation — found via live testing: "My roommate warned
// that she plans to delete our shared documents folder..." uses "plans to" instead of a bare
// modal, and the modal-only version of this pattern didn't cover it, leaving the bare "delete"
// keyword to still trip HIGH_RISK_PATTERNS. An imperative ("cancel my subscription") or
// first-person intent ("I will cancel it") has no third-person subject here and still gates
// normally.
const REPORTED_THIRD_PARTY_SPEECH =
  /\b(said|told me|mentioned|warned|threatened)\b.{0,30}\b(he|she|they|it)\b\s*(?:'ll|will|would|might|could|is (?:going|planning) to|plans to|intends to|wants to)\b/i

export function classifyRisk(message: string): RiskClassification {
  const isReminderRecallQuestion = REMINDER_RECALL_QUESTION.test(message)
  if (REMINDER_PATTERN.pattern.test(message) && !isReminderRecallQuestion) {
    if (looksLikeEnumeratedItems(message)) {
      return { riskLevel: 'MEDIUM', requiresApproval: true, reason: `Request ${BULK_REMINDER_REASON}.` }
    }
    return { riskLevel: 'MEDIUM', requiresApproval: false, reason: `Request ${REMINDER_PATTERN.reason}.` }
  }
  if (!PAST_TENSE_QUESTION.test(message) && !REPORTED_THIRD_PARTY_SPEECH.test(message)) {
    for (const { pattern, reason } of HIGH_RISK_PATTERNS) {
      if (pattern.test(message)) {
        return { riskLevel: 'HIGH', requiresApproval: true, reason: `Request ${reason}.` }
      }
    }
  }
  for (const { pattern, reason } of MEDIUM_RISK_PATTERNS) {
    // Same recall-question exemption as above — REMINDER_PATTERN is also one of these patterns,
    // and without this guard a recall question would fall through the block above only to
    // immediately re-match here.
    if (pattern === REMINDER_PATTERN.pattern && isReminderRecallQuestion) continue
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
