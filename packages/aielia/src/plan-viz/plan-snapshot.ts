import type { TaskStatus } from '@buildaharness/harness'
import type { PlanRecord } from '../plan-store.js'
import type { GoalGraphRecord } from '../goal-graph-store.js'
import { normalizePlanNodes } from './normalize.js'
import type { VizNode, VizStatus } from './types.js'

/** One node of the snapshot the web viewer consumes (cuddlytoddly's node shape; absent metadata means "nothing to show"). */
export interface SnapshotNode {
  id: string
  node_type: 'goal' | 'task'
  status: string
  origin: 'system'
  dependencies: string[]
  children: string[]
  result: string | null
  metadata: {
    description: string
    expanded?: boolean
    required_input: string[]
    output: string[]
    execution_steps: string[]
    reflection_notes: string[]
    verification_failure?: string
  }
}

export interface PlanSnapshot {
  type: 'snapshot'
  nodes: Record<string, SnapshotNode>
  status: { total: number; by_status: Record<string, number>; running_nodes: string[]; node_activities: Record<string, string> }
  structure_version: number
  paused: boolean
  activity: string | null
  activity_started_ms: number | null
  status_events: never[]
  tokens: { prompt: number; completion: number; total: number; calls: number }
}

export interface PlanSnapshotResult {
  /** What the web viewer consumes. */
  snapshot: PlanSnapshot
  /** The normalized nodes the CLI renderer consumes (goal nodes included, ids namespaced exactly as in the snapshot). */
  nodes: VizNode[]
  /** Repairs `normalizePlanNodes` made to malformed input (empty for a well-formed plan). */
  warnings: string[]
}

export interface PlanSnapshotOptions {
  /** The node the harness is currently executing — becomes `activity: "Executing: <currentNode>"`. Defaults to the first running task. */
  currentNode?: string
  tokens?: { prompt: number; completion: number; total: number; calls: number }
}

/** The task fields the adapter reads; both `PlanTaskRecord` and `GoalTaskRecord` satisfy it. */
interface SourceTask {
  id: string
  description: string
  depends_on: string[]
  status: TaskStatus
  cancelled?: boolean
  statusNote?: string
}

interface Group {
  goalId: string
  description: string
  rationale: string
  prefix: string
  tasks: SourceTask[]
  /** Whether the live overlay's un-namespaced ids apply to this group. */
  live: boolean
}

const STATUS: Record<TaskStatus, VizStatus> = { PENDING: 'pending', RUNNING: 'running', COMPLETE: 'done', FAILED: 'failed', BLOCKED: 'awaiting_input', HUMAN_REQUIRED: 'awaiting_user' }

const isGoalGraph = (s: PlanRecord | GoalGraphRecord): s is GoalGraphRecord => 'threads' in s

function groupsOf(source: PlanRecord | GoalGraphRecord): Group[] {
  if (!isGoalGraph(source)) {
    return [{ goalId: 'plan', description: source.successCriteria, rationale: source.rationale, prefix: '', tasks: source.tasks, live: true }]
  }
  return source.threads.map((t) => {
    const sibling = t.relationToSiblings ? ` (${t.relationToSiblings})` : ''
    return {
      goalId: t.id,
      description: `${t.successCriteria}${sibling}`,
      rationale: t.rationale,
      prefix: `${t.id}__`,
      tasks: t.tasks as SourceTask[],
      live: t.id === source.activeThreadId || source.threads.length === 1,
    }
  })
}

/**
 * Turns a plan (or every goal thread) into the node snapshot both surfaces draw. Pure and total: malformed
 * input is repaired by `normalizePlanNodes`, never thrown on. `live` overlays per-task statuses from a
 * running turn; un-namespaced ids apply to the active thread (or the only plan), namespaced ids anywhere.
 * Statuses: PENDING with every dependency done is `ready`; BLOCKED -> awaiting_input; HUMAN_REQUIRED ->
 * awaiting_user; a cancelled task is `done` in the snapshot (with a ⊘ description) and `cancelled` for the CLI.
 */
