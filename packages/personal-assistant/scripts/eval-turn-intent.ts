#!/usr/bin/env -S npx tsx
/**
 * Real-LLM accuracy eval for classifyTurnIntent (packages/personal-assistant/src/turn-intent-classifier.ts) —
 * serves two plans' evidence requirements at once:
 *
 * 1. plans/personal_assistant_consolidated_classifier_plan.html's Phase 3 gate ("gate the cutover on this
 *    suite passing") — ENGLISH_CASES/CHINESE_CASES below.
 * 2. plans/lexical_functions_hardening_plan.html's Phase 5 step 3 ("eval evidence for the paraphrase/
 *    non-English claim... so it's a measured claim, not just documented intent") — FACT_BACKSTOP_CASES/
 *    RISK_STEP_BACKSTOP_CASES below, which specifically target the two fields that plan's Phase 1 added to
 *    this same classifier (statesDurableFact, per-task riskLevel) as the LLM backstop for
 *    fact-extraction.ts's FACT_MARKERS/HEALTH_OR_DIETARY_MARKERS and risk-classifier.ts's classifyRisk.
 *
 * turn-intent-classifier.test.ts only proves the parsing/derivation code around the LLM call is correct
 * (via scripted canned responses); this script proves the prompt/schema design itself classifies real
 * English *and* non-English *and* deliberately-paraphrased-past-the-lexical-net input correctly, by running
 * it against a real model. The FACT_BACKSTOP_CASES/RISK_STEP_BACKSTOP_CASES fixtures below aren't just
 * "unusual phrasing" by assertion — each one is checked at eval time against the actual lexical functions
 * it's meant to evade (extractFactsFromTurn, classifyRisk) and the run aborts if a fixture stops evading
 * them (e.g. because a future Phase 0-style consolidation widens a marker to cover it), so this can't
 * silently degrade into testing something the lexical path already catches for free.
 *
 * Not part of `npm test`/CI — makes real LLM calls and costs time/tokens. Run manually before deleting the
 * superseded regex classifiers (risk-classifier.ts's LLM/pattern bits, triviality-classifier.ts,
 * decomposition-classifier.ts's gate, plan-store.ts's abandon detection, planning-classifier.ts):
 *
 *   cd packages/personal-assistant && npx tsx scripts/eval-turn-intent.ts
 *   npx tsx scripts/eval-turn-intent.ts --lang=zh              # only the Chinese fixtures
 *   npx tsx scripts/eval-turn-intent.ts --min-pass-rate=0.95   # override the default 0.85 threshold
 *
 * Uses the claude-cli backend (shells out to `claude -p`, already on PATH, no API key needed — see
 * CLAUDE.md's "Driving the personal-assistant" section) so this runs in any dev environment with Claude
 * Code installed.
 */
import { ClaudeCliLLMClient } from '../src/claude-cli-llm-client.js'
import { classifyTurnIntent, type TurnIntentClassification, type TurnIntentContext } from '../src/turn-intent-classifier.js'
import { extractFactsFromTurn } from '../src/fact-extraction.js'
import { classifyRisk } from '../src/risk-classifier.js'

interface Case {
  id: string
  lang: 'en' | 'zh'
  message: string
  context?: TurnIntentContext
  /** Only the fields worth pinning per case — an eval case doesn't need to nail every field. */
  expected: Partial<TurnIntentClassification>
}

/**
 * A durable-fact statement written so extractFactsFromTurn (fact-extraction.ts's lexical, zero-LLM-call
 * FACT_MARKERS/HEALTH_OR_DIETARY_MARKERS pass) finds nothing for it — verified at eval time, not just by
 * construction — so a pass here is real evidence the statesDurableFact LLM backstop (Phase 1 of
 * lexical_functions_hardening_plan.html) actually catches what the lexical path structurally can't.
 */
interface FactBackstopCase {
  id: string
  lang: 'en' | 'zh'
  message: string
  expectDurable: boolean
}

/**
 * A two-step "First X, then Y" request where Y is a paraphrase of a HIGH-risk action (delete/spend money/
 * cancel) written to avoid every keyword risk-classifier.ts's classifyRisk() matches — verified at eval
 * time against classifyRisk() itself, so a pass here is evidence the per-task riskLevel LLM backstop
 * (also Phase 1) catches a step the old standalone lexical classifyRisk(description) call would have
 * silently waved through as LOW. X is deliberately ordinary/LOW so a model that just marks everything HIGH
 * wouldn't pass either — see runRiskStepCase's assertion on decomposedTasks[0].
 */
