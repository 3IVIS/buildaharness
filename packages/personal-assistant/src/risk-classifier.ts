import { looksLikeEnumeratedItems } from './decomposition-classifier.js'
import { getRiskPatterns, testAny, splitOnAny } from './lexical/patterns.js'

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

export interface RiskClassification {
  riskLevel: RiskLevel
  requiresApproval: boolean
  reason: string
}

// Every pattern this file used to hand-declare (ORDER_VERB_PATTERN, EMAIL_TEXT_VERB_PATTERN,
// PURCHASE_VERB_PATTERN, PUBLISH_VERB_PATTERN, BOOK_VERB_PATTERN, SCHEDULE_VERB_PATTERN,
// FORWARD_VERB_PATTERN, DELETE_VERB_PATTERN, PAY_WIRE_PATTERN, CANCEL_VERB_PATTERN,
// HIGH_RISK_PATTERNS, MEDIUM_RISK_PATTERNS, REMINDER_PATTERN, REMINDER_RECALL_QUESTION,
// BULK_REMINDER_REASON, PAST_TENSE_QUESTION, FIRST_PERSON_PAST_NARRATIVE,
// REPORTED_THIRD_PARTY_SPEECH, RISK_CLAUSE_BOUNDARY) now live as compiled regex source strings in
// packages/personal-assistant/src/lexical/patterns/risk-patterns.json (see lexical/patterns.ts's
// getRiskPatterns()) — concentrated there so a future non-English pattern set is a pure data
// addition, not a second copy of this file's logic. The historical rationale below (every
// "found via live testing" fix that shaped each pattern's exact wording) stays here rather than
// in the JSON, since JSON can't carry prose comments and this context is exactly what a future
// editor of risk-patterns.json needs before changing a pattern's shape.
//
// The shared "noun-signaling lookbehind" trick these patterns use internally (excluding
// "order"/"delete"/"pay"/etc. when preceded by a possessive/article/demonstrative/quantifier, so
// "my coffee order" doesn't read as a live "order" verb) is specifically an English
// noun/verb-homograph disambiguation — per
// plans/personal_assistant_chinese_lexical_checks_plan.html's Phase 1a note, Chinese doesn't have
// the same ambiguity for most of these verbs, so a future Chinese entry in risk-patterns.json is
// very likely a much simpler pattern, not a port of this same lookbehind machinery.
const risk = getRiskPatterns()

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
// "several/few/many/most/all" are the same noun-signaling quantifier shape as "no/any/some/every/
// each" but were missing from the list — found via live testing: "Several delete requests came in
// from the support queue this morning, all resolved now." had a quantifier directly before
// "delete" that the lookbehind didn't recognize, so the delete pattern still misfired HIGH.
// The word-gap window below only allowed 0-2 modifier words between the determiner and the
// keyword — "My extremely late final pay stub finally arrived in the mail." has 3 (extremely,
// late, final), exceeding the old window, so the lookbehind failed to recognize the noun usage
// and the pay/order patterns still misfired HIGH. Widened to 0-4 to give descriptive
// noun phrases more headroom; still requires an actual determiner earlier in the clause, so it
// doesn't loosen the exclusion for a bare imperative with no determiner at all.
//
// h2: the trailing exclusion originally only covered the "in order to" idiom ("to" right after
// "order") — "in order for X to succeed" is the equally common variant of the same idiom, with
// "for" instead of "to" directly after "order" ("order for us to succeed"), and "in" isn't a
// determiner the lookbehind recognizes either — found via live testing:
// "In order for us to succeed, I need to finish this project first." misfired HIGH.
// batch 10 re-probe (conv166/h2): a sentence-initial "Order" (capitalized, nothing precedes it
// for the lookbehind to exclude on) followed by a noun-compound word not in the trailing
// list still misfired HIGH — found via live testing: "Order confirmation emails from this store
// take forever to arrive, is that normal?" misfired. Added "confirmation(s)"/"number"/"status"/
// "history", the same order-tracking noun-compounds the cancel pattern's own trailing list
// already covers the analogous case for.
// h1: same sentence-initial gap, one more noun-compound the trailing list didn't cover — "of" (as
// in "order of operations"/"order of magnitude") — found via live testing: "Order of operations
// always trips up my students when we get to nested parentheses." misfired HIGH.
// batch 19 (h1): "form" is the same sentence-initial noun-compound gap ("order form", a document,
// not a purchase verb) — found via live testing: "Order form for the new office chairs needs to
// be filled out before Friday, does anyone know where to find it?" misfired HIGH.

