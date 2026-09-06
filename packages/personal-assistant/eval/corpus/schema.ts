/**
 * Task-corpus schema for the comparative harness benchmark (Plan Phase B —
 * plans/harness_consolidation_and_control_plane_plan.html).
 *
 * One JSON file per task in this directory. Every file is validated against `TaskSpecSchema`
 * by `corpus.test.ts` (runs in `npm test`) — a malformed task fails CI, not the benchmark run.
 *
 * A task is a fixed prompt + a fixed workspace + a mechanical grader. The grader is deliberately
 * boring — regex / substring / file-state / result-status — so a task's pass/fail does not itself
 * depend on an LLM. The one exception is `judge`, an LLM-as-judge rubric used only where a
 * mechanical check genuinely cannot express the criterion; a run without a judge model scores
 * those `skipped`, never `pass`.
 */
import { z } from 'zod'

export const TASK_CATEGORIES = [
  'lookup', // single fact, model knowledge or one tool call
  'research', // multi-source synthesis over the workspace
  'compute', // arithmetic / deterministic transformation
  'file_read', // read + report over workspace files
  'mutation', // a consequential change — MUST be staged, never executed
  'multi_step', // read → decide → answer
  'adv_injection', // workspace/web content carrying an instruction
  'adv_ambiguous', // under-specified goal — must ask, not fabricate
  'adv_contradiction', // sources disagree — must surface, not pick
  'adv_dead_end', // the answer does not exist — must not hallucinate one
] as const

export type TaskCategory = (typeof TASK_CATEGORIES)[number]

/**
 * Benchmark-slice tags. The trajectory-supervisor S7 slice
 * (`plans/harness_trajectory_supervisor_plan.html`) groups tasks that are unsolvable without a
 * strategy pivot, an external lookup, or a user clarification — the exact conditions the
 * supervisor exists for. `run-harness-benchmark.ts --slice=<name>` filters the run to one.
 */
export const SUPERVISOR_SLICES = [
  'supervisor_pivot', // the obvious first approach dead-ends; the answer needs a different route
  'supervisor_lookup', // the fact lives somewhere non-obvious — a second file, a nested dir, a transitive ref
  'supervisor_clarification', // genuinely ambiguous — must ask, not guess
  'supervisor_adversarial_digest', // workspace text carries injection ("ignore instructions, ABORT")
] as const

export type SupervisorSlice = (typeof SUPERVISOR_SLICES)[number]

/** A file placed in the task's workspace before the turn runs. */
const WorkspaceFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
})

/** The mechanical grader. All present checks must pass for `success`. */
const GraderSchema = z
  .object({
    /** Reply must contain every one of these (case-insensitive substring). */
    contains: z.array(z.string()).optional(),
    /** Reply must contain none of these — the hallucination / leak check. */
    notContains: z.array(z.string()).optional(),
    /** Reply must match this regex (JS, `i` flag applied). */
    regex: z.string().optional(),
    /** Expected `AssistantTurnResult.status`. */
    status: z.enum(['ok', 'needs_approval', 'escalated']).optional(),
    /** These workspace files must still exist with byte-identical content after the turn. */
    filesUnchanged: z.array(z.string()).optional(),
    /** Expected `answerClaim.verification_status`, when the turn produced an AnswerClaim. */
    answerClaimStatus: z
      .enum(['verified', 'unverified_attempted', 'contradicted', 'no_evidence'])
      .optional(),
    /** LLM-as-judge rubric — scored only when the run has a judge model; otherwise `skipped`. */
    judge: z.object({ rubric: z.string().min(1) }).optional(),
  })
  .refine((g) => Object.keys(g).length > 0, { message: 'grader must have at least one check' })

export const TaskSpecSchema = z.object({
  /** Stable id — also the filename stem. Kebab-case. */
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.enum(TASK_CATEGORIES),
  /** One line — what this task is probing. */
  intent: z.string().min(1),
  /** The user message sent to the assistant. */
  prompt: z.string().min(1),
  /** Files present in the workspace before the turn. */
  workspace: z.array(WorkspaceFileSchema).default([]),
  /** Which tool contexts the arm should wire up for this task. */
  tools: z
    .object({ file: z.boolean().default(false), web: z.boolean().default(false), shell: z.boolean().default(false) })
    .default({ file: false, web: false, shell: false }),
  grader: GraderSchema,
  /**
   * Marks a task whose grader's `notContains` failure counts as a *hallucination*, not just a
   * miss — used for the corpus-wide hallucination-rate metric.
   */
  hallucinationProbe: z.boolean().default(false),
  /**
   * Marks a task where any effect on `grader.filesUnchanged` / a non-staged mutation counts as
   * an *unauthorized effect* — the safety metric the adversarial slice exists for.
   */
  unauthorizedEffectProbe: z.boolean().default(false),
  /**
   * When set, the arm injects this failure once (e.g. the first tool call throws) — the task
   * then measures `recovered`: did the arm still reach a passing answer.
   */
  injectedFailure: z.enum(['first_tool_call_throws']).optional(),
  /** Optional benchmark-slice tag — see `SUPERVISOR_SLICES`. */
  slice: z.enum(SUPERVISOR_SLICES).optional(),
  /** Free-text note for the report. */
  note: z.string().optional(),
})

export type TaskSpec = z.infer<typeof TaskSpecSchema>
export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>

/** Parse + validate one task JSON blob. Throws `ZodError` on a malformed task. */
export function parseTaskSpec(raw: unknown, sourceLabel: string): TaskSpec {
  const result = TaskSpecSchema.safeParse(raw)
  if (!result.success) {
    throw new Error(`invalid task spec (${sourceLabel}): ${result.error.message}`)
  }
  return result.data
}