interface RiskStepBackstopCase {
  id: string
  lang: 'en' | 'zh'
  message: string
  /** The risky clause alone, as embedded in `message` — used only for the pre-flight classifyRisk() check. */
  riskyClause: string
}

const NO_PLAN: TurnIntentContext = { hasActivePlan: false }
const ACTIVE_PLAN: TurnIntentContext = { hasActivePlan: true }

// English cases ported from risk-classifier.ts's 45 "found via live testing" comments (see that
// file's history) plus one representative case per other judgment (triviality, decomposition,
// bulk-reminder, abandon, plan-template) — the same corpus turn-intent-classifier.test.ts's mocked
// suite exercises for plumbing, run here for real to check the model actually gets them right.
const ENGLISH_CASES: Case[] = [
  { id: 'en-order-noun', lang: 'en', message: 'My coffee order is an oat milk cortado.', expected: { riskLevel: 'LOW' } },
  { id: 'en-order-verb', lang: 'en', message: 'Please order me a pizza for dinner.', expected: { riskLevel: 'HIGH' } },
  { id: 'en-send-past-question', lang: 'en', message: 'Did that actually send a real email just now?', expected: { riskLevel: 'LOW' } },
  { id: 'en-forward-genuine', lang: 'en', message: 'Please forward our proposal to the client before end of day.', expected: { riskLevel: 'HIGH' } },
  { id: 'en-remove-domain', lang: 'en', message: 'Remove.bg is a great tool for removing backgrounds from photos.', expected: { riskLevel: 'LOW' } },
  { id: 'en-wire-noun', lang: 'en', message: 'Wire fraud cases have increased significantly this year.', expected: { riskLevel: 'LOW' } },
  {
    id: 'en-bulk-reminder',
    lang: 'en',
    message: 'Remind me to: research the company, prepare answers to behavioral questions, pick out what to wear, and plan my route.',
    expected: { riskLevel: 'MEDIUM', isReminderRequest: true, isBulkReminderRequest: true, requiresApproval: true },
  },
  {
    id: 'en-single-reminder',
    lang: 'en',
    message: 'Remind me to call the dentist tomorrow.',
    expected: { riskLevel: 'MEDIUM', isReminderRequest: true, isBulkReminderRequest: false, requiresApproval: false },
  },
  { id: 'en-past-narrative', lang: 'en', message: 'I already deleted the old vacation photos last year.', expected: { riskLevel: 'LOW' } },
  { id: 'en-reported-speech', lang: 'en', message: 'My roommate warned that she plans to delete our shared documents folder.', expected: { riskLevel: 'LOW' } },
  { id: 'en-trivial-fact', lang: 'en', message: 'What timezone is Tokyo in?', expected: { riskLevel: 'LOW', isTrivial: true } },
  { id: 'en-not-trivial-compound', lang: 'en', message: "What's the capital of France and what's the capital of Germany?", expected: { riskLevel: 'LOW', isTrivial: false } },
  {
    id: 'en-decomposition',
    lang: 'en',
    message: 'First book my flight to Paris, then book a hotel near the Louvre.',
    expected: { riskLevel: 'MEDIUM' },
  },
  { id: 'en-abandon', lang: 'en', message: 'Forget this plan, let\'s do something else.', context: ACTIVE_PLAN, expected: { isAbandonRequest: true } },
  { id: 'en-not-abandon-progress-check', lang: 'en', message: 'Give me an update on the plan.', context: ACTIVE_PLAN, expected: { isAbandonRequest: false } },
  {
    id: 'en-plan-template',
    lang: 'en',
    message: 'Plan and launch the Q3 onboarding redesign project, then build the rollout schedule and deliver the milestone roadmap.',
    expected: { matchedPlanTemplate: 'project_planning' },
  },
]

