import contentCreation from '../../plan-templates/data/content_creation.json'
import decisionMaking from '../../plan-templates/data/decision_making.json'
import problemSolving from '../../plan-templates/data/problem_solving.json'
import processImprovement from '../../plan-templates/data/process_improvement.json'
import projectPlanning from '../../plan-templates/data/project_planning.json'
import researchAnalysis from '../../plan-templates/data/research_analysis.json'
import tripPlanning from '../../plan-templates/data/trip_planning.json'
import { displayWidth } from './display-width.js'
import { VIZ_STATUSES, type Box, type Edge, type VizNode, type VizStatus } from './types.js'

// ── seeded randomness ────────────────────────────────────────────────────────────────────────────

/** Small deterministic PRNG (mulberry32): the same seed always yields the same plans, so failures reproduce. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── graph helpers (independent of any production code) ───────────────────────────────────────────

export function edgesOf(nodes: readonly VizNode[]): Edge[] {
  return nodes.flatMap((n) => n.deps.map((d) => ({ from: d, to: n.id })))
}

export function dependentsOf(nodes: readonly VizNode[]): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(nodes.map((n) => [n.id, []]))
  for (const n of nodes) for (const d of n.deps) out[d]?.push(n.id)
  return out
}

export function isAcyclic(nodes: readonly VizNode[]): boolean {
  const state = new Map<string, 0 | 1 | 2>()
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const visit = (id: string): boolean => {
    const s = state.get(id)
    if (s === 1) return false
    if (s === 2) return true
    state.set(id, 1)
    for (const d of byId.get(id)?.deps ?? []) if (byId.has(d) && !visit(d)) return false
    state.set(id, 2)
    return true
  }
  return nodes.every((n) => visit(n.id))
}

/** Weakly connected: ignoring edge direction, every node can reach every other. */
export function isConnected(nodes: readonly VizNode[]): boolean {
  if (nodes.length <= 1) return true
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]))
  for (const n of nodes) for (const d of n.deps) if (adj.has(d)) { adj.get(n.id)!.push(d); adj.get(d)!.push(n.id) }
  const seen = new Set([nodes[0].id])
  const q = [nodes[0].id]
  while (q.length) for (const m of adj.get(q.shift()!) ?? []) if (!seen.has(m)) { seen.add(m); q.push(m) }
  return seen.size === nodes.length
}

/** Longest-path rank from the roots (roots are rank 0). Assumes an acyclic, normalized plan. */
export function ranksOf(nodes: readonly VizNode[]): Record<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const memo: Record<string, number> = {}
  const rank = (id: string): number => (memo[id] ??= Math.max(-1, ...(byId.get(id)?.deps ?? []).map(rank)) + 1)
  for (const n of nodes) rank(n.id)
  return memo
}

/** Adds a goal node that depends on every sink — exactly what the production adapter does, so the result is connected. */
export function withGoal(nodes: readonly VizNode[], goalId = 'GOAL', label = 'Goal'): VizNode[] {
  const depended = new Set(nodes.flatMap((n) => n.deps))
  const sinks = nodes.filter((n) => !depended.has(n.id)).map((n) => n.id)
  return [...nodes, { id: goalId, label, status: 'pending', deps: sinks }]
}

export function withStatus(nodes: readonly VizNode[], id: string, status: VizStatus): VizNode[] {
  return nodes.map((n) => (n.id === id ? { ...n, status } : n))
}

// ── specification of "normalized": what the layout may assume about its input ────────────────────

export interface Normalized {
  nodes: VizNode[]
  warnings: string[]
}

/**
 * Executable specification of input sanitising: drops duplicate ids (first wins), unknown and self
 * dependencies, and breaks cycles by removing the edge that closes one (deterministically, in input order).
 * The production adapter/layout must satisfy `checkNormalized` on every input, malformed ones included.
 */
export function normalizePlan(input: readonly VizNode[]): Normalized {
  const warnings: string[] = []
  const seen = new Set<string>()
  const nodes: VizNode[] = []
  for (const n of input) {
    if (seen.has(n.id)) { warnings.push(`duplicate id ${n.id}`); continue }
    seen.add(n.id)
    nodes.push({ ...n, deps: [...new Set(n.deps)] })
  }
  for (const n of nodes) {
    const kept = n.deps.filter((d) => {
      if (d === n.id) { warnings.push(`self dependency ${n.id}`); return false }
      if (!seen.has(d)) { warnings.push(`unknown dependency ${d} of ${n.id}`); return false }
      return true
    })
    n.deps = kept
  }
  // break cycles: DFS in input order, dropping the back edge
  const state = new Map<string, 1 | 2>()
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const visit = (id: string): void => {
    state.set(id, 1)
    const n = byId.get(id)!
    n.deps = n.deps.filter((d) => {
      if (state.get(d) === 1) { warnings.push(`cycle broken: ${id} -> ${d}`); return false }
      if (!state.has(d)) visit(d)
      return true
    })
    state.set(id, 2)
  }
  for (const n of nodes) if (!state.has(n.id)) visit(n.id)
  return { nodes, warnings }
}

