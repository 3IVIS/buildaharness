import { z } from 'zod'
import type { FsBackend, MemoryAdapter } from '@buildaharness/runtime'
import { loadPlanRecord, type PlanFsPersistence, type PlanRecord } from './plan-store.js'

// Storage-taxonomy note (Phase 1 of plans/hierarchical_goal_tree_and_steering_plan.html): this is
// the personal-assistant's State tier, same as plan-store.ts's PlanRecord — see
// packages/aielia/README.md's "Memory, Knowledge, and the other four" section. Per Q1 (resolved
// 2026-09-22), GoalGraphRecord absorbs PlanRecord rather than coexisting with it: one GoalThread
// is what one PlanRecord used to be, just N of them, each carrying its own scheduler-facing
// `status` on top of the old plan shape. This module is schema-only and unused until Phase 4 —
// nothing in the running assistant reads or writes a GoalGraphRecord yet, so building it can't
// change any existing behavior (INV-43).

export const GoalThreadStatusSchema = z.enum(['READY', 'ACTIVE', 'BLOCKED', 'PAUSED', 'DONE', 'ABANDONED'])
export type GoalThreadStatus = z.infer<typeof GoalThreadStatusSchema>

/**
 * R3's two reasons for multiple root nodes, handled oppositely: `alternative` roots are competing
 * guesses at one intent (resolving one abandons the others), `concurrent` roots are genuinely
 * separate goals that coexist. Absent for a thread with no siblings needing disambiguation.
 */
export const SiblingRelationSchema = z.enum(['alternative', 'concurrent'])
export type SiblingRelation = z.infer<typeof SiblingRelationSchema>