// "email"/"text" used as VERBS ("email the landlord", "text my sister") are the same
// send-a-message action as "send an email/text", but the send-message pattern requires
// the literal word "send" and misses these entirely. Both words are also common NOUNS ("check my
// email", "reply to that text", "an email came in", "the text message says..."), so — same
// approach as the order pattern above — exclude the noun-signaling contexts: preceded by a
// possessive/article/demonstrative, a bare quantifier (no/any/some/every/each — "there's no text
// from him yet" is exactly this shape), or a receive-shaped verb
// (check/read/reply to/got/get/received/see/saw), or followed by "message"/"address" (a
// noun-compound, not a direct object).
// The receive-verb exclusion above only matched exact base word forms — a trailing \b right after
// e.g. "check" doesn't close between "check" and an -ing suffix (still mid-word), so "checking"/
// "reading"/"getting"/"receiving"/"seeing" weren't excluded at all. Found via live testing: "I
// spend way too much time checking email every morning" still tripped the bare pattern as a
// HIGH-risk send-a-message request despite being a receive-shaped verb, just inflected.
// h9: unlike the cancel/publish patterns (already patched for a
// sentence-initial capitalized noun with nothing preceding it to exclude on), this pattern never
// got the same fix — "alignment" is the same noun-compound shape as "engagement"/"confirmation"
// below, and a sentence-initial "Text" has no determiner for the lookbehind to exclude
// on — found via live testing: "Text alignment in this document looks off, everything is
// centered instead of left-justified." misfired HIGH.
// batch 10 re-probe (conv166/h5): "thread"/"threads" is the same sentence-initial noun-compound
// gap as "alignment" above — found via live testing: "Email thread got really long today, over
// 50 replies by lunchtime." misfired HIGH with no live send request at all.
// batch 19 (h5): "editor" (text editor) is the same sentence-initial noun-compound gap as
// "alignment"/"thread" above — found via live testing: "Text editor I use at work keeps crashing
// every time I paste in a large file." misfired HIGH.
// batch 29 (convSweep1, surfaced while re-probing h3): "campaign(s)" (an email marketing
// campaign, a noun-compound, not a live send-a-message request) wasn't in the trailing exclusion
// list either — found via live testing: "Unsubscribe rates jumped after last week's email
// campaign, according to marketing." (a plain statistics statement, no live send request)
// misfired HIGH via the bare "email" alternative before the cancel pattern's own gap on the same
// sentence's "unsubscribe" ever got a chance to run (this pattern is checked first in
// highRiskPatterns). Added "campaigns?" to the trailing exclusion.

// "purchase"/"checkout" have the exact same noun-vs-verb ambiguity "order" does ("my purchase
// hasn't shipped", "the checkout process was slow") but had no noun-context exclusion — found via
// live testing: a question merely mentioning a past purchase/checkout tripped the bare
// pay/purchase/buy/checkout/... pattern below and got silently auto-declined (fails-closed) as a
// HIGH-risk money-spending request. "pay"/"buy"/"transfer money"/"wire" are left in the bare
// pattern below — they're overwhelmingly verbs in ordinary usage and weren't the words the live
// failure hit.
// h12: "purchase orders" is a common business noun-compound with sentence-initial "Purchase"
// having no preceding determiner for the lookbehind to exclude on — found via live
// testing: "Purchase orders take forever to get approved at my company, it's so frustrating."
// misfired HIGH. Same sentence-initial gap already patched for the cancel/publish
// patterns via a trailing noun-compound exclusion.
// batch 19 (h11): "history" (purchase history) is the same sentence-initial noun-compound gap as
// "orders" above — found via live testing: "Purchase history on this site is really hard to find,
// the search is broken." misfired HIGH.

