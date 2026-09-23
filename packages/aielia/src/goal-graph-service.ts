import type { MemoryAdapter } from '@buildaharness/runtime'
import { loadGoalGraphRecord, type GoalGraphFsPersistence, type GoalThread, type GoalThreadStatus, type SiblingRelation } from './goal-graph-store.js'

// Phase 7 of plans/hierarchical_goal_tree_and_steering_plan.html — the shared query layer (R5,
// "Visibility") both the CLI's `/goals` and chat-ui's GoalsPanel read through, analogous to
// AssistantSession.searchTranscript: a pure, non-destructive read over whatever Phases 4-5 already
// populate in the persisted GoalGraphRecord. Nothing here writes state.

/**
 * R5's four visibility buckets, derived from fields Phases 1/4/5 already persist rather than any
 * new schema or wiring: `mode: 'drafting'` is a thread proposed but not yet approved/committed to
 * (Q1's absorbed PlanRecord semantics) — "suggested-but-not-committed"; `status: 'DONE'` is done;
 * everything else is "freshly (re)computed this turn" when it has never been touched since
 * creation (`createdAt === updatedAt`), else "carried over" from a prior turn.
 */
export type GoalThreadVisibility = 'suggested_not_committed' | 'done' | 'freshly_computed' | 'carried_over'

export function classifyThreadVisibility(thread: GoalThread): GoalThreadVisibility {
  if (thread.status === 'DONE') return 'done'
  if (thread.mode === 'drafting') return 'suggested_not_committed'
  return thread.createdAt === thread.updatedAt ? 'freshly_computed' : 'carried_over'
}

export interface GoalTaskSummary {
  total: number
  complete: number
  failed: number
  pending: number
}

function summarizeTasks(thread: GoalThread): GoalTaskSummary {
  return {
    total: thread.tasks.length,
    complete: thread.tasks.filter((t) => t.status === 'COMPLETE').length,
    failed: thread.tasks.filter((t) => t.status === 'FAILED').length,
    pending: thread.tasks.filter((t) => t.status === 'PENDING' || t.status === 'RUNNING' || t.status === 'BLOCKED' || t.status === 'HUMAN_REQUIRED').length,
  }
}

/** One thread as rendered by a review surface — a read-only projection, never the raw persisted `GoalThread` (callers have no business mutating it). */
export interface GoalThreadView {
  id: string
  status: GoalThreadStatus
  visibility: GoalThreadVisibility
  successCriteria: string
  tasks: GoalTaskSummary
  relationToSiblings?: SiblingRelation
  siblingIds?: string[]
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface GoalGraphState {
  activeThreadId: string | null
  threads: GoalThreadView[]
}

const EMPTY_STATE: GoalGraphState = { activeThreadId: null, threads: [] }

function toThreadView(thread: GoalThread, activeThreadId: string | null): GoalThreadView {
  return {
    id: thread.id,
    status: thread.status,
    visibility: classifyThreadVisibility(thread),
    successCriteria: thread.successCriteria,
    tasks: summarizeTasks(thread),
    relationToSiblings: thread.relationToSiblings,
    siblingIds: thread.siblingIds,
    isActive: thread.id === activeThreadId && thread.status === 'ACTIVE',
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  }
}

/**
 * R5's review-surface entry point: every known GoalThread for `sessionId`, each tagged with its
 * visibility bucket, plus the current focus pointer. Returns the empty state (never throws, never
 * mints a record) when no goal graph exists yet for this session — same "nothing to show" shape as
 * `getPlanState`'s `null`, just pre-shaped into an empty list instead, since a review surface wants
 * something iterable, not a null check.
 */
export async function getGoalGraphState(memory: MemoryAdapter, sessionId: string, fsPersistence?: GoalGraphFsPersistence): Promise<GoalGraphState> {
  const record = await loadGoalGraphRecord(memory, sessionId, fsPersistence)
  if (!record) return EMPTY_STATE
  return {
    activeThreadId: record.activeThreadId,
    threads: record.threads.map((t) => toThreadView(t, record.activeThreadId)),
  }
}
