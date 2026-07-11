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
// Shared noun-signaling lookbehind: a possessive/article/demonstrative/bare-quantifier right
// before a word almost always marks that word as a noun, not a live verb request ("my coffee
// order", "the checkout process", "a good book", "that post"). Reused below by ORDER_VERB_PATTERN
// and its siblings (PURCHASE_VERB_PATTERN, PUBLISH_VERB_PATTERN, BOOK_VERB_PATTERN) rather than
// duplicating the same alternation four times.
// "several/few/many/most/all" are the same noun-signaling quantifier shape as "no/any/some/every/
// each" but were missing from the list — found via live testing: "Several delete requests came in
// from the support queue this morning, all resolved now." had a quantifier directly before
// "delete" that the lookbehind didn't recognize, so DELETE_VERB_PATTERN still misfired HIGH.
const NOUN_CONTEXT_DETERMINERS = 'my|his|her|their|our|your|the|this|that|an?|no|any|some|every|each|several|few|many|most|all'
// The word-gap window below only allowed 0-2 modifier words between the determiner and the
// keyword — "My extremely late final pay stub finally arrived in the mail." has 3 (extremely,
// late, final), exceeding the old window, so the lookbehind failed to recognize the noun usage
// and PAY_WIRE_PATTERN/ORDER_VERB_PATTERN still misfired HIGH. Widened to 0-4 to give descriptive
// noun phrases more headroom; still requires an actual determiner earlier in the clause, so it
// doesn't loosen the exclusion for a bare imperative with no determiner at all.
const nounContextLookbehind = (extra = ''): string =>
  `(?<!\\b(?:${NOUN_CONTEXT_DETERMINERS}${extra ? '|' + extra : ''})\\b(?:\\s+\\w+){0,4}\\s)`

const ORDER_VERB_PATTERN = new RegExp(`${nounContextLookbehind()}\\border\\b(?!\\s+(?:is|was|to)\\b)`, 'i')

// "email"/"text" used as VERBS ("email the landlord", "text my sister") are the same
// send-a-message action as "send an email/text", but the send-message pattern above requires
// the literal word "send" and misses these entirely. Both words are also common NOUNS ("check my
// email", "reply to that text", "an email came in", "the text message says..."), so — same
// approach as ORDER_VERB_PATTERN above — exclude the noun-signaling contexts: preceded by a
// possessive/article/demonstrative, a bare quantifier (no/any/some/every/each — "there's no text
// from him yet" is exactly this shape, same gap as ORDER_VERB_PATTERN), or a receive-shaped verb
// (check/read/reply to/got/get/received/see/saw), or followed by "message"/"address" (a
// noun-compound, not a direct object).
// The receive-verb exclusion above only matched exact base word forms — a trailing \b right after
// e.g. "check" doesn't close between "check" and an -ing suffix (still mid-word), so "checking"/
// "reading"/"getting"/"receiving"/"seeing" weren't excluded at all. Found via live testing: "I
// spend way too much time checking email every morning" still tripped the bare pattern as a
// HIGH-risk send-a-message request despite being a receive-shaped verb, just inflected.
const EMAIL_TEXT_VERB_PATTERN = new RegExp(
  `${nounContextLookbehind('check(?:ing)?|read(?:ing)?|repl(?:y|ying) to|got|get(?:ting)?|received|receiving|see(?:ing)?|saw')}\\b(?:email|text)\\b(?!\\s+(?:message|messages|address|addresses|is|was)\\b)`,
  'i',
)

// "purchase"/"checkout" have the exact same noun-vs-verb ambiguity "order" does ("my purchase
// hasn't shipped", "the checkout process was slow") but had no noun-context exclusion — found via
// live testing: a question merely mentioning a past purchase/checkout tripped the bare
// pay/purchase/buy/checkout/... pattern below and got silently auto-declined (fails-closed) as a
// HIGH-risk money-spending request. "pay"/"buy"/"transfer money"/"wire" are left in the bare
// pattern below — they're overwhelmingly verbs in ordinary usage and weren't the words the live
// failure hit.
const PURCHASE_VERB_PATTERN = new RegExp(`${nounContextLookbehind()}\\b(?:purchase|checkout)\\b(?!\\s+(?:is|was|process|line|page|counter)\\b)`, 'i')

