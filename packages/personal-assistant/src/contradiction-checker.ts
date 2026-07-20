import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import type { ExternalContradictionInput } from '@buildaharness/harness'

export interface BeliefCandidate {
  id: string
  statement: string
}

// The lexical/negation-pair check (detect-contradictions.ts, always-on and free) already
// covers boolean/system-state-shaped claims well — build passed/failed, file exists/missing,
// service available/unavailable, and so on. If every newly-added belief looks like that kind
// of structured, technical claim, there's nothing this LLM call would catch that the lexical
// pass hasn't already had a fair shot at — so it's skipped entirely, no LLM call spent.
// "passed"/"passing" alone also matches the entirely unrelated "passed away" (died) idiom —
// found via live testing: "Actually, Biscuit passed away last month — I adopted a new cat named
// Pepper instead." got admitted as a fact purely because of this coincidental collision (the
// original "I have a cat named Biscuit" statement itself was never captured, since nothing else
// here or in fact-extraction.ts's other markers matches an ordinary pet-ownership statement) —
// producing a confusing, out-of-context fact entry ("Biscuit passed away...") with no record of
// what it was correcting. "passed"/"passing" immediately followed by "away" is never the
// build/test-status sense this list exists for, so it's excluded rather than admitted.
// batch 10 re-probe (conv166/h12, investigated as staged): "package" only matched the singular
// form — \bpackage\b's trailing word boundary can't match a directly-appended plural "s", so
// "...tracking packages..." never looksLikeCodingFact, extractFactsFromTurn's isClaimClause gate
// fails, and the whole statement is dropped before it ever becomes a belief at all — no
// contradiction check (lexical or LLM) ever gets a chance to run, since there's no second belief
// to compare against. Found via live testing: "I never bother insuring or tracking packages,
// it's not worth the hassle." (a genuine contradiction with an earlier "I always insure and track
// any package I mail." statement) was silently dropped entirely, while the singular-form version
// of the same statement was correctly captured and flagged as contradictory. Several other nouns
// in this list have the same singular-only gap (library, script, command, log, bug, commit,
// error, exception, server, service, function, database, config, module, variable, schema,
// endpoint) — left as a known adjacent gap for a future pass rather than widening all of them
// speculatively without live-testing each one.
// batch 12 re-probe (conv178/conv198): "repo" and "branch" are two of those named sibling gaps,
// now live-tested — "I never bother backing up my repos anymore" and "I never bother squashing or
// rebasing branches anymore" both reproduced the exact same drop, each contradicting an earlier
// singular-form statement ("...my repo...", "...any branch...") that had been captured fine.
// Widened just these two (not the rest of the still-untested list above) for the same reason the
// package fix stayed narrow: confirm each one live rather than widening speculatively.
// batch 19 (h7/h8, re-probing conv178/conv198): "server" and "commit" are two more of the named
// sibling gaps, now live-tested — "servers" and "commits" reproduced the same silent-drop shape.
// Widened just these two for the same reason as before: confirm each live rather than widening
// the rest of the still-untested list speculatively.
// batch 20 (h1, re-probing conv178/conv198): "library" is another of the still-named sibling
// gaps, now live-tested — "libraries" reproduced the same silent-drop shape ("I never bother
// pinning versions for libraries, floating latest is fine these days." contradicting an earlier
// "...for any library I use in production." never became a belief at all). Widened just this one
// for the same reason as before: confirm each live rather than widening the rest speculatively.
// batch 21 (h2, re-probing conv178/conv198): "database" and "script" are two more of the named
// sibling gaps, now live-tested — "I always back up every database before deploying." became a
// belief, but "I never bother backing up my databases anymore, it's not worth the hassle." was
// silently dropped (never even became a UserFact, let alone a contradiction), and both "scripts"
// statements in the same session ("I always keep my scripts under version control." / "I never
// bother versioning my scripts these days, it's not worth it.") were dropped identically since
// neither ever matched the singular-only "script". Widened just these two for the same reason as
// before: confirm each live rather than widening the rest of the still-untested list
// (command, log, bug, error, exception, service, function, config, module, variable, schema,
// endpoint) speculatively.
// batch 24 (h2, re-probing conv178/conv198): "module" is another of the still-named sibling gaps,
// now live-tested — looksLikeCodingFact('I never bother documenting my modules anymore, it is not
// worth the hassle.') returned false (dropped) while the singular 'I always document every module
// I write.' returned true, reproducing the exact same silent-drop shape as the other nouns already
// widened above. Widened just this one for the same reason as before: confirm each live rather
// than widening the rest of the still-untested list (command, log, bug, error, exception, service,
// function, config, variable, schema, endpoint) speculatively.
// batch 25 (re-probing conv178/conv198): "bug", "error", "config", and "endpoint" are four more of
// the still-named sibling gaps, now live-tested — a four-pair session ("I always triage every bug
// immediately..." / "I never bother triaging bugs anymore...", and the same always/never shape for
// error/errors, config/configs, endpoint/endpoints) showed all four plural-form contradicting
// statements silently dropped from /memory's Facts list entirely, while all four singular-form
// originals were captured fine. Widened just these four for the same reason as before: confirm each
// live rather than widening the rest of the still-untested list (command, log, service, function,
// variable, schema) speculatively.
// batch 29 (conv3/convR2, re-probing conv178/conv198/conv394): "log" and "command" are two more of
// the still-named sibling gaps, now live-tested — "The build logs show success right now." /
// "Actually, the build logs show failure now after the last commit." (conv3) and "All the deploy
// commands are passing in CI right now." / "Actually, the deploy commands are now failing in the
// staging environment." (convR2) both reproduced the exact same silent-drop shape: /memory's Facts
// list showed neither statement at all. Widened just these two for the same reason as before:
// confirm each live rather than widening the rest of the still-untested list (service, function,
// variable, schema) speculatively.
const CODING_FACT_MARKERS =
  /\b(test|tests|build|deploy(ment)?|compile|file|files|configs?|servers?|service|function|modules?|dependency|dependencies|errors?|exception|endpoints?|api|databases?|schema|branch(?:es)?|commits?|pipeline|ci\/cd|ci|environment|variable|packages?|libraries|library|repos?|repository|scripts?|commands?|logs?|status|bugs?|pass(?:ed|ing)?(?!\s+away)|fail(ed|ing)?|available|unavailable|enabled|disabled|running|stopped|online|offline|exists?|missing|present|absent)\b/i

