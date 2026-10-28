/**
 * The user-facing on/off surface for reasoning layers, shared by the CLI (`/layers`) and the desktop/browser
 * Settings screen. It is a thin layer over the existing `AUDIT_*` env flags, which every layer already reads in
 * exactly one place: `applyLayerSettings` writes the persisted `config.layers` choices into an env object, so no
 * layer needed a second code path. An env value the operator set themselves always wins and renders as pinned,
 * the same precedence `explicitEnvOverride` already gives it.
 *
 * Floor layers: control state, tool policy and verification each have a gate flag and may be switched off (they carry
 * a `caution`). Approval staging is locked on purpose, and diagnostics and template hypotheses have no effect of their own
 * (they only feed the control state), so they follow `control_state`.
 */

export type LayerGroup = 'escalation' | 'behaviour' | 'opt_in' | 'floor'

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
  /** What switching it off gives up; set on floor layers a user may still switch off. */
  caution?: string
  /** A layer with no gate of its own: it is on exactly when this layer is. */
  followsLayer?: string
  /** Layers this one does nothing without. Switching it on while one of them is off is allowed but reported. */
  requires?: readonly string[]
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

  { id: 'supervisor', group: 'behaviour', flag: 'HARNESS_TRAJECTORY_SUPERVISOR', defaultOn: true, summary: 'When a turn stalls, one call decides whether to gather evidence, change strategy or ask you', cost: 'one call per stall, none on a healthy turn', evidence: 'best evidence of the set (94% vs 78% on injected stalls); the stalls are synthetic' },
  { id: 'constraint_check', group: 'behaviour', flag: 'AUDIT_SEMANTIC_CONSTRAINT_CHECK', defaultOn: true, summary: 'Checks the finished answer against rules you stated, and re-asks once on a violation', cost: 'one call per turn with a stated rule', evidence: 'fires and persists; no outcome delta (the base model obeys unaided)' },
  { id: 'semantic_grounding', group: 'behaviour', flag: 'AUDIT_SEMANTIC_GROUNDING', requires: ['mandatory_verification'], defaultOn: true, summary: 'Compares a reply with the raw tool text before it is labelled verified', cost: 'one call on tool or research turns', evidence: 'mechanism real, outcome not shown' },
  { id: 'retry_system_errors', group: 'behaviour', flag: 'AUDIT_RETRY_SYSTEM_ERRORS', defaultOn: true, summary: 'Retries a task once after a transient model or tool error', cost: 'one extra attempt after an error', evidence: 'demonstrated on a synthetic 503' },
  { id: 'plan_step_prompt', group: 'behaviour', flag: 'AUDIT_PLAN_STEP_PROMPT', defaultOn: true, summary: 'Tells each plan step which step it is and carries earlier answers forward', cost: 'none (prompt text)', evidence: 'cost removed; completion not measured beyond one conversation' },
  { id: 'decomposed_answer_once', group: 'behaviour', flag: 'AUDIT_DECOMPOSED_ANSWER_ONCE', defaultOn: true, summary: 'A decomposed turn answers once and later subtasks reuse that answer', cost: 'none (saves calls)', evidence: 'cost removed' },
  // Separate from AUDIT_PLAN_QUESTION_ROUTING: that answers a question about the plan, this decides what a non-question message does to a stuck one.
  { id: 'stuck_plan_resume', group: 'behaviour', flag: 'AUDIT_STUCK_PLAN_RESUME', defaultOn: true, summary: 'A stuck plan is retried only by a message that continues it', cost: 'none', evidence: 'demonstrated once (control FAIL)' },
  { id: 'memory_budgeted_render', group: 'behaviour', flag: 'AUDIT_MEMORY_BUDGETED_RENDER', defaultOn: true, summary: 'Fits remembered facts into a size budget and replaces older values of the same fact', cost: 'none', evidence: 'control FAIL, candidate PASS on 3/3 seeds' },

  { id: 'semantic_hypotheses', group: 'opt_in', flag: 'AUDIT_SEMANTIC_HYPOTHESES', defaultOn: false, summary: 'For an underdetermined question, weighs 2-4 competing explanations before answering', cost: 'about 4x per turn when it fires', evidence: 'suggestive: 13/15 vs 11/18, not significant' },
  { id: 'source_reliability', group: 'opt_in', flag: 'AUDIT_SEMANTIC_SOURCE_RELIABILITY', defaultOn: false, summary: 'Weighs how trustworthy each file or page is', cost: 'two calls per turn', evidence: 'mechanism verified' },
  { id: 'reviewer_revision', group: 'opt_in', flag: 'AUDIT_REVIEWER_REVISION', requires: ['reviewer_adversarial'], defaultOn: false, summary: 'Lets reviewer findings revise the reply', cost: 'a second answer when it fires', evidence: 'fires and acts; no outcome delta' },
  { id: 'experience_learning', group: 'opt_in', flag: 'AUDIT_EXPERIENCE_LEARNING', defaultOn: false, summary: 'Learns which recovery strategies worked before', cost: 'none (bookkeeping)', evidence: 'not demonstrable as an outcome' },
  { id: 'semantic_compaction', group: 'opt_in', flag: 'AUDIT_SEMANTIC_COMPACTION', defaultOn: false, summary: 'Summarises long transcripts by meaning instead of truncating', cost: 'one call when the thresholds trip', evidence: 'demonstrated on one matched pair' },
  { id: 'semantic_task_completion', group: 'opt_in', flag: 'AUDIT_SEMANTIC_TASK_COMPLETION', defaultOn: false, summary: 'A plan step counts complete only if its output did the task', cost: 'one call per plan step', evidence: 'shown on one conversation, 3/3 seeds; not measured on a broader set' },
  { id: 'contradiction_severity', group: 'opt_in', flag: 'AUDIT_SEMANTIC_CONTRADICTION_SEVERITY', defaultOn: false, summary: 'Grades how serious a detected contradiction is', cost: 'none extra (rides the contradiction call)', evidence: '10/10 direct HIGH, 0 false HIGH on synthetic pairs' },
  { id: 'code_plan_templates', group: 'opt_in', flag: 'AUDIT_CODE_PLAN_TEMPLATES', defaultOn: false, summary: 'Offers plan templates for code work (debug, implement, review, refactor)', cost: 'none', evidence: 'wired; the base model passed unaided' },
  { id: 'retry_failed_task', group: 'opt_in', flag: 'AUDIT_RETRY_FAILED_TASK', defaultOn: false, summary: 'Retries every failed task after a strategy switch, not only system errors', cost: 'extra attempts', evidence: 'demonstrated, but changes how runaway loops end' },
  { id: 'memory_write_gate', group: 'opt_in', flag: 'AUDIT_MEMORY_WRITE_GATE', defaultOn: false, summary: 'Screens memory writes for secrets and instructions', cost: 'none extra (rides the classifier)', evidence: 'mechanism works; no outcome delta' },
  { id: 'memory_audit_log', group: 'opt_in', flag: 'AUDIT_MEMORY_AUDIT_LOG', defaultOn: false, summary: 'Logs every memory change with its pre-image (/memory history, /memory undo)', cost: 'none', evidence: 'undo exactness unit-tested only' },
  { id: 'episodic_digest', group: 'opt_in', flag: 'AUDIT_EPISODIC_DIGEST', defaultOn: false, summary: 'Summarises a session when it ends so the next one can pick up', cost: 'one call per session end', evidence: 'control FAIL 2/2, candidate PASS 2/2 on one scenario' },
  { id: 'recall_tool', group: 'opt_in', flag: 'AUDIT_RECALL_TOOL', requires: ['episodic_digest'], defaultOn: false, summary: 'Gives the model a read-only tool to look up past session digests', cost: 'tool calls when used', evidence: 'measured together with the digest' },
  { id: 'memory_consolidation', group: 'opt_in', flag: 'AUDIT_MEMORY_CONSOLIDATION', requires: ['memory_audit_log'], defaultOn: false, summary: 'Merges duplicate memories and proposes archiving old ones', cost: 'extra calls; needs the audit log', evidence: 'not measured as an outcome' },
  { id: 'memory_reviewer', group: 'opt_in', flag: 'AUDIT_MEMORY_REVIEWER', defaultOn: false, summary: 'Reviews recent turns for facts worth remembering', cost: 'two calls every few turns', evidence: 'small samples' },

  { id: 'control_state', group: 'floor', flag: 'AUDIT_CONTROL_STATE_GATE', defaultOn: true, summary: 'Tightens or blocks the harness as failures accumulate', cost: 'none', evidence: 'harness-level only (<=4 executions vs 43); redundant in the assistant', caution: 'Off: the harness never blocks or escalates on repeated failures, and diagnostics and hypothesis go with it; the supervisor and stall rule still bound a loop.' },
  { id: 'tool_policy', group: 'floor', flag: 'AUDIT_CONTROL_STATE_TOOL_POLICY', defaultOn: true, summary: 'Denies read-only tool calls once failures pile up', cost: 'none', evidence: 'demonstrated: stops a retry loop at 8 attempts instead of 15', caution: 'Off: a failing read-only tool can be retried without limit. Writes and shell commands still need approval.' },
  { id: 'mandatory_verification', group: 'floor', flag: 'AUDIT_VERIFICATION', defaultOn: true, summary: 'Verifies figures and tool results before they are reported', cost: 'none', evidence: 'mechanism real; outcome not shown', caution: 'Off: replies are not checked by the nine verification layers, so a wrong figure goes out unflagged.' },
  { id: 'approval_staging', group: 'floor', defaultOn: true, summary: 'Stages every consequential action until you approve it', cost: 'none', evidence: 'safety floor, always on', caution: 'Locked: it guards file writes, shell and email.' },
  { id: 'diagnostics', group: 'floor', followsLayer: 'control_state', defaultOn: true, summary: 'Tracks sub-dimensions that feed the control state', cost: 'none', evidence: 'not separately demonstrable; no effect once control_state is off' },
  { id: 'hypothesis', group: 'floor', followsLayer: 'control_state', defaultOn: true, summary: 'Template hypothesis bookkeeping (entropy feeds the control state); not the same as semantic_hypotheses', cost: 'none', evidence: 'no outcome effect on its own; follows control_state' },
]