// Same noun-vs-verb ambiguity for "post"/"tweet" ("I saw an interesting post", "did you see that
// tweet") — found via live testing alongside the purchase pattern above, same false-positive
// shape on the "publishes content publicly" HIGH pattern.
// A sentence-initial "Post"/"Tweet" (capitalized, nothing precedes it) has no determiner for
// the lookbehind to exclude on at all — found via live testing: "Post engagement has been
// dropping across all my accounts this month." (a social-media analytics observation, no
// publishing request) still misfired HIGH. "engagement"/"engagements" added to the trailing
// exclusion, the same noun-compound shape the cancel pattern's link/option/button list below
// already uses for its own sentence-initial gap.
// batch 10 re-probe (conv166/h6): "office"/"mortem" are the same sentence-initial noun-compound
// gap as "engagement" above, just not exhaustively covered by that one earlier fix — found via
// live testing: "Post office hours changed this week, they now close at 5." misfired HIGH.
// batch 19 (h12): "count" (post count) is the same sentence-initial noun-compound gap as
// "office"/"mortem" above — found via live testing: "Post count on my account keeps resetting for
// no reason, it's really annoying." misfired HIGH.

// "book" in "schedule|book|reserve" has the same noun-vs-verb ambiguity ("a good book
// about jazz") — found via live testing: a book recommendation request mistagged MEDIUM risk
// ("books or schedules something") purely because of the word "book". "schedule"/"reserve" are
// left bare; they weren't the word the live failure hit and are far less commonly nouns here.
// h10: same unfixed sentence-initial gap as the email/text and purchase patterns above
// — "Book recommendations" has no preceding determiner and "recommendations" wasn't in the
// trailing noun-compound exclusion — found via live testing: "Book recommendations from my
// sister were great this month, I finished three of them already." misfired MEDIUM.
// batch 10 re-probe (conv166/h9): "signing" is the same sentence-initial noun-compound gap as
// club/report/recommendations above, just not exhaustively covered by those two earlier fixes —
// found via live testing: "Book signing events are popular at that indie bookstore this
// weekend." misfired MEDIUM with no scheduling request present.
// h4: same sentence-initial noun-compound gap, one more not yet covered — "store" (book store) —
// found via live testing: "Book store closures have been in the news a lot lately, it's sad to
// see." misfired MEDIUM.
// batch 34 (h6, re-probing conv381): same sentence-initial noun-compound gap — "fair" (book
// fair) wasn't in the trailing exclusion list either — found via live testing: "Book fair at
// school this weekend was really fun for the kids." misfired MEDIUM with no live
// booking/scheduling request present. Added "fairs?" to the trailing exclusion.

// "schedule" is just as common a plain noun ("my schedule is completely packed") as "book" is —
// found via live testing, same false-positive shape as the book pattern above: a determiner
// right before "schedule" tripped the bare pattern below and mistagged MEDIUM "books or schedules
// something" with no scheduling request present. "reserve" is left in the same pattern; it wasn't
// the word the live failure hit.
// h11: same unfixed sentence-initial gap as the book pattern above — "Schedule conflicts" has
// no preceding determiner and "conflicts" wasn't in the trailing exclusion — found via live
// testing: "Schedule conflicts are the worst part of managing a team, especially with people
// across time zones." misfired MEDIUM.
// batch 23 (h4, re-probing conv381): "reserve" has its own financial-noun-compound sense
// ("reserve funds", "cash reserve requirements") distinct from "schedule"'s idioms above, and a
// sentence-initial "Reserve" has no preceding determiner for the lookbehind to exclude on
// either — found via live testing: "Reserve funds at my company only cover about three months of
// expenses, which worries me a bit." (a plain financial observation, no scheduling/reservation
// request) misfired MEDIUM. Added "funds?"/"requirements?" to the trailing exclusion, the same
// noun-compound shape already used for the book/order patterns above.
// batch 24 (h8, re-probing conv381): same sentence-initial noun-compound gap as "conflicts"/
// "funds"/"requirements" above — "change(s)" wasn't in the trailing exclusion list, and a
// sentence-initial "Schedule" has no preceding determiner either — found via live testing:
// "Schedule change requests have to go through HR now." misfired MEDIUM with no live
// scheduling request present. Added "changes?" to the trailing exclusion.
// batch 29 (h6, re-probing conv381/conv397): same sentence-initial noun-compound gap as
// "conflicts"/"funds"/"requirements"/"changes" above — "detail(s)" wasn't in the trailing
// exclusion list either — found via live testing: "Schedule details are attached for the
// conference, let me know if you have questions." misfired MEDIUM with no live scheduling
// request present. Added "details?" to the trailing exclusion.
// batch 34 (h6, re-probing conv381): same sentence-initial noun-compound gap as
// "conflicts"/"funds"/"requirements"/"changes"/"details" above — "adjustment(s)" wasn't in the
// trailing exclusion list either — found via live testing: "Schedule adjustments are common
// this time of year at my company." misfired MEDIUM with no live scheduling request present.
// Added "adjustments?" to the trailing exclusion.
// batch 42 (h3, re-probing conv381/conv397): same gap again — "template(s)" wasn't in the
// trailing exclusion list either — found via live testing: "Schedule template for the new hires
// still needs work, nobody's touched it in weeks." misfired MEDIUM with no live scheduling
// request present. Added "templates?" to the trailing exclusion.

