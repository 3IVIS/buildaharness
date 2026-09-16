#!/usr/bin/env -S npx tsx
/**
 * Real-LLM accuracy eval for checkForContradictions (packages/personal-assistant/src/contradiction-checker.ts),
 * scoped to the corroboration/retraction judgment plans/personal_assistant_fact_extraction_llm_confidence_plan.html's
 * Phase 3 added to that function (the uncertainFacts/rejectedFacts pools and the "corroborations" output) — that
 * plan's Phase 5 asks for "a real-LLM eval pass scoped to this function, rather than eval-turn-intent.ts", since
 * the corroboration/retraction logic now lives entirely in this one call, not in classifyTurnIntent.
 *
 * contradiction-checker.test.ts only proves the parsing/id-filtering code around the LLM call is correct (via
 * scripted canned responses); this script proves the prompt/schema design itself gets the judgment right against
 * a real model, for the three shapes that plan's Phase 5 named explicitly:
 *
 *   1. Corroboration — a hedged statement from an earlier turn (the uncertainFacts pool, standing in for what
 *      memory-service.ts's recordFacts() would have read back from facts:${sessionId}) restated in different
 *      words on a later turn (newBeliefs) should be reported as a corroboration, not silently ignored.
 *   2. Negative case — a genuinely unrelated fact stated in between must not be mistaken for corroboration just
 *      because both entries are present in the same uncertainFacts/newBeliefs comparison.
 *   3. Retraction — a later statement that contradicts the earlier hedge should be reported as a contradiction
 *      against the uncertain-pool id (memory-service.ts treats this as a retraction — see that function's own
 *      doc comment), not as a corroboration and not silently dropped.
 *
 * Plus one case named directly in fact-extraction.ts's tierForFact doc comment ("the ... nurse-vs-designer
 * job-flip cases this file's admission logic exists to support" — semantic-tier, non-durable job facts staying
 * eligible for contradiction detection): two simultaneous, non-corrective job claims should be flagged as a
 * contradiction, while the same pair phrased as an explicit update ("Actually, ... now ...") should not, per
 * SYSTEM_PROMPT's own update-language exclusion.
 *
 * Not part of `npm test`/CI — makes real LLM calls and costs time/tokens. Run manually when changing
 * contradiction-checker.ts's SYSTEM_PROMPT or CONTRADICTION_SCHEMA:
 *
 *   cd packages/personal-assistant && npx tsx scripts/eval-contradiction-checker.ts
 *   npx tsx scripts/eval-contradiction-checker.ts --min-pass-rate=0.95   # override the default 0.85 threshold
 *
 * Uses the claude-cli backend (shells out to `claude -p`, already on PATH, no API key needed — see
 * CLAUDE.md's "Driving the personal-assistant" section), same as eval-turn-intent.ts.
 */
import { ClaudeCliLLMClient } from '../src/claude-cli-llm-client.js'
import { checkForContradictions, type BeliefCandidate } from '../src/contradiction-checker.js'

interface Case {
  id: string
  newBeliefs: BeliefCandidate[]
  existingBeliefs?: BeliefCandidate[]
  uncertainFacts?: BeliefCandidate[]
  /** Description used only in console output — not sent to the model. */
  description: string
  /** What the model is expected to report. Checked against the ids in checkForContradictions' output, not exact text. */
  expect:
    | { kind: 'corroboration'; existingId: string; newId: string }
    | { kind: 'contradiction'; beliefIds: string[] }
    | { kind: 'neither' }
}

