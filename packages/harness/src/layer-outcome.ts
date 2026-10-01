import type { Decision, LayerPolicy } from './layer-policy.js'

/**
 * AL9b of the adaptive layer selection plan: the per-turn outcome log and shadow-mode telemetry.
 * Logging and reporting only — nothing here feeds back into a decision (no adaptation from outcomes yet).
 *
 * AL-10: a row carries enums, counts, ids and costs ONLY. Rows are built field by field through the
 * sanitisers below (never spread from caller input), so message text, facts or file contents handed
 * to a builder cannot end up in a row — free strings are dropped unless they look like an identifier.
 */

const ID_RE = /^[A-Za-z0-9_.:-]{1,96}$/
const DECISIONS: readonly string[] = ['off', 'cheap', 'full']

const id = (v: unknown): string | undefined => (typeof v === 'string' && ID_RE.test(v) ? v : undefined)
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0)
const flag = (v: unknown): boolean => v === true
const decision = (v: unknown): Decision | undefined => (typeof v === 'string' && DECISIONS.includes(v) ? (v as Decision) : undefined)

/** What one layer did this turn. */
export interface LayerOutcome {
  layer: string
  fired: boolean
  calls: number
  tokens: number
  /** The layer changed the reply or a verdict (a finding, not mere activity). */
  changed: boolean
  /** The finding was acted on (it changed something and the turn ran through to completion). */
  actedOn: boolean
}

export interface LayerOutcomeRow {
  kind: 'layer_outcome'
  runId: string
  mode: string
  tier: string
  layers: LayerOutcome[]
  /** Unknown at write time; filled by a later `layer_outcome_feedback` row from the next turn's `pushbackOnPriorTurn`. */
  nextTurnCorrection: boolean | null
}

/** Written by the NEXT turn: whether it corrected the turn `runId`. */
export interface LayerOutcomeFeedbackRow {
  kind: 'layer_outcome_feedback'
  runId: string
  nextTurnCorrection: boolean
}

export interface ShadowDisagreement {
  layer: string
  executed: Decision
  shadow: Decision
  trigger: string
}

/** Shadow mode: what adaptive would have decided next to what actually ran. */
export interface ShadowRow {
  kind: 'shadow_turn'
  runId: string
  executedTier: string
  shadowTier: string
  /** Every layer where the shadow decision differed from the executed one. */
  disagreements: ShadowDisagreement[]
  /** LLM calls the executed (static) policy would draw vs what the shadow policy would. */
  executedCalls: number
  shadowCalls: number
  /** Actual LLM calls the turn made across the instrumented escalation layers (measured, not modelled). */
  observedCalls: number
  /** Measured calls per escalation layer (only layers that made at least one). Absent on rows written before it existed. */
  observedByLayer?: Record<string, number>
  verificationFailed: boolean
  nextTurnCorrection: boolean | null
}

export type LayerTelemetryRow = LayerOutcomeRow | LayerOutcomeFeedbackRow | ShadowRow

export interface LayerActivityLike {
  layer?: unknown
  fired?: unknown
  llmCalls?: unknown
  tokens?: unknown
}

export function buildLayerOutcomeRow(input: {
  runId: string
  mode: string
  tier: string
  activity: readonly LayerActivityLike[]
  /** Layers that produced a finding this turn (caller decides; names only). */
  changedLayers?: readonly string[]
  completed: boolean
  /**
   * MEASURED LLM use of the escalation layers whose hooks the host instruments (escalation-layer id → calls and tokens). Each
   * becomes its own outcome entry (`fired` = made at least one call), so `layer-yield` shows real calls and tokens instead of 0.
   * A layer that is not instrumented simply has no entry — absence means "not measured", not "made no calls".
   */
  layerUse?: Readonly<Record<string, { calls: number; tokens: number }>>
}): LayerOutcomeRow | undefined {
  const runId = id(input.runId)
  if (runId === undefined) return undefined
  const changedSet = new Set((input.changedLayers ?? []).filter((l): l is string => id(l) !== undefined))
  const byLayer = new Map<string, LayerOutcome>()
  for (const ev of input.activity) {
    const layer = id(ev.layer)
    if (layer === undefined) continue
    const prior = byLayer.get(layer) ?? { layer, fired: false, calls: 0, tokens: 0, changed: false, actedOn: false }
    prior.fired = prior.fired || flag(ev.fired)
    prior.calls += count(ev.llmCalls)
    prior.tokens += count(ev.tokens)
    byLayer.set(layer, prior)
  }
  for (const o of byLayer.values()) {
    o.changed = o.fired && changedSet.has(o.layer)
    o.actedOn = o.changed && input.completed
  }
  for (const [layer, use] of Object.entries(input.layerUse ?? {})) {
    const lid = id(layer)
    if (lid === undefined || byLayer.has(lid)) continue
    const calls = count(use?.calls)
    byLayer.set(lid, { layer: lid, fired: calls > 0, calls, tokens: count(use?.tokens), changed: false, actedOn: false })
  }
  return {
    kind: 'layer_outcome',
    runId,
    mode: id(input.mode) ?? 'unknown',
    tier: id(input.tier) ?? 'unknown',
    layers: [...byLayer.values()],
    nextTurnCorrection: null,
  }
}

