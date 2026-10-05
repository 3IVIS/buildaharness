/**
 * The user-facing on/off surface for reasoning layers, shared by the CLI (`/layers`) and the desktop/browser
 * Settings screen. It is a thin layer over the existing `AUDIT_*` env flags, which every layer already reads in
 * exactly one place: `applyLayerSettings` writes the persisted `config.layers` choices into an env object, so no
 * layer needed a second code path. An env value the operator set themselves always wins and renders as pinned,
 * the same precedence `explicitEnvOverride` already gives it.
 *
 * Floor layers (safety, approval, tool policy, verification, diagnostics) are listed but locked: there is no
 * flag for them and the adaptive policy's types make them un-decidable on purpose.
 */

export type LayerGroup = 'escalation' | 'opt_in' | 'floor'

export interface LayerSetting {
  id: string
  group: LayerGroup
  /** The env flag that carries the choice; absent for locked layers. */
  flag?: string
  /** What the layer does when the user hasn't chosen. */
  defaultOn: boolean
  summary: string
  /** Rough extra cost when it fires, in plain words. */
  cost: string
  /** What the audit found, in plain words — the record, not a promise. */
  evidence: string
}

export const LAYER_SETTINGS: readonly LayerSetting[] = [
  { id: 'semantic_contradiction', group: 'escalation', flag: 'AUDIT_SEMANTIC_CONTRADICTION', defaultOn: true, summary: 'Notices when two things you said conflict by meaning, not wording', cost: 'one call when beliefs are compared', evidence: 'verified: base model misses these unaided' },
  { id: 'failure_match', group: 'escalation', flag: 'AUDIT_SEMANTIC_FAILURE_MATCH', defaultOn: true, summary: 'Recognises a known class of tool failure and routes recovery by it', cost: 'one call per tool failure', evidence: 'demonstrated on a synthetic 503' },
  { id: 'criterion_coverage', group: 'escalation', flag: 'AUDIT_SEMANTIC_CRITERION_COVERAGE', defaultOn: true, summary: 'Checks a reply against your stated "done when" criteria', cost: 'one call when criteria are stated', evidence: 'not shown beyond one conversation' },
  { id: 'change_review', group: 'escalation', flag: 'AUDIT_SEMANTIC_CHANGE_REVIEW', defaultOn: true, summary: 'Flags a later change that breaks an earlier constraint', cost: 'one call per proposed change', evidence: 'blocked: constraints rarely reach it' },
  { id: 'injection_detection', group: 'escalation', flag: 'AUDIT_LLM_INJECTION_DETECT', defaultOn: true, summary: 'Asks a model whether tool output hides instructions (the regex floor stays on)', cost: 'one call per tool result', evidence: 'not demonstrated end to end' },
  { id: 'decomposition_reframe', group: 'escalation', flag: 'AUDIT_DECOMPOSITION', defaultOn: true, summary: 'Splits a multi-part request into tracked deliverables', cost: '3-7x on multi-part requests', evidence: 'no positive regime found so far' },
  { id: 'model_inferred_facts', group: 'escalation', flag: 'AUDIT_MODEL_INFERRED_FACTS', defaultOn: true, summary: 'Remembers facts you implied but never stated outright', cost: 'none extra (reuses the classifier call)', evidence: 'verified 3/3' },
  { id: 'reviewer_adversarial', group: 'escalation', flag: 'AUDIT_REVIEWER_PASS', defaultOn: true, summary: 'A three-lens reviewer pass over the draft reply', cost: 'extra calls per turn', evidence: 'no outcome delta in the audit' },

  { id: 'semantic_hypotheses', group: 'opt_in', flag: 'AUDIT_SEMANTIC_HYPOTHESES', defaultOn: false, summary: 'For an underdetermined question, weighs 2-4 competing explanations before answering', cost: 'about 4x per turn when it fires', evidence: 'suggestive: 13/15 vs 11/18, not significant' },
  { id: 'source_reliability', group: 'opt_in', flag: 'AUDIT_SEMANTIC_SOURCE_RELIABILITY', defaultOn: false, summary: 'Weighs how trustworthy each file or page is', cost: 'two calls per turn', evidence: 'mechanism verified' },
  { id: 'reviewer_revision', group: 'opt_in', flag: 'AUDIT_REVIEWER_REVISION', defaultOn: false, summary: 'Lets reviewer findings revise the reply', cost: 'a second answer when it fires', evidence: 'fires and acts; no outcome delta' },
  { id: 'experience_learning', group: 'opt_in', flag: 'AUDIT_EXPERIENCE_LEARNING', defaultOn: false, summary: 'Learns which recovery strategies worked before', cost: 'none (bookkeeping)', evidence: 'not demonstrable as an outcome' },
  { id: 'semantic_compaction', group: 'opt_in', flag: 'AUDIT_SEMANTIC_COMPACTION', defaultOn: false, summary: 'Summarises long transcripts by meaning instead of truncating', cost: 'one call when the thresholds trip', evidence: 'demonstrated on one matched pair' },
  { id: 'memory_reviewer', group: 'opt_in', flag: 'AUDIT_MEMORY_REVIEWER', defaultOn: false, summary: 'Reviews recent turns for facts worth remembering', cost: 'two calls every few turns', evidence: 'small samples' },

  { id: 'control_state', group: 'floor', defaultOn: true, summary: 'Tightens or blocks tool use as failures accumulate', cost: 'none', evidence: 'safety floor' },
  { id: 'approval_staging', group: 'floor', defaultOn: true, summary: 'Stages every consequential action until you approve it', cost: 'none', evidence: 'safety floor' },
  { id: 'tool_policy', group: 'floor', defaultOn: true, summary: 'Denies tool calls the current control state forbids', cost: 'none', evidence: 'safety floor' },
  { id: 'diagnostics', group: 'floor', defaultOn: true, summary: 'Tracks sub-dimensions that feed the control state', cost: 'none', evidence: 'safety floor' },
  { id: 'hypothesis', group: 'floor', defaultOn: true, summary: 'Template hypothesis bookkeeping (entropy feeds the control state); not the same as semantic_hypotheses', cost: 'none', evidence: 'no outcome effect on its own' },
  { id: 'mandatory_verification', group: 'floor', defaultOn: true, summary: 'Verifies figures and tool results before they are reported', cost: 'none', evidence: 'safety floor' },
]