// Chinese equivalents covering the same intent categories — vocabulary informed by
// plans/personal_assistant_chinese_lexical_checks_plan.html's sketched risk/reminder/abandon
// phrases (that plan is unimplemented scoping; nothing here is copied code, only the vocabulary
// ideas). A fluent-speaker review of these phrasings is still worth doing before treating this as
// an authoritative Chinese test corpus — see that plan's own open decisions on this point.
const CHINESE_CASES: Case[] = [
  { id: 'zh-order-noun', lang: 'zh', message: '我的咖啡订单是燕麦拿铁。', expected: { riskLevel: 'LOW' } },
  { id: 'zh-order-verb', lang: 'zh', message: '请帮我订一份披萨当晚餐。', expected: { riskLevel: 'HIGH' } },
  { id: 'zh-delete-genuine', lang: 'zh', message: '请删除我旧的发票文件。', expected: { riskLevel: 'HIGH' } },
  { id: 'zh-delete-past', lang: 'zh', message: '我去年已经删除了旧的度假照片。', expected: { riskLevel: 'LOW' } },
  {
    id: 'zh-bulk-reminder',
    lang: 'zh',
    message: '提醒我:给银行打电话、给房东发邮件、还要去取干洗的衣服。',
    expected: { riskLevel: 'MEDIUM', isReminderRequest: true, isBulkReminderRequest: true, requiresApproval: true },
  },
  {
    id: 'zh-single-reminder',
    lang: 'zh',
    message: '提醒我明天打电话给牙医。',
    expected: { riskLevel: 'MEDIUM', isReminderRequest: true, isBulkReminderRequest: false, requiresApproval: false },
  },
  { id: 'zh-trivial-fact', lang: 'zh', message: '东京是什么时区?', expected: { riskLevel: 'LOW', isTrivial: true } },
  { id: 'zh-abandon', lang: 'zh', message: '算了,不用管这个计划了,我们做点别的。', context: ACTIVE_PLAN, expected: { isAbandonRequest: true } },
  {
    id: 'zh-decomposition',
    lang: 'zh',
    message: '先帮我订去巴黎的机票,然后在卢浮宫附近订一家酒店。',
    expected: { riskLevel: 'MEDIUM' },
  },
]

// Each message was checked by hand against fact-extraction.ts's FACT_MARKERS/HEALTH_OR_DIETARY_MARKERS
// (en-*) — the zh-* cases need no such check since those patterns only exist for "en" in
// fact-markers.json, so any non-English fact statement is an automatic lexical miss. runFactCase()
// re-verifies extractFactsFromTurn returns [] for every case here at run time regardless, so this
// comment can't silently go stale.
const FACT_BACKSTOP_CASES: FactBackstopCase[] = [
  {
    id: 'fact-paraphrase-allergy',
    lang: 'en',
    message: "Peanuts landed me in the ER once, so it's smart to keep them out of anything you suggest for me to eat.",
    expectDurable: true,
  },
  {
    id: 'fact-paraphrase-name',
    lang: 'en',
    message: 'Around the office everyone just knows me as Jax, not my full name.',
    expectDurable: true,
  },
  {
    id: 'fact-zh-allergy',
    lang: 'zh',
    message: '我小时候被蜜蜂蜇过一次,现在身体对蜂毒特别敏感,吃东西前最好先确认一下。',
    expectDurable: true,
  },
  {
    id: 'fact-zh-name',
    lang: 'zh',
    message: '在公司里,大家都叫我阿杰,没人用我的本名。',
    expectDurable: true,
  },
]

// Each riskyClause was checked by hand against risk-classifier.ts's classifyRisk() (none of its
// HIGH_RISK_PATTERNS keywords — delete/remove/wipe/erase, pay/buy/transfer money/wire, cancel/
// unsubscribe, etc. — appear). runRiskStepCase() re-verifies classifyRisk(riskyClause).riskLevel !==
// 'HIGH' at run time regardless, for the same reason as FACT_BACKSTOP_CASES above.
const RISK_STEP_BACKSTOP_CASES: RiskStepBackstopCase[] = [
  {
    id: 'risk-paraphrase-delete',
    lang: 'en',
    message: 'First check my calendar for tomorrow, then get rid of the old draft documents in the shared folder for good.',
    riskyClause: 'get rid of the old draft documents in the shared folder for good',
  },
  {
    id: 'risk-paraphrase-money',
    lang: 'en',
    message: 'First check the weather for this weekend, then get three hundred dollars over to Sam for the rent split, however works best for you.',
    riskyClause: 'get three hundred dollars over to Sam for the rent split, however works best for you',
  },
  {
    id: 'risk-paraphrase-cancel',
    lang: 'en',
    message: "First look up the gym's policy on membership changes, then let my membership lapse for good so the charges stop.",
    riskyClause: 'let my membership lapse for good so the charges stop',
  },
]

function matchesExpected(actual: TurnIntentClassification, expected: Partial<TurnIntentClassification>): string[] {
  const mismatches: string[] = []
  for (const [key, value] of Object.entries(expected)) {
    const actualValue = actual[key as keyof TurnIntentClassification]
    if (actualValue !== value) mismatches.push(`${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actualValue)}`)
  }
  return mismatches
}

