/**
 * Phase 4 of plans/harness_and_assistant_architecture_remediation_plan.html: a named,
 * typed replacement for the three implicit bypass branches runTurn() used to make on its
 * own, ad hoc, with no shared vocabulary between them:
 *   - classification.isTrivial          → skip the harness run entirely (assistant.ts:1487-1495)
 *   - the plan-cancel bypass            → skip classifyTurnIntent entirely (assistant.ts:1341-1370)
 *   - the batch-confirmation resume     → skip the per-turn HarnessRuntime run entirely (assistant.ts:2467-2487)
 * Each of those is a real, distinct guarantee-level a turn can run at — README's "every ordinary
 * message walks the full 11-layer harness" claim is only true for two of the five modes below, and
 * classifyExecutionMode() makes that precise instead of leaving it to be inferred from call-site
 * reading order.
 */
export type ExecutionMode = 'FAST' | 'TOOL' | 'PLAN' | 'CONSEQUENTIAL' | 'RESEARCH'

/**
 * Per-mode guarantee documentation — what a caller can and can't rely on for a turn classified
 * into each mode. Kept next to the type (not just in this file's header comment) so a reader
 * inspecting one mode's behavior sees its contract without having to scroll up.
 *
 *  - FAST:          Trivial, self-contained factual turns (turn-intent-classifier.ts's isTrivial
 *                    contract). No HarnessRuntime run at all this turn — no verification, no
 *                    control-state, no reviewer pass, no checkpoint. Fastest path, weakest
 *                    guarantees; safe only because isTrivial is deliberately conservative.
 *  - PLAN:          A durable-plan bookkeeping turn (cancel/abandon a task) that never leaves this
 *                    session's own plan-store state — no external effect, so no harness run and no
 *                    tool loop either.
 *  - RESEARCH:      The batch-research path (an explicit N-item list). Runs its own self-calibrating
 *                    per-item tool-call budget (see budget.ts / BATCH_* constants) instead of the
 *                    harness's task graph; a confirmed-large batch pauses for approval before
 *                    spending it. No per-turn HarnessRuntime run backs this mode's own tool calls
 *                    (though a resumed confirmation still skips it too, matching the direct path).
 *  - TOOL:          An ordinary tool-using turn with no approval gate tripped. Walks the full
 *                    HarnessRuntime run (world model, hypothesis, contradiction, control state,
 *                    verification, recovery, reviewer pass) over the tool loop's already-produced
 *                    reply — today's real guarantee level, still post-hoc bookkeeping rather than
 *                    an in-loop control plane (see ToolPolicy for where deterministic, harness-
 *                    state-informed gating is actually enforced).
 *  - CONSEQUENTIAL: classification.requiresApproval was set, or the turn's tool calls include a
 *                    write_file/run_shell_command (always staged, independent of risk
 *                    classification — see ToolPolicy). Never executes without an explicit
 *                    approve-by-ID round trip; the harness run (when one applies) still runs on
 *                    top for bookkeeping, but ToolPolicy — not classification.riskLevel — is the
 *                    actual authoritative decision for whether this turn's action proceeds.
 */
export const EXECUTION_MODE_GUARANTEES: Record<ExecutionMode, string> = {
  FAST: 'no HarnessRuntime run this turn — no verification, control state, or reviewer pass',
  PLAN: 'session-local plan bookkeeping only — no external effect, no harness run, no tool loop',
  RESEARCH: 'self-calibrating batch tool-call budget, not the harness task graph — no per-turn HarnessRuntime run',
  TOOL: 'full HarnessRuntime run as post-hoc bookkeeping over an already-produced reply',
  CONSEQUENTIAL: 'ToolPolicy is the authoritative gate — never executes without an approve-by-ID round trip',
}

export interface ExecutionModeInput {
  /** True when the plan-cancel bypass (matchTaskCancelAttempt) short-circuited before
   * classifyTurnIntent ever ran this turn. */
  isPlanCancelBypass: boolean
  /** True when this turn is resolving a batch-research confirmation pause
   * (resolvePendingBatchConfirmation) or is about to enter the batch-research path
   * (runBatchToolLoop) fresh. */
  isBatchResearch: boolean
  /** turn-intent-classifier.ts's own isTrivial verdict — only meaningful once classification has
   * actually run (never true when isPlanCancelBypass/isBatchResearch already short-circuited). */
  isTrivial: boolean
  /** turn-intent-classifier.ts's own requiresApproval verdict, OR a write_file/run_shell_command
   * tool call was proposed this turn (file-tools.ts's unconditional per-call staging gate) — see
   * ToolPolicy for the deterministic version of this same decision. */
  requiresApproval: boolean
}

/**
 * Pure classification — no I/O, no LLM call. Order matters: earlier bypasses in runTurn's own
 * control flow take precedence over classification fields that were never computed for that path
 * (e.g. isTrivial is meaningless once isPlanCancelBypass already fired), mirroring the exact
 * precedence runTurn's own if/else chain already encodes today.
 */
export function classifyExecutionMode(input: ExecutionModeInput): ExecutionMode {
  if (input.isPlanCancelBypass) return 'PLAN'
  if (input.isBatchResearch) return 'RESEARCH'
  if (input.requiresApproval) return 'CONSEQUENTIAL'
  if (input.isTrivial) return 'FAST'
  return 'TOOL'
}
