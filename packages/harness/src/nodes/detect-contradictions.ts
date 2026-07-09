import type { WorldModel, Contradiction, Belief, BeliefDepGraph, EnvironmentChange } from '../state/world-model.js'
import type { EvidenceStore } from '../state/evidence-store.js'
import type { HypothesisSet } from '../state/hypothesis-set.js'

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'SYSTEM_BREAKING'
type ConfidenceClass = 'HIGH' | 'MEDIUM' | 'LOW'

// Matches adapter/harness/contradiction.py's _NEGATION_PAIRS.
//
// passed/failed, passing/failing, running/stopped, and online/offline exist as
// literal words in contradiction-checker.ts's CODING_FACT_MARKERS (personal-assistant
// package) — that regex skips the LLM-backed semantic contradiction check whenever a
// belief statement matches it, on the assumption this lexical pass already covers
// build/test/service-state claims. That assumption only holds for the antonym pairs
// actually listed here, so any status word added to CODING_FACT_MARKERS needs its
// opposite pair added here too, or a statement using it (e.g. "the tests passed" vs.
// "the tests failed") silently gets neither check.
const NEGATION_PAIRS: Array<[string, string]> = [
  ['present', 'absent'],
  ['true', 'false'],
  ['exists', 'missing'],
  ['success', 'failure'],
  ['available', 'unavailable'],
  ['enabled', 'disabled'],
  ['found', 'not found'],
  ['is', 'is not'],
  ['passed', 'failed'],
  ['passing', 'failing'],
  ['running', 'stopped'],
  ['online', 'offline'],
]

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'at'])

/**
 * Matches _statements_opposed(): a keyword-negation check for semantic opposition.
 *
 * Requires the two statements to share a subject (some non-stopword vocabulary) before treating
 * any polarity difference as a real opposition. Without this gate, two statements about entirely
 * different things each containing one half of a NEGATION_PAIRS entry were flagged as
 * contradicting purely by coincidence — e.g. "the login tests passed" / "the payment build
 * failed" — because belief statements are free text (verbatim user messages, LLM-authored task
 * descriptions), not a controlled vocabulary that only differs by its status word.
 */
function statementsOpposed(stmtA: string, stmtB: string): boolean {
  const a = stmtA.toLowerCase()
  const b = stmtB.toLowerCase()

  const wordsA = new Set(a.split(/\s+/))
  const wordsB = new Set(b.split(/\s+/))
  const common = [...wordsA].filter(w => wordsB.has(w) && !STOPWORDS.has(w))
  if (common.length === 0) return false

  for (const [pos, neg] of NEGATION_PAIRS) {
    if (a.includes(pos) && b.includes(neg)) return true
    if (a.includes(neg) && b.includes(pos)) return true
  }

  if (wordsA.has('not') !== wordsB.has('not')) return true
  if (wordsA.has('absent') !== wordsB.has('absent')) return true
  if (wordsA.has('no') !== wordsB.has('no')) return true

  return false
}

/** Matches _confidence_to_class(). */
function confidenceToClass(confidence: number): ConfidenceClass {
  if (confidence >= 0.8) return 'HIGH'
  if (confidence >= 0.5) return 'MEDIUM'
  return 'LOW'
}

let uidCounter = 0
function makeId(): string {
  uidCounter += 1
  return `c-${Date.now().toString(36)}-${uidCounter}`
}