// Same noun-vs-verb ambiguity for "post"/"tweet" ("I saw an interesting post", "did you see that
// tweet") — found via live testing alongside PURCHASE_VERB_PATTERN above, same false-positive
// shape on the "publishes content publicly" HIGH pattern.
// A sentence-initial "Post"/"Tweet" (capitalized, nothing precedes it) has no determiner for
// nounContextLookbehind to exclude on at all — found via live testing: "Post engagement has been
// dropping across all my accounts this month." (a social-media analytics observation, no
// publishing request) still misfired HIGH. "engagement"/"engagements" added to the trailing
// exclusion, the same noun-compound shape CANCEL_VERB_PATTERN's link/option/button list below
// already uses for its own sentence-initial gap.
const PUBLISH_VERB_PATTERN = new RegExp(`${nounContextLookbehind()}\\b(?:post|tweet)\\b(?!\\s+(?:engagement|engagements|is|was)\\b)`, 'i')

// "book" in "schedule|book|reserve" below has the same noun-vs-verb ambiguity ("a good book
// about jazz") — found via live testing: a book recommendation request mistagged MEDIUM risk
// ("books or schedules something") purely because of the word "book". "schedule"/"reserve" are
// left bare; they weren't the word the live failure hit and are far less commonly nouns here.
const BOOK_VERB_PATTERN = new RegExp(`${nounContextLookbehind()}\\bbook\\b(?!\\s+(?:club|report|is|was)\\b)`, 'i')

// "schedule" is just as common a plain noun ("my schedule is completely packed") as "book" is —
// found via live testing, same false-positive shape as BOOK_VERB_PATTERN above: a determiner
// right before "schedule" tripped the bare pattern below and mistagged MEDIUM "books or schedules
// something" with no scheduling request present. "reserve" is left in the same pattern; it wasn't
// the word the live failure hit.
const SCHEDULE_VERB_PATTERN = new RegExp(`${nounContextLookbehind()}\\b(?:schedule|reserve)\\b(?!\\s+(?:is|was)\\b)`, 'i')

// "forward" is a send-a-message action just as much as "send"/"email"/"text" ("forward this
// email to my accountant") but wasn't a keyword anywhere in HIGH_RISK_PATTERNS — found via live
// testing: a genuinely risky send-on-my-behalf request never gated at all. Unlike email/text,
// "forward" is common as a non-messaging adverb/particle ("going forward", "move forward with the
// plan", "look forward to it") — none of those take a determiner+noun object the way "forward
// this/that/my email" does, so requiring an object determiner right after the verb (rather than
// the email/text pattern's noun-context lookbehind) is the narrower, more reliable signal here.
const FORWARD_VERB_PATTERN = /\bforward(?:ed|ing)?\b\s+(?:this|that|my|the|it|these|those|him|her|them)\b/i

// "delete"/"remove"/"wipe"/"erase" have the same noun-vs-verb ambiguity ORDER_VERB_PATTERN and its
// siblings already handle ("the Remove button", "my delete key", "the wipe cycle on my
// dishwasher") — found via live testing: a UI-element or appliance-cycle mention with a preceding
// determiner tripped the bare pattern below and got silently auto-declined (fails-closed) as a
// HIGH-risk irreversible-deletion request with no delete/remove intent at all.
const DELETE_VERB_PATTERN = new RegExp(`${nounContextLookbehind()}\\b(?:delete|remove|wipe|erase)\\b(?!\\s+(?:is|was)\\b)`, 'i')

// "pay"/"wire" are common plain nouns ("my pay was late this month", "the wire behind my desk")
// just as much as "buy"/"transfer money" are verbs — found via live testing, same false-positive
// shape as DELETE_VERB_PATTERN above: a determiner-preceded noun mention tripped the bare pattern
// and got auto-declined as a HIGH-risk money-spend request with no spend request present.
const PAY_WIRE_PATTERN = new RegExp(`${nounContextLookbehind()}\\b(?:pay|buy|transfer money|wire)\\b(?!\\s+(?:is|was)\\b)`, 'i')

