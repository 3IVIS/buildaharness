/**
 * AL5b — pure machinery for the classifier signal eval: label reconciliation (double pass, per-field
 * disagreements dropped), per-field agreement scoring against the 85% bar, the owner spot-check
 * sample, the cost-floor share, and the markdown table. No model calls here — the scripts inject them.
 */
import type { TurnIntentClassification } from '../src/turn-intent-classifier.js'
import type { TurnSignalField, TurnSignalTurn } from './turn-signals-corpus.js'

export const SIGNAL_FIELDS: TurnSignalField[] = ['needsGrounding', 'ambiguity', 'userPosture', 'pushbackOnPriorTurn', 'statesConstraint']

/** A field below this agreement with the label is not used by any AL10 trigger. */
export const FIELD_ACCURACY_BAR = 0.85

export type SignalLabel = Partial<Record<TurnSignalField, boolean | string>>

/** Per-field: keep a label only where both labelling passes agree; otherwise leave the field unlabelled. */
export function reconcileLabels(a: SignalLabel | null, b: SignalLabel | null): SignalLabel {
  const out: SignalLabel = {}
  if (!a || !b) return out
  for (const f of SIGNAL_FIELDS) {
    if (a[f] !== undefined && a[f] === b[f]) out[f] = a[f]
  }
  return out
}

export interface LabelledTurn extends TurnSignalTurn {
  labels: SignalLabel
  /** Which model produced/checked the labels — recorded so a same-family labeller is visible in review. */
  labeller: string
}

export interface FieldAccuracy {
  field: TurnSignalField
  scored: number
  agreed: number
  accuracy: number | null
  usable: boolean
}

/** Score classifier output (keyed by turn id) against reconciled labels; unlabelled fields are skipped. */
export function scoreFields(
  labelled: LabelledTurn[],
  predictions: Record<string, Partial<TurnIntentClassification> | undefined>,
  bar = FIELD_ACCURACY_BAR,
): FieldAccuracy[] {
  return SIGNAL_FIELDS.map((field) => {
    let scored = 0
    let agreed = 0
    for (const t of labelled) {
      const want = t.labels[field]
      const got = predictions[t.id]?.[field]
      if (want === undefined || got === undefined) continue
      scored++
      if (want === got) agreed++
    }
    const accuracy = scored === 0 ? null : agreed / scored
    return { field, scored, agreed, accuracy, usable: accuracy !== null && accuracy >= bar }
  })
}

/** Deterministic sample (seeded LCG shuffle) of labelled turns for the owner's non-blocking spot check. */
export function sampleForReview<T>(items: T[], n = 30, seed = 1): T[] {
  const a = [...items]
  let s = seed >>> 0
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, n)
}

export interface CostFloor {
  classifierTokens: number
  turnTokens: number
  /** classifier share of per-turn tokens, or null when the turn total is unknown/zero. */
  tokenShare: number | null
  classifierMs: number
  turnMs: number
  latencyShare: number | null
}

export function costFloor(c: { classifierTokens: number; turnTokens: number; classifierMs: number; turnMs: number }): CostFloor {
  return {
    ...c,
    tokenShare: c.turnTokens > 0 ? c.classifierTokens / c.turnTokens : null,
    latencyShare: c.turnMs > 0 ? c.classifierMs / c.turnMs : null,
  }
}

/** A smaller model is only shipped (behind its flag) if every field the trigger set relies on holds the bar. */
export function smallerModelHoldsBar(baseline: FieldAccuracy[], small: FieldAccuracy[], bar = FIELD_ACCURACY_BAR): boolean {
  return baseline.every((b) => {
    if (!b.usable) return true // nothing to preserve for a field that is already unusable
    const s = small.find((x) => x.field === b.field)
    return !!s && s.accuracy !== null && s.accuracy >= bar
  })
}

const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`)

export function renderAccuracyTable(opts: {
  classifierModel: string
  labeller: string
  totalTurns: number
  fields: FieldAccuracy[]
  smallModel?: { model: string; fields: FieldAccuracy[]; holdsBar: boolean }
  ownerSpotCheckDone: boolean
  cost?: CostFloor
}): string {
  const lines = [
    '# Turn-signal classifier accuracy (AL5b)',
    '',
    `Classifier model: \`${opts.classifierModel}\` · labeller: \`${opts.labeller}\` · turns: ${opts.totalTurns} · bar: ${pct(FIELD_ACCURACY_BAR)} per field`,
    `Owner spot check (docs/turn_signal_labels_review.md): **${opts.ownerSpotCheckDone ? 'done' : 'NOT done'}** (non-blocking)`,
    '',
    '| Field | Scored | Agreed | Accuracy | AL10 may use |' + (opts.smallModel ? ` Small model (${opts.smallModel.model}) |` : ''),
    '|---|---|---|---|---|' + (opts.smallModel ? '---|' : ''),
  ]
  for (const f of opts.fields) {
    const s = opts.smallModel?.fields.find((x) => x.field === f.field)
    lines.push(`| ${f.field} | ${f.scored} | ${f.agreed} | ${pct(f.accuracy)} | ${f.usable ? 'yes' : 'no'} |${opts.smallModel ? ` ${pct(s?.accuracy ?? null)} |` : ''}`)
  }
  if (opts.smallModel) lines.push('', `Smaller-model option holds the bar on every usable field: **${opts.smallModel.holdsBar ? 'yes — may ship behind its flag' : 'no — not shipped'}**`)
  if (opts.cost) {
    lines.push(
      '',
      '## Cost floor',
      `Classifier share of per-turn tokens: ${pct(opts.cost.tokenShare)} (${opts.cost.classifierTokens} / ${opts.cost.turnTokens}); of latency: ${pct(opts.cost.latencyShare)} (${opts.cost.classifierMs}ms / ${opts.cost.turnMs}ms).`,
    )
  }
  return lines.join('\n') + '\n'
}

export function renderReviewSample(sample: LabelledTurn[]): string {
  const rows = sample.map((t) => `- **${t.id}** (${t.lang}) — ${JSON.stringify(t.message)}\n  labels: \`${JSON.stringify(t.labels)}\` · labeller: ${t.labeller}`)
  return ['# Turn-signal label spot check (AL5b)', '', 'Non-blocking. Mark any label you disagree with; record in the accuracy table that the review happened.', '', ...rows, ''].join('\n')
}