// "forward" is a send-a-message action just as much as "send"/"email"/"text" ("forward this
// email to my accountant") but wasn't a keyword anywhere in highRiskPatterns for a long time —
// found via live testing: a genuinely risky send-on-my-behalf request never gated at all. Unlike
// email/text, "forward" is common as a non-messaging adverb/particle ("going forward", "move
// forward with the plan", "look forward to it") — none of those take a determiner+noun object the
// way "forward this/that/my email" does, so requiring an object determiner right after the verb
// (rather than the email/text pattern's noun-context lookbehind) is the narrower, more reliable
// signal here.
// h1: "going forward"/"moving forward" is a common adverbial idiom ("I'll try to be more
// organized going forward this year") that can be immediately followed by one of the object
// words below as a filler continuation, not an object of "forward" — found via live testing:
// "going forward this year" misfired HIGH despite "this" not actually being what's being
// forwarded. A determiner-object pattern with no live "forward X" action can't distinguish the
// two without excluding the idiom's own lead-in words directly.
// batch 10 re-probe (conv166/h4): the object-determiner alternation was missing "our"/"your"/
// "his"/"a"/"an"/"us" — unlike this file's other patterns (which fail toward over-triggering,
// the safety-conservative direction), a missing determiner here is the opposite failure mode: a
// genuine live forward-a-message request silently never gates HIGH at all — found via live
// testing: "Please forward our proposal to the client before end of day." never triggered an
// approval prompt.
// batch 19 (h6): the object-determiner alternation was still missing possessive "their" — found
// via live testing: "Please forward their proposal to the client before end of day." never
// triggered an approval prompt at all — the opposite failure direction from the other patterns in
// this file (a false negative, letting a genuine send-on-behalf request through with no gate).
// h1 (this batch): the object-determiner list still required SOME determiner right after the
// verb — a bare plural-noun object with no determiner at all ("forward invoices to accounting",
// "forward emails to the client") has nothing for that alternation to match, so a genuine
// send-on-behalf request slipped through ungated (the same false-negative direction as the
// batch-19 "their" fix above). Added a second alternative that accepts any bare object as long as
// it's followed by "to" (the recipient marker) — "to" is what actually signals a live forward-to-
// someone action, the same signal every real example in this file's own test suite already
// contains. The trailing exclusion right after the verb keeps this from misfiring on "forwarding
// address/rules/service"-shaped noun compounds, which have the same bare-object-then-preposition
// shape but aren't a live send request.

// "delete"/"remove"/"wipe"/"erase" have the same noun-vs-verb ambiguity the order pattern and its
// siblings already handle ("the Remove button", "my delete key", "the wipe cycle on my
// dishwasher") — found via live testing: a UI-element or appliance-cycle mention with a preceding
// determiner tripped the bare pattern below and got silently auto-declined (fails-closed) as a
// HIGH-risk irreversible-deletion request with no delete/remove intent at all.
// h8: a product/brand name like "Remove.bg" has a period directly after the keyword with no
// whitespace at all — the trailing exclusion's `(?!\s+...)` requires whitespace to even attempt
// matching, so it never engages, and a sentence-initial "Remove" has no preceding determiner for
// the lookbehind to exclude on either — found via live testing: "Remove.bg is a great tool for
// removing backgrounds from photos, have you heard of it?" misfired HIGH. Excluding a keyword
// directly followed by ".word" (a domain/filename-shaped token, not a verb's own object) closes
// this without requiring whitespace.
// batch 10 re-probe (conv166/h7): the trailing exclusion only ever covered is/was (plus the
// domain-token ".word" exclusion) — never extended with a noun-compound list the way
// the cancel pattern's link/option/button/confirmation list was — found via live testing:
// "Delete key on this keyboard doesn't work half the time, so annoying." misfired HIGH.
// h3: same UI-element noun-compound shape, missing the exact one the cancel pattern's sibling
// list already covers — "button" — found via live testing: "Delete button on this remote doesn't
// work half the time, so annoying." misfired HIGH.
// batch 19 (h3): "queue" (delete/print queue) is the same UI/system-element noun-compound gap as
// key/button above — found via live testing: "Delete queue on this printer keeps growing no
// matter how many times IT clears it." misfired HIGH.
// batch 29 (h1, re-probing conv381/conv397 cluster): "confirmation(s)" is the same noun-compound
// gap the order/cancel patterns' own trailing lists already cover for the
// analogous case, but the delete pattern never got it — found via live testing: "Delete
// confirmation for my old account finally came through this morning." (a status observation, no
// live delete request) misfired HIGH.
// batch 34 (h5, re-probing conv381/conv397 cluster): "option(s)" is the same UI-element
// noun-compound gap the cancel pattern's own trailing list already covers ("link/option/button"),
// but the delete pattern never got it — found via live testing: "Delete option is missing from
// the settings menu on this app, does anyone know why?" (a UI question, no live delete request)
// misfired HIGH.

