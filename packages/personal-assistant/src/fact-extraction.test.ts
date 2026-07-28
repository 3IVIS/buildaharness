import { describe, it, expect } from 'vitest'
import { extractFactsFromTurn } from './fact-extraction.js'

describe('extractFactsFromTurn', () => {
  it('captures a message stating the user\'s name', () => {
    const facts = extractFactsFromTurn('My name is Ali.', 'turn:1')
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toBe('My name is Ali.')
    expect(facts[0].sourceTurn).toBe('turn:1')
  })

  // Chinese (Simplified) fixtures below are a first pass, not verified by a fluent Chinese
  // speaker — see fact-markers.json's "zh" entry and
  // plans/personal_assistant_chinese_lexical_checks_plan.html for the design rationale. Per the
  // plan, allergy/health cases are prioritized first — this is the file where a missed match
  // means the fact is never captured, full stop (no LLM fallback exists at all).
  it('captures an allergy statement in Chinese and flags it durable', () => {
    const facts = extractFactsFromTurn('我对花生过敏', 'turn:zh1')
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toBe('我对花生过敏')
    expect(facts[0].durable).toBe(true)
  })

  it('captures an allergy statement in Chinese with an intensifier between the pronoun and the marker', () => {
    // Mirrors the English h6 fix (an intervening intensifier breaking strict adjacency) — the
    // Chinese healthOrDietaryMarkers pattern uses a 0-15-character gap after 我 rather than a
    // proximity-window check, per the plan's note that English's "0-4 words of a pronoun"
    // proximity check has no clean Chinese analogue.
    const facts = extractFactsFromTurn('我严重对花生过敏，请一定要注意', 'turn:zh2')
    expect(facts).toHaveLength(1)
    expect(facts[0].durable).toBe(true)
  })

  it('does not capture a general statement about allergies in Chinese with no first-person subject', () => {
    // Confirms the plan's prediction that a simpler, direct-substring strategy (here: requiring 我
    // to be present) is enough to keep precision without porting English's proximity window.
    expect(extractFactsFromTurn('过敏反应通常在几分钟内发生', 'turn:zh3')).toEqual([])
  })

  it('captures other health/dietary phrasings in Chinese', () => {
    expect(extractFactsFromTurn('我是糖尿病患者', 'turn:zh4')).toHaveLength(1)
    expect(extractFactsFromTurn('我不能吃辣', 'turn:zh5')).toHaveLength(1)
    expect(extractFactsFromTurn('我是素食者', 'turn:zh6')).toHaveLength(1)
  })

  it('captures a Chinese health fact wrapped inside a single polite-request clause with no separator ("请注意" framing)', () => {
    // Mirrors the English h4 "please note that" fix — "请注意" is admitted unconditionally via
    // factMarkers, sidestepping nonClaimMarkers' "请" rejection the same way.
    const facts = extractFactsFromTurn('请注意，我对贝类过敏', 'turn:zh7')
    expect(facts).toHaveLength(1)
    expect(facts[0].durable).toBe(true)
  })

  it('does not capture a Chinese question/recall about an allergy as a claim', () => {
    expect(extractFactsFromTurn('医生说我对什么过敏？', 'turn:zh8')).toEqual([])
  })

  it('captures a stated preference', () => {
    const facts = extractFactsFromTurn('I prefer tea over coffee.', 'turn:2')
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toBe('I prefer tea over coffee.')
  })

  it('captures an explicit "remember that" request', () => {
    const facts = extractFactsFromTurn('Remember that my flight is on Friday.', 'turn:3')
    expect(facts).toHaveLength(1)
  })

  it('returns no facts for an ordinary question', () => {
    expect(extractFactsFromTurn('What timezone is Tokyo in?', 'turn:4')).toEqual([])
  })

  it('returns no facts for a consequential request with no self-statement', () => {
    expect(extractFactsFromTurn('Please send an email to my boss telling him I quit.', 'turn:5')).toEqual([])
  })

  it('captures a build/test/service-status statement even with no personal-fact phrasing', () => {
    const facts = extractFactsFromTurn('The tests passed on the CI pipeline for the auth service.', 'turn:6')
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toBe('The tests passed on the CI pipeline for the auth service.')
  })

  it('does not capture a request/command that merely mentions a coding-domain word', () => {
    // Contains "files" (a CODING_FACT_MARKERS word) but is a request, not a claim about the
    // world — admitting it would let an imperative turn into a persisted "known fact".
    expect(extractFactsFromTurn('Please delete the old backup files in the workspace to free up space.', 'turn:7')).toEqual([])
  })

  it('does not capture a question that merely mentions a coding-domain word', () => {
    // Contains "missing" (a CODING_FACT_MARKERS word, via "missing.txt") but is a question, not
    // a claim about the world — admitting it would let a lookup turn into a persisted "known fact".
    expect(extractFactsFromTurn('What does missing.txt say?', 'turn:8')).toEqual([])
  })

  it('captures a personal-fact statement using the plural form of a CODING_FACT_MARKERS word', () => {
    // batch 10 re-probe (conv166/h12): "package" only matched the singular form — the plural
    // "packages" was silently dropped entirely (not admitted as a fact at all), which is how a
    // genuine contradiction with an earlier "I always insure and track any package I mail."
    // statement went undetected: there was no second belief for the contradiction check to
    // compare against.
    const facts = extractFactsFromTurn("I never bother insuring or tracking packages, it's not worth the hassle.", 'turn:8b')
    expect(facts).toHaveLength(1)
  })

  it('captures a personal-fact statement using a plural CODING_FACT_MARKERS word not previously widened (server/commit)', () => {
    // batch 19 (h7/h8, re-probing conv178/conv198): "server" and "commit" were still singular-only.
    expect(extractFactsFromTurn('Honestly I stopped bothering with backups on our servers, we have snapshots now.', 'turn:8c')).toHaveLength(1)
    expect(extractFactsFromTurn('Actually I stopped squashing commits a while back, our team keeps full history now.', 'turn:8d')).toHaveLength(1)
  })

  it('does not reject a first-person declarative statement that happens to use a NON_CLAIM_MARKERS action verb', () => {
    // batch 19: found while investigating conv178's re-probe — "I always run a backup script
    // before touching the server." was silently dropped entirely, because bare "run" tripped
    // NON_CLAIM_MARKERS even though this is a plain statement of routine behavior, not a request
    // directed at the assistant.
    const facts = extractFactsFromTurn('I always run a backup script before touching the server.', 'turn:8e')
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toBe('I always run a backup script before touching the server.')
  })

  it('still rejects a genuine imperative using the same action verb with no subject pronoun', () => {
    // Guards the NON_CLAIM_MARKERS fix above from over-widening: a bare imperative ("Run the
    // tests") has no "I"/"we" before the verb and must still be rejected as a request, not a fact.
    expect(extractFactsFromTurn('Run the tests before you merge this branch.', 'turn:8f')).toEqual([])
  })

  it('captures a health/dietary self-statement with no FACT_MARKERS phrasing', () => {
    // "I'm allergic to shellfish." matches none of FACT_MARKERS' identity-statement phrases
    // ("my name is", "i'm a", ...) — this was filed only as a reminder, never as a known fact,
    // until HEALTH_OR_DIETARY_MARKERS was added.
    const facts = extractFactsFromTurn("I'm allergic to shellfish.", 'turn:9')
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toBe("I'm allergic to shellfish.")
  })

  it('captures other health/dietary phrasings', () => {
    expect(extractFactsFromTurn('I am vegetarian.', 'turn:10')).toHaveLength(1)
    expect(extractFactsFromTurn("I don't eat pork.", 'turn:11')).toHaveLength(1)
    expect(extractFactsFromTurn('I have a peanut allergy.', 'turn:12')).toHaveLength(1)
  })

  it('captures a celiac statement (batch 19, h9)', () => {
    const facts = extractFactsFromTurn('I am celiac, so please avoid recommending anything with wheat or gluten.', 'turn:12c')
    expect(facts).toHaveLength(1)
  })

  it('captures an i\'ve/i have allergy statement with an intervening verb before the marker', () => {
    // batch 10 re-probe (conv166/h11): the i'm/i am branch got a 0-4-word modifier-gap widening,
    // but the i've/i have branch never got the same treatment — a verb between "i've" and the
    // allergy statement silently dropped the fact entirely.
    const facts = extractFactsFromTurn("I've recently developed a peanut allergy, so please double check ingredient labels for me.", 'turn:12b')
    expect(facts).toHaveLength(1)
  })

  it('captures a health/dietary fact even when a later clause in the same message is a polite request', () => {
    // "please remind me..." used to make NON_CLAIM_MARKERS reject the whole message, dropping
    // the diabetic fact stated in the first clause entirely.
    const facts = extractFactsFromTurn(
      "I'm diabetic, so please remind me to always check the sugar content before buying snacks.",
      'turn:13',
    )
    expect(facts).toHaveLength(1)

    const facts2 = extractFactsFromTurn("I'm allergic to peanuts, so please don't suggest any recipes with peanuts in them.", 'turn:14')
    expect(facts2).toHaveLength(1)
  })

  it('captures a negated correction to a previously-stated dietary/health fact', () => {
    // "not"/"no longer" used to break adjacency to the marker word, silently dropping the
    // correction and leaving the stale original fact unchallenged.
    expect(extractFactsFromTurn("I'm not vegetarian anymore, I started eating meat again last month.", 'turn:15')).toHaveLength(1)
    expect(extractFactsFromTurn("I'm no longer allergic to shellfish, I got treated for it last year.", 'turn:16')).toHaveLength(1)
  })

  it('flags name, preference, and health/dietary facts as durable', () => {
    expect(extractFactsFromTurn('My name is Ali.', 'turn:17')[0].durable).toBe(true)
    expect(extractFactsFromTurn('Call me Ali.', 'turn:18')[0].durable).toBe(true)
    expect(extractFactsFromTurn('I prefer tea over coffee.', 'turn:19')[0].durable).toBe(true)
    expect(extractFactsFromTurn("I'm allergic to shellfish.", 'turn:20')[0].durable).toBe(true)
  })

  it('flags Chinese name, preference, and health/dietary facts as durable', () => {
    expect(extractFactsFromTurn('我叫李明', 'turn:zh9')[0].durable).toBe(true)
    expect(extractFactsFromTurn('叫我阿里就行', 'turn:zh10')[0].durable).toBe(true)
    expect(extractFactsFromTurn('我更喜欢喝茶', 'turn:zh11')[0].durable).toBe(true)
    expect(extractFactsFromTurn('我对花生过敏', 'turn:zh12')[0].durable).toBe(true)
  })

  it('does not capture "叫" (name/call) in its "told someone to do X" sense as a name statement in Chinese', () => {
    // Genuine finding during fixture-writing: 叫 is a real homograph in Chinese, unlike the
    // money/deletion/messaging verbs — "我叫" can mean either "my name is" (我叫李明) or "I told
    // him/her to ..." (我叫他关门 = "I told him to close the door"), and "叫我" can mean either
    // "call me [name]" or "[someone] told me to ...". Resolved with a lightweight, targeted fix
    // (excluding a pronoun immediately after 叫 for "我叫"; anchoring the bare "叫我" form to the
    // start of the message, plus explicit polite lead-ins like "你可以叫我"/"请叫我"/"其实，叫我"
    // for the non-initial case) rather than porting English's NOUN_CONTEXT_DETERMINERS lookbehind
    // — this is a different kind of ambiguity (a verb with two unrelated meanings, not a noun/verb
    // homograph) with its own narrower fix.
    expect(extractFactsFromTurn('他叫我关门', 'turn:zh13')).toEqual([])
  })

  it('captures "call me" in Chinese via an explicit lead-in phrase, not just the message-initial bare form', () => {
    const facts = extractFactsFromTurn('你可以叫我阿里', 'turn:zh14')
    expect(facts).toHaveLength(1)
    expect(facts[0].durable).toBe(true)
  })

  it('captures a filler-prefixed "call me" ("其实，叫我阿里就行") — native-speaker review flagged this as worth', () => {
    // fixing (plans/personal_assistant_chinese_lexical_checks_plan.html's native-speaker review):
    // "其实" ("actually") is a common lead-in before a polite bare "叫我" restatement, the same
    // shape as "你可以叫我"/"请叫我" above — added as its own explicit lead-in rather than a
    // generic filler-skipping rule, matching this fix's existing narrow-enumeration style.
    const facts = extractFactsFromTurn('其实，叫我阿里就行', 'turn:zh14b')
    expect(facts).toHaveLength(1)
    expect(facts[0].durable).toBe(true)
  })

  it('does not flag a Chinese session-scoped fact (location, job) as durable', () => {
    expect(extractFactsFromTurn('我现在住在上海', 'turn:zh15')[0].durable).toBe(false)
    expect(extractFactsFromTurn('我在谷歌工作', 'turn:zh16')[0].durable).toBe(false)
  })

  it('captures "我住在"/"我在...工作" in Chinese with a modifier word between the pronoun and the verb', () => {
    // Mirrors the English batch 23/25 fixes (a modifier breaking strict word-adjacency) — Chinese
    // doesn't need \b word boundaries (substring matching is enough), but still needs a character
    // gap to tolerate an inserted modifier like "现在"/"目前" the same way English needed a
    // word-count gap.
    expect(extractFactsFromTurn('我现在住在上海', 'turn:zh17')).toHaveLength(1)
    expect(extractFactsFromTurn('我目前居住在上海', 'turn:zh18')).toHaveLength(1)
    expect(extractFactsFromTurn('我目前在一家科技公司工作', 'turn:zh19')).toHaveLength(1)
  })

  it('does not flag a session-scoped fact (location, job, generic "remember that") as durable', () => {
    expect(extractFactsFromTurn('I live in Seattle.', 'turn:21')[0].durable).toBe(false)
    expect(extractFactsFromTurn('I work as a nurse.', 'turn:22')[0].durable).toBe(false)
    expect(extractFactsFromTurn('Remember that my flight is on Friday.', 'turn:23')[0].durable).toBe(false)
  })

  it('captures a health fact wrapped inside a single polite-request clause with no separator', () => {
    // h4: "Please note that I'm allergic to shellfish." is ONE clause containing both "please"
    // and the fact (no sentence punctuation or comma+conjunction to split on), so the
    // clause-scoped NON_CLAIM_MARKERS check rejected the whole thing outright — "note that" is
    // now in FACT_MARKERS, admitted unconditionally like "remember that" already was.
    const facts = extractFactsFromTurn("Please note that I'm allergic to shellfish.", 'turn:24')
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toBe("Please note that I'm allergic to shellfish.")
    expect(facts[0].durable).toBe(true)
  })

  it('captures a name statement phrased with "I go by ..." and flags it durable', () => {
    // h9: FACT_MARKERS/DURABLE_NAME_OR_PREFERENCE_MARKERS only recognized "my name is"/"call me"
    // — "I go by Alex" is an equally common name-statement phrasing and wasn't captured at all.
    const facts = extractFactsFromTurn('I go by Alex, by the way.', 'turn:25')
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toBe('I go by Alex, by the way.')
    expect(facts[0].durable).toBe(true)
  })

  it('captures a health/dietary self-statement with an intensifier between "I\'m" and the marker word', () => {
    // h6: HEALTH_OR_DIETARY_MARKERS originally required the marker word immediately adjacent to
    // "i'm"/"i am" (only an optional "not "/"no longer " in between) — "severely" broke that
    // adjacency and silently dropped the fact entirely.
    const facts = extractFactsFromTurn("I'm severely allergic to peanuts, so please keep that in mind for any food suggestions.", 'turn:27')
    expect(facts).toHaveLength(1)
    expect(facts[0].durable).toBe(true)
  })

  it('captures a job-correction statement with a modifier word between "i\'m" and "a"', () => {
    // batch 20 (h2, re-probing conv354): FACT_MARKERS' "i'm a"/"i am a" branches required strict
    // literal adjacency — "I'm actually a product manager now" has "actually" between "i'm" and
    // "a", so the substring "i'm a" never appears and the correction was silently dropped from
    // the facts store entirely (the harness still answered correctly in-conversation from raw
    // transcript context, but /memory kept showing the stale original job).
    const facts = extractFactsFromTurn(
      "Oh wait, I'm actually a product manager at a totally different company now, I switched roles last month.",
      'turn:28',
    )
    expect(facts).toHaveLength(1)
  })

  it('captures an ordinary pet-ownership/naming statement', () => {
    // batch 21 (h2/convA, re-probing conv354): matched none of FACT_MARKERS, CODING_FACT_MARKERS,
    // or HEALTH_OR_DIETARY_MARKERS — "Also, I have a golden retriever named Max." never appeared
    // in /memory's Facts list at all.
    const facts = extractFactsFromTurn('Also, I have a golden retriever named Max.', 'turn:29')
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toBe('Also, I have a golden retriever named Max.')
    // Left non-durable (unlike "my name is"/"call me") — see fact-extraction.ts's doc comment.
    expect(facts[0].durable).toBe(false)
  })

  it('captures a possessive naming statement ("my dog\'s name is ...")', () => {
    const facts = extractFactsFromTurn("My dog's name is Biscuit, he's a 3 year old beagle.", 'turn:30')
    expect(facts).toHaveLength(1)
    expect(facts[0].durable).toBe(false)
  })

  it('captures an ordinary pet-ownership/naming statement in Chinese', () => {
    expect(extractFactsFromTurn('我有一只叫Max的金毛', 'turn:zh20')[0].durable).toBe(false)
    expect(extractFactsFromTurn('我养了一只叫豆豆的猫', 'turn:zh21')).toHaveLength(1)
  })

  it('captures "i work" with a modifier word between the pronoun and the verb (batch 23, conv354/373)', () => {
    const facts = extractFactsFromTurn('I currently work as a project manager at a design agency.', 'turn:33')
    expect(facts).toHaveLength(1)
  })

  it('captures "i live in" with a modifier word between the pronoun and the verb (batch 23, conv380)', () => {
    const facts = extractFactsFromTurn('I currently live in a small apartment in Denver.', 'turn:31')
    expect(facts).toHaveLength(1)
    expect(facts[0].durable).toBe(false)
  })

  it('captures "my ... name is" with an adjective before a possessive noun (batch 23, conv380)', () => {
    const facts = extractFactsFromTurn("My good friend's name is Marcus.", 'turn:32')
    expect(facts).toHaveLength(1)
  })

  it('captures "i live in" with a modifier word between "live" and "in" (batch 25, re-probing conv380)', () => {
    // batch 23 only opened a gap before "live"; a modifier after "live" but before "in" still
    // broke the match until this widening.
    const facts = extractFactsFromTurn('I live currently in Austin, Texas.', 'turn:34')
    expect(facts).toHaveLength(1)
  })

  it('captures a health/dietary fact joined to a request clause by "yet"', () => {
    // h5: CLAUSE_BOUNDARY's conjunction list originally only covered so/but/and/because/
    // although/while/whereas — "yet" is the same contrastive-conjunction shape and wasn't in
    // the list, so the request clause's "please" suppressed the allergy fact in the same clause.
    const facts = extractFactsFromTurn(
      "I'm allergic to shellfish, yet please still recommend some good seafood restaurants for my friends' dinner.",
      'turn:26',
    )
    expect(facts).toHaveLength(1)
  })
})