// "cancel"/"unsubscribe" have the same mention-vs-request ambiguity — "an unsubscribe link"
// reintroduces the noun-compound shape EMAIL_TEXT_VERB_PATTERN's trailing exclusion already
// handles ("the message/address I'm looking for"), and a determiner right before "unsubscribe"
// ("an unsubscribe link") is the same noun-signaling shape as DELETE_VERB_PATTERN above — found
// via live testing: a message merely describing an unfindable unsubscribe link tripped the bare
// pattern and got auto-declined as a HIGH-risk cancellation request with no live request at all.
// A sentence-initial "Cancel" (capitalized, nothing precedes it) has no determiner for
// nounContextLookbehind to exclude on either — found via live testing: "Cancel confirmations from
// that airline always take a few days to show up in my inbox." (a status observation, no live
// cancellation request) still misfired HIGH. "confirmation"/"confirmations" added to the trailing
// exclusion alongside link/option/button.
const CANCEL_VERB_PATTERN = new RegExp(
  `${nounContextLookbehind()}\\b(?:cancel|unsubscribe)\\b(?!\\s+(?:link|option|button|confirmation|confirmations|is|was)\\b)`,
  'i',
)

// Consequential, hard-to-undo actions — gated behind explicit approval before the
// harness is allowed to execute anything on the user's behalf.
const HIGH_RISK_PATTERNS: RiskPattern[] = [
  { pattern: /\bsend\b.{0,30}\b(email|e-mail|message|text|dm)\b/i, reason: "sends a message on the user's behalf" },
  { pattern: EMAIL_TEXT_VERB_PATTERN, reason: "sends a message on the user's behalf" },
  { pattern: DELETE_VERB_PATTERN, reason: 'deletes or removes something, possibly irreversibly' },
  { pattern: PAY_WIRE_PATTERN, reason: 'spends money or moves funds' },
  { pattern: ORDER_VERB_PATTERN, reason: 'spends money or moves funds' },
  { pattern: PURCHASE_VERB_PATTERN, reason: 'spends money or moves funds' },
  { pattern: /\b(publish|share publicly)\b/i, reason: 'publishes content publicly' },
  { pattern: PUBLISH_VERB_PATTERN, reason: 'publishes content publicly' },
  { pattern: FORWARD_VERB_PATTERN, reason: "sends a message on the user's behalf" },
  { pattern: CANCEL_VERB_PATTERN, reason: 'cancels a subscription or commitment' },
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
// "create a/plural reminder(s)" is just as obvious an everyday synonym for "set a reminder" as
// "create an event" already was, but had no alternative of its own — found via live testing:
// "Please create reminders for calling the bank, emailing the landlord, and picking up dry
// cleaning." bypassed REMINDER_PATTERN entirely (falling through as LOW, skipping the same
// bulk-confirmation gate) purely because it used "create" instead of "set". Duplicated identically
// in reminder-tools.ts and file-tools-mcp-server.mjs's REMINDER_REQUEST_MARKER — keep all three in
// sync by hand (see the playbook's claude-cli-backend gotcha).
const REMINDER_PATTERN: RiskPattern = {
  pattern: /\b(remind me|set (?:a |)reminders?|create (?:a |an )?(?:reminders?|events?))\b/i,
  reason: 'creates a calendar or reminder entry',
}

// "remind me what my job is?" / "remind me again what the first item was?" ask the assistant to
// RECALL something already stated in the conversation — they contain "remind me" but aren't a
// create-reminder request at all, and REMINDER_PATTERN's bare match doesn't distinguish the two.
// Found via live testing: no reminder is actually (mis)created and no approval gate fires
// incorrectly, but the reply still surfaced a misleading [risk: MEDIUM] tag. A WH-word (what/who/
// when/where/why/how) after "remind me", plus a trailing "?" (same fails-closed shape
// PAST_TENSE_QUESTION already uses, so an oddly-phrased genuine create-reminder request still
// gates normally by default), is the recall-question shape.
//
// Two more recall shapes found via live testing that the above branch alone doesn't cover:
// - The WH-word can come BEFORE "remind me" instead of after ("What did you just remind me
//   about?") — the "after" branch's distance check never looks backwards.
// - A recall can be phrased as a flat statement, not a question ("Remind me again what my
//   pharmacy reminder was.") — no trailing "?" at all. Relaxing the trailing-"?" requirement for
//   every WH-word case risked misclassifying a genuine event-triggered creation request phrased
//   the same way ("remind me when it's time to leave."), so the statement form is only recognized
//   when it ends in a past-tense "was"/"were" — the grammatical marker of recalling something
//   already established, which a creation request (necessarily about the future) never has.
const REMINDER_RECALL_QUESTION =
  /\b(what|who|when|where|why|how)\b.{0,20}\bremind(?:ed)? me\b.*\?\s*$|\bremind me\b.{0,20}\b(what|who|when|where|why|how)\b.*(?:\?\s*$|\b(?:was|were)\b\s*\.?\s*$)/i

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
  { pattern: SCHEDULE_VERB_PATTERN, reason: 'books or schedules something' },
  { pattern: BOOK_VERB_PATTERN, reason: 'books or schedules something' },
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
// 30-day trial?" is the same question shape in the present tense and was still missing. "is"/
// "are" are the same present-tense "to be" auxiliary as "does"/"do" ("Is the Remove button
// supposed to be grayed out, or is that a bug?") and were still missing too.
const PAST_TENSE_QUESTION = /^\s*(did|was|were|has|have|does|do|is|are)\b.*\?\s*$/i

// A first-person past narrative ("Yesterday I had to cancel my dentist appointment because of
// the snowstorm.") reports an action the user themselves already completed — neither
// PAST_TENSE_QUESTION's shape (needs a trailing "?") nor REPORTED_THIRD_PARTY_SPEECH's shape
// (needs a third-person subject) covers it, so bare "cancel"/"delete" still tripped
// HIGH_RISK_PATTERNS and forced an approval prompt for something already done, with nothing left
// to approve. Narrow on purpose ("I had to" / "I already" — a genuine forced-or-completed-action
// frame): an imperative ("cancel my subscription") or first-person intent ("I will cancel it",
// "I need to cancel it") has neither shape and still gates normally.
// "needed to"/"decided to"/"chose to"/"wanted to" are the same completed-action frame as "had to"
// — an infinitive-after-modal construction that leaves the HIGH-risk verb in its exact bare form
// (unlike simple past tense "I cancelled", which evades the bare \bcancel\b keyword on its own via
// the missing word boundary between stem and -ed suffix) — found via live testing: "I needed to
// cancel my dentist appointment yesterday" and "I decided to delete those old vacation photos last
// weekend" both still tripped HIGH_RISK_PATTERNS for an action already completed.
const FIRST_PERSON_PAST_NARRATIVE = /\bi (?:had to|already|needed to|decided to|chose to|wanted to)\b/i

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

// PAST_TENSE_QUESTION/REPORTED_THIRD_PARTY_SPEECH/FIRST_PERSON_PAST_NARRATIVE originally ran a
// single bare .test() against the WHOLE message — none of them anchored or clause-scoped the way
// fact-extraction.ts's CLAUSE_BOUNDARY splitting is (added specifically to fix this exact
// whole-message-vs-clause bug class for NON_CLAIM_MARKERS). That let an unrelated exemption-shaped
// clause suppress HIGH_RISK_PATTERNS for the ENTIRE message, including a live, different HIGH-risk
// imperative riding along in the same message — found via live testing: "I already deleted the old
// vacation photos last year, and please delete my entire Google Photos account now." let the
// past-narrative clause suppress gating for the live account-deletion request. Splitting on a
// comma before a coordinating conjunction (the same shape fact-extraction.ts splits on, minus
// sentence-ending punctuation — several of these exemptions rely on a trailing "?" surviving
// within its own clause) and checking each clause independently keeps one clause's exemption from
// reaching across into a separate, live request clause.
const RISK_CLAUSE_BOUNDARY = /,\s*(?:so|but|yet|and|because|although|while|whereas)\b/i

function splitRiskClauses(message: string): string[] {
  return message
    .split(RISK_CLAUSE_BOUNDARY)
    .map((clause) => clause.trim())
    .filter(Boolean)
}

function isExemptClause(clause: string): boolean {
  return PAST_TENSE_QUESTION.test(clause) || REPORTED_THIRD_PARTY_SPEECH.test(clause) || FIRST_PERSON_PAST_NARRATIVE.test(clause)
}

export function classifyRisk(message: string): RiskClassification {
  const isReminderRecallQuestion = REMINDER_RECALL_QUESTION.test(message)
  if (REMINDER_PATTERN.pattern.test(message) && !isReminderRecallQuestion) {
    if (looksLikeEnumeratedItems(message)) {
      return { riskLevel: 'MEDIUM', requiresApproval: true, reason: `Request ${BULK_REMINDER_REASON}.` }
    }
    return { riskLevel: 'MEDIUM', requiresApproval: false, reason: `Request ${REMINDER_PATTERN.reason}.` }
  }
  for (const clause of splitRiskClauses(message)) {
    if (isExemptClause(clause)) continue
    for (const { pattern, reason } of HIGH_RISK_PATTERNS) {
      if (pattern.test(clause)) {
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