const CASES: Case[] = [
  {
    id: 'corroboration-hedge-then-paraphrase',
    description: 'a hedged uncertain fact restated in different words on a later turn',
    uncertainFacts: [{ id: 'u1', statement: 'the user might be lactose intolerant' }],
    newBeliefs: [{ id: 'n1', statement: "the user can't have dairy" }],
    expect: { kind: 'corroboration', existingId: 'u1', newId: 'n1' },
  },
  {
    id: 'negative-unrelated-fact-not-corroboration',
    description: 'a genuinely unrelated new fact must not be mistaken for corroborating an existing hedge',
    uncertainFacts: [{ id: 'u1', statement: 'the user might be lactose intolerant' }],
    newBeliefs: [{ id: 'n2', statement: 'the user lives in Denver' }],
    expect: { kind: 'neither' },
  },
  {
    id: 'retraction-contradicts-uncertain-pool',
    description: 'a later statement contradicting an earlier hedge is a retraction, reported as a contradiction against the uncertain-pool id',
    uncertainFacts: [{ id: 'u1', statement: 'the user might be vegetarian' }],
    newBeliefs: [{ id: 'n3', statement: 'the user eats steak all the time' }],
    expect: { kind: 'contradiction', beliefIds: ['u1', 'n3'] },
  },
  {
    // tierForFact's doc comment names this shape explicitly: two simultaneous, non-corrective job
    // claims (no "actually"/"now" update language) should be flagged, unlike an explicit update.
    id: 'nurse-vs-designer-simultaneous-claims',
    description: 'two job claims stated as simultaneously true (no update language) should be flagged as a contradiction',
    existingBeliefs: [{ id: 'e1', statement: 'the user works as a nurse' }],
    newBeliefs: [{ id: 'n4', statement: 'the user works as a graphic designer' }],
    expect: { kind: 'contradiction', beliefIds: ['e1', 'n4'] },
  },
  {
    // The mirror case, phrased as an explicit correction — SYSTEM_PROMPT explicitly excludes this
    // update-language shape from being flagged.
    id: 'nurse-vs-designer-explicit-update',
    description: 'the same job change phrased as an explicit correction should NOT be flagged (update, not conflict)',
    existingBeliefs: [{ id: 'e1', statement: 'the user works as a nurse' }],
    newBeliefs: [{ id: 'n5', statement: 'Actually, the user is now a graphic designer, having left nursing behind' }],
    expect: { kind: 'neither' },
  },
]

interface CaseResult {
  id: string
  description: string
  passed: boolean
  mismatches: string[]
}

async function runCase(testCase: Case, llm: ClaudeCliLLMClient): Promise<CaseResult> {
  const result = await checkForContradictions(
    testCase.newBeliefs,
    testCase.existingBeliefs ?? [],
    llm,
    undefined,
    undefined,
    testCase.uncertainFacts ?? [],
  )
  const mismatches: string[] = []
  const expect = testCase.expect

  if (expect.kind === 'corroboration') {
    const match = result.corroborations.some((c) => c.existingId === expect.existingId && c.newId === expect.newId)
    if (!match) mismatches.push(`expected corroboration {existingId: ${expect.existingId}, newId: ${expect.newId}}, got ${JSON.stringify(result.corroborations)}`)
    if (result.contradictions.length > 0) mismatches.push(`expected no contradictions, got ${JSON.stringify(result.contradictions)}`)
  } else if (expect.kind === 'contradiction') {
    const match = result.contradictions.some((c) => expect.beliefIds.every((id) => c.beliefIds.includes(id)))
    if (!match) mismatches.push(`expected a contradiction covering beliefIds ${JSON.stringify(expect.beliefIds)}, got ${JSON.stringify(result.contradictions)}`)
    if (result.corroborations.length > 0) mismatches.push(`expected no corroborations, got ${JSON.stringify(result.corroborations)}`)
  } else {
    if (result.contradictions.length > 0) mismatches.push(`expected no contradictions, got ${JSON.stringify(result.contradictions)}`)
    if (result.corroborations.length > 0) mismatches.push(`expected no corroborations, got ${JSON.stringify(result.corroborations)}`)
  }

  return { id: testCase.id, description: testCase.description, passed: mismatches.length === 0, mismatches }
}

const DEFAULT_MIN_PASS_RATE = 0.85

async function main(): Promise<void> {
  const minPassRateArg = process.argv.find((a) => a.startsWith('--min-pass-rate='))?.split('=')[1]
  const minPassRate = minPassRateArg ? Number(minPassRateArg) : DEFAULT_MIN_PASS_RATE

  const llm = new ClaudeCliLLMClient()
  const results: CaseResult[] = []
  for (const testCase of CASES) results.push(await runCase(testCase, llm))

  for (const r of results) {
    if (r.passed) {
      console.log(`PASS  ${r.id}`)
    } else {
      console.log(`FAIL  ${r.id} — ${r.description}`)
      for (const m of r.mismatches) console.log(`        ${m}`)
    }
  }

  const passed = results.filter((r) => r.passed).length
  const passRate = results.length === 0 ? 1 : passed / results.length
  console.log(`\n${passed}/${results.length} passed (${(passRate * 100).toFixed(1)}%, threshold ${(minPassRate * 100).toFixed(1)}%)`)

  const failures = results.filter((r) => !r.passed)
  if (failures.length > 0) {
    console.log(`\n${failures.length} failure(s):`)
    for (const f of failures) console.log(`  - ${f.id}`)
  }

  if (passRate < minPassRate) {
    console.log(`\nFAILED: pass rate ${(passRate * 100).toFixed(1)}% is below the ${(minPassRate * 100).toFixed(1)}% threshold.`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
