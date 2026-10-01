/**
 * `AUDIT_HARNESS_TOKEN_BUDGET` gate. Default **OFF**: the harness's memory layer keeps its `token_budget` at 0 used of 200,000,
 * so its context-compression pressure test (90%) can never trip, exactly as before. A positive integer turns it on and IS the
 * budget (`AUDIT_HARNESS_TOKEN_BUDGET=30000`): the turn's real model usage (input + output tokens, every call the turn made) is
 * reported to the harness each iteration, and compression runs once usage passes 90% of the total. What it trims is the harness's
 * own bookkeeping (compressed-structure and pruned-region records), never the model's conversation context — that is
 * `semantic-compaction.ts`. Read at one site: harness-bridge.ts.
 */
export function harnessTokenBudgetTotal(env?: Record<string, string | undefined>): number | undefined {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_HARNESS_TOKEN_BUDGET ?? '').trim()
  if (!/^\d+$/.test(raw)) return undefined
  const total = Number(raw)
  return Number.isSafeInteger(total) && total > 0 ? total : undefined
}
