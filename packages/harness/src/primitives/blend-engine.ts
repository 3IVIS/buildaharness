/**
 * G-1 — StrategyBlendEngine
 *
 * Configurable, momentum-bounded strategy weight distribution engine.
 * Port of adapter/harness/blend_engine.py. No domain vocabulary.
 */

export interface BlendRule {
  condition: (state: Record<string, unknown>) => boolean
  adjustments: Record<string, number>
  redistributeTo?: string[]
  styleOverride?: string
}

export function normalizeBlend(blend: Record<string, number>): Record<string, number> {
  const floored: Record<string, number> = {}
  for (const [k, v] of Object.entries(blend)) {
    floored[k] = Math.max(0, v)
  }
  const total = Object.values(floored).reduce((sum, v) => sum + v, 0)
  if (total === 0) return blend
  const scale = 100 / total
  const result: Record<string, number> = {}
  for (const [k, v] of Object.entries(floored)) {
    result[k] = v * scale
  }
  return result
}

export function makeBlendAdjuster(
  rules: BlendRule[],
  blendKey = 'strategy_blend',
  momentumCap = 10,
): (state: Record<string, unknown>) => Record<string, unknown> {
  return function adjuster(state: Record<string, unknown>): Record<string, unknown> {
    const blend = state[blendKey] as Record<string, number> | undefined | null
    if (!blend) return state

    const original: Record<string, number> = { ...blend }
    const current: Record<string, number> = { ...blend }
    const firedRules: BlendRule[] = []

    for (const rule of rules) {
      if (!rule.condition(state)) continue
      firedRules.push(rule)
      let freed = 0

      for (const [key, delta] of Object.entries(rule.adjustments)) {
        if (!(key in current)) continue
        const oldVal = current[key]
        const newVal = Math.max(0, oldVal + delta)
        freed += oldVal - newVal
        current[key] = newVal
      }

      if (freed > 0 && rule.redistributeTo) {
        const targets = rule.redistributeTo.filter((k) => k in current)
        const totalTarget = targets.reduce((s, k) => s + current[k], 0)
        if (totalTarget > 0) {
          for (const k of targets) {
            current[k] += freed * (current[k] / totalTarget)
          }
        }
      }
    }

    // Momentum cap: second pass comparing each key vs original
    for (const key of Object.keys(current)) {
      if (!(key in original)) continue
      const delta = current[key] - original[key]
      if (Math.abs(delta) > momentumCap) {
        current[key] = Math.max(0, original[key] + (delta > 0 ? momentumCap : -momentumCap))
      }
    }

    const normalized = normalizeBlend(current)
    const result: Record<string, unknown> = { ...state, [blendKey]: normalized }

    for (const rule of firedRules) {
      if (rule.styleOverride !== undefined) {
        result['style_override'] = rule.styleOverride
      }
    }

    return result
  }
}