// "pay"/"wire" are common plain nouns ("my pay was late this month", "the wire behind my desk")
// just as much as "buy"/"transfer money" are verbs — found via live testing, same false-positive
// shape as the delete pattern above: a determiner-preceded noun mention tripped the bare pattern
// and got auto-declined as a HIGH-risk money-spend request with no spend request present.
// h4: "pay attention (to X)" is an extremely common idiom with no money meaning at all, and
// "attention" wasn't in the trailing exclusion — found via live testing: "Please pay attention
// to this email from my landlord, it looks important." misfired HIGH.
// batch 10 re-probe (conv166/h3): the trailing exclusion only covered is/was/attention, the same
// class of gap conv149's narrower "pay attention" fix left open for other noun-compounds — found
// via live testing: "Pay stubs from my old job are surprisingly hard to track down online."
// misfired HIGH.
// h2: same class of gap, one more noun-compound not in the trailing list — "day" (payday as two
// words) — found via live testing: "Pay day at my company always falls on the last Friday of the
// month." misfired HIGH.
// batch 19 (h2): "grade" (pay grade) is the same noun-compound gap as "day"/"period" above — found
// via live testing: "Pay grade differences between departments never made sense to me, honestly."
// misfired HIGH.
// batch 29 (h2, re-probing conv381/conv397 cluster): the trailing exclusion list above only ever
// covered "pay"-noun-compounds, never "wire"-noun-compounds ("wire fraud", "wire mesh", "high
// wire act") — found via live testing: "Wire fraud cases have increased significantly this year
// according to the report." (a plain statement, no live wire-transfer request) misfired HIGH via
// the bare "wire" alternative. Added "fraud" to the trailing exclusion.
// batch 34 (h4, re-probing conv381/conv397 cluster): "transfer" itself is the same
// "wire"-noun-compound gap as "fraud" above — "wire transfer" is far more often the plain noun
// phrase for a bank fee/charge than a live "wire transfer money" request — found via live
// testing: "Wire transfer fees at my bank are outrageous, I switch banks every few years because
// of it." (a plain observation, no live transfer request) misfired HIGH via the bare "wire"
// alternative. Added "transfers?" to the trailing exclusion.

