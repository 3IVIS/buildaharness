import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { classifyRisk, classifyRiskWithLLM, looksActionOriented } from './risk-classifier.js'

describe('classifyRisk', () => {
  it('flags a HIGH risk request', () => {
    expect(classifyRisk('Please delete my old invoices').riskLevel).toBe('HIGH')
  })

  it('flags a MEDIUM risk request', () => {
    expect(classifyRisk('Can you book a table for two tonight').riskLevel).toBe('MEDIUM')
  })

  it('requires approval for a reminder-shaped request that looks enumerated (bulk creation risk)', () => {
    const result = classifyRisk(
      'Remind me to: research the company, prepare answers to behavioral questions, pick out what to wear, and plan my route.',
    )
    expect(result.riskLevel).toBe('MEDIUM')
    expect(result.requiresApproval).toBe(true)
  })

  it('does not require approval for an ordinary single-item reminder request', () => {
    const result = classifyRisk('Remind me to call the dentist tomorrow.')
    expect(result.riskLevel).toBe('MEDIUM')
    expect(result.requiresApproval).toBe(false)
  })

  it('classifies a reminder naming a HIGH-risk-keyword action as MEDIUM (creating the reminder), not HIGH (doing the action now)', () => {
    // d100db3: REMINDER_PATTERN wasn't checked before HIGH_RISK_PATTERNS, so "remind me to
    // delete the old invoices" tripped the delete/remove HIGH pattern and forced an approval
    // prompt for an everyday reminder — found via live testing. This was documented in a code
    // comment (REMINDER_PATTERN's doc comment above) but never pinned down as its own test.
    const result = classifyRisk('remind me to delete the old invoices')
    expect(result.riskLevel).toBe('MEDIUM')
    expect(result.requiresApproval).toBe(false)
  })

  it('does not flag a "remind me" recall question as MEDIUM', () => {
    expect(classifyRisk('Can you remind me what my job is and what my hobby is?').riskLevel).toBe('LOW')
    expect(classifyRisk('And can you remind me again what the very first item was?').riskLevel).toBe('LOW')
  })

  it('still flags an actual create-reminder request even when phrased with "remind me" and a question mark', () => {
    expect(classifyRisk('Could you remind me to call the dentist tomorrow?').riskLevel).toBe('MEDIUM')
  })

  it('does not flag a past-tense yes/no question asking whether a HIGH-risk action already happened', () => {
    // d100db3: the original found case — "Did that actually send a real email just now?" is a
    // follow-up question about a completed action, not a live request, but tripped the
    // send-a-message HIGH pattern and forced an approval prompt for a question with no side
    // effects. Later commits (h3/h10 above) generalized PAST_TENSE_QUESTION well beyond this
    // exact wording, but the original bug sentence itself was never pinned down as a test.
    expect(classifyRisk('Did that actually send a real email just now?').riskLevel).not.toBe('HIGH')
  })

  it('classifies ordinary conversation as LOW', () => {
    expect(classifyRisk('What timezone is Tokyo in?').riskLevel).toBe('LOW')
  })

  it('flags a genuine purchase request using "order" as a verb', () => {
    expect(classifyRisk('Can you order me a pizza').riskLevel).toBe('HIGH')
    expect(classifyRisk('please order the parts from the supplier').riskLevel).toBe('HIGH')
  })

  it('does not flag a stated preference using "order" as a noun', () => {
    expect(classifyRisk('My favorite coffee order is an oat milk cortado.').riskLevel).toBe('LOW')
    expect(classifyRisk('My usual order was a cortado.').riskLevel).toBe('LOW')
    expect(classifyRisk('in order to finish this I need more time').riskLevel).toBe('LOW')
  })

  it('does not flag an informational statement using "order" as a noun preceded by an article/demonstrative', () => {
    // ORDER_VERB_PATTERN's lookbehind originally only excluded a possessive pronoun before
    // "order" — a definite/indefinite article or demonstrative is just as clearly a noun usage.
    expect(classifyRisk('The order arrived yesterday, thanks for the update.').riskLevel).toBe('LOW')
    expect(classifyRisk('An order came in this morning.').riskLevel).toBe('LOW')
    expect(classifyRisk('That order was wrong.').riskLevel).toBe('LOW')
  })

  it('still flags a genuine purchase request phrased with an article before "order"', () => {
    expect(classifyRisk('Please order the parts from the supplier').riskLevel).toBe('HIGH')
  })

  it('does not flag a declarative sentence reporting a third party\'s reported/hypothetical action', () => {
    // The user isn't asking the assistant to cancel or pay anything here — they're relaying
    // what someone else said they would do.
    const result = classifyRisk("My landlord said he will cancel my lease if I don't pay rent by Friday.")
    expect(result.riskLevel).not.toBe('HIGH')
  })

  it('still flags a first-person or imperative request even near reported-speech-shaped words', () => {
    expect(classifyRisk('Please cancel my gym membership.').riskLevel).toBe('HIGH')
  })

  it('flags "email"/"text" used as verbs, which the literal "send" pattern misses', () => {
    expect(classifyRisk('email the landlord about the leak').riskLevel).toBe('HIGH')
    expect(classifyRisk('text my sister that I\'ll be late').riskLevel).toBe('HIGH')
    expect(classifyRisk('Can you text him now?').riskLevel).toBe('HIGH')
  })

  it('does not flag "email"/"text" used as nouns', () => {
    expect(classifyRisk('check my email').riskLevel).toBe('LOW')
    expect(classifyRisk('reply to that text').riskLevel).toBe('LOW')
    expect(classifyRisk('an email came in this morning').riskLevel).toBe('LOW')
    expect(classifyRisk('the text message says he is running late').riskLevel).toBe('LOW')
    expect(classifyRisk('what is my email address').riskLevel).toBe('LOW')
    expect(classifyRisk('I got a text from him').riskLevel).toBe('LOW')
  })

  it('does not flag "text"/"order" as nouns preceded by a bare quantifier (no/any/some/every/each)', () => {
    // h1/h2: the determiner-exclusion lookbehind originally only covered possessives/articles/
    // demonstratives — bare quantifiers are the same noun-signaling shape.
    expect(classifyRisk("There's no text from him yet, so I'll just wait a bit longer.").riskLevel).toBe('LOW')
    expect(classifyRisk("Every order I've placed with them this year has been late.").riskLevel).toBe('LOW')
    expect(classifyRisk('There is no order confirmation yet.').riskLevel).toBe('LOW')
  })

  it('does not flag a present-tense yes/no question about a HIGH-risk-keyword topic', () => {
    // h3: PAST_TENSE_QUESTION's auxiliary list originally only covered past-tense/completed
    // auxiliaries (did/was/were/has/have) — "does"/"do" is the same question shape, present tense.
    const result = classifyRisk('Does this subscription cancel automatically after the 30-day trial, or do I need to do something?')
    expect(result.riskLevel).not.toBe('HIGH')
  })

  it('does not flag reported third-party speech using a "plans to"/"is going to" continuation instead of a bare modal', () => {
    // h8: REPORTED_THIRD_PARTY_SPEECH originally required a bare modal ('ll/will/would/might/could)
    // immediately after the third-person subject.
    const result = classifyRisk("My roommate warned that she plans to delete our shared documents folder if we don't split the rent by Friday.")
    expect(result.riskLevel).not.toBe('HIGH')
  })

  it('flags a plural "set reminders for X, Y, and Z" bulk request instead of falling through as LOW', () => {
    // h6: REMINDER_PATTERN's fixed phrase list originally only matched the singular "set a
    // reminder" — the plural phrasing never matched at all, skipping both ordinary MEDIUM
    // classification and the bulk-reminder confirmation gate below.
    const result = classifyRisk('Set reminders for calling the bank, emailing the landlord, and picking up dry cleaning.')
    expect(result.riskLevel).toBe('MEDIUM')
    expect(result.requiresApproval).toBe(true)
  })

  it('flags a "create reminders for X, Y, and Z" bulk request phrased with "create" instead of "set"', () => {
    // h5: REMINDER_PATTERN had "set a/plural reminder(s)" and "create a/an event(s)" but no
    // "create a/plural reminder(s)" alternative, despite it being an obvious everyday synonym —
    // this phrasing bypassed REMINDER_PATTERN entirely and fell through as LOW with no bulk gate.
    const result = classifyRisk('Please create reminders for calling the bank, emailing the landlord, and picking up dry cleaning.')
    expect(result.riskLevel).toBe('MEDIUM')
    expect(result.requiresApproval).toBe(true)
  })

  it('still flags an ordinary single "create a reminder" request as MEDIUM without requiring approval', () => {
    const result = classifyRisk('Can you create a reminder to call the dentist tomorrow?')
    expect(result.riskLevel).toBe('MEDIUM')
    expect(result.requiresApproval).toBe(false)
  })

  it('does not flag "purchase"/"checkout" used as nouns', () => {
    // h1: unlike ORDER_VERB_PATTERN, the bare pay/purchase/buy/checkout pattern had no
    // noun-context exclusion.
    expect(classifyRisk("My purchase from last week still hasn't shipped -- is that normal for this store?").riskLevel).not.toBe('HIGH')
    expect(classifyRisk('Also, the checkout process on their site was really slow when I placed it.').riskLevel).not.toBe('HIGH')
  })

  it('flags a genuine purchase/checkout request using the words as verbs', () => {
    expect(classifyRisk('Can you purchase this for me').riskLevel).toBe('HIGH')
    expect(classifyRisk('Please checkout my cart now').riskLevel).toBe('HIGH')
  })

  it('does not flag "post"/"tweet" used as nouns', () => {
    // h2: the publish-content pattern had no noun-context exclusion either.
    expect(
      classifyRisk('I saw a really interesting post about home renovation on social media earlier -- do you know good sources for tile suppliers?')
        .riskLevel,
    ).not.toBe('HIGH')
    expect(classifyRisk("Also, did you see that tweet about the new phone launch everyone's talking about?").riskLevel).not.toBe('HIGH')
  })

  it('flags a genuine publish request using "post"/"tweet" as verbs', () => {
    expect(classifyRisk('Can you post this to my timeline').riskLevel).toBe('HIGH')
    expect(classifyRisk('Please tweet this announcement').riskLevel).toBe('HIGH')
  })

  it('does not flag a first-person past narrative reporting an already-completed action', () => {
    // h3: PAST_TENSE_QUESTION needs a trailing "?" and REPORTED_THIRD_PARTY_SPEECH needs a
    // third-person subject — neither covers a first-person past narrative with no question mark.
    expect(classifyRisk('Yesterday I had to cancel my dentist appointment because of the snowstorm.').riskLevel).not.toBe('HIGH')
    expect(classifyRisk('I had to delete a bunch of duplicate photos from my phone last night to free up storage.').riskLevel).not.toBe('HIGH')
  })

  it('still flags a live cancel/delete request despite containing "had"/"already"-adjacent words', () => {
    expect(classifyRisk('Please cancel my gym membership.').riskLevel).toBe('HIGH')
    expect(classifyRisk('I need to cancel my subscription right now.').riskLevel).toBe('HIGH')
  })

  it('does not flag a present-tense "is"/"are" yes/no question about a HIGH-risk-keyword topic', () => {
    // h10 (sharper root cause than the original hypothesis): PAST_TENSE_QUESTION's auxiliary list
    // had "does"/"do" but not "is"/"are", the same present-tense "to be" question shape.
    expect(
      classifyRisk('Is the Remove button on the settings page supposed to be grayed out, or is that a bug?').riskLevel,
    ).not.toBe('HIGH')
  })

  it('flags "forward" used as a send-a-message verb', () => {
    // h8: no keyword in HIGH_RISK_PATTERNS covered "forward" at all.
    expect(classifyRisk('Please forward this email to my accountant so she can file it.').riskLevel).toBe('HIGH')
  })

  it('does not flag "forward"/"going forward" used as a non-messaging adverb', () => {
    expect(classifyRisk("Going forward, let's touch base every Monday.").riskLevel).not.toBe('HIGH')
    expect(classifyRisk("I'm looking forward to the trip.").riskLevel).not.toBe('HIGH')
  })

  it('does not flag "book" used as a noun', () => {
    // convN: MEDIUM_RISK_PATTERNS' bare schedule|book|reserve pattern had no noun-context
    // exclusion either.
    expect(classifyRisk('Can you recommend a good book about the history of jazz?').riskLevel).not.toBe('MEDIUM')
  })

  it('still flags a genuine booking request using "book" as a verb', () => {
    expect(classifyRisk('Can you book a table for two tonight').riskLevel).toBe('MEDIUM')
  })

  it('recognizes a statement-phrased reminder recall with no trailing "?"', () => {
    // h6: REMINDER_RECALL_QUESTION required a trailing "?" — a recall phrased as a flat
    // statement ending in past-tense "was" is the same recall shape without one.
    expect(classifyRisk('Remind me again what my pharmacy reminder was.').riskLevel).toBe('LOW')
  })

  it('recognizes a reminder recall question with the WH-word before "remind me"', () => {
    expect(classifyRisk('What did you just remind me about?').riskLevel).toBe('LOW')
  })

  it('does not flag "delete"/"remove"/"wipe" used as nouns for a UI element or appliance cycle', () => {
    // h1: the bare delete/remove/wipe/erase HIGH pattern had no noun-context exclusion at all,
    // unlike ORDER_VERB_PATTERN and its siblings.
    expect(classifyRisk("The Remove button on this app is grayed out and I can't figure out why.").riskLevel).not.toBe('HIGH')
    expect(classifyRisk('My delete key on this keyboard has been sticking lately, sometimes it double-types.').riskLevel).not.toBe('HIGH')
    expect(classifyRisk('I ran the wipe cycle on my dishwasher last night and it still left spots on the glasses.').riskLevel).not.toBe('HIGH')
  })

  it('still flags a genuine delete/remove request', () => {
    expect(classifyRisk('Please delete the old backup files in my downloads folder.').riskLevel).toBe('HIGH')
    expect(classifyRisk('Please delete my old invoices').riskLevel).toBe('HIGH')
  })

  it('does not flag "wire"/"pay" used as plain nouns', () => {
    // h2: the bare pay/buy/transfer money/wire HIGH pattern had no noun-context exclusion either.
    expect(classifyRisk('The wire behind my desk keeps coming loose and I keep tripping over it, any ideas?').riskLevel).not.toBe('HIGH')
    expect(classifyRisk('My pay was two days late this month, is that normal for a brand new job?').riskLevel).not.toBe('HIGH')
  })

  it('does not flag "schedule" used as a plain noun', () => {
    // h6: MEDIUM_RISK_PATTERNS' bare schedule/reserve pattern had no noun-context exclusion,
    // unlike BOOK_VERB_PATTERN right next to it.
    expect(classifyRisk("My schedule is completely packed this week, I don't think I have room for anything else.").riskLevel).not.toBe('MEDIUM')
  })

  it('still flags a genuine scheduling request', () => {
    expect(classifyRisk('Can you schedule a meeting for tomorrow at 3pm').riskLevel).toBe('MEDIUM')
  })

  it('does not flag a message merely describing/mentioning an unsubscribe link', () => {
    // h7: the bare cancel/unsubscribe HIGH pattern had no exclusion for mentioning an unsubscribe
    // option vs. actually requesting to unsubscribe.
    expect(
      classifyRisk("There's supposed to be an unsubscribe link at the bottom of this newsletter but I can't find it anywhere.").riskLevel,
    ).not.toBe('HIGH')
  })

  it('does not flag an infinitive-after-modal past narrative ("needed to", "decided to", "chose to")', () => {
    // h3 (refined): FIRST_PERSON_PAST_NARRATIVE's exemption only covered "i had to"/"i already" —
    // other modal constructions leave the HIGH-risk verb in bare form too, describing something
    // already completed.
    expect(classifyRisk('I needed to cancel my dentist appointment yesterday because I was sick.').riskLevel).not.toBe('HIGH')
    expect(classifyRisk('I decided to delete those old vacation photos last weekend to free up space.').riskLevel).not.toBe('HIGH')
    expect(classifyRisk('I chose to unsubscribe from that mailing list a few days ago, way too many emails.').riskLevel).not.toBe('HIGH')
  })

  it('flags "checking"/"reading" email as still receive-shaped despite the -ing inflection', () => {
    // h5: EMAIL_TEXT_VERB_PATTERN's receive-verb exclusion only matched exact base word forms —
    // an -ing inflection like "checking" doesn't satisfy \bcheck\b's trailing word boundary.
    expect(classifyRisk('I spend way too much time checking email every single morning before I even get out of bed.').riskLevel).not.toBe('HIGH')
  })

  it('does not flag a single reminder followed by an unrelated noun-subject aside', () => {
    // h8: ONE_COMMA_LIST_MARKER's subject-reintroduction exclusion only covered pronouns — a new
    // noun subject after and/or ("my accountant's office") wasn't excluded either.
    const result = classifyRisk("Remind me to call the bank, and my accountant's office is closed on Fridays anyway.")
    expect(result.riskLevel).toBe('MEDIUM')
    expect(result.requiresApproval).toBe(false)
  })

  it('does not flag a single reminder followed by an unrelated PROPER-NOUN-subject aside', () => {
    // h6/convH: same gap as above, but reintroducing the subject with a name instead of a pronoun.
    const result = classifyRisk('Remind me to call the bank, and Sarah will handle the rest of the emails.')
    expect(result.riskLevel).toBe('MEDIUM')
    expect(result.requiresApproval).toBe(false)
  })

  it('does not flag an ordinary fact+single-reminder message as a bulk-reminder candidate', () => {
    // h8 (incidental second occurrence): "I'm X, and remind me to Y" has a comma+and followed by
    // "remind" (not a pronoun/determiner), so the naive exclusion doesn't cover it either — but
    // there's only one "remind" in the whole message, so it isn't a bulk request.
    const result = classifyRisk("I'm vegan, and remind me to buy oat milk on the way home tonight.")
    expect(result.riskLevel).toBe('MEDIUM')
    expect(result.requiresApproval).toBe(false)
  })

  it('still requires confirmation for a genuine bulk request phrased with "remind" repeated after and/or', () => {
    const result = classifyRisk('Remind me to call the bank, and remind me to email the landlord about the leak.')
    expect(result.riskLevel).toBe('MEDIUM')
    expect(result.requiresApproval).toBe(true)
  })

  it('does not flag a noun phrase with 3+ modifier words between the determiner and the keyword', () => {
    // h1: nounContextLookbehind()'s word-gap window originally only allowed 0-2 modifier words.
    expect(classifyRisk('My extremely late final pay stub finally arrived in the mail.').riskLevel).not.toBe('HIGH')
    expect(classifyRisk('My completely unexpected surprise birthday order finally shipped today.').riskLevel).not.toBe('HIGH')
  })

  it('does not flag a quantifier ("several") not previously in NOUN_CONTEXT_DETERMINERS', () => {
    // h2: several/few/many/most/all are the same noun-signaling quantifier shape as no/any/some/
    // every/each but were missing from the list.
    expect(classifyRisk('Several delete requests came in from the support queue this morning, all resolved now.').riskLevel).not.toBe(
      'HIGH',
    )
  })

  it('does not flag a sentence-initial bare noun-compound with no preceding determiner at all', () => {
    // h2: CANCEL_VERB_PATTERN/PUBLISH_VERB_PATTERN had nothing for the lookbehind to exclude on
    // when the keyword itself opens the sentence with no determiner before it.
    expect(classifyRisk('Cancel confirmations from that airline always take a few days to show up in my inbox.').riskLevel).not.toBe(
      'HIGH',
    )
    expect(classifyRisk('Post engagement has been dropping across all my accounts this month.').riskLevel).not.toBe('HIGH')
  })

  it('does not let a past-narrative clause suppress HIGH-risk gating for a live, different request in the same message', () => {
    // h7: FIRST_PERSON_PAST_NARRATIVE/REPORTED_THIRD_PARTY_SPEECH originally ran against the whole
    // message with a bare .test(), so an unrelated exemption-shaped clause suppressed gating for
    // a live, genuinely actionable request riding along in the same message.
    expect(
      classifyRisk('I already deleted the old vacation photos from last year, and please delete my entire Google Photos account now.')
        .riskLevel,
    ).toBe('HIGH')
    expect(
      classifyRisk('My roommate said she will cancel our shared streaming subscription, so please cancel my gym membership for me right now.')
        .riskLevel,
    ).toBe('HIGH')
    expect(
      classifyRisk('I already forwarded the quarterly report to my boss yesterday, but please forward this new contract to the lawyer right now.')
        .riskLevel,
    ).toBe('HIGH')
  })

  it('does not flag "going forward"/"moving forward" immediately followed by a filler object-determiner word', () => {
    // h1: FORWARD_VERB_PATTERN's object-determiner check had no protection against the "going
    // forward"/"moving forward" idiom immediately followed by one of its own trigger words used
    // as a filler continuation, not an object of "forward".
    expect(classifyRisk("I'll try to be more organized going forward this year.").riskLevel).not.toBe('HIGH')
    expect(classifyRisk("Moving forward, let's touch base every Monday.").riskLevel).not.toBe('HIGH')
  })

  it('does not flag the "in order for X to" idiom as a purchase request', () => {
    // h2: the trailing exclusion only covered "order to", not the equally common "order for"
    // variant of the same idiom.
    expect(classifyRisk('In order for us to succeed, I need to finish this project first.').riskLevel).not.toBe('HIGH')
  })

  it('does not flag "pay attention" as a money-spend request', () => {
    // h4: the trailing exclusion had no case for the "pay attention" idiom.
    expect(classifyRisk('Please pay attention to this email from my landlord, it looks important.').riskLevel).not.toBe('HIGH')
  })

  it('does not flag the "cancel each other out" idiom as a cancellation request', () => {
    // h5: the trailing exclusion had no case for the "cancel out" idiom, and "each" (with no
    // preceding determiner) wasn't excluded by the lookbehind either.
    expect(
      classifyRisk('These two effects cancel each other out in the final calculation, so the net result is zero.').riskLevel,
    ).not.toBe('HIGH')
  })

  it('still flags a genuine "cancel each of X" request despite containing "each"', () => {
    expect(classifyRisk('Please cancel each of my recurring subscriptions.').riskLevel).toBe('HIGH')
  })

  it('does not flag a product name with no whitespace after the delete/remove keyword', () => {
    // h8: "Remove.bg" has a period directly after "Remove" with no preceding determiner
    // (sentence-initial) and no whitespace for the trailing exclusion to even attempt matching.
    expect(
      classifyRisk('Remove.bg is a great tool for removing backgrounds from photos, have you heard of it?').riskLevel,
    ).not.toBe('HIGH')
  })

  it('does not flag a sentence-initial "Text alignment..." as a send-a-message request', () => {
    // h9: EMAIL_TEXT_VERB_PATTERN never got the same sentence-initial-noun-compound fix
    // CANCEL_VERB_PATTERN/PUBLISH_VERB_PATTERN already have.
    expect(
      classifyRisk('Text alignment in this document looks off, everything is centered instead of left-justified.').riskLevel,
    ).not.toBe('HIGH')
  })

  it('does not flag a sentence-initial "Book recommendations..." as a MEDIUM booking request', () => {
    // h10: same unfixed sentence-initial gap as h9, applied to BOOK_VERB_PATTERN.
    expect(
      classifyRisk('Book recommendations from my sister were great this month, I finished three of them already.').riskLevel,
    ).not.toBe('MEDIUM')
  })

  it('does not flag a sentence-initial "Schedule conflicts..." as a MEDIUM scheduling request', () => {
    // h11: same unfixed sentence-initial gap as h9/h10, applied to SCHEDULE_VERB_PATTERN.
    expect(
      classifyRisk('Schedule conflicts are the worst part of managing a team, especially with people across time zones.').riskLevel,
    ).not.toBe('MEDIUM')
  })

  it('does not flag a sentence-initial "Reserve funds..." as a MEDIUM scheduling request (batch 23, h4/conv381)', () => {
    // "reserve" has its own financial-noun-compound sense ("reserve funds") distinct from
    // "schedule"'s conflicts/is/was exclusions above — "funds" wasn't in the trailing exclusion.
    expect(
      classifyRisk('Reserve funds at my company only cover about three months of expenses, which worries me a bit.').riskLevel,
    ).not.toBe('MEDIUM')
  })

  it('does not flag a sentence-initial "Purchase orders..." as a money-spend request', () => {
    // h12: "purchase orders" is a common business noun-compound never added to
    // PURCHASE_VERB_PATTERN's trailing exclusion.
    expect(classifyRisk('Purchase orders take forever to get approved at my company, it\'s so frustrating.').riskLevel).not.toBe('HIGH')
  })

  it('does not flag a sentence-initial "Schedule details..." as a MEDIUM scheduling request (batch 29, h6/conv381/conv397)', () => {
    // Same sentence-initial noun-compound gap as "conflicts"/"funds"/"requirements"/"changes"
    // above — "detail(s)" wasn't in the trailing exclusion.
    expect(
      classifyRisk('Schedule details are attached for the conference, let me know if you have questions.').riskLevel,
    ).not.toBe('MEDIUM')
  })

  it('does not flag a sentence-initial "Delete confirmation..." as a HIGH delete request (batch 29, h1)', () => {
    // Same noun-compound gap ORDER_VERB_PATTERN/CANCEL_VERB_PATTERN's own trailing lists already
    // cover — "confirmation(s)" wasn't in DELETE_VERB_PATTERN's trailing exclusion.
    expect(
      classifyRisk('Delete confirmation for my old account finally came through this morning.').riskLevel,
    ).not.toBe('HIGH')
  })

  it('does not flag a sentence-initial "Wire fraud..." as a HIGH money-spend request (batch 29, h2)', () => {
    // PAY_WIRE_PATTERN's trailing exclusion only ever covered "pay"-noun-compounds, never
    // "wire"-noun-compounds ("wire fraud", "wire mesh", "high wire act").
    expect(
      classifyRisk('Wire fraud cases have increased significantly this year according to the report.').riskLevel,
    ).not.toBe('HIGH')
  })

  it('does not flag a sentence-initial "Wire transfer fees..." as a HIGH money-spend request (batch 34, h4)', () => {
    // "transfer" is the same "wire"-noun-compound gap as "fraud" above — "wire transfer fees" is
    // a plain observation, not a live transfer-money request.
    expect(
      classifyRisk('Wire transfer fees at my bank are outrageous, I switch banks every few years because of it.').riskLevel,
    ).not.toBe('HIGH')
  })

  it('does not flag a sentence-initial "Delete option..." as a HIGH delete request (batch 34, h5)', () => {
    // "option(s)" is the same UI-element noun-compound gap CANCEL_VERB_PATTERN's own trailing
    // list already covers, but DELETE_VERB_PATTERN never got it.
    expect(
      classifyRisk('Delete option is missing from the settings menu on this app, does anyone know why?').riskLevel,
    ).not.toBe('HIGH')
  })

  it('does not flag a sentence-initial "Schedule adjustments..." as a MEDIUM scheduling request (batch 34, h6)', () => {
    // Same sentence-initial noun-compound gap as "conflicts"/"funds"/"requirements"/"changes"/
    // "details" above — "adjustment(s)" wasn't in the trailing exclusion.
    expect(
      classifyRisk('Schedule adjustments are common this time of year at my company.').riskLevel,
    ).not.toBe('MEDIUM')
  })

  it('does not flag "...last week\'s email campaign..." as a HIGH send-message request (batch 29, surfaced re-probing h3)', () => {
    // EMAIL_TEXT_VERB_PATTERN's trailing exclusion never covered "campaign(s)" — an email
    // marketing campaign is a noun-compound, not a live send-a-message request. This pattern is
    // checked before CANCEL_VERB_PATTERN in HIGH_RISK_PATTERNS, so it used to mask the
    // "unsubscribe rates" gap below from ever being reached on this exact sentence.
    expect(
      classifyRisk("Unsubscribe rates jumped after last week's email campaign, according to marketing.").riskLevel,
    ).not.toBe('HIGH')
  })

  it('does not flag "Unsubscribe rates..." as a HIGH cancellation request (batch 29, h3)', () => {
    // CANCEL_VERB_PATTERN's trailing exclusion never covered "rate(s)" (unsubscribe rate, a
    // marketing-metric noun-compound, not a live cancellation request).
    expect(
      classifyRisk('Unsubscribe rates on our newsletter are much higher than industry average this quarter.').riskLevel,
    ).not.toBe('HIGH')
  })

  it('still exempts a pure past-narrative/reported-speech message with no separate live request', () => {
    // Regression guard for the h7 fix above: splitting into clauses must not reintroduce a false
    // positive for the plain single-clause cases these exemptions exist for.
    expect(classifyRisk('Yesterday I had to cancel my dentist appointment because of the snowstorm.').riskLevel).not.toBe('HIGH')
    expect(classifyRisk("My landlord said he will cancel my lease if I don't pay rent by Friday.").riskLevel).not.toBe('HIGH')
  })

  // batch 10 re-probe (conv166) — h1: splitRiskClauses only split on a comma before a
  // coordinating conjunction, never a semicolon, so a semicolon-joined exempt past-narrative
  // clause suppressed HIGH-risk gating for a live, different request in the same message too.
  it('does not let a semicolon-joined past-narrative clause suppress HIGH-risk gating for a live, different request', () => {
    expect(
      classifyRisk('I already cancelled my old gym membership; please cancel my current streaming subscription now.').riskLevel,
    ).toBe('HIGH')
  })

  it('still exempts a pure semicolon-joined past-narrative message with no separate live request', () => {
    expect(
      classifyRisk('I already cancelled my old gym membership; it was long overdue.').riskLevel,
    ).not.toBe('HIGH')
  })

  // h2 (re-probe): ORDER_VERB_PATTERN's trailing exclusion only covered is/was/to/for — a
  // sentence-initial "Order" followed by a noun-compound outside that list still misfired HIGH.
  it('does not flag a sentence-initial "Order confirmation..." as a money-spend request', () => {
    expect(
      classifyRisk('Order confirmation emails from this store take forever to arrive, is that normal?').riskLevel,
    ).not.toBe('HIGH')
  })

  // h3 (re-probe): PAY_WIRE_PATTERN's trailing exclusion only covered is/was/attention.
  it('does not flag a sentence-initial "Pay stubs..." as a money-spend request', () => {
    expect(classifyRisk('Pay stubs from my old job are surprisingly hard to track down online.').riskLevel).not.toBe('HIGH')
  })

  // h4 (re-probe): FORWARD_VERB_PATTERN's object-determiner list was missing "our" (also missing
  // your/his/a/an/us) — the opposite failure mode from this file's other patterns, a false
  // negative that let a genuine live request through with no approval gate at all.
  it('flags a genuine forward request phrased with a previously-missing object determiner ("our")', () => {
    expect(classifyRisk('Please forward our proposal to the client before end of day.').riskLevel).toBe('HIGH')
  })

  // h5 (re-probe): EMAIL_TEXT_VERB_PATTERN's trailing exclusion covered "alignment" but not
  // "thread"/"threads".
  it('does not flag a sentence-initial "Email thread..." as a send-a-message request', () => {
    expect(classifyRisk('Email thread got really long today, over 50 replies by lunchtime.').riskLevel).not.toBe('HIGH')
  })

  // h6 (re-probe): PUBLISH_VERB_PATTERN's trailing exclusion covered "engagement" but not
  // "office"/"mortem".
  it('does not flag a sentence-initial "Post office hours..." as a publish request', () => {
    expect(classifyRisk('Post office hours changed this week, they now close at 5.').riskLevel).not.toBe('HIGH')
  })

  // h7 (re-probe): DELETE_VERB_PATTERN's trailing exclusion only ever covered is/was.
  it('does not flag a sentence-initial "Delete key..." as a delete request', () => {
    expect(classifyRisk("Delete key on this keyboard doesn't work half the time, so annoying.").riskLevel).not.toBe('HIGH')
  })

  // h8 (re-probe): CANCEL_VERB_PATTERN's trailing exclusion covered link/option/button/
  // confirmation(s) but not "culture".
  it('does not flag "cancel culture" as a cancellation request', () => {
    expect(classifyRisk("Cancel culture has gotten out of hand online lately, don't you think?").riskLevel).not.toBe('HIGH')
  })

  // h9 (re-probe): BOOK_VERB_PATTERN's trailing exclusion covered club/report/recommendations
  // but not "signing"/"signings".
  it('does not flag a sentence-initial "Book signing events..." as a MEDIUM booking request', () => {
    expect(
      classifyRisk('Book signing events are popular at that indie bookstore this weekend.').riskLevel,
    ).not.toBe('MEDIUM')
  })

  // batch 12, h1: ORDER_VERB_PATTERN's trailing exclusion covered is/was/to/for/confirmations?/
  // number/status/history but not "of" (order of operations/magnitude).
  it('does not flag a sentence-initial "Order of operations..." as a money-spend request', () => {
    expect(
      classifyRisk('Order of operations always trips up my students when we get to nested parentheses.').riskLevel,
    ).not.toBe('HIGH')
  })

  // batch 12, h2: PAY_WIRE_PATTERN's trailing exclusion covered is/was/attention/stubs?/period/
  // raise but not "day" (payday as two words).
  it('does not flag a sentence-initial "Pay day..." as a money-spend request', () => {
    expect(
      classifyRisk('Pay day at my company always falls on the last Friday of the month.').riskLevel,
    ).not.toBe('HIGH')
  })

  // batch 12, h3: DELETE_VERB_PATTERN's trailing exclusion only had key/keys/is/was — unlike its
  // sibling CANCEL_VERB_PATTERN, which already excludes "button" for the identical UI-element
  // noun-compound shape.
  it('does not flag a sentence-initial "Delete button..." as a delete request', () => {
    expect(
      classifyRisk("Delete button on this remote doesn't work half the time, so annoying.").riskLevel,
    ).not.toBe('HIGH')
  })

  // batch 12, h4: BOOK_VERB_PATTERN's trailing exclusion covered club/report/recommendations?/
  // signings?/is/was but not "store" (book store).
  it('does not flag a sentence-initial "Book store closures..." as a MEDIUM booking request', () => {
    expect(
      classifyRisk("Book store closures have been in the news a lot lately, it's sad to see.").riskLevel,
    ).not.toBe('MEDIUM')
  })

  // batch 34, h6: BOOK_VERB_PATTERN's trailing exclusion still didn't cover "fair" (book fair).
  it('does not flag a sentence-initial "Book fair..." as a MEDIUM booking request', () => {
    expect(
      classifyRisk('Book fair at school this weekend was really fun for the kids.').riskLevel,
    ).not.toBe('MEDIUM')
  })

  // batch 19, h1: ORDER_VERB_PATTERN's trailing exclusion was missing "form" (order form).
  it('does not flag a sentence-initial "Order form..." as a money-spend request', () => {
    expect(
      classifyRisk('Order form for the new office chairs needs to be filled out before Friday, does anyone know where to find it?').riskLevel,
    ).not.toBe('HIGH')
  })

  // batch 19, h2: PAY_WIRE_PATTERN's trailing exclusion was missing "grade" (pay grade).
  it('does not flag a sentence-initial "Pay grade..." as a money-spend request', () => {
    expect(
      classifyRisk('Pay grade differences between departments never made sense to me, honestly.').riskLevel,
    ).not.toBe('HIGH')
  })

  // batch 19, h3: DELETE_VERB_PATTERN's trailing exclusion was missing "queue" (delete/print queue).
  it('does not flag a sentence-initial "Delete queue..." as a delete request', () => {
    expect(
      classifyRisk('Delete queue on this printer keeps growing no matter how many times IT clears it.').riskLevel,
    ).not.toBe('HIGH')
  })

  // batch 19, h4: CANCEL_VERB_PATTERN's trailing exclusion was missing "policy" (cancellation policy).
  it('does not flag a sentence-initial "Cancel policy..." as a cancellation request', () => {
    expect(
      classifyRisk("Cancel policy on this website is really unclear, I can't tell if I'd get a refund.").riskLevel,
    ).not.toBe('HIGH')
  })

  // batch 19, h5: EMAIL_TEXT_VERB_PATTERN's trailing exclusion was missing "editor" (text editor).
  it('does not flag a sentence-initial "Text editor..." as a send-message request', () => {
    expect(
      classifyRisk('Text editor I use at work keeps crashing every time I paste in a large file.').riskLevel,
    ).not.toBe('HIGH')
  })

  // batch 19, h11: PURCHASE_VERB_PATTERN's trailing exclusion was missing "history" (purchase history).
  it('does not flag a sentence-initial "Purchase history..." as a money-spend request', () => {
    expect(
      classifyRisk('Purchase history on this site is really hard to find, the search is broken.').riskLevel,
    ).not.toBe('HIGH')
  })

  // batch 19, h12: PUBLISH_VERB_PATTERN's trailing exclusion was missing "count" (post count).
  it('does not flag a sentence-initial "Post count..." as a publish request', () => {
    expect(
      classifyRisk("Post count on my account keeps resetting for no reason, it's really annoying.").riskLevel,
    ).not.toBe('HIGH')
  })

  // batch 19, h6: FORWARD_VERB_PATTERN's object-determiner alternation was missing "their" — the
  // opposite failure direction from the other cases above (a false negative: a genuine
  // send-on-behalf request silently never gated at all).
  it('flags "forward their X" as a HIGH-risk send-on-behalf request', () => {
    const result = classifyRisk('Please forward their proposal to the client before end of day.')
    expect(result.riskLevel).toBe('HIGH')
    expect(result.requiresApproval).toBe(true)
  })

  // h1 (this batch): FORWARD_VERB_PATTERN required a determiner right after the verb, so a bare
  // plural-noun object with no determiner at all slipped through with no HIGH-risk gate at all.
  it('flags "forward" with a bare plural-noun object and no determiner', () => {
    expect(classifyRisk('Please forward invoices to accounting.').riskLevel).toBe('HIGH')
    expect(classifyRisk('Please forward emails to the client.').riskLevel).toBe('HIGH')
  })

  // The widened bare-object alternative shouldn't misfire on "forwarding address/rules/service"
  // noun compounds, which have the same bare-object-then-preposition shape but aren't a live send.
  it('does not flag "forwarding address"/"forwarding rules" noun compounds', () => {
    expect(classifyRisk('The forwarding address to update is listed below.').riskLevel).not.toBe('HIGH')
  })
})