const GoalTaskRecordSchema = z.object({
  id: z.string(),
  description: z.string(),
  depends_on: z.array(z.string()),
  status: z.enum(['PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'BLOCKED', 'HUMAN_REQUIRED']),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  cancelled: z.boolean().optional(),
})
export type GoalTaskRecord = z.infer<typeof GoalTaskRecordSchema>

/**
 * A persisted next-step suggestion (R7) — what next-step-proposer.ts's `proposeNextSteps()` yields
 * for a thread that just reached DONE, minus `goalThreadId` (it lives on the thread that owns it).
 * Advisory only: a suggestion is never a task on the thread and is never executed; the user acts on
 * it, if at all, by simply asking. `promotion` records the confidence policy that admitted it
 * (`auto` = high confidence, `pending_confirm` = medium); `session_only` (low confidence)
 * suggestions are never persisted, so they don't appear here.
 */
export const ThreadSuggestionSchema = z.object({
  id: z.string(),
  description: z.string(),
  rationale: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  promotion: z.enum(['auto', 'pending_confirm', 'session_only']),
  createdAt: z.string(),
})
export type ThreadSuggestion = z.infer<typeof ThreadSuggestionSchema>

const GoalThreadModeSchema = z.enum(['drafting', 'awaiting_approval', 'active', 'done', 'abandoned'])

/**
 * One node in the persisted goal DAG (R2). Absorbs PlanRecord's exact shape (Q1) — templateName
 * through updatedAt below are unchanged in meaning from PlanRecord — plus the fields that make a
 * thread schedulable: a stable `id` (PlanRecord had none, being a singleton), a scheduler-facing
 * `status` distinct from `mode` (which is about this thread's own Tier-2 drafting/approval
 * lifecycle, not whether the Scheduler may currently give it focus — see INV-40), and R3's sibling
 * relation for when this thread is one of several roots.
 */
export const GoalThreadSchema = z.object({
  id: z.string(),
  status: GoalThreadStatusSchema,
  relationToSiblings: SiblingRelationSchema.optional(),
  /** Sibling GoalThread ids this one is grouped with as competing/concurrent roots (R3). */
  siblingIds: z.array(z.string()).optional(),

  /** templateName..updatedAt: absorbed from PlanRecord unchanged (Q1). */
  templateName: z.string().nullable(),
  successCriteria: z.string(),
  rationale: z.string(),
  tasks: z.array(GoalTaskRecordSchema),
  mode: GoalThreadModeSchema,
  reviewNotes: z.array(z.string()).optional(),
  verifiedAt: z.string().optional(),
  executingOnPlan: z.boolean(),
  /** Advisory next steps proposed when this thread reached DONE — see ThreadSuggestionSchema. */
  suggestions: z.array(ThreadSuggestionSchema).optional(),
  trustApprovedSteps: z.boolean().optional(),
  planApprovalId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type GoalThread = z.infer<typeof GoalThreadSchema>

/**
 * The persisted DAG itself (R2): `threads` is the full set of goal threads known this session,
 * `activeThreadId` is the O(1) current-focus pointer every downstream mechanism (classifier,
 * Scheduler, next-step proposer, Tier-2 scoping) needs answerable without a graph traversal —
 * see the "current-focus / task→goal linkage primitive" gap this plan's design brief calls out.
 * INV-38/39 (at most one ACTIVE thread, Scheduler is the sole writer of this pointer) are enforced
 * starting Phase 5, not here — this phase only defines the shape.
 */
export const GoalGraphRecordSchema = z.object({
  threads: z.array(GoalThreadSchema),
  activeThreadId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type GoalGraphRecord = z.infer<typeof GoalGraphRecordSchema>

/** Same `{backend, workspaceRoot}` pair as PlanFsPersistence — a goal graph and its session's plan file live in the same workspace. */
export type GoalGraphFsPersistence = PlanFsPersistence

function goalGraphKey(sessionId: string): string {
  return `goalgraph:${sessionId}`
}

function goalGraphFilePath(workspaceRoot: string, sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${workspaceRoot}/.buildaharness/goals/${safeId}.goalgraph.json`
}

/** Write-tmp-then-rename when the backend supports it — mirrors plan-store.ts's atomicWriteFile. */
async function atomicWriteFile(backend: FsBackend, path: string, contents: string): Promise<void> {
  if (!backend.rename) {
    await backend.writeTextFile(path, contents)
    return
  }
  const tmp = `${path}.tmp-${crypto.randomUUID()}`
  await backend.writeTextFile(tmp, contents)
  await backend.rename(tmp, path)
}

async function writeGoalGraphFile(fsPersistence: GoalGraphFsPersistence, sessionId: string, record: GoalGraphRecord): Promise<void> {
  try {
    const { backend, workspaceRoot } = fsPersistence
    const path = goalGraphFilePath(workspaceRoot, sessionId)
    await backend.mkdir(`${workspaceRoot}/.buildaharness/goals`)
    await atomicWriteFile(backend, path, JSON.stringify(record, null, 2))
  } catch (err) {
    console.error(`goal-graph-store: writing goal graph file for session ${sessionId} failed:`, err)
  }
}

async function readGoalGraphFile(fsPersistence: GoalGraphFsPersistence | undefined, sessionId: string): Promise<GoalGraphRecord | undefined> {
  if (!fsPersistence) return undefined
  try {
    const raw = await fsPersistence.backend.readTextFile(goalGraphFilePath(fsPersistence.workspaceRoot, sessionId))
    if (raw === undefined) return undefined
    return GoalGraphRecordSchema.parse(JSON.parse(raw))
  } catch (err) {
    console.error(`goal-graph-store: reading goal graph file for session ${sessionId} failed:`, err)
    return undefined
  }
}

/**
 * Maps a `PlanRecord`'s `mode` to the new scheduler-facing `status` for the single thread it
 * migrates into. `active` keeps live continuity (`ACTIVE`, unchanged focus); `drafting`/
 * `awaiting_approval` become `READY` since a thread mid-Tier-2-drafting must never be
 * Scheduler-selectable (INV-40) and there's no Scheduler focus concept to preserve pre-migration
 * anyway; `done`/`abandoned` map straight across.
 */
function statusForMigratedPlan(mode: PlanRecord['mode']): GoalThreadStatus {
  switch (mode) {
    case 'active': return 'ACTIVE'
    case 'done': return 'DONE'
    case 'abandoned': return 'ABANDONED'
    case 'drafting':
    case 'awaiting_approval':
      return 'READY'
  }
}

/**
 * Wraps an existing `PlanRecord` into the single `GoalThread` it becomes under Q1's "absorb, don't
 * duplicate" resolution — nothing in `plan`'s own fields is dropped.
 */
export function createGoalThreadFromPlanRecord(plan: PlanRecord, id: string = crypto.randomUUID()): GoalThread {
  return {
    id,
    status: statusForMigratedPlan(plan.mode),
    templateName: plan.templateName,
    successCriteria: plan.successCriteria,
    rationale: plan.rationale,
    tasks: plan.tasks.map((t) => ({ id: t.id, description: t.description, depends_on: t.depends_on, status: t.status, riskLevel: t.riskLevel, cancelled: t.cancelled })),
    mode: plan.mode,
    reviewNotes: plan.reviewNotes,
    verifiedAt: plan.verifiedAt,
    executingOnPlan: plan.executingOnPlan,
    trustApprovedSteps: plan.trustApprovedSteps,
    planApprovalId: plan.planApprovalId,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  }
}

/** A fresh, empty goal graph — no threads, nothing active. */
export function createEmptyGoalGraphRecord(): GoalGraphRecord {
  const now = new Date().toISOString()
  return { threads: [], activeThreadId: null, createdAt: now, updatedAt: now }
}

/** Wraps a single pre-existing `PlanRecord` into a one-thread `GoalGraphRecord` — the migration path's output shape. */
export function createGoalGraphRecordFromPlanRecord(plan: PlanRecord): GoalGraphRecord {
  const thread = createGoalThreadFromPlanRecord(plan)
  const now = new Date().toISOString()
  return {
    threads: [thread],
    activeThreadId: thread.status === 'ACTIVE' ? thread.id : null,
    createdAt: plan.createdAt,
    updatedAt: now,
  }
}

/**
 * R2's O(1) locatability primitive, live as of Phase 4: the currently-focused thread, found by a
 * direct field lookup (`activeThreadId`), never a graph traversal. Defensive about a transient
 * inconsistency Phase 4 can produce (see goal-graph-reconcile.ts): a NEW_GOAL/CANCEL_CURRENT
 * steering message can pause/abandon the thread `activeThreadId` still points at, ahead of Phase
 * 5's Scheduler ever reassigning that pointer (INV-39 — only the Scheduler writes it) — so this
 * only returns a thread whose own `status` is still genuinely `ACTIVE`, not just pointed-at.
 */
export function getActiveThread(record: GoalGraphRecord): GoalThread | null {
  if (!record.activeThreadId) return null
  const thread = record.threads.find((t) => t.id === record.activeThreadId)
  return thread && thread.status === 'ACTIVE' ? thread : null
}

/** R2's task→goal parent-link query — every task belonging to `goalId`, a direct field filter, never a traversal. */
export function tasksForGoal(record: GoalGraphRecord, goalId: string): GoalTaskRecord[] {
  const thread = record.threads.find((t) => t.id === goalId)
  return thread ? thread.tasks : []
}

/**
 * Every thread the Scheduler could hand focus to right now (Phase 5): READY, and not mid-Tier-2
 * drafting or awaiting approval (INV-40). A drafting thread's `status` is READY (see
 * createGoalThreadFromPlanRecord / mintConcurrentReadyThread), so the exclusion has to look at
 * `mode`, not just `status` — until 2026-09-23 this filtered on status alone, which quietly made
 * INV-40 false: a thread minted by a NEW_GOAL steering message (mode 'drafting') was eligible for
 * focus. The identity matcher (goal-thread-identity.ts) is what adopts such a thread, by matching
 * a real turn to it and promoting its mode to 'active'.
 */
export function readyThreads(record: GoalGraphRecord): GoalThread[] {
  return record.threads.filter((t) => t.status === 'READY' && t.mode !== 'drafting' && t.mode !== 'awaiting_approval')
}

/**
 * R4's NEW_GOAL branch (both IMMEDIATE and DEFERRED collapse to this in Phase 4 — see
 * check-caller-updates.ts's cancel_current sibling doc comment and the plan's resolved
 * "ACTIVE-pointer write authority" decision: Tier-1 never writes `activeThreadId` itself, it only
 * pauses the old thread and mints the new one READY; Phase 5's Scheduler decides what becomes
 * ACTIVE next). `pauseThreadId`, when given and currently ACTIVE, transitions to PAUSED and is
 * linked to the new thread as a `concurrent` sibling (R3) — never `alternative`, since a NEW_GOAL
 * is a genuinely separate objective, not a competing guess at the same one.
 */
export function mintConcurrentReadyThread(record: GoalGraphRecord, description: string, pauseThreadId?: string | null): GoalGraphRecord {
  const now = new Date().toISOString()
  const newId = crypto.randomUUID()
  const newThread: GoalThread = {
    id: newId,
    status: 'READY',
    relationToSiblings: pauseThreadId ? 'concurrent' : undefined,
    siblingIds: pauseThreadId ? [pauseThreadId] : undefined,
    templateName: null,
    successCriteria: description,
    rationale: description,
    tasks: [],
    mode: 'drafting',
    executingOnPlan: false,
    createdAt: now,
    updatedAt: now,
  }
  const threads = record.threads.map((t) => {
    if (t.id !== pauseThreadId) return t
    const siblingIds = [...(t.siblingIds ?? []), newId]
    return { ...t, status: t.status === 'ACTIVE' ? ('PAUSED' as const) : t.status, relationToSiblings: 'concurrent' as const, siblingIds, updatedAt: now }
  })
  return { ...record, threads: [...threads, newThread], updatedAt: now }
}

/** R4's CANCEL_CURRENT branch — marks a thread ABANDONED. Kept for audit trail, never removed from `threads`. */
export function abandonThread(record: GoalGraphRecord, threadId: string): GoalGraphRecord {
  const now = new Date().toISOString()
  const threads = record.threads.map((t) => (t.id === threadId ? { ...t, status: 'ABANDONED' as const, updatedAt: now } : t))
  return { ...record, threads, updatedAt: now }
}

export async function saveGoalGraphRecord(memory: MemoryAdapter, sessionId: string, record: GoalGraphRecord, fsPersistence?: GoalGraphFsPersistence): Promise<void> {
  if (fsPersistence) await writeGoalGraphFile(fsPersistence, sessionId, record)
  await memory.set(goalGraphKey(sessionId), record)
}

/**
 * Loads `sessionId`'s goal graph, migrating a pre-existing `PlanRecord` in place the first time
 * this is called for a session that predates this mechanism (P5-equivalent non-destructive
 * discipline — same as `migrateFact`/`migratePlanRecord`: the old record's data is never silently
 * dropped, just re-shaped and persisted once under the new key). Every call after that first one
 * finds the migrated `GoalGraphRecord` directly and never re-touches the legacy `PlanRecord`.
 *
 * When `fsPersistence` is configured and its goal-graph JSON file exists, that file wins over the
 * Dexie/State-tier record, mirroring `loadPlanRecord`'s own fs-file-wins-then-reconcile behavior
 * (INV-33's discipline, applied here too: the result is written back into `memory` so the two
 * never stay silently split).
 */
export async function loadGoalGraphRecord(memory: MemoryAdapter, sessionId: string, fsPersistence?: GoalGraphFsPersistence): Promise<GoalGraphRecord | null> {
  const fromFile = await readGoalGraphFile(fsPersistence, sessionId)
  if (fromFile !== undefined) {
    await memory.set(goalGraphKey(sessionId), fromFile)
    return fromFile
  }

  const stored = (await memory.get(goalGraphKey(sessionId))) as GoalGraphRecord | undefined
  if (stored) return GoalGraphRecordSchema.parse(stored)

  const legacyPlan = await loadPlanRecord(memory, sessionId, fsPersistence)
  if (!legacyPlan) return null

  const migrated = createGoalGraphRecordFromPlanRecord(legacyPlan)
  await saveGoalGraphRecord(memory, sessionId, migrated, fsPersistence)
  return migrated
}

/**
 * Appends advisory `suggestions` to `threadId`, skipping any whose description (case-insensitive,
 * trimmed) the thread already carries — proposing again for the same DONE thread must not stack
 * duplicates. `session_only` suggestions are dropped here (low confidence is advisory for the turn
 * that produced it, never persisted). A `threadId` not present in `record.threads` is a no-op.
 */
export function addThreadSuggestions(record: GoalGraphRecord, threadId: string, suggestions: ThreadSuggestion[]): GoalGraphRecord {
  const persistable = suggestions.filter((sg) => sg.promotion !== 'session_only')
  if (persistable.length === 0) return record
  const stamp = new Date().toISOString()
  const threads = record.threads.map((t) => {
    if (t.id !== threadId) return t
    const existing = t.suggestions ?? []
    const seen = new Set(existing.map((sg) => sg.description.trim().toLowerCase()))
    const fresh = persistable.filter((sg) => {
      const key = sg.description.trim().toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return fresh.length === 0 ? t : { ...t, suggestions: [...existing, ...fresh], updatedAt: stamp }
  })
  return { ...record, threads, updatedAt: stamp }
}