// "cancel"/"unsubscribe" have the same mention-vs-request ambiguity — "an unsubscribe link"
// reintroduces the noun-compound shape the email/text pattern's trailing exclusion already
// handles ("the message/address I'm looking for"), and a determiner right before "unsubscribe"
// ("an unsubscribe link") is the same noun-signaling shape as the delete pattern above — found
// via live testing: a message merely describing an unfindable unsubscribe link tripped the bare
// pattern and got auto-declined as a HIGH-risk cancellation request with no live request at all.
// A sentence-initial "Cancel" (capitalized, nothing precedes it) has no determiner for
// the lookbehind to exclude on either — found via live testing: "Cancel confirmations from
// that airline always take a few days to show up in my inbox." (a status observation, no live
// cancellation request) still misfired HIGH. "confirmation"/"confirmations" added to the trailing
// exclusion alongside link/option/button.
// h5: "cancel (each other) out" is a common math/physics idiom with no subscription/commitment
// meaning at all — "each" directly follows "cancel" with no preceding determiner for the
// lookbehind to exclude on, and wasn't in the trailing exclusion either — found via live
// testing: "These two effects cancel each other out in the final calculation, so the net result
// is zero." misfired HIGH. Scoped to "each other" specifically (not bare "each") so a genuine
// request like "cancel each of my recurring subscriptions" still gates normally.
// batch 10 re-probe (conv166/h8): "culture" (as in "cancel culture") is an extremely common
// phrase this pattern's own trailing noun-compound treatment never got extended to cover — found
// via live testing: "Cancel culture has gotten out of hand online lately, don't you think?"
// misfired HIGH.
// batch 19 (h4): "policy" (cancellation/return policy) is the same sentence-initial noun-compound
// gap as "culture" above — found via live testing: "Cancel policy on this website is really
// unclear, I can't tell if I'd get a refund." misfired HIGH.
// h3 (re-probing conv381/conv397 cluster, batch 29): "rate(s)" (unsubscribe rate, a marketing
// metric noun-compound, not a live cancellation request) wasn't in the trailing exclusion list
// either — found via code reading (convSweep1's live test hit the email/text pattern's own
// "campaign" gap on the same sentence first, since that pattern is checked earlier in
// highRiskPatterns and masked this one from ever being reached): "Unsubscribe rates jumped
// after last week's email campaign, according to marketing." would still misfire HIGH here once
// the email/campaign gap above is fixed, since "unsubscribe" followed by "rates" isn't excluded.
// Added "rates?" to the trailing exclusion pre-emptively rather than waiting for a future batch
// to rediscover it once the masking pattern above no longer fires first.

// A reminder/event request names what to be reminded about, not an action to carry out right
// now — checked before highRiskPatterns below so "remind me to buy milk" or "remind me to
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
// cleaning." bypassed the reminder pattern entirely (falling through as LOW, skipping the same
// bulk-confirmation gate) purely because it used "create" instead of "set". Duplicated identically
// in reminder-tools.ts and file-tools-mcp-server.mjs's REMINDER_REQUEST_MARKER — keep all three in
// sync by hand (see the playbook's claude-cli-backend gotcha).

// "remind me what my job is?" / "remind me again what the first item was?" ask the assistant to
// RECALL something already stated in the conversation — they contain "remind me" but aren't a
// create-reminder request at all, and the reminder pattern's bare match doesn't distinguish the
// two. Found via live testing: no reminder is actually (mis)created and no approval gate fires
// incorrectly, but the reply still surfaced a misleading [risk: MEDIUM] tag. A WH-word (what/who/
// when/where/why/how) after "remind me", plus a trailing "?" (same fails-closed shape the
// past-tense-question pattern already uses, so an oddly-phrased genuine create-reminder request
// still gates normally by default), is the recall-question shape.
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

// A reminder-shaped request that ALSO looks enumerated (see looksLikeEnumeratedItems) risks the
// model silently bulk-creating several reminders in one turn with no chance to confirm first —
// prompt-level nudges for this exact class of behavior have not reliably held across past testing
// (see conv12/conv21's shell-reuse wording attempts, and conv28/conv51's bulk-reminder finding),
// so this gates deterministically instead, via the same simple message-level approval flow
// HIGH-risk requests already use (requiresApproval, resolved by a later approved:true re-entry —
// see assistant.ts's runTurn). A false positive here just costs one extra confirmation for a
// single wordy reminder that happens to look enumerated — same tradeoff decomposition-classifier.ts
// already accepts for its own enumeration signals.

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

// A first-person past narrative ("Yesterday I had to cancel my dentist appointment because of
// the snowstorm.") reports an action the user themselves already completed — neither
// the past-tense-question pattern's shape (needs a trailing "?") nor the reported-third-party
// pattern's shape (needs a third-person subject) covers it, so bare "cancel"/"delete" still
// tripped highRiskPatterns and forced an approval prompt for something already done, with nothing
// left to approve. Narrow on purpose ("I had to" / "I already" — a genuine forced-or-completed-
// action frame): an imperative ("cancel my subscription") or first-person intent ("I will cancel
// it", "I need to cancel it") has neither shape and still gates normally.
// "needed to"/"decided to"/"chose to"/"wanted to" are the same completed-action frame as "had to"
// — an infinitive-after-modal construction that leaves the HIGH-risk verb in its exact bare form
// (unlike simple past tense "I cancelled", which evades the bare \bcancel\b keyword on its own via
// the missing word boundary between stem and -ed suffix) — found via live testing: "I needed to
// cancel my dentist appointment yesterday" and "I decided to delete those old vacation photos last
// weekend" both still tripped highRiskPatterns for an action already completed.