/** Matches detect_pairwise_contradictions(). */
function detectPairwiseContradictions(beliefs: Belief[]): Contradiction[] {
  const results: Contradiction[] = []
  for (let i = 0; i < beliefs.length; i++) {
    for (let j = i + 1; j < beliefs.length; j++) {
      const bA = beliefs[i]
      const bB = beliefs[j]
      if (!statementsOpposed(bA.statement, bB.statement)) continue
      if (bA.confidence < 0.5 && bB.confidence < 0.5) continue

      const clsA = confidenceToClass(bA.confidence)
      const clsB = confidenceToClass(bB.confidence)
      let severity: Severity
      if (clsA === 'HIGH' && clsB === 'HIGH') severity = 'HIGH'
      else if (clsA === 'LOW' && clsB === 'LOW') severity = 'LOW'
      else severity = 'MEDIUM'

      results.push({
        id: makeId(),
        type: 'pairwise',
        severity,
        scope: 'local',
        description: `Pairwise contradiction between "${bA.id}" and "${bB.id}"`,
        involved_belief_ids: [bA.id, bB.id],
      })
    }
  }
  return results
}

/** Matches detect_set_level_contradictions(): a 3-cycle over the opposition adjacency graph. */
function detectSetLevelContradictions(beliefs: Belief[]): Contradiction[] {
  const results: Contradiction[] = []
  const highConf = beliefs.filter(b => b.confidence >= 0.6)

  const opposition = new Map<string, string[]>(highConf.map(b => [b.id, [] as string[]]))
  for (let i = 0; i < highConf.length; i++) {
    for (let j = i + 1; j < highConf.length; j++) {
      const bA = highConf[i]
      const bB = highConf[j]
      if (statementsOpposed(bA.statement, bB.statement)) {
        opposition.get(bA.id)!.push(bB.id)
        opposition.get(bB.id)!.push(bA.id)
      }
    }
  }

  const reported = new Set<string>()
  for (const idA of highConf.map(b => b.id)) {
    for (const idB of opposition.get(idA) ?? []) {
      for (const idC of opposition.get(idB) ?? []) {
        if (idC === idA || idC === idB) continue
        const triple = [idA, idB, idC].sort().join('|')
        if (reported.has(triple)) continue
        reported.add(triple)
        results.push({
          id: makeId(),
          type: 'set-level',
          severity: 'HIGH',
          scope: 'task',
          description: `Set-level contradiction in triple [${idA}, ${idB}, ${idC}]`,
          involved_belief_ids: [idA, idB, idC],
        })
      }
    }
  }
  return results
}

/**
 * Matches detect_temporal_contradictions(): a belief invalidated by an environment
 * change to one of its derivation sources. MEDIUM when the change is recent (after
 * the belief was recorded); HIGH when the change pre-dates the belief (the belief was
 * formed after the world had already changed).
 */
function detectTemporalContradictions(beliefs: Belief[], environmentChangeLog: EnvironmentChange[]): Contradiction[] {
  const results: Contradiction[] = []
  for (const belief of beliefs) {
    const beliefSources = new Set([...belief.derived_from, ...(belief.supporting_evidence ?? [])])
    const beliefTs = new Date(belief.recorded_at).getTime()

    for (const change of environmentChangeLog) {
      if (!change.affected_paths.some(p => beliefSources.has(p))) continue
      const changeTs = new Date(change.timestamp).getTime()
      if (Number.isNaN(changeTs)) continue

      const severity: Severity = changeTs > beliefTs ? 'MEDIUM' : 'HIGH'
      results.push({
        id: makeId(),
        type: 'temporal',
        severity,
        scope: 'local',
        description: `Temporal contradiction: belief "${belief.id}" invalidated by change "${change.id}"`,
        involved_belief_ids: [belief.id],
      })
    }
  }
  return results
}

export interface AbstractionContext {
  abstraction_level?: string
}

const LINE_LEVEL_KEYWORDS = ['line ', 'line\t', ':line', ' ln ', ' l', 'column ', 'char ']

/**
 * Matches detect_abstraction_contradictions(): advisory-only (LOW severity) — flags
 * beliefs stated at finer granularity than the current task's abstraction level.
 */
