#!/usr/bin/env -S npx tsx
/**
 * Real-LLM accuracy eval for classifyTurnIntent (packages/personal-assistant/src/turn-intent-classifier.ts) —
 * the actual gate plans/personal_assistant_consolidated_classifier_plan.html's Phase 3 means by "gate the
 * cutover on this suite passing." turn-intent-classifier.test.ts only proves the parsing/derivation code
 * around the LLM call is correct (via scripted canned responses); this script proves the prompt/schema design
 * itself classifies real English *and* non-English input correctly, by running it against a real model.
 *
 * Not part of `npm test`/CI — makes real LLM calls and costs time/tokens. Run manually before deleting the
 * superseded regex classifiers (risk-classifier.ts's LLM/pattern bits, triviality-classifier.ts,
 * decomposition-classifier.ts's gate, plan-store.ts's abandon detection, planning-classifier.ts):
 *
 *   cd packages/personal-assistant && npx tsx scripts/eval-turn-intent.ts
 *   npx tsx scripts/eval-turn-intent.ts --lang=zh   # only the Chinese fixtures
 *
 * Uses the claude-cli backend (shells out to `claude -p`, already on PATH, no API key needed — see
 * CLAUDE.md's "Driving the personal-assistant" section) so this runs in any dev environment with Claude
 * Code installed.
 */
import { ClaudeCliLLMClient } from '../src/claude-cli-llm-client.js'
import { classifyTurnIntent, type TurnIntentClassification, type TurnIntentContext } from '../src/turn-intent-classifier.js'

interface Case {
  id: string
  lang: 'en' | 'zh'
  message: string
  context?: TurnIntentContext
  /** Only the fields worth pinning per case — an eval case doesn't need to nail every field. */
  expected: Partial<TurnIntentClassification>
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

function matchesExpected(actual: TurnIntentClassification, expected: Partial<TurnIntentClassification>): string[] {
  const mismatches: string[] = []
  for (const [key, value] of Object.entries(expected)) {
    const actualValue = actual[key as keyof TurnIntentClassification]
    if (actualValue !== value) mismatches.push(`${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actualValue)}`)
  }
  return mismatches
}

async function main(): Promise<void> {
  const langFilter = process.argv.find((a) => a.startsWith('--lang='))?.split('=')[1]
  const cases = [...ENGLISH_CASES, ...CHINESE_CASES].filter((c) => !langFilter || c.lang === langFilter)

  const llm = new ClaudeCliLLMClient()
  let passed = 0
  const failures: { id: string; message: string; mismatches: string[] }[] = []

  for (const testCase of cases) {
    const actual = await classifyTurnIntent(testCase.message, llm, testCase.context ?? NO_PLAN)
    const mismatches = matchesExpected(actual, testCase.expected)
    if (mismatches.length === 0) {
      passed++
      console.log(`PASS  ${testCase.id}`)
    } else {
      failures.push({ id: testCase.id, message: testCase.message, mismatches })
      console.log(`FAIL  ${testCase.id} — ${testCase.message}`)
      for (const m of mismatches) console.log(`        ${m}`)
    }
  }

  console.log(`\n${passed}/${cases.length} passed`)
  if (failures.length > 0) {
    console.log(`\n${failures.length} failure(s):`)
    for (const f of failures) console.log(`  - ${f.id}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