export type LayerChoices = Readonly<Record<string, boolean>>

export function findLayer(id: string): LayerSetting | undefined {
  return LAYER_SETTINGS.find((l) => l.id === id)
}

/** The layers that have no switch of their own and are on exactly when `leader` is. */
export function followersOf(leader: LayerSetting): LayerSetting[] {
  return LAYER_SETTINGS.filter((l) => l.followsLayer === leader.id)
}

/** The layers `layer` needs that are currently off. Empty when `layer` is off itself: nothing is lost then. */
export function unmetRequirements(layer: LayerSetting, choices: LayerChoices | undefined, pinned: ReadonlySet<string>, env: Env): LayerSetting[] {
  if (!layer.requires || !effectiveState(layer, choices, pinned, env)) return []
  return layer.requires.flatMap((id) => {
    const need = findLayer(id)
    return need && !effectiveState(need, choices, pinned, env) ? [need] : []
  })
}

/** One line per switched-on layer that has no effect because a layer it needs is off. */
export function layerWarnings(choices: LayerChoices | undefined, pinned: ReadonlySet<string>, env: Env): string[] {
  return LAYER_SETTINGS.flatMap((l) => {
    const unmet = unmetRequirements(l, choices, pinned, env)
    return unmet.length === 0 ? [] : [`"${l.id}" is on but does nothing while ${unmet.map((u) => `"${u.id}"`).join(' and ')} ${unmet.length === 1 ? 'is' : 'are'} off.`]
  })
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
  if (layer.followsLayer) {
    const leader = findLayer(layer.followsLayer)
    return leader ? effectiveState(leader, choices, pinned, env) : true
  }
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
  if (layer.followsLayer) throw new LayerSettingError(`"${id}" has no switch of its own; it follows "${layer.followsLayer}".`)
  if (!isToggleable(layer)) throw new LayerSettingError(`"${id}" is locked: ${layer.caution ?? 'it cannot be switched off.'}`)
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
    ['escalation', 'Checks, on by default (switch off to save cost)'],
    ['behaviour', 'Other behaviours, on by default'],
    ['opt_in', 'Off by default (switch on to try)'],
    ['floor', 'Safety floor (on by default; read the caution before switching off)'],
  ]
  const lines: string[] = []
  for (const [group, title] of sections) {
    lines.push(title)
    for (const layer of LAYER_SETTINGS.filter((l) => l.group === group)) {
      const on = effectiveState(layer, choices, pinned, env)
      const mark = layer.followsLayer ? (on ? 'on*' : 'off*') : !isToggleable(layer) ? 'locked' : on ? 'on ' : 'off'
      const note = pinned.has(layer.id) ? `  (pinned by ${layer.flag})` : choices?.[layer.id] !== undefined ? '  (changed)' : ''
      lines.push(`  ${layer.id.padEnd(24)} ${mark.padEnd(6)} ${layer.summary}${note}`)
      lines.push(`  ${''.padEnd(24)} ${''.padEnd(6)} cost: ${layer.cost}; evidence: ${layer.evidence}`)
      const unmet = unmetRequirements(layer, choices, pinned, env)
      if (unmet.length > 0) lines.push(`  ${''.padEnd(24)} ${''.padEnd(6)} needs: ${unmet.map((u) => u.id).join(', ')} (off), so this has no effect`)
      if (layer.caution) lines.push(`  ${''.padEnd(24)} ${''.padEnd(6)} caution: ${layer.caution}`)
    }
    lines.push('')
  }
  lines.push('* follows control_state (no switch of its own)')
  lines.push('Change with: /layers on <id> | /layers off <id> | /layers reset [id]  (bare /layers shows what fired last turn)')
  return lines.join('\n')
}
