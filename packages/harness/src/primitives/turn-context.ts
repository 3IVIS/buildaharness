/**
 * G-2 — TurnContextBootstrap
 *
 * Configurable turn-state initialiser for multi-turn conversational agents.
 * Port of adapter/harness/turn_context.py. No domain vocabulary.
 */

export interface SessionField {
  key: string
  default: unknown
  sourcePath?: string
  initOnce?: boolean
}

export interface ResourceBudget {
  timeLimitSeconds: number
  tokenBudget: number
  budgetKey?: string
  turnKey?: string
}

function resolveDotPath(
  state: Record<string, unknown>,
  path: string,
): { found: boolean; value: unknown } {
  let current: unknown = state
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null || !(part in (current as Record<string, unknown>))) {
      return { found: false, value: undefined }
    }
    current = (current as Record<string, unknown>)[part]
    if (current === null || current === undefined) {
      return { found: true, value: null }
    }
  }
  return { found: true, value: current }
}

export function makeTurnInitializer(
  fields: SessionField[],
  options?: {
    resourceBudget?: ResourceBudget
    emptyModelKey?: string
    emptyModelTemplate?: Record<string, unknown>
  },
): (state: Record<string, unknown>) => Record<string, unknown> {
  const turnKey = options?.resourceBudget?.turnKey ?? 'turn_number'

  return function initializer(state: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { ...state }
    const rawTurn = result[turnKey] as number | null | undefined
    const isTurnOne = rawTurn == null || rawTurn <= 1

    // Steps 1 & 2: SessionFields
    for (const f of fields) {
      if (f.sourcePath !== undefined) {
        if (f.initOnce && !isTurnOne) continue
        const { found, value } = resolveDotPath(result, f.sourcePath)
        result[f.key] = !found || value === null || value === undefined ? f.default : value
      } else {
        if (!(f.key in result)) {
          result[f.key] = f.default
        }
      }
    }

    // Step 3: Resource budget
    if (options?.resourceBudget !== undefined) {
      const budget = options.resourceBudget
      const budgetKey = budget.budgetKey ?? 'resource_budget'

      if (isTurnOne) {
        result[budgetKey] = {
          timeLimitSeconds: budget.timeLimitSeconds,
          tokenBudget: budget.tokenBudget,
          elapsedSeconds: 0,
          tokensUsed: 0,
          startedAt: new Date(),
        }
      } else {
        const existing = (result[budgetKey] ?? {}) as Record<string, unknown>
        const startedAt = existing['startedAt']
        const elapsed = startedAt instanceof Date ? (Date.now() - startedAt.getTime()) / 1000 : 0
        result[budgetKey] = { ...existing, elapsedSeconds: elapsed }
      }
    }

    // Step 4: Empty model seeding
    if (options?.emptyModelKey !== undefined && !result[options.emptyModelKey]) {
      const template = options.emptyModelTemplate ?? {}
      result[options.emptyModelKey] = JSON.parse(JSON.stringify(template))
    }

    return result
  }
}