export function buildFeedbackRow(runId: string, correction: boolean): LayerOutcomeFeedbackRow | undefined {
  const rid = id(runId)
  return rid === undefined ? undefined : { kind: 'layer_outcome_feedback', runId: rid, nextTurnCorrection: correction === true }
}

const costOf = (policy: LayerPolicy, costs: Readonly<Record<string, number>>): number => {
  let total = 0
  for (const [layer, d] of Object.entries(policy)) if (d.decision === 'full') total += costs[layer] ?? 0
  return total
}

function sanitizeObserved(by: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [layer, n] of Object.entries(by)) {
    const lid = id(layer)
    const c = count(n)
    if (lid !== undefined && c > 0) out[lid] = c
  }
  return out
}

export function buildShadowRow(input: {
  runId: string
  executed: LayerPolicy
  executedTier: string
  shadow: { policy: LayerPolicy; tier: string }
  layerCosts: Readonly<Record<string, number>>
  observedCalls: number
  /** Measured calls per escalation layer; layers with none are left out. */
  observedByLayer?: Readonly<Record<string, number>>
  verificationFailed: boolean
}): ShadowRow | undefined {
  const runId = id(input.runId)
  if (runId === undefined) return undefined
  const disagreements: ShadowDisagreement[] = []
  for (const layer of Object.keys(input.executed)) {
    const e = decision(input.executed[layer as keyof LayerPolicy]?.decision)
    const s = decision(input.shadow.policy[layer as keyof LayerPolicy]?.decision)
    if (e === undefined || s === undefined || e === s) continue
    disagreements.push({ layer, executed: e, shadow: s, trigger: id(input.shadow.policy[layer as keyof LayerPolicy]?.trigger) ?? 'unknown' })
  }
  return {
    kind: 'shadow_turn',
    runId,
    executedTier: id(input.executedTier) ?? 'unknown',
    shadowTier: id(input.shadow.tier) ?? 'unknown',
    disagreements,
    executedCalls: costOf(input.executed, input.layerCosts),
    shadowCalls: costOf(input.shadow.policy, input.layerCosts),
    observedCalls: count(input.observedCalls),
    ...(input.observedByLayer ? { observedByLayer: sanitizeObserved(input.observedByLayer) } : {}),
    verificationFailed: flag(input.verificationFailed),
    nextTurnCorrection: null,
  }
}

/** Folds `layer_outcome_feedback` rows into the rows they refer to (a later row wins). */
function withFeedback<T extends LayerOutcomeRow | ShadowRow>(rows: readonly LayerTelemetryRow[], kind: T['kind']): T[] {
  const fb = new Map<string, boolean>()
  for (const r of rows) if (r.kind === 'layer_outcome_feedback') fb.set(r.runId, r.nextTurnCorrection)
  return rows
    .filter((r): r is T => r.kind === kind)
    .map(r => (fb.has(r.runId) ? { ...r, nextTurnCorrection: fb.get(r.runId) as boolean } : r))
}

export interface LayerYield {
  layer: string
  turns: number
  fired: number
  calls: number
  tokens: number
  changed: number
  actedOn: number
  /** Turns after which the next turn was a correction / turns whose correction status is known. */
  correctedNext: number
  knownNext: number
  /** changed / calls, or null when the layer drew no LLM calls. */
  changesPerCall: number | null
}

