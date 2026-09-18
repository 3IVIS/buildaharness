import type { FsBackend, MemoryAdapter } from '@buildaharness/runtime'
import { containsCJK, tokenize, type TaskStatus } from '@buildaharness/harness'
import type { Plan } from './plan-builder.js'
import { getTaskCancelPatterns, testAny } from './lexical/patterns.js'

// Storage-taxonomy note (Phase 5b): this is the personal-assistant's State tier ("what's true
// now") — `plan:${sessionId}` records the currently-active task graph and its per-task status,
// distinct from Knowledge (fact-extraction.ts's UserFact, "what we believe") or Experience
// (DexieExperienceStore, "what worked before"). See
// packages/aielia/README.md's "Memory, Knowledge, and the other four" section for
// the full six-tier map.

export interface PlanTaskRecord {
  id: string
  description: string
  depends_on: string[]
  status: TaskStatus
  /**
   * Per-task risk, attached at plan-creation time (see plan-builder.ts's buildPlanFromTemplate)
   * instead of re-derived from the description text on every resume. Optional only for backward
   * compatibility with a plan persisted before this field existed — assistant.ts's
   * toHarnessTasks falls back to the lexical planTaskRiskLevel/classifyRisk for those.
   */
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH'
  /**
   * True once the user explicitly cancelled this specific task (see matchTaskCancelAttempt/
   * cancelPlanTask) — distinct from `status`, which gets set to 'COMPLETE' alongside this so the
   * harness's task-graph selection and dependent-unblocking treat it as resolved the same way a
   * genuinely finished task would be (TaskStatus, from @buildaharness/harness, has no CANCELLED
   * value of its own — extending that union is a cross-package change out of scope here).
   * formatPlanProgress/planCompletionPct read this flag to show/count it accurately instead of
   * claiming the user's own work actually got done.
   */
  cancelled?: boolean
}

/**
 * Superset of the old 3-value `status`: 'drafting' and 'awaiting_approval' are new (plan mode's
 * P1/P2 — not wired to any producer yet, this phase is schema-only), 'active'/'done'/'abandoned'
 * are the pre-existing values, unchanged in meaning.
 */
export type PlanMode = 'drafting' | 'awaiting_approval' | 'active' | 'done' | 'abandoned'

export interface PlanRecord {
  /** null for a fully custom-drafted plan (P3) that isn't seeded from one of the named templates. */
  templateName: string | null
  successCriteria: string
  /** Why this approach, not just the success criteria — see Plan.rationale. */
  rationale: string
  tasks: PlanTaskRecord[]
  mode: PlanMode
  /** Populated by plan mode's P6 self-verification pass. */
  reviewNotes?: string[]
  verifiedAt?: string
  /** Whether the harness should auto-advance through this plan's tasks without a per-step pacing pause (plan mode's P4). */
  executingOnPlan: boolean
  /**
   * Plan mode's P10 "trust this approved plan" opt-in — absent/false (the default, "absent when
   * unused" per this codebase's convention for additive fields) means every write/shell/email
   * action this plan's execution proposes stays individually gated exactly as before this phase.
   * `true` only once the user chose `'approve_trusted'` at the P2 approval screen (never the
   * default choice there — see PlanApprovalService) — while true, an action proposed during
   * execution of whichever task is this plan's currently RUNNING one is auto-applied instead of
   * staged (INV-36; see assistant.ts's buildToolLoopPauseResult). Per-plan, not global or
   * per-session: a fresh plan, or this same plan reloaded after `abandonPlan`, starts back at
   * false.
   */
  trustApprovedSteps?: boolean
  /**
   * Set only while `mode === 'awaiting_approval'` (plan mode's P2) — correlates a
   * `turn(message, { planApprovalId, planDecision })` resolution to exactly this staged snapshot,
   * same "resolved by ID, never re-derived" discipline pendingActionId/pendingClarificationId
   * already follow. Cleared (undefined) once the plan is activated or the draft is abandoned.
   */
  planApprovalId?: string
  createdAt: string
  updatedAt: string
}