// This substring match, and the shared-subject gate in detect-contradictions.ts's
// statementsOpposed (packages/harness), only catch a real contradiction when the two compared
// statements lead with the same concrete subject ("the login tests" vs "the login tests", not
// "the login tests" vs "the auth suite") — which is why decomposition-classifier.ts and
// plan-builder.ts prompt task descriptions to be phrased subject-first.
/** Zero-LLM-call gate: true when a belief statement reads like a structured/technical (build, test, service, file) claim rather than a natural-language personal fact. */
export function looksLikeCodingFact(statement: string): boolean {
  return CODING_FACT_MARKERS.test(statement)
}

// Phase 2 (layer 1, World Model) writes a synthetic "Completed: <task description>" belief as
// an auditable trail for a multi-step/consequential turn with no extracted fact — a bookkeeping
// record of what ran, not a first-order claim about the world. Two task-completion records
// ("Completed: X", "Completed: Y") are never meaningfully "contradictory" the way two competing
// facts are, so there's nothing here worth an LLM call over, no matter how the phrasing reads.
const TASK_COMPLETION_TRAIL_PREFIX = /^Completed: /

function isCheckWorthy(statement: string): boolean {
  return !looksLikeCodingFact(statement) && !TASK_COMPLETION_TRAIL_PREFIX.test(statement)
}

const CONTRADICTION_SCHEMA = {
  type: 'object',
  properties: {
    contradictions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          beliefIds: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
        },
        required: ['beliefIds', 'description'],
      },
    },
  },
  required: ['contradictions'],
}