export type LayerChoices = Readonly<Record<string, boolean>>

export function findLayer(id: string): LayerSetting | undefined {
  return LAYER_SETTINGS.find((l) => l.id === id)
}

/** The layers a user may change: everything except the locked floor. */
export function isToggleable(layer: LayerSetting): boolean {
  return layer.flag !== undefined
}

type Env = Record<string, string | undefined>

/** Per env object: the value this module last wrote for each flag, so a re-apply can tell its own writes from the operator's. */
const written = new WeakMap<Env, Map<string, string>>()

export interface AppliedLayers {
  /** Layer ids whose env flag was set outside this module (shell env / build var), so the saved choice is ignored. */
  pinned: Set<string>
}

/**
 * Makes `env` reflect `choices`. Idempotent: a layer no longer in `choices` is restored to unset, and a flag that
 * holds a value this module did not write is left alone and reported as pinned. Unknown ids and locked layers are ignored.
 */
export function applyLayerSettings(choices: LayerChoices | undefined, env: Env): AppliedLayers {
  const mine = written.get(env) ?? new Map<string, string>()
  written.set(env, mine)
  const pinned = new Set<string>()
  for (const layer of LAYER_SETTINGS) {
    if (!layer.flag) continue
    const current = env[layer.flag]
    const ours = mine.get(layer.flag)
    if (current !== undefined && current !== '' && current !== ours) {
      pinned.add(layer.id)
      continue
    }
    const choice = choices?.[layer.id]
    if (choice === undefined) {
      if (ours !== undefined) { delete env[layer.flag]; mine.delete(layer.flag) }
      continue
    }
    const value = choice ? '1' : '0'
    env[layer.flag] = value
    mine.set(layer.flag, value)
  }
  return { pinned }
}

/** What a layer will do right now: the saved choice, else its default; a pinned layer reports its env value. */
export function effectiveState(layer: LayerSetting, choices: LayerChoices | undefined, pinned: ReadonlySet<string>, env: Env): boolean {
  if (!layer.flag) return true
  if (pinned.has(layer.id)) {
    const raw = String(env[layer.flag] ?? '').trim().toLowerCase()
    return !['0', 'false', 'off', 'no', 'disabled'].includes(raw)
  }
  return choices?.[layer.id] ?? layer.defaultOn
}

/** Returns the choices after setting one layer; throws on an unknown or locked id so a typo never silently persists. */
export function withLayerChoice(choices: LayerChoices | undefined, id: string, on: boolean | undefined): Record<string, boolean> {
  const layer = findLayer(id)
  if (!layer) throw new LayerSettingError(`Unknown layer "${id}". Run /layers to see the list.`)
  if (!isToggleable(layer)) throw new LayerSettingError(`"${id}" is a safety/floor layer and cannot be switched off.`)
  const next = { ...(choices ?? {}) }
  if (on === undefined) delete next[id]
  else next[id] = on
  return next
}

export class LayerSettingError extends Error {}

/** Drops anything in a persisted value that is not a known toggleable layer with a boolean, so a stale or hand-edited file can't smuggle junk in. */
export function sanitizeLayerChoices(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [id, value] of Object.entries(raw)) {
    const layer = findLayer(id)
    if (layer && isToggleable(layer) && typeof value === 'boolean') out[id] = value
  }
  return out
}

export function formatLayerListing(choices: LayerChoices | undefined, pinned: ReadonlySet<string>, env: Env): string {
  const sections: [LayerGroup, string][] = [
    ['escalation', 'On by default (switch off to save cost)'],
    ['opt_in', 'Off by default (switch on to try)'],
    ['floor', 'Always on (safety floor, locked)'],
  ]
  const lines: string[] = []
  for (const [group, title] of sections) {
    lines.push(title)
    for (const layer of LAYER_SETTINGS.filter((l) => l.group === group)) {
      const on = effectiveState(layer, choices, pinned, env)
      const mark = !isToggleable(layer) ? 'locked' : on ? 'on ' : 'off'
      const note = pinned.has(layer.id) ? `  (pinned by ${layer.flag})` : choices?.[layer.id] !== undefined ? '  (changed)' : ''
      lines.push(`  ${layer.id.padEnd(24)} ${mark.padEnd(6)} ${layer.summary}${note}`)
      if (group !== 'floor') lines.push(`  ${''.padEnd(24)} ${''.padEnd(6)} cost: ${layer.cost}; evidence: ${layer.evidence}`)
    }
    lines.push('')
  }
  lines.push('Change with: /layers on <id> | /layers off <id> | /layers reset [id]  (bare /layers shows what fired last turn)')
  return lines.join('\n')
}