export function summarizeLayerYield(rows: readonly LayerTelemetryRow[]): LayerYield[] {
  const acc = new Map<string, LayerYield>()
  for (const row of withFeedback<LayerOutcomeRow>(rows, 'layer_outcome')) {
    for (const o of row.layers) {
      const y = acc.get(o.layer) ?? { layer: o.layer, turns: 0, fired: 0, calls: 0, tokens: 0, changed: 0, actedOn: 0, correctedNext: 0, knownNext: 0, changesPerCall: null }
      y.turns++
      if (o.fired) y.fired++
      y.calls += o.calls
      y.tokens += o.tokens
      if (o.changed) y.changed++
      if (o.actedOn) y.actedOn++
      if (row.nextTurnCorrection !== null) {
        y.knownNext++
        if (row.nextTurnCorrection) y.correctedNext++
      }
      acc.set(o.layer, y)
    }
  }
  return [...acc.values()]
    .map(y => ({ ...y, changesPerCall: y.calls > 0 ? y.changed / y.calls : null }))
    .sort((a, b) => a.layer.localeCompare(b.layer))
}

export interface ShadowLayerReport {
  layer: string
  turns: number
  disagreements: number
  disagreementRate: number
  /** Disagreements where shadow would have skipped/degraded the layer (shadow < executed). */
  wouldSkip: number
  /** Of those, turns where the next turn (or verification) was a correction/failure — a possible miss. */
  skipCoincidedWithCorrection: number
  skipKnown: number
  /** MEASURED calls this layer made on the turns where the shadow policy would have skipped it — what adaptive would really have saved. */
  observedCallsSkipped: number
}

export interface ShadowReport {
  turns: number
  callsSaved: number
  executedCalls: number
  shadowCalls: number
  /** Measured calls across the instrumented layers, and how many of them fall on turns/layers the shadow policy would have skipped. */
  observedCalls: number
  observedCallsSkipped: number
  layers: ShadowLayerReport[]
}

const RANK: Record<Decision, number> = { off: 0, cheap: 1, full: 2 }

export function summarizeShadow(rows: readonly LayerTelemetryRow[]): ShadowReport {
  const shadows = withFeedback<ShadowRow>(rows, 'shadow_turn')
  const acc = new Map<string, ShadowLayerReport>()
  const touch = (layer: string) => {
    let r = acc.get(layer)
    if (!r) acc.set(layer, (r = { layer, turns: 0, disagreements: 0, disagreementRate: 0, wouldSkip: 0, skipCoincidedWithCorrection: 0, skipKnown: 0, observedCallsSkipped: 0 }))
    return r
  }
  let callsSaved = 0, executedCalls = 0, shadowCalls = 0, observedCalls = 0, observedCallsSkipped = 0
  for (const row of shadows) {
    executedCalls += row.executedCalls
    shadowCalls += row.shadowCalls
    callsSaved += Math.max(0, row.executedCalls - row.shadowCalls)
    observedCalls += row.observedCalls
    for (const d of row.disagreements) {
      const r = touch(d.layer)
      r.disagreements++
      if (RANK[d.shadow] < RANK[d.executed]) {
        r.wouldSkip++
        const measured = row.observedByLayer?.[d.layer] ?? 0
        r.observedCallsSkipped += measured
        observedCallsSkipped += measured
        if (row.nextTurnCorrection !== null) {
          r.skipKnown++
          if (row.nextTurnCorrection || row.verificationFailed) r.skipCoincidedWithCorrection++
        } else if (row.verificationFailed) {
          r.skipKnown++
          r.skipCoincidedWithCorrection++
        }
      }
    }
  }
  // Every shadow turn counts as a turn for every layer that ever disagreed.
  for (const r of acc.values()) {
    r.turns = shadows.length
    r.disagreementRate = shadows.length > 0 ? r.disagreements / shadows.length : 0
  }
  return { turns: shadows.length, callsSaved, executedCalls, shadowCalls, observedCalls, observedCallsSkipped, layers: [...acc.values()].sort((a, b) => a.layer.localeCompare(b.layer)) }
}

/** Parses a JSONL (or JSON array) telemetry log; malformed lines are skipped. */
export function parseTelemetryLog(text: string): LayerTelemetryRow[] {
  const trimmed = text.trim()
  const items: unknown[] = []
  if (trimmed.startsWith('[')) {
    try { items.push(...(JSON.parse(trimmed) as unknown[])) } catch { /* ignore */ }
  } else {
    for (const line of trimmed.split('\n')) {
      try { items.push(JSON.parse(line)) } catch { /* skip */ }
    }
  }
  return items.filter((r): r is LayerTelemetryRow => {
    const k = (r as { kind?: unknown } | null)?.kind
    return k === 'layer_outcome' || k === 'layer_outcome_feedback' || k === 'shadow_turn'
  })
}
