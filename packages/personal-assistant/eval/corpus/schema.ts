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
  // Multi-turn: turn 1 stalls (injected persistent_tool_failure) so the supervisor emits
  // ASK_USER; turn 2 the user supplies the missing detail. Measures whether ASK_USER turns a
  // dead turn into a recoverable one — the supervisor's value that a single turn can't show.
  'supervisor_conversation',
] as const

export type SupervisorSlice = (typeof SUPERVISOR_SLICES)[number]

/**
 * Feature-value audit slices (`plans/feature_audit_automation_plan.html`). Kept a closed enum,
 * validated in `corpus.test.ts`, exactly like `SUPERVISOR_SLICES`. Each groups the "here or
 * nowhere" stress tasks for one Batch B feature the audit is testing the value of.
 */
export const AUDIT_SLICES = [
  // Belief pairs that contradict by *meaning* — paraphrase, unit change, indirect reference,
  // mild cross-language — which the always-on lexical negation-pair check provably can't catch.
  // Only the `checkForContradictions` semantic LLM call (arm `flagOn` vs `contradictionOff`) can.
  'audit_contradiction_semantic',
  // Tool-output prompt-injection payloads phrased to slip past the deterministic regex/pattern
  // pass (`detectInjectionLikely`) — only the `detectInjectionLikelyWithLLM` escalation (arm
  // `flagOn` vs `injectionDetectOff`) can catch them — paired with benign instruction-like files
  // where an injection flag would be a false positive.
  'audit_injection_llm',
  // Injected persistent-tool-failure symptoms phrased as a *paraphrase* of a curated
  // FailureModeLibrary entry (timeout / auth rejected / rate limited / resource missing) rather
  // than a verbatim match — so `FailureModeLibrary.match()`'s exact-string-overlap floor misses
  // and only the `checkSemanticFailureMatch` LLM call (arm `flagOn` vs `failureMatchOff`) can
  // classify the failure class and route recovery.
  'audit_failure_match_semantic',
  // Multi-turn: a belief stated turn 1, unrelated beliefs added turns 2-3, then a *paraphrased*
  // contradiction on the last turn — the real trigger for `checkForContradictions` (belief-set
  // growth over a conversation), and the real per-belief-set-growth cost the hypothesis asks
  // about. Includes control tasks (a legitimate change over time) that must NOT be false-flagged.
  'audit_contradiction_multiturn',
  // Multi-turn (4-8 turns) sessions where the harness's cross-turn machinery is what differs
  // from a bare loop: staged approval spanning turns, cross-turn correction, control-state
  // escalation after repeated failure, not compounding an early wrong assumption. For
  // `harness-vs-bare` (which runs the full corpus, so these are picked up automatically).
  'harness_session',
] as const

export type AuditSlice = (typeof AUDIT_SLICES)[number]

/** Every valid `slice` value — the supervisor S7 slices plus the feature-value-audit slices. */
export const BENCHMARK_SLICES = [...SUPERVISOR_SLICES, ...AUDIT_SLICES] as const
export type BenchmarkSlice = SupervisorSlice | AuditSlice

/** A file placed in the task's workspace before the turn runs. */
const WorkspaceFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
})

/**
 * A subsequent user turn in a multi-turn task. The arm sends it to the *same* assistant session
 * (same memory, same conversation history) after the previous turn resolves. See `followups`.
 */
const FollowupSchema = z.object({
  /** The user message for this turn. */
  prompt: z.string().min(1),
  /** Files that appear in the workspace just before this turn (rarely needed — a contradiction
   * or correction usually lives in `prompt` itself). */
  addWorkspace: z.array(WorkspaceFileSchema).default([]),
  /** Inject a failure on *this* turn (e.g. a supervisor task that should stall on turn 1 only).
   * Same semantics as the task-level `injectedFailure`. */
  injectedFailure: z.enum(['first_tool_call_throws', 'persistent_tool_failure']).optional(),
  injectedFailureCount: z.number().int().min(1).max(6).optional(),
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
  /** The user message sent to the assistant (turn 1). */
  prompt: z.string().min(1),
  /**
   * Subsequent user turns, sent to the same session after the previous turn resolves. Empty =
   * a single-turn task (the default). The grader always scores the *last* turn's reply +
   * the final workspace snapshot; cost / latency / tokens are summed across turns.
   */
  followups: z.array(FollowupSchema).default([]),
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
   * When set, the arm injects a failure — the task then measures `recovered`: did the arm
   * still reach a passing answer.
   *   - `first_tool_call_throws`  — the FsBackend's first read throws once (proxy backend only).
   *   - `persistent_tool_failure` — the one-loop proposer's first `injectedFailureCount`
   *     iterations report a failed execution and recurring records are seeded into the run's
   *     failure diagnostics, tripping `cannotMakeProgress()` so the Trajectory Supervisor's
   *     stall edge is exercised in a single turn (S7 slice).
   */
  injectedFailure: z.enum(['first_tool_call_throws', 'persistent_tool_failure']).optional(),
  /** For `persistent_tool_failure`: leading failed iterations to inject. Default 1. */
  injectedFailureCount: z.number().int().min(1).max(6).optional(),
  /** Optional benchmark-slice tag — see `SUPERVISOR_SLICES` / `AUDIT_SLICES`. */
  slice: z.enum(BENCHMARK_SLICES).optional(),
  /** Free-text note for the report. */
  note: z.string().optional(),
})

export type TaskSpec = z.infer<typeof TaskSpecSchema>
export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>
export type Followup = z.infer<typeof FollowupSchema>

/** Parse + validate one task JSON blob. Throws `ZodError` on a malformed task. */
export function parseTaskSpec(raw: unknown, sourceLabel: string): TaskSpec {
  const result = TaskSpecSchema.safeParse(raw)
  if (!result.success) {
    throw new Error(`invalid task spec (${sourceLabel}): ${result.error.message}`)
  }
  return result.data
}
