import { MemoryAdapter } from '@buildaharness/runtime';
import { GoalGraphFsPersistence, GoalThread, GoalThreadStatus, SiblingRelation } from './goal-graph-store.js';
/**
 * R5's four visibility buckets, derived from fields Phases 1/4/5 already persist rather than any
 * new schema or wiring: `mode: 'drafting'` is a thread proposed but not yet approved/committed to
 * (Q1's absorbed PlanRecord semantics) — "suggested-but-not-committed"; `status: 'DONE'` is done;
 * everything else is "freshly (re)computed this turn" when it has never been touched since
 * creation (`createdAt === updatedAt`), else "carried over" from a prior turn.
 */
export type GoalThreadVisibility = 'suggested_not_committed' | 'done' | 'freshly_computed' | 'carried_over';
export declare function classifyThreadVisibility(thread: GoalThread): GoalThreadVisibility;
export interface GoalTaskSummary {
    total: number;
    complete: number;
    failed: number;
    pending: number;
}
/** One thread as rendered by a review surface — a read-only projection, never the raw persisted `GoalThread` (callers have no business mutating it). */
export interface GoalThreadView {
    id: string;
    status: GoalThreadStatus;
    visibility: GoalThreadVisibility;
    successCriteria: string;
    tasks: GoalTaskSummary;
    relationToSiblings?: SiblingRelation;
    siblingIds?: string[];
    isActive: boolean;
    /** Advisory next steps proposed when the thread reached DONE (high/medium confidence only — low is never persisted). Absent when there are none. */
    suggestions?: {
        description: string;
        rationale: string;
        confidence: 'high' | 'medium' | 'low';
    }[];
    createdAt: string;
    updatedAt: string;
}
export interface GoalGraphState {
    activeThreadId: string | null;
    threads: GoalThreadView[];
}
/**
 * R5's review-surface entry point: every known GoalThread for `sessionId`, each tagged with its
 * visibility bucket, plus the current focus pointer. Returns the empty state (never throws, never
 * mints a record) when no goal graph exists yet for this session — same "nothing to show" shape as
 * `getPlanState`'s `null`, just pre-shaped into an empty list instead, since a review surface wants
 * something iterable, not a null check.
 */
export declare function getGoalGraphState(memory: MemoryAdapter, sessionId: string, fsPersistence?: GoalGraphFsPersistence): Promise<GoalGraphState>;
