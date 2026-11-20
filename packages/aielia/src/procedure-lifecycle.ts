/**
 * Procedure library lifecycle: a draft area that is never loaded, promotion only after N independent supporting
 * sources, a per-class cap (once full only a refinement is allowed), typed curator operations decided by an
 * injected curator (ACCEPT, REPLACE, MERGE, SKIP, PRUNE), carry events as votes, retirement gated by an injected
 * judge-reliability value, and a drift flag for items no longer retrieved or followed. No similarity measure
 * lives here: whether two entries are the same procedure is the curator's decision. Pure: no node:* or DOM imports.
 */
import { parseProcedureEntry, type ProcedureClass, type ProcedureEntry } from './procedure-library.js'

export interface LifecycleConfig {
  /** Distinct supporting sources a draft needs before it is offered to the curator. */
  minSupport: number
  /** Most entries per class in the loaded library. */
  capPerClass: number
  /** The judge must be at least this reliable for any retirement to happen. */
  minJudgeReliability: number
  /** Votes against (net of votes for) at which an item is retired. */
  retireMargin: number
  /** Rounds without retrieval or being followed before the drift flag is raised. */
  driftRounds: number
}

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  minSupport: 3, capPerClass: 8, minJudgeReliability: 0.8, retireMargin: 3, driftRounds: 10,
}

export interface ProcedureDraft {
  entry: ProcedureEntry
  /** Independent supporting task or session ids (a set, so a repeat from one source counts once). */
  supporters: string[]
  /** Set when the draft is meant to refine an existing entry of the same class. */
  refines?: string
}

export interface ProcedureStats {
  support: number
  against: number
  /** Rounds since the item was last retrieved or followed. */
  idleRounds: number
}

export interface ProcedureLifecycleState {
  /** The loaded library: the only part a planning call ever sees. */
  library: ProcedureEntry[]
  /** Never loaded. */
  drafts: ProcedureDraft[]
  stats: Record<string, ProcedureStats>
}

export function emptyLifecycleState(): ProcedureLifecycleState {
  return { library: [], drafts: [], stats: {} }
}

/** What a planning call may load: library entries only, never drafts. */
export function loadedProcedures(state: ProcedureLifecycleState): ProcedureEntry[] {
  return state.library.slice()
}

/** Adds a supporter to a draft (creating it if new). An invalid entry is rejected; an id already in the library is not re-drafted. */
export function addDraft(
  state: ProcedureLifecycleState, raw: unknown, sourceId: string, refines?: string,
): { state: ProcedureLifecycleState; ok: boolean; reason?: string } {
  const parsed = parseProcedureEntry(raw)
  if (!parsed.ok) return { state, ok: false, reason: parsed.reason }
  const entry = parsed.entry
  if (state.library.some(e => e.id === entry.id)) return { state, ok: false, reason: 'id already in library' }
  const existing = state.drafts.find(d => d.entry.id === entry.id)
  const drafts = existing
    ? state.drafts.map(d => (d === existing && !d.supporters.includes(sourceId) ? { ...d, supporters: [...d.supporters, sourceId] } : d))
    : [...state.drafts, { entry, supporters: [sourceId], ...(refines ? { refines } : {}) }]
  return { state: { ...state, drafts }, ok: true }
}

export type CuratorOp =
  | { verb: 'ACCEPT' }
  | { verb: 'REPLACE'; targetId: string }
  | { verb: 'MERGE'; targetId: string; merged: unknown }
  | { verb: 'SKIP' }
  | { verb: 'PRUNE'; targetId: string }

/** Injected decision-maker (a model call in production, scripted in tests). */
export interface ProcedureCurator {
  decide(candidate: ProcedureDraft, library: readonly ProcedureEntry[]): Promise<CuratorOp>
}

function classCount(library: readonly ProcedureEntry[], c: ProcedureClass): number {
  return library.filter(e => e.procedureClass === c).length
}

function withoutStats(stats: Record<string, ProcedureStats>, id: string): Record<string, ProcedureStats> {
  const { [id]: _drop, ...rest } = stats
  return rest
}