// A message can report a THIRD PARTY's action/threat/plan rather than ask the assistant to do
// anything — "my landlord said he will cancel my lease if I don't pay rent" contains "cancel" and
// "pay", but the acting subject in both cases is someone else, relayed as reported speech, not a
// live instruction from the user. Narrow and modeled on the past-tense-question pattern: a
// speech-report verb (said/told me/mentioned/warned/threatened) followed reasonably closely by a
// third-person subject (he/she/they/it) and a future/conditional auxiliary OR an equivalent
// "plans to"/"is going to"/"intends to"/"wants to" continuation — found via live testing: "My
// roommate warned that she plans to delete our shared documents folder..." uses "plans to"
// instead of a bare modal, and the modal-only version of this pattern didn't cover it, leaving the
// bare "delete" keyword to still trip highRiskPatterns. An imperative ("cancel my subscription")
// or first-person intent ("I will cancel it") has no third-person subject here and still gates
// normally.

// The past-tense-question/reported-third-party/first-person-past-narrative exemptions originally
// ran a single bare .test() against the WHOLE message — none of them anchored or clause-scoped the
// way fact-extraction.ts's CLAUSE_BOUNDARY splitting is (added specifically to fix this exact
// whole-message-vs-clause bug class for NON_CLAIM_MARKERS). That let an unrelated exemption-shaped
// clause suppress highRiskPatterns for the ENTIRE message, including a live, different HIGH-risk
// imperative riding along in the same message — found via live testing: "I already deleted the old
// vacation photos last year, and please delete my entire Google Photos account now." let the
// past-narrative clause suppress gating for the live account-deletion request. Splitting on a
// comma before a coordinating conjunction (the same shape fact-extraction.ts splits on, minus
// sentence-ending punctuation — several of these exemptions rely on a trailing "?" surviving
// within its own clause) and checking each clause independently keeps one clause's exemption from
// reaching across into a separate, live request clause.
//
// batch 10 re-probe (conv166/h1): the comma-before-conjunction boundary never covered a
// semicolon, unlike decomposition-classifier.ts's own SEMICOLON_LIST_MARKER, which already
// treats a semicolon as a genuine clause/item boundary — found via live testing: "I already
// cancelled my old gym membership; please cancel my current streaming subscription now." let
// the first-person-past-narrative pattern match across the whole unsplit string and silently
// suppress HIGH-risk gating for the live, different second request too. A semicolon is
// unambiguously a clause boundary in ordinary prose (unlike a bare comma, which needs the
// conjunction check to avoid over-splitting), so it's split on unconditionally.

function splitRiskClauses(message: string): string[] {
  return splitOnAny(risk.riskClauseBoundary, message)
}

function isExemptClause(clause: string): boolean {
  return testAny(risk.pastTenseQuestion, clause) || testAny(risk.reportedThirdPartySpeech, clause) || testAny(risk.firstPersonPastNarrative, clause)
}

export function classifyRisk(message: string): RiskClassification {
  const isReminderRecallQuestion = testAny(risk.reminderRecallQuestion, message)
  if (risk.reminderPattern.pattern.test(message) && !isReminderRecallQuestion) {
    if (looksLikeEnumeratedItems(message)) {
      return { riskLevel: 'MEDIUM', requiresApproval: true, reason: `Request ${risk.bulkReminderReason}.` }
    }
    return { riskLevel: 'MEDIUM', requiresApproval: false, reason: `Request ${risk.reminderPattern.reason}.` }
  }
  for (const clause of splitRiskClauses(message)) {
    if (isExemptClause(clause)) continue
    for (const { pattern, reason } of risk.highRiskPatterns) {
      if (pattern.test(clause)) {
        return { riskLevel: 'HIGH', requiresApproval: true, reason: `Request ${reason}.` }
      }
    }
  }
  for (const { pattern, reason } of risk.mediumRiskPatterns) {
    if (pattern.test(message)) {
      return { riskLevel: 'MEDIUM', requiresApproval: false, reason: `Request ${reason}.` }
    }
  }
  return { riskLevel: 'LOW', requiresApproval: false, reason: 'Conversational request with no detected side effects.' }
}