export function checkNormalized(nodes: readonly VizNode[]): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  for (const n of nodes) {
    if (ids.has(n.id)) problems.push(`duplicate id ${n.id}`)
    ids.add(n.id)
  }
  for (const n of nodes) for (const d of n.deps) {
    if (d === n.id) problems.push(`self dependency ${n.id}`)
    else if (!ids.has(d)) problems.push(`unknown dependency ${d} of ${n.id}`)
  }
  if (!isAcyclic(nodes)) problems.push('contains a cycle')
  return problems
}

// ── toy layout: only for exercising oracles without the production layout ────────────────────────

/**
 * A trivial deterministic layout (longest-path ranks, input order within a rank). It is *not* the
 * production layout; it exists so navigation and viewport oracles can be tested before that layout
 * exists, and as a cross-check afterwards. Box height is 3, label width is the display width.
 */
export function toyLayout(plan: readonly VizNode[], gapX = 3, gapY = 3): { boxes: Box[]; edges: Edge[]; width: number; height: number } {
  const nodes = normalizePlan(plan).nodes
  const ranks = ranksOf(nodes)
  const byRank = new Map<number, VizNode[]>()
  for (const n of nodes) byRank.set(ranks[n.id], [...(byRank.get(ranks[n.id]) ?? []), n])
  const boxes: Box[] = []
  let width = 0
  for (const [r, row] of [...byRank.entries()].sort((a, b) => a[0] - b[0])) {
    let x = 0
    for (const n of row) {
      const w = displayWidth(n.label) + 6
      boxes.push({ id: n.id, x, y: r * (3 + gapY), w, h: 3 })
      x += w + gapX
    }
    width = Math.max(width, x - gapX)
  }
  const height = (Math.max(0, ...Object.values(ranks)) + 1) * (3 + gapY) - gapY
  return { boxes, edges: edgesOf(nodes), width, height }
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

const N = (id: string, label: string, status: VizStatus, deps: string[] = []): VizNode => ({ id, label, status, deps })

/** The 9-task plan used throughout the verification work, every interesting status included, goal depending on the terminals. */
export const NINE_TASK_PLAN: VizNode[] = [
  N('T1', 'Collect data', 'done'), N('T2', 'Clean data', 'done', ['T1']), N('T3', 'Analyse trends', 'running', ['T1']),
  N('T4', 'Draft charts', 'pending', ['T2', 'T3']), N('T5', 'Write summary', 'pending', ['T4']), N('T6', 'Legal sign-off', 'awaiting_user', ['T1']),
  N('T7', 'Optional appendix', 'cancelled', ['T1']), N('T8', 'Needs creds', 'awaiting_input', ['T1']), N('T9', 'Send email', 'failed', ['T5', 'T6']),
  N('G', 'Ship the report', 'pending', ['T7', 'T8', 'T9']),
]

const chain = (n: number): VizNode[] => Array.from({ length: n }, (_, i) => N(`C${i}`, `Step ${i}`, 'pending', i ? [`C${i - 1}`] : []))

/** Hand-shaped plans, each chosen to stress one thing. Every one is normalized; `connected` says whether it is weakly connected. */
export const NAMED_PLANS: Record<string, { nodes: VizNode[]; connected: boolean }> = {
  single: { nodes: [N('A', 'Only task', 'pending')], connected: true },
  linear: { nodes: withGoal(chain(4)), connected: true },
  diamond: { nodes: [N('A', 'Start', 'done'), N('B', 'Left', 'done', ['A']), N('C', 'Right', 'running', ['A']), N('D', 'Join', 'pending', ['B', 'C'])], connected: true },
  fanOut5: { nodes: withGoal([N('R', 'Root', 'done'), ...['a', 'b', 'c', 'd', 'e'].map((k) => N(k, `Branch ${k}`, 'pending', ['R']))]), connected: true },
  fanIn5: { nodes: withGoal(['a', 'b', 'c', 'd', 'e'].map((k) => N(k, `Source ${k}`, 'done'))), connected: true },
  skipEdge: { nodes: [N('A', 'Top', 'done'), N('B', 'Mid 1', 'done', ['A']), N('C', 'Mid 2', 'running', ['B']), N('D', 'Bottom', 'pending', ['C', 'A'])], connected: true },
  twoGoals: { nodes: [N('A', 'Shared', 'done'), N('B', 'Left work', 'pending', ['A']), N('C', 'Right work', 'pending', ['A']), N('G1', 'Goal one', 'pending', ['B']), N('G2', 'Goal two', 'pending', ['C'])], connected: true },
  twoThreads: { nodes: [N('t1__A', 'Thread one A', 'done'), N('t1__G', 'Thread one goal', 'pending', ['t1__A']), N('t2__A', 'Thread two A', 'running'), N('t2__G', 'Thread two goal', 'pending', ['t2__A'])], connected: false },
  nineTask: { nodes: NINE_TASK_PLAN, connected: true },
  allStatuses: { nodes: VIZ_STATUSES.map((s, i) => N(`S${i}`, `Status ${s}`, s, i ? [`S${i - 1}`] : [])), connected: true },
  cjkLabels: { nodes: withGoal([N('A', '数据收集', 'done'), N('B', '分析趋势与风险', 'running', ['A']), N('C', 'データを整理する', 'pending', ['A']), N('D', '결과 정리', 'pending', ['B', 'C'])]), connected: true },
  emojiLabels: { nodes: [N('A', '🚀 Launch', 'pending'), N('B', 'Review ✅', 'pending', ['A'])], connected: true },
  longLabels: { nodes: withGoal([N('A', 'A very long task description that goes on and on and certainly exceeds any sensible box width', 'pending'), N('B', 'Another extremely verbose label that should be truncated gracefully by the renderer', 'pending', ['A'])]), connected: true },
  wide25: { nodes: withGoal([N('R', 'Root', 'done'), ...Array.from({ length: 24 }, (_, i) => N(`w${i}`, `Wide ${i}`, 'pending', ['R']))]), connected: true },
  deepChain30: { nodes: withGoal(chain(30)), connected: true },
}

const TEMPLATES = { contentCreation, decisionMaking, problemSolving, processImprovement, projectPlanning, researchAnalysis, tripPlanning } as const

/**
 * The seven real plan templates shipped with aielia, converted to nodes with a goal node added
 * (what a user of the product actually gets). Statuses are assigned by progress so each one exercises
 * done / running / pending.
 */
export function templatePlans(): Record<string, VizNode[]> {
  const out: Record<string, VizNode[]> = {}
  for (const [key, tpl] of Object.entries(TEMPLATES)) {
    const tasks = tpl.tasks as Array<{ id: string; title: string; depends_on: string[] }>
    const base: VizNode[] = tasks.map((t, i) => N(t.id, t.title, i === 0 ? 'done' : i === 1 ? 'running' : 'pending', t.depends_on))
    out[key] = withGoal(base, 'goal', (tpl.success_criteria as string).slice(0, 40))
  }
  return out
}

const WORDS = ['collect', 'analyse', 'draft', 'review', 'ship', 'verify', 'plan', 'book', 'write', 'test', 'clean', 'merge']
const CJK = ['数据', '分析', '整理', 'データ', '검토']

export interface RandomPlanOptions {
  minNodes?: number
  maxNodes?: number
  /** Probability that a node depends on any given earlier node (default depends on size). */
  density?: number
  /** Add a goal depending on every sink (connected, like the adapter's output). Default true. */
  goal?: boolean
  /** Mix in CJK and very long labels. Default false. */
  unicodeLabels?: boolean
}

export function randomPlan(seed: number, opts: RandomPlanOptions = {}): VizNode[] {
  const r = rng(seed)
  const min = opts.minNodes ?? 3
  const max = opts.maxNodes ?? 40
  const n = min + Math.floor(r() * (max - min + 1))
  const density = opts.density ?? (n < 12 ? 0.3 : 0.12)
  const ids = Array.from({ length: n }, (_, i) => `N${i}`)
  const label = (): string => {
    if (opts.unicodeLabels && r() < 0.25) return CJK[Math.floor(r() * CJK.length)] + CJK[Math.floor(r() * CJK.length)]
    if (opts.unicodeLabels && r() < 0.1) return 'x'.repeat(40 + Math.floor(r() * 60))
    return `${WORDS[Math.floor(r() * WORDS.length)]} ${WORDS[Math.floor(r() * WORDS.length)]}`
  }
  const nodes = ids.map((id, i) => N(id, label(), VIZ_STATUSES[Math.floor(r() * VIZ_STATUSES.length)], ids.slice(0, i).filter(() => r() < density)))
  return opts.goal === false ? nodes : withGoal(nodes)
}

/** Malformed inputs the production code must survive (it receives LLM-drafted and hand-edited plans). */
export const MALFORMED_PLANS: Record<string, VizNode[]> = {
  empty: [],
  unknownDependency: [N('A', 'A', 'pending', ['nope']), N('B', 'B', 'pending', ['A'])],
  selfLoop: [N('A', 'A', 'pending', ['A'])],
  twoCycle: [N('A', 'A', 'pending', ['B']), N('B', 'B', 'pending', ['A'])],
  longCycle: [N('A', 'A', 'pending', ['C']), N('B', 'B', 'pending', ['A']), N('C', 'C', 'pending', ['B'])],
  duplicateIds: [N('A', 'first', 'pending'), N('A', 'second', 'done'), N('B', 'B', 'pending', ['A'])],
  duplicateDeps: [N('A', 'A', 'pending'), N('B', 'B', 'pending', ['A', 'A', 'A'])],
  emptyLabel: [N('A', '', 'pending'), N('B', '   ', 'pending', ['A'])],
  hugeLabel: [N('A', 'x'.repeat(500), 'pending')],
  newlineInLabel: [N('A', 'line one\nline two\ttabbed', 'pending')],
  controlChars: [N('A', 'bell\u0007 escape\u001b[31m red', 'pending')],
  thousandNodes: Array.from({ length: 1000 }, (_, i) => N(`M${i}`, `Task ${i}`, 'pending', i ? [`M${i - 1}`] : [])),
}