describe('looksActionOriented', () => {
  it('flags a paraphrased action request classifyRisk misses', () => {
    expect(looksActionOriented('Can you get rid of my old invoices for me')).toBe(true)
    expect(looksActionOriented('go ahead and renew it')).toBe(true)
    expect(looksActionOriented('that costs $50, can you handle it')).toBe(true)
  })

  it('does not flag ordinary conversation', () => {
    expect(looksActionOriented('What timezone is Tokyo in?')).toBe(false)
    expect(looksActionOriented('hello, how are you')).toBe(false)
  })
})

class StructuredOnlyLLMClient implements ILLMClient {
  calls = 0
  constructor(private readonly content: string) {}

  async *callChat(): AsyncIterable<string> {
    yield ''
  }

  async callChatSync(): Promise<string> {
    return ''
  }

  async callChatStructured(_messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMStructuredResponse> {
    this.calls++
    return { content: this.content }
  }
}

class ThrowingLLMClient implements ILLMClient {
  async *callChat(): AsyncIterable<string> {
    yield ''
  }
  async callChatSync(): Promise<string> {
    return ''
  }
  async callChatStructured(): Promise<LLMStructuredResponse> {
    throw new Error('proxy unreachable')
  }
}

describe('classifyRiskWithLLM', () => {
  it('adopts the LLM verdict when it flags HIGH risk', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ riskLevel: 'HIGH', reason: 'wires money to a third party' }))