interface CaseResult {
  id: string
  message: string
  passed: boolean
  mismatches: string[]
}

async function runCase(testCase: Case, llm: ClaudeCliLLMClient): Promise<CaseResult> {
  const actual = await classifyTurnIntent(testCase.message, llm, testCase.context ?? NO_PLAN)
  const mismatches = matchesExpected(actual, testCase.expected)
  return { id: testCase.id, message: testCase.message, passed: mismatches.length === 0, mismatches }
}

async function runFactCase(testCase: FactBackstopCase, llm: ClaudeCliLLMClient): Promise<CaseResult> {
  const lexicalFacts = extractFactsFromTurn(testCase.message, 'eval-turn')
  if (lexicalFacts.length > 0) {
    return {
      id: testCase.id,
      message: testCase.message,
      passed: false,
      mismatches: [`fixture is broken: extractFactsFromTurn found ${JSON.stringify(lexicalFacts)} lexically — this case no longer tests the LLM backstop, it needs rephrasing`],
    }
  }
  const actual = await classifyTurnIntent(testCase.message, llm, NO_PLAN)
  const mismatches: string[] = []
  if (actual.statesDurableFact === null) {
    mismatches.push('statesDurableFact: expected non-null, got null')
  } else if (actual.statesDurableFact.durable !== testCase.expectDurable) {
    mismatches.push(`statesDurableFact.durable: expected ${testCase.expectDurable}, got ${actual.statesDurableFact.durable}`)
  }
  return { id: testCase.id, message: testCase.message, passed: mismatches.length === 0, mismatches }
}

async function runRiskStepCase(testCase: RiskStepBackstopCase, llm: ClaudeCliLLMClient): Promise<CaseResult> {
  const lexicalRisk = classifyRisk(testCase.riskyClause)
  if (lexicalRisk.riskLevel === 'HIGH') {
    return {
      id: testCase.id,
      message: testCase.message,
      passed: false,
      mismatches: [`fixture is broken: classifyRisk() already flags "${testCase.riskyClause}" as HIGH lexically (${lexicalRisk.reason}) — this case no longer tests the LLM backstop, it needs rephrasing`],
    }
  }
  const actual = await classifyTurnIntent(testCase.message, llm, NO_PLAN)
  const mismatches: string[] = []
  if (!actual.decomposedTasks || actual.decomposedTasks.length !== 2) {
    mismatches.push(`decomposedTasks: expected exactly 2 steps, got ${JSON.stringify(actual.decomposedTasks)}`)
  } else {
    const [first, second] = actual.decomposedTasks
    if (first.riskLevel === 'HIGH') mismatches.push(`decomposedTasks[0].riskLevel: expected the ordinary first step to stay non-HIGH, got HIGH — suspicious of a model marking everything HIGH rather than actually discriminating`)
    if (second.riskLevel !== 'HIGH') mismatches.push(`decomposedTasks[1].riskLevel: expected HIGH for the paraphrased risky step, got ${second.riskLevel}`)
  }
  return { id: testCase.id, message: testCase.message, passed: mismatches.length === 0, mismatches }
}

const DEFAULT_MIN_PASS_RATE = 0.85

async function main(): Promise<void> {
  const langFilter = process.argv.find((a) => a.startsWith('--lang='))?.split('=')[1]
  const minPassRateArg = process.argv.find((a) => a.startsWith('--min-pass-rate='))?.split('=')[1]
  const minPassRate = minPassRateArg ? Number(minPassRateArg) : DEFAULT_MIN_PASS_RATE

  const turnIntentCases = [...ENGLISH_CASES, ...CHINESE_CASES].filter((c) => !langFilter || c.lang === langFilter)
  const factCases = FACT_BACKSTOP_CASES.filter((c) => !langFilter || c.lang === langFilter)
  const riskStepCases = RISK_STEP_BACKSTOP_CASES.filter((c) => !langFilter || c.lang === langFilter)

  const llm = new ClaudeCliLLMClient()
  const results: CaseResult[] = []

  for (const testCase of turnIntentCases) results.push(await runCase(testCase, llm))
  for (const testCase of factCases) results.push(await runFactCase(testCase, llm))
  for (const testCase of riskStepCases) results.push(await runRiskStepCase(testCase, llm))

  for (const r of results) {
    if (r.passed) {
      console.log(`PASS  ${r.id}`)
    } else {
      console.log(`FAIL  ${r.id} — ${r.message}`)
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