/** Pre-P0 persisted shape: `status` instead of `mode`, no `rationale`/`executingOnPlan`. */
interface LegacyPlanRecordShape {
  templateName: string
  successCriteria: string
  tasks: PlanTaskRecord[]
  status: 'active' | 'done' | 'abandoned'
  createdAt: string
  updatedAt: string
}

function isLegacyShape(record: PlanRecord | LegacyPlanRecordShape): record is LegacyPlanRecordShape {
  return !('mode' in record) && 'status' in record
}

/**
 * Maps a persisted record — old 3-value `status` shape or the current 5-value `mode` shape — to
 * the current PlanRecord shape, same "default pre-existing records without demoting a real value"
 * convention fact-extraction.ts's migrateFact already uses elsewhere in this package. A migrated
 * `active` plan gets `executingOnPlan: true` so an in-flight plan from before this change keeps
 * progressing rather than silently stalling.
 */
export function migratePlanRecord(record: PlanRecord | LegacyPlanRecordShape): PlanRecord {
  if (!isLegacyShape(record)) return record
  return {
    templateName: record.templateName,
    successCriteria: record.successCriteria,
    rationale: '',
    tasks: record.tasks,
    mode: record.status,
    executingOnPlan: record.status === 'active',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function planKey(sessionId: string): string {
  return `plan:${sessionId}`
}

/**
 * Plan mode's P5 file-backed persistence: when a real filesystem is available (CLI/desktop —
 * the same `{backend, workspaceRoot}` pair AssistantSession.undoWorkspace() already resolves for
 * write_file/run_shell_command), every plan write is mirrored to
 * `<workspaceRoot>/.buildaharness/plans/<sessionId>.plan.json` (plus a generated `.plan.md`
 * view), and every load prefers that file over the Dexie/IndexedDB State-tier record so a
 * hand-edit to the JSON between turns is picked up. On a surface with no filesystem (a browser
 * tab), this is `undefined` throughout and Dexie alone remains the source of truth, unchanged
 * from before P5.
 */
export interface PlanFsPersistence {
  backend: FsBackend
  workspaceRoot: string
}

function planFilePaths(workspaceRoot: string, sessionId: string): { dir: string; json: string; md: string } {
  // sessionId is an API-level identifier, not sandboxed user input the way write_file's `path`
  // arg is — but it still flows into a filesystem path, so strip anything that could traverse
  // out of the plans directory rather than trusting it's always a plain slug.
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const dir = `${workspaceRoot}/.buildaharness/plans`
  return { dir, json: `${dir}/${safeId}.plan.json`, md: `${dir}/${safeId}.plan.md` }
}

/**
 * Writes `contents` to `path` via write-tmp-then-rename when the backend supports `rename`
 * (real disk backends — see FsBackend.rename's doc comment), mirroring
 * adapter/harness/plan_store.py's `tmp.write_text(...); os.replace(tmp, final)` reference
 * design. Falls back to a plain (non-atomic) write when the backend can't rename.
 */
async function atomicWriteFile(backend: FsBackend, path: string, contents: string): Promise<void> {
  if (!backend.rename) {
    await backend.writeTextFile(path, contents)
    return
  }
  const tmp = `${path}.tmp-${crypto.randomUUID()}`
  await backend.writeTextFile(tmp, contents)
  await backend.rename(tmp, path)
}

/**
 * Human-readable file view alongside the JSON — reuses formatPlanProgress's exact task-status
 * rendering rather than re-deriving it, and appends the fields formatPlanProgress doesn't cover
 * (rationale, review notes, verification timestamp). Purely generated: explicitly not parsed
 * back in if hand-edited (the plan document's own non-goal) — the JSON file next to it is the
 * one editable-and-reloadable artifact.
 */
function formatPlanFileMarkdown(plan: PlanRecord): string {
  const lines = [
    `# Plan: ${plan.templateName ?? '(custom)'}`,
    '',
    `_Mode: ${plan.mode} — generated ${plan.updatedAt}. This file is a generated view, not re-parsed if hand-edited; edit the sibling .plan.json instead._`,
    '',
    '```',
    formatPlanProgress(plan),
    '```',
  ]
  if (plan.rationale) lines.push('', '## Rationale', plan.rationale)
  if (plan.reviewNotes && plan.reviewNotes.length > 0) lines.push('', '## Review notes', ...plan.reviewNotes.map((n) => `- ${n}`))
  if (plan.verifiedAt) lines.push('', `_Verified at: ${plan.verifiedAt}_`)
  return `${lines.join('\n')}\n`
}

/**
 * Best-effort dual-write side channel — never throws (matches plan_store.py's "save errors are
 * swallowed and logged" convention) since a filesystem hiccup here must never lose the plan,
 * which the Dexie/State-tier write (the caller's other half of the dual write) still holds.
 */
async function writePlanFiles(fsPersistence: PlanFsPersistence, sessionId: string, plan: PlanRecord): Promise<void> {
  try {
    const { backend, workspaceRoot } = fsPersistence
    const { dir, json, md } = planFilePaths(workspaceRoot, sessionId)
    await backend.mkdir(dir)
    await atomicWriteFile(backend, json, JSON.stringify(plan, null, 2))
    await atomicWriteFile(backend, md, formatPlanFileMarkdown(plan))
  } catch (err) {
    console.error(`plan-store: writing plan files for session ${sessionId} failed:`, err)
  }
}

/**
 * Reads back the fs-persisted plan JSON, if any. Returns `undefined` (not `null`) when there's
 * nothing to prefer over Dexie — no fs configured, no file yet (a session that predates P5 or
 * has never run on a filesystem surface), or a read/parse error — so callers can tell "fall back
 * to Dexie" apart from "the fs file legitimately holds no active plan".
 */
async function readPlanFile(fsPersistence: PlanFsPersistence | undefined, sessionId: string): Promise<PlanRecord | undefined> {
  if (!fsPersistence) return undefined
  try {
    const { json } = planFilePaths(fsPersistence.workspaceRoot, sessionId)
    const raw = await fsPersistence.backend.readTextFile(json)
    if (raw === undefined) return undefined
    return migratePlanRecord(JSON.parse(raw) as PlanRecord | LegacyPlanRecordShape)
  } catch (err) {
    console.error(`plan-store: reading plan file for session ${sessionId} failed:`, err)
    return undefined
  }
}

/**
 * Reads `sessionId`'s stored plan record regardless of `mode` — unlike `loadActivePlan`, which
 * filters to `mode === 'active'` only. Plan mode's P1 drafting path needs to resume a
 * `mode: 'drafting'` record across turns (and P2 needs `awaiting_approval` the same way), neither
 * of which `loadActivePlan` would ever return.
 *
 * When `fsPersistence` is configured and its plan JSON file exists, that file wins over the
 * Dexie/State-tier record (P5 — the file is the editable-and-reloadable artifact, so a hand-edit
 * between turns takes effect on the very next load) and is written back into `memory` to
 * reconcile the two (INV-33: after any interrupted dual write, the next load's result is
 * self-consistent and Dexie catches back up to it, rather than the two staying silently split).
 */
export async function loadPlanRecord(memory: MemoryAdapter, sessionId: string, fsPersistence?: PlanFsPersistence): Promise<PlanRecord | null> {
  const fromFile = await readPlanFile(fsPersistence, sessionId)
  if (fromFile !== undefined) {
    await memory.set(planKey(sessionId), fromFile)
    return fromFile
  }
  const stored = (await memory.get(planKey(sessionId))) as PlanRecord | LegacyPlanRecordShape | undefined
  if (!stored) return null
  return migratePlanRecord(stored)
}

/** Returns null when no plan exists for this session, or the stored plan is already done/abandoned — a finished plan never auto-resumes. */
export async function loadActivePlan(memory: MemoryAdapter, sessionId: string, fsPersistence?: PlanFsPersistence): Promise<PlanRecord | null> {
  const record = await loadPlanRecord(memory, sessionId, fsPersistence)
  if (!record || record.mode !== 'active') return null
  return record
}

/**
 * Builds an immediately-`active` PlanRecord with no drafting/approval step at all. Before P3 of
 * plans/ask_question_and_plan_mode_plan.html, TurnInterpreter.resolveTasks called this the instant
 * classifyTurnIntent matched a template; P3 retired that call site — a template match (or the
 * newer general needsMultiStepPlan judgment) now always routes through plan mode's exclusive
 * drafting+approval loop instead (see assistant.ts's auto-trigger and
 * PlanDraftingService.draftTurn's template-seeding). This function itself is unchanged and still
 * used directly by tests/callers that want to seed an already-active plan without going through
 * drafting. The ONLY other place `mode: 'active'` is ever set is `activatePlanRecord` below,
 * reached solely via a drafted plan's explicit approve/approve-with-edits (INV-31) — this function
 * remains the one intentional exception to "exactly one place", now purely a low-level primitive
 * rather than something classification wires up automatically.
 */
export function createPlanRecord(plan: Plan): PlanRecord {
  const now = new Date().toISOString()
  return {
    templateName: plan.templateName,
    successCriteria: plan.successCriteria,
    rationale: plan.rationale ?? '',
    tasks: plan.tasks.map((t): PlanTaskRecord => ({ id: t.id, description: t.description, depends_on: t.depends_on, status: 'PENDING', riskLevel: t.riskLevel })),
    mode: 'active',
    executingOnPlan: true,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * The funnel every plan mutation in this module writes through. When `fsPersistence` is
 * configured, the fs file is written first and Dexie second (P5, INV-33): if the process dies
 * between the two, the fs file — which `loadPlanRecord` always prefers when present — already
 * reflects either the old state (rename never happened) or the new one (rename completed),
 * never a half-written file, so the next load resolves to one consistent version of both instead
 * of a silently split pair.
 */
export async function savePlan(memory: MemoryAdapter, sessionId: string, plan: PlanRecord, fsPersistence?: PlanFsPersistence): Promise<void> {
  if (fsPersistence) await writePlanFiles(fsPersistence, sessionId, plan)
  await memory.set(planKey(sessionId), plan)
}

/**
 * A fresh, empty `mode: 'drafting'` record — the seed for plan mode's P1 drafting loop, started
 * either from nothing (a from-scratch draft, P3) or already carrying a `templateName` seed.
 * Unlike `createPlanRecord`, `executingOnPlan` starts false (P4's auto-advance only ever applies
 * once P2 approval flips the record to `active`) and `mode` starts `'drafting'`, not `'active'`.
 */
export function createDraftPlanRecord(templateName: string | null): PlanRecord {
  const now = new Date().toISOString()
  return {
    templateName,
    successCriteria: '',
    rationale: '',
    tasks: [],
    mode: 'drafting',
    executingOnPlan: false,
    createdAt: now,
    updatedAt: now,
  }
}

export async function abandonPlan(memory: MemoryAdapter, sessionId: string, plan: PlanRecord, fsPersistence?: PlanFsPersistence): Promise<void> {
  await savePlan(memory, sessionId, { ...plan, mode: 'abandoned', executingOnPlan: false, updatedAt: new Date().toISOString() }, fsPersistence)
}

/**
 * Stages a drafted plan for plan mode's P2 mandatory whole-plan approval gate: `mode` moves to
 * `'awaiting_approval'` and a fresh `planApprovalId` is minted so the eventual
 * `turn(message, { planApprovalId, planDecision })` resolves exactly this snapshot, never a
 * second, re-derived one (see PlanRecord.planApprovalId's doc comment).
 */
export async function stagePlanForApproval(memory: MemoryAdapter, sessionId: string, plan: PlanRecord, fsPersistence?: PlanFsPersistence): Promise<PlanRecord> {
  const updated: PlanRecord = { ...plan, mode: 'awaiting_approval', planApprovalId: crypto.randomUUID(), updatedAt: new Date().toISOString() }
  await savePlan(memory, sessionId, updated, fsPersistence)
  return updated
}

/**
 * The sole place a *drafted* plan reaches `mode: 'active'` (INV-31) — called only from
 * PlanApprovalService's approve/approve-with-edits branch, once any edits have already landed on
 * `plan`. `createPlanRecord` above sets `mode: 'active'` too, but that's the pre-existing,
 * unrelated template-instant-match path — not a second way for a *drafted* plan to skip approval.
 * `planApprovalId` is cleared since the staged snapshot it correlated to no longer exists once
 * activated.
 */
export async function activatePlanRecord(memory: MemoryAdapter, sessionId: string, plan: PlanRecord, fsPersistence?: PlanFsPersistence): Promise<PlanRecord> {
  const updated: PlanRecord = { ...plan, mode: 'active', executingOnPlan: true, planApprovalId: undefined, updatedAt: new Date().toISOString() }
  await savePlan(memory, sessionId, updated, fsPersistence)
  return updated
}

export interface TaskCancelMatch {
  taskId: string
  taskDescription: string
}

// Compiled from packages/aielia/src/lexical/patterns/task-cancel-markers.json (see
// lexical/patterns.ts) — the historical rationale below documents this pattern's current shape;
// edit the JSON to change it, not this file.
const { taskCancelVerbs: TASK_CANCEL_VERBS, taskReferenceMarker: TASK_REFERENCE_MARKER, cancelMatchStopwords: CANCEL_MATCH_STOPWORDS } = getTaskCancelPatterns()

// Common words that would spuriously "overlap" with almost any task description if not excluded
// — matchTaskCancelAttempt needs a genuinely distinctive word in common with a task, not just any
// shared word, or "cancel that" / "skip this one" would match the first task in every plan.

// A single shared 4+-letter word is not enough on its own — a genuine, unrelated real-world cancel
// request can coincidentally share a word with an auto-generated task description (e.g. "insurance"
// appears both in a real "cancel my travel insurance policy" request AND a plan's own
// "arrange travel insurance" logistics task). Found via live testing: with an active trip-planning
// plan running, "please cancel my travel insurance policy with my current provider" — a genuine,
// gateable HIGH-risk request the user actually wants acted on — got silently misrouted into
// cancelling the plan's internal logistics_prep bookkeeping task instead, with no approval gate,
// and the real request was never surfaced, gated, or fulfilled at all.
// Requiring the message itself to explicitly reference the PLAN/a TASK/STEP ("cancel that task",
// "skip this step", "drop that part of the plan") — not just any cancel-shaped verb plus a
// coincidentally shared word — keeps this deterministic shortcut scoped to what it was actually
// built for (conv59/conv70's h9: dropping one step of an active plan the user is talking to the
// assistant about), and lets anything else fall through to the ordinary message-level risk gate,
// the same safe default this function already falls back to when no task match is found at all.

/**
 * Detects a request to cancel/skip ONE task within an active plan — distinct from
 * classifyTurnIntent's isAbandonRequest judgment, which is about ending the WHOLE plan (see
 * conv59/conv70's h9 finding: "cancel the daily-budget task" isn't asking to abandon a trip-planning
 * plan entirely, just to drop one of its steps, and there was no feature to route that to at
 * all). Matches a cancel-shaped verb (cancel/skip/drop/remove), an explicit reference to the plan
 * or one of its tasks/steps (TASK_REFERENCE_MARKER), together with a distinctive word (4+ letters,
 * not a common stopword) shared with one of the plan's own not-yet-complete task
 * descriptions/ids — deliberately conservative: a bare "cancel" with no recognizable task
 * reference (e.g. "cancel my gym membership", unrelated to anything in this plan, or "cancel my
 * travel insurance policy with my current provider", a genuine external request that merely
 * happens to share a word with a task description) returns null and falls through to the ordinary
 * message-level risk gate, same as today. Returns the first matching task in plan order, or null.
 */
export function matchTaskCancelAttempt(message: string, plan: PlanRecord): TaskCancelMatch | null {
  if (!testAny(TASK_CANCEL_VERBS, message)) return null
  if (!testAny(TASK_REFERENCE_MARKER, message)) return null
  const lower = message.toLowerCase()
  for (const task of plan.tasks) {
    if (task.status === 'COMPLETE' || task.cancelled) continue
    // tokenize (not a bare `.split(/[^a-z0-9]+/)`) so this works on non-Latin scripts too — that
    // ASCII-only split produced an empty word list for any CJK task description, silently
    // disabling this feature entirely rather than just matching less precisely. The "4+ letters"
    // distinctiveness filter is an English-specific heuristic (a short word is usually a stopword,
    // a longer one usually isn't) that doesn't transfer to CJK, where tokenize splits per
    // character and even a single character is often already distinctive — so that length
    // threshold only applies to non-CJK tokens; a CJK token just needs to not be a stopword.
    const words = tokenize(`${task.id} ${task.description}`.toLowerCase()).filter(
      (w) => !CANCEL_MATCH_STOPWORDS.has(w) && (containsCJK(w) || w.length >= 4),
    )
    if (words.some((w) => lower.includes(w))) {
      return { taskId: task.id, taskDescription: task.description }
    }
  }
  return null
}

/**
 * Cancels one task within an active plan — internal bookkeeping only (see PlanTaskRecord.cancelled
 * for why status becomes 'COMPLETE' alongside the cancelled flag). Unlike abandonPlan, the plan
 * itself stays 'active' so the remaining tasks continue normally.
 */
export async function cancelPlanTask(memory: MemoryAdapter, sessionId: string, plan: PlanRecord, taskId: string, fsPersistence?: PlanFsPersistence): Promise<PlanRecord> {
  const tasks = plan.tasks.map((t): PlanTaskRecord => (t.id === taskId ? { ...t, status: 'COMPLETE', cancelled: true } : t))
  const updated: PlanRecord = { ...plan, tasks, updatedAt: new Date().toISOString() }
  await savePlan(memory, sessionId, updated, fsPersistence)
  return updated
}

/**
 * Changes one task's description without marking it complete — a lighter sibling of
 * cancelPlanTask, for plan mode's P2 approve-with-edits path (a user can want a task reworded
 * without dropping it entirely, which cancelPlanTask's "mark COMPLETE + cancelled" would do).
 */
export async function editPlanTask(memory: MemoryAdapter, sessionId: string, plan: PlanRecord, taskId: string, newDescription: string, fsPersistence?: PlanFsPersistence): Promise<PlanRecord> {
  const tasks = plan.tasks.map((t): PlanTaskRecord => (t.id === taskId ? { ...t, description: newDescription } : t))
  const updated: PlanRecord = { ...plan, tasks, updatedAt: new Date().toISOString() }
  await savePlan(memory, sessionId, updated, fsPersistence)
  return updated
}

/**
 * Maps the harness's resulting task statuses back onto the plan's own task list —
 * mirrors what adapter/harness/plan_store.py's task_graph_to_plan does for the
 * Python planner, just keyed to a chat session instead of a snapshot file. Marks
 * the plan 'done' once every task is COMPLETE, so loadActivePlan stops resuming it.
 * Also flips `executingOnPlan` back to false in that same allComplete branch (plan
 * mode's P4, INV-32) — one of exactly two places that happens, the other being
 * `abandonPlan`'s explicit user-abort path; every other event (a task failing, a
 * needs_approval/needs_clarification interrupt, a harness error) leaves it untouched.
 */
export function updatePlanFromRun(plan: PlanRecord, taskGraphTasks: { id: string; status: TaskStatus }[]): PlanRecord {
  const statusById = new Map(taskGraphTasks.map((t) => [t.id, normalizeRestingStatus(t.status)]))
  const tasks = plan.tasks.map((t): PlanTaskRecord => ({ ...t, status: statusById.get(t.id) ?? t.status }))
  const allComplete = tasks.length > 0 && tasks.every((t) => t.status === 'COMPLETE')
  return {
    ...plan,
    tasks,
    mode: allComplete ? 'done' : plan.mode,
    executingOnPlan: allComplete ? false : plan.executingOnPlan,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * RUNNING is a mid-run status only. A task the harness didn't finish before this
 * turn's run() returned (e.g. the step cap was hit mid-task) is not "in progress"
 * across turns — it just needs a fresh attempt next time. Persisting RUNNING as-is
 * would strand it forever: TaskGraph.selectUnblockedLeaf only reselects PENDING
 * tasks, and a dependent only unblocks once its dependency is COMPLETE.
 */
function normalizeRestingStatus(status: TaskStatus): TaskStatus {
  return status === 'RUNNING' ? 'PENDING' : status
}

/** Cancelled tasks are excluded from both sides of the ratio — they're neither remaining work nor
 * something the user actually did, so counting them as "complete" would overstate real progress.
 * A plan with no tasks at all is 0% (unchanged); a plan whose remaining tasks were all cancelled
 * is 100% (nothing left to do) — two different situations, not the same "empty" case. */
export function planCompletionPct(plan: PlanRecord): number {
  if (plan.tasks.length === 0) return 0
  const relevant = plan.tasks.filter((t) => !t.cancelled)
  if (relevant.length === 0) return 100
  return (relevant.filter((t) => t.status === 'COMPLETE').length / relevant.length) * 100
}

/**
 * Live, mid-run position within a durable plan — see the harness layer activation plan's
 * Phase 3.2. `stepIndex` is 1-based: the task currently RUNNING, or (once nothing is running)
 * the last COMPLETE task, or the first task before anything has started.
 */
export interface PlanPosition {
  templateName: string | null
  stepIndex: number
  stepCount: number
  currentTaskDescription: string
  completionPct: number
}

/** Computes live plan position from a live (possibly mid-run) task-status list — `plan.tasks`' own order is authoritative; `taskGraphTasks` only supplies current status per id. */
export function computePlanPosition(plan: PlanRecord, taskGraphTasks: { id: string; status: TaskStatus }[]): PlanPosition | null {
  if (plan.tasks.length === 0) return null
  const statusById = new Map(taskGraphTasks.map((t) => [t.id, t.status]))

  let idx = plan.tasks.findIndex((t) => statusById.get(t.id) === 'RUNNING')
  if (idx === -1) {
    for (let i = plan.tasks.length - 1; i >= 0; i--) {
      if (statusById.get(plan.tasks[i].id) === 'COMPLETE') { idx = i; break }
    }
  }
  if (idx === -1) idx = 0

  const completedCount = plan.tasks.filter((t) => statusById.get(t.id) === 'COMPLETE').length
  return {
    templateName: plan.templateName,
    stepIndex: idx + 1,
    stepCount: plan.tasks.length,
    currentTaskDescription: plan.tasks[idx].description,
    completionPct: (completedCount / plan.tasks.length) * 100,
  }
}

/** The next not-yet-COMPLETE task in plan order — used to phrase a pause/resume prompt ("Ready to continue with: <description>?"). Returns null once every task is COMPLETE. */
export function nextPendingTask(plan: PlanRecord): PlanTaskRecord | null {
  return plan.tasks.find((t) => t.status !== 'COMPLETE') ?? null
}

const STATUS_ICON: Record<TaskStatus, string> = {
  PENDING: '○',
  RUNNING: '▶',
  COMPLETE: '✓',
  FAILED: '✗',
  BLOCKED: '✗',
  HUMAN_REQUIRED: '~',
}

/** Human-readable plan status — mirrors agents/planner/utils.py's format_plan_progress, for callers (the CLI) that want text instead of the structured planStatus field. */
export function formatPlanProgress(plan: PlanRecord): string {
  const lines = [
    `Plan: ${plan.templateName} (${planCompletionPct(plan).toFixed(1)}% complete)`,
    '',
    'Task statuses:',
    ...plan.tasks.map((t) => `  ${t.cancelled ? '⊘' : STATUS_ICON[t.status]} [${t.cancelled ? 'CANCELLED' : t.status}] ${t.id} — ${t.description}`),
    '',
    `Success criteria: ${plan.successCriteria}`,
  ]
  return lines.join('\n')
}