/** Applies one curator operation to a draft; an operation that breaks a rule is refused and the state is unchanged. */
export function applyCuratorOp(
  state: ProcedureLifecycleState, draft: ProcedureDraft, op: CuratorOp, config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): { state: ProcedureLifecycleState; applied: boolean; reason?: string } {
  const refuse = (reason: string) => ({ state, applied: false, reason })
  const dropDraft = (s: ProcedureLifecycleState): ProcedureLifecycleState => ({ ...s, drafts: s.drafts.filter(d => d !== draft) })
  const cls = draft.entry.procedureClass
  const target = 'targetId' in op ? state.library.find(e => e.id === op.targetId) : undefined
  if ('targetId' in op && !target) return refuse('unknown target')
  switch (op.verb) {
    case 'SKIP':
      return { state: dropDraft(state), applied: true }
    case 'ACCEPT': {
      if (classCount(state.library, cls) >= config.capPerClass) return refuse('class full: only a refinement is allowed')
      return {
        state: dropDraft({ ...state, library: [...state.library, draft.entry], stats: { ...state.stats, [draft.entry.id]: { support: 0, against: 0, idleRounds: 0 } } }),
        applied: true,
      }
    }
    case 'REPLACE': {
      if (target!.procedureClass !== cls) return refuse('target is in another class')
      const library = state.library.map(e => (e === target ? draft.entry : e))
      const stats = { ...withoutStats(state.stats, target!.id), [draft.entry.id]: { support: 0, against: 0, idleRounds: 0 } }
      return { state: dropDraft({ ...state, library, stats }), applied: true }
    }
    case 'MERGE': {
      if (target!.procedureClass !== cls) return refuse('target is in another class')
      const merged = parseProcedureEntry(op.merged)
      if (!merged.ok) return refuse(`merged entry invalid: ${merged.reason}`)
      if (merged.entry.procedureClass !== cls) return refuse('merged entry changes class')
      if (merged.entry.id !== target!.id && state.library.some(e => e.id === merged.entry.id)) return refuse('merged id collides')
      const library = state.library.map(e => (e === target ? merged.entry : e))
      const stats = { ...withoutStats(state.stats, target!.id), [merged.entry.id]: state.stats[target!.id] ?? { support: 0, against: 0, idleRounds: 0 } }
      return { state: dropDraft({ ...state, library, stats }), applied: true }
    }
    case 'PRUNE': {
      // Removes the target and keeps the draft, so the curator can follow with an ACCEPT into the freed slot.
      return { state: { ...state, library: state.library.filter(e => e !== target), stats: withoutStats(state.stats, target!.id) }, applied: true }
    }
  }
}

/** Drafts with enough independent support, in order. */
export function promotableDrafts(state: ProcedureLifecycleState, config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG): ProcedureDraft[] {
  return state.drafts.filter(d => d.supporters.length >= config.minSupport)
}

/**
 * Offers every promotable draft to the curator once. A draft below the support threshold is never offered. When a
 * class is full, only REPLACE and MERGE (a refinement of an existing entry) can add anything; the cap check in
 * applyCuratorOp refuses a bare ACCEPT. A refused operation leaves the draft in place.
 */
export async function curateDrafts(
  state: ProcedureLifecycleState, curator: ProcedureCurator, config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): Promise<{ state: ProcedureLifecycleState; log: { id: string; verb: CuratorOp['verb']; applied: boolean; reason?: string }[] }> {
  let cur = state
  const log: { id: string; verb: CuratorOp['verb']; applied: boolean; reason?: string }[] = []
  for (const draft of promotableDrafts(state, config)) {
    if (!cur.drafts.includes(draft)) continue
    const op = await curator.decide(draft, cur.library)
    const r = applyCuratorOp(cur, draft, op, config)
    log.push({ id: draft.entry.id, verb: op.verb, applied: r.applied, ...(r.reason ? { reason: r.reason } : {}) })
    cur = r.state
  }
  return { state: cur, log }
}

/** A carry event is a vote on one library item. Unknown ids are ignored. */
export function recordCarryEvent(state: ProcedureLifecycleState, id: string, vote: 'support' | 'against'): ProcedureLifecycleState {
  const s = state.stats[id]
  if (!s) return state
  return { ...state, stats: { ...state.stats, [id]: { ...s, [vote]: s[vote] + 1 } } }
}

/** One round passed: items that were retrieved or followed reset their idle count; the rest age by one. */
export function recordRound(state: ProcedureLifecycleState, activeIds: readonly string[]): ProcedureLifecycleState {
  const active = new Set(activeIds)
  const stats: Record<string, ProcedureStats> = {}
  for (const [id, s] of Object.entries(state.stats)) stats[id] = { ...s, idleRounds: active.has(id) ? 0 : s.idleRounds + 1 }
  return { ...state, stats }
}

/**
 * Retires items whose net votes against reach the margin, but only when the injected judge reliability meets the
 * threshold: below it the votes are not trusted and nothing is retired.
 */
export function retireItems(
  state: ProcedureLifecycleState, judgeReliability: number, config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): { state: ProcedureLifecycleState; retired: string[] } {
  if (!(judgeReliability >= config.minJudgeReliability)) return { state, retired: [] }
  const retired = state.library.filter(e => {
    const s = state.stats[e.id]
    return s !== undefined && s.against - s.support >= config.retireMargin
  }).map(e => e.id)
  if (retired.length === 0) return { state, retired }
  let stats = state.stats
  for (const id of retired) stats = withoutStats(stats, id)
  return { state: { ...state, library: state.library.filter(e => !retired.includes(e.id)), stats }, retired }
}

/** Items idle for driftRounds or more. A flag only: nothing is removed. */
export function driftFlags(state: ProcedureLifecycleState, config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG): string[] {
  return state.library.filter(e => (state.stats[e.id]?.idleRounds ?? 0) >= config.driftRounds).map(e => e.id)
}