function detectAbstractionContradictions(beliefs: Belief[], context: AbstractionContext | null | undefined): Contradiction[] {
  const results: Contradiction[] = []
  if (!context) return results

  const abstractionLevel = context.abstraction_level ?? 'module'
  if (!['module', 'component', 'system'].includes(abstractionLevel)) return results

  for (const belief of beliefs) {
    const stmt = belief.statement.toLowerCase()
    if (LINE_LEVEL_KEYWORDS.some(kw => stmt.includes(kw))) {
      results.push({
        id: makeId(),
        type: 'abstraction',
        severity: 'LOW',
        scope: 'local',
        description: `Abstraction contradiction: belief "${belief.id}" stated at line-level granularity`,
        involved_belief_ids: [belief.id],
      })
    }
  }
  return results
}

/**
 * Matches assign_system_breaking_severity(): upgrades HIGH pairwise/set-level
 * contradictions to SYSTEM_BREAKING when the involved belief pair is predicted as a
 * conflict by an active hypothesis's discriminating_evidence.
 */
function assignSystemBreakingSeverity(contradictions: Contradiction[], hypothesisSet: HypothesisSet): Contradiction[] {
  const hypothesisConflictPairs = new Set<string>()
  for (const hyp of hypothesisSet.active) {
    const ev = hyp.discriminating_evidence
    for (let i = 0; i < ev.length; i++) {
      for (let j = i + 1; j < ev.length; j++) {
        hypothesisConflictPairs.add([ev[i], ev[j]].sort().join('|'))
      }
    }
  }

  return contradictions.map((c) => {
    if (c.severity !== 'HIGH' || (c.type !== 'pairwise' && c.type !== 'set-level')) return c
    const pairKey = [...c.involved_belief_ids].sort().join('|')
    if (hypothesisConflictPairs.has(pairKey)) {
      return { ...c, severity: 'SYSTEM_BREAKING' as const }
    }
    return c
  })
}

// ── resolution policy ─────────────────────────────────────────────────────────

function hasAppliedContradiction(belief: Belief, contradictionId: string): boolean {
  return (belief.applied_contradiction_ids ?? []).includes(contradictionId)
}

function markApplied(belief: Belief, contradictionId: string): void {
  belief.applied_contradiction_ids = [...(belief.applied_contradiction_ids ?? []), contradictionId]
  belief.pending_sweep = true
}

/** Matches _resolve_low(): reduce involved belief confidence by 10%. */
function resolveLow(c: Contradiction, worldModel: WorldModel): void {
  for (const belief of worldModel.beliefs) {
    if (!c.involved_belief_ids.includes(belief.id)) continue
    if (hasAppliedContradiction(belief, c.id)) continue
    belief.confidence = Math.max(0, belief.confidence * 0.9)
    markApplied(belief, c.id)
  }
}

/** Matches _resolve_medium(): reduce confidence by 25% and queue downstream propagation. */
function resolveMedium(c: Contradiction, worldModel: WorldModel, beliefDepGraph?: BeliefDepGraph): void {
  for (const belief of worldModel.beliefs) {
    if (!c.involved_belief_ids.includes(belief.id)) continue
    if (hasAppliedContradiction(belief, c.id)) continue
    belief.confidence = Math.max(0, belief.confidence * 0.75)
    markApplied(belief, c.id)
    if (beliefDepGraph && !beliefDepGraph.propagation_queue.some(t => t.source_belief_id === belief.id)) {
      beliefDepGraph.propagation_queue.push({ source_belief_id: belief.id, target_belief_id: belief.id })
    }
  }
}

/** Matches _resolve_high(): add involved beliefs to the invalidation frontier. */
function resolveHigh(c: Contradiction, worldModel: WorldModel, beliefDepGraph?: BeliefDepGraph): void {
  for (const belief of worldModel.beliefs) {
    if (!c.involved_belief_ids.includes(belief.id)) continue
    if (hasAppliedContradiction(belief, c.id)) continue
    markApplied(belief, c.id)
    if (beliefDepGraph && !beliefDepGraph.invalidation_frontier.includes(belief.id)) {
      beliefDepGraph.invalidation_frontier.push(belief.id)
    }
  }
}