// batch 21 (convA): a job-promotion self-correction ("I work as a data analyst..." then "Actually,
// I'm now a senior data analyst...") got flagged as a conflict needing the user's attention, even
// though the second statement is an explicit, unambiguous update of the first, not an unresolved
// simultaneous claim — found via live testing. The two examples below ("actually...now"/"I no
// longer...") name the update-language shape this instruction is meant to exclude.
// batch 24 (h3, re-probing conv354/373): the description field is surfaced verbatim to the user
// as the contradictionNotice (assistant.ts's findContradictionNotice reads Contradiction.description
// straight through) — but the ids in "newBeliefs"/"existingBeliefs" are internal bookkeeping
// tokens (e.g. "fact-respond-1-0"), never meant for prose. Nothing here told the model not to name
// them, so a description like "fact-respond-1-0 states the person works as a nurse, while
// fact-respond-1-1 states..." reached the user's screen verbatim — found via live testing. Told
// the model explicitly to describe beliefs by their content, never by id; kept as a hint only
// (see the deterministic strip in checkForContradictions below for the actual guarantee, since a
// prompt instruction alone isn't reliable — playbook §6).
const SYSTEM_PROMPT =
  'You check a personal assistant\'s beliefs for genuine contradictions — statements that cannot ' +
  "both be true at the same time (e.g. two different home cities, conflicting preferences, " +
  'opposite factual claims). Do not flag beliefs that are merely about different topics, or that ' +
  'could both be true (e.g. "likes coffee" and "likes tea" are not a contradiction). Do not flag a ' +
  'newBelief that explicitly updates or corrects an existingBelief (e.g. "Actually, I\'m now a ' +
  'senior analyst" superseding "I\'m an analyst", or "I no longer live in Boston") — that is a ' +
  'stated change over time, not two simultaneously-held conflicting claims. You are given ' +
  '"newBeliefs" (just learned) and "existingBeliefs" (already known and already mutually ' +
  'consistent with each other) as JSON. Check newBeliefs against existingBeliefs, and against each ' +
  'other. Respond with JSON only: {"contradictions": [{"beliefIds": [id, id, ...], "description": ' +
  'string}]}. "description" is shown directly to the user in prose — describe what the beliefs ' +
  'say, never their ids (e.g. write "you said you work as a nurse, but also as a physical ' +
  'therapist", not "fact-respond-1-0 states..."). Empty array if none.'

/**
 * One LLM call reviewing whatever belief(s) were just added against everything already known —
 * never per-pair, never a full re-scan (old-vs-old was already cleared by a previous call).
 * Skips the LLM call entirely when every new belief looks like a structured/technical claim the
 * always-on lexical check already handles (see looksLikeCodingFact). Falls back to "no
 * contradictions found" on any parse failure or LLM error, matching this codebase's other
 * LLM-backed classifiers (isAbandonPhraseWithLLM, classifyRiskWithLLM) — a missed contradiction
 * costs nothing worse than the lexical-only behavior this is layered on top of.
 */
// batch 24 (h3, re-probing conv354/373): the prompt-level instruction above (not to name ids in
// "description") is only a hint the model may or may not follow — found via live testing that it
// didn't hold on its own before this guard existed. This is the actual guarantee: strip every
// known belief id (the exact ids handed to the model in "newBeliefs"/"existingBeliefs", not a
// generic pattern) out of whatever the model returns, so a leaked id can never reach the user's
// screen regardless of model compliance.
function stripBeliefIds(description: string, knownIds: string[]): string {
  let sanitized = description
  for (const id of knownIds) {
    sanitized = sanitized.split(id).join('')
  }
  return sanitized.replace(/\s{2,}/g, ' ').trim()
}

export async function checkForContradictions(
  newBeliefs: BeliefCandidate[],
  existingBeliefs: BeliefCandidate[],
  llmClient: ILLMClient,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<ExternalContradictionInput[]> {
  if (newBeliefs.length === 0) return []
  if (newBeliefs.every((b) => !isCheckWorthy(b.statement))) return []

  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ newBeliefs, existingBeliefs }) },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: CONTRADICTION_SCHEMA } },
    )
    const parsed = JSON.parse(response.content) as { contradictions?: ExternalContradictionInput[] }
    const contradictions = Array.isArray(parsed.contradictions) ? parsed.contradictions : []
    const knownIds = [...newBeliefs, ...existingBeliefs].map((b) => b.id)
    return contradictions.map((c) => ({ ...c, description: stripBeliefIds(c.description, knownIds) }))
  } catch {
    return []
  }
}
