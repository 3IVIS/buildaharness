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