/** Matches _resolve_system_breaking(): ensure presence in contradictions[] and mark global scope. */
function resolveSystemBreaking(c: Contradiction, worldModel: WorldModel): void {
  if (!worldModel.contradictions.some(existing => existing.id === c.id)) {
    worldModel.contradictions.push(c)
  }
  const stored = worldModel.contradictions.find(existing => existing.id === c.id)
  if (stored) stored.scope = 'global'
}

/**
 * Matches apply_resolution_policy(): routes a contradiction to its severity-tier
 * handler. Idempotent per (belief, contradiction id) pair via applied_contradiction_ids.
 */
function applyResolutionPolicy(c: Contradiction, worldModel: WorldModel, beliefDepGraph?: BeliefDepGraph): void {
  if (c.severity === 'LOW') resolveLow(c, worldModel)
  else if (c.severity === 'MEDIUM') resolveMedium(c, worldModel, beliefDepGraph)
  else if (c.severity === 'HIGH') resolveHigh(c, worldModel, beliefDepGraph)
  else if (c.severity === 'SYSTEM_BREAKING') resolveSystemBreaking(c, worldModel)
}

/**
 * Matches detect_contradictions(): orchestrates all four detection functions,
 * upgrades system-breaking severity, stores every result via add_contradiction(),
 * and applies the resolution policy. Never raises — SYSTEM_BREAKING contradictions
 * flow into world_model.contradictions[] the same way LOW ones do; Control State's
 * Tier 1 is what actually reacts to them.
 */
export function detectContradictions(
  worldModel: WorldModel,
  _evidenceStore: EvidenceStore,
  hypothesisSet: HypothesisSet,
  abstractionContext?: AbstractionContext | null,
  beliefDepGraph?: BeliefDepGraph,
): void {
  const beliefs = worldModel.beliefs
  const envLog = worldModel.environment_change_log

  let all: Contradiction[] = [
    ...detectPairwiseContradictions(beliefs),
    ...detectSetLevelContradictions(beliefs),
    ...detectTemporalContradictions(beliefs, envLog),
    ...detectAbstractionContradictions(beliefs, abstractionContext),
  ]

  all = assignSystemBreakingSeverity(all, hypothesisSet)

  for (const c of all) {
    worldModel.contradictions.push(c)
    applyResolutionPolicy(c, worldModel, beliefDepGraph)
  }
}

export interface ExternalContradictionInput {
  beliefIds: string[]
  description: string
  severity?: Severity
}

/**
 * Records a contradiction found by an external (e.g. LLM-based semantic) check — not one this
 * file's own lexical/negation-pair detectors found. Goes through the same push +
 * apply_resolution_policy pipeline as a lexically-detected one, so it gets identical treatment
 * (confidence decay, invalidation frontier, SYSTEM_BREAKING handling). Skips a group already
 * recorded (same involved_belief_ids, order-independent) so re-checking a belief set that
 * hasn't changed doesn't double-apply confidence decay for the same underlying conflict.
 */
export function recordExternalContradiction(
  worldModel: WorldModel,
  input: ExternalContradictionInput,
  beliefDepGraph?: BeliefDepGraph,
): Contradiction | null {
  const key = [...input.beliefIds].sort().join('|')
  const alreadyRecorded = worldModel.contradictions.some(
    c => [...c.involved_belief_ids].sort().join('|') === key,
  )
  if (alreadyRecorded) return null

  const contradiction: Contradiction = {
    id: makeId(),
    type: 'pairwise',
    severity: input.severity ?? 'MEDIUM',
    scope: 'local',
    description: input.description,
    involved_belief_ids: input.beliefIds,
  }
  worldModel.contradictions.push(contradiction)
  applyResolutionPolicy(contradiction, worldModel, beliefDepGraph)
  return contradiction
}