    const result = await classifyRiskWithLLM('wire that over to them', llm)

    expect(result).toEqual({ riskLevel: 'HIGH', requiresApproval: true, reason: 'wires money to a third party' })
    expect(llm.calls).toBe(1)
  })

  it('adopts the LLM verdict when it says LOW', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ riskLevel: 'LOW', reason: 'just asking a question' }))

    const result = await classifyRiskWithLLM('for me, what time is it', llm)

    expect(result).toEqual({ riskLevel: 'LOW', requiresApproval: false, reason: 'just asking a question' })
  })

  it('falls back to LOW on malformed JSON instead of throwing', async () => {
    const llm = new StructuredOnlyLLMClient('not json at all')

    expect(await classifyRiskWithLLM('anything', llm)).toEqual({
      riskLevel: 'LOW',
      requiresApproval: false,
      reason: 'Conversational request with no detected side effects.',
    })
  })

  it('falls back to LOW on an unrecognized riskLevel value', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ riskLevel: 'UNKNOWN' }))

    expect((await classifyRiskWithLLM('anything', llm)).riskLevel).toBe('LOW')
  })

  it('falls back to LOW when the LLM call itself throws', async () => {
    const llm = new ThrowingLLMClient()

    expect((await classifyRiskWithLLM('anything', llm)).riskLevel).toBe('LOW')
  })
})