export function planToSnapshot(source: PlanRecord | GoalGraphRecord, live: readonly { id: string; status: TaskStatus }[] = [], opts: PlanSnapshotOptions = {}): PlanSnapshotResult {
  const liveBy = new Map(live.map((l) => [l.id, l.status]))
  const warnings: string[] = []
  const snapNodes: Record<string, SnapshotNode> = {}
  const vizNodes: VizNode[] = []
  const usedIds = new Set<string>()
  let firstRunning: string | undefined

  for (const g of groupsOf(source)) {
    const byRawId = new Map<string, SourceTask & { status: TaskStatus }>()
    for (const t of g.tasks) {
      if (byRawId.has(t.id)) continue
      const status = liveBy.get(g.prefix + t.id) ?? (g.live ? liveBy.get(t.id) : undefined) ?? t.status
      byRawId.set(t.id, { ...t, status })
    }
    const norm = normalizePlanNodes(g.tasks.map((t) => ({ id: t.id, label: t.description, status: 'pending' as const, deps: t.depends_on ?? [] })))
    warnings.push(...norm.warnings.map((w) => (g.prefix ? `${g.goalId}: ${w}` : w)))
    const depsOf = new Map(norm.nodes.map((n) => [n.id, n.deps]))
    const rank = (rawId: string): string => g.prefix + rawId

    const groupSnap: SnapshotNode[] = []
    for (const n of norm.nodes) {
      const t = byRawId.get(n.id)!
      const deps = depsOf.get(n.id)!
      const cancelled = t.status === 'COMPLETE' && t.cancelled === true
      let status: VizStatus = cancelled ? 'cancelled' : STATUS[t.status] ?? 'pending'
      if (t.status === 'PENDING' && deps.every((d) => byRawId.get(d)!.status === 'COMPLETE')) status = 'ready'
      if (t.status === 'RUNNING' && firstRunning === undefined) firstRunning = rank(n.id)
      const failed = t.status === 'FAILED'
      groupSnap.push({
        id: rank(n.id),
        node_type: 'task',
        status: status === 'cancelled' ? 'done' : status,
        origin: 'system',
        dependencies: deps.map(rank),
        children: [],
        result: cancelled ? '(cancelled by you)' : (t.statusNote ?? (t.status === 'COMPLETE' ? 'done' : null)),
        metadata: {
          description: (cancelled ? '⊘ ' : '') + t.description,
          required_input: [], output: [], execution_steps: [], reflection_notes: [],
          ...(failed && t.statusNote ? { verification_failure: t.statusNote } : {}),
        },
      })
      vizNodes.push({ id: rank(n.id), label: t.description, status, deps: deps.map(rank) })
    }

    const depended = new Set(groupSnap.flatMap((n) => n.dependencies))
    const terminals = groupSnap.filter((n) => !depended.has(n.id)).map((n) => n.id)
    let goalId = g.goalId
    const taken = (id: string): boolean => usedIds.has(id) || groupSnap.some((n) => n.id === id) || vizNodes.some((n) => n.id === id)
    while (taken(goalId)) goalId += '_goal'
    usedIds.add(goalId)
    const byId = new Map(groupSnap.map((n) => [n.id, n]))
    for (const n of groupSnap) for (const d of n.dependencies) byId.get(d)!.children.push(n.id)
    for (const id of terminals) byId.get(id)!.children.push(goalId)
    const goalDone = terminals.every((id) => byId.get(id)!.status === 'done')
    snapNodes[goalId] = {
      id: goalId, node_type: 'goal', status: goalDone ? 'done' : 'pending', origin: 'system', dependencies: terminals, children: [], result: null,
      metadata: { description: g.description, expanded: true, required_input: [], output: [], execution_steps: [], reflection_notes: [g.rationale].filter(Boolean) },
    }
    for (const n of groupSnap) snapNodes[n.id] = n
    vizNodes.push({ id: goalId, label: g.description, status: goalDone ? 'done' : 'pending', deps: terminals })
    for (const n of groupSnap) usedIds.add(n.id)
  }

  const by_status: Record<string, number> = {}
  for (const n of Object.values(snapNodes)) by_status[n.status] = (by_status[n.status] ?? 0) + 1
  const running = Object.values(snapNodes).filter((n) => n.node_type === 'task' && vizNodes.find((v) => v.id === n.id)?.status === 'running').map((n) => n.id)
  const current = opts.currentNode ?? firstRunning
  const activity = current ? `Executing: ${current}` : null
  return {
    snapshot: {
      type: 'snapshot',
      nodes: snapNodes,
      status: { total: Object.keys(snapNodes).length, by_status, running_nodes: running, node_activities: current && running.length ? { [current]: activity! } : {} },
      structure_version: 1,
      paused: false,
      activity,
      activity_started_ms: activity ? Date.now() : null,
      status_events: [],
      tokens: opts.tokens ?? { prompt: 0, completion: 0, total: 0, calls: 0 },
    },
    nodes: vizNodes,
    warnings,
  }
}
