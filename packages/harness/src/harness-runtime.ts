import { type ExperienceStore, UnavailableExperienceStore } from './state/experience-store.js'
import { gatherEvidence } from './nodes/gather-evidence.js'
import { applyToolReliability } from './nodes/apply-tool-reliability.js'
import { resolveControlState, CAUTION_THRESHOLD } from './nodes/resolve-control-state.js'
import { updateDiagnostics } from './nodes/update-diagnostics.js'
import { detectContradictions } from './nodes/detect-contradictions.js'
import { generateUpdateHypotheses } from './nodes/generate-update-hypotheses.js'
import { updateWorldModel, propagateBeliefs } from './nodes/update-world-model.js'
import { updateTaskGraph } from './nodes/update-task-graph.js'
import { selectTask, reconcileParallelBranches } from './nodes/select-task.js'
import { estimateRisk, type RiskableAction } from './nodes/estimate-risk.js'
import { estimateVOI } from './nodes/estimate-voi.js'
import { reviewProposedChange } from './nodes/review-proposed-change.js'
import { actionGate, postExecGate } from './nodes/policy-gates.js'
import { execute, type ProposedExecutionChange } from './nodes/execute.js'
import { verify } from './nodes/verify.js'
import { rollbackAndReplan, cannotMakeProgress } from './nodes/rollback-replan.js'
import { escalateBudgetExhausted, EscalationHalt } from './nodes/escalate.js'
import { checkCallerUpdates, NoOpUpdateChannel, type UpdateChannel, RESTART_ITERATION } from './nodes/check-caller-updates.js'
import { contextCompression } from './nodes/context-compression.js'
import { warmStart } from './nodes/warm-start.js'
import { reviewerPass, type PropagationQueue } from './nodes/reviewer-pass.js'
import { outputValidation, type OutputValidationResult } from './nodes/output-validation.js'
import { initializeHarness, type HarnessInitOptions, type HarnessInitResult } from './nodes/initialize.js'
import { HarnessRunState } from './harness-run-state.js'
import { DepGraphBudget, WorldModel } from './state/world-model.js'
import type { HarnessCheckpoint, HarnessRunConfigData, HarnessRunProgressData } from './harness-checkpoint.js'

export const BUDGET_WARNING_FLOOR = 0.5

/**
 * One shared per-turn complexity signal, computed once by the caller (see
 * personal-assistant's assistant.ts) from data it already has — the risk classifier's
 * verdict, how many tasks this turn's graph has, whether a durable cross-turn plan is
 * driving it, and which tool kinds this turn's tasks touch. Read by the Phase 2 per-layer
 * trigger conditions instead of each layer inventing its own gating heuristic (see
 * plans/harness_layer_activation_plan.html, Design Principle 2). `consequentialTools`
 * is a bare string set (not a closed union) so the generic runtime never hardcodes any one
 * caller's tool names — well-known values in personal-assistant are 'read_file',
 * 'list_directory', 'web_search', 'fetch_url', 'write_file', 'run_shell_command'.
 */
export interface TurnComplexitySignal {
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'
  taskCount: number
  hasDurablePlan: boolean
  consequentialTools: Set<string>
}

/** Emitted once per layer per main-loop iteration — see HarnessRunOptions.onLayerActivity. */
export interface LayerActivityEvent {
  layer:
    | 'world_model' | 'evidence_reasoning' | 'hypothesis' | 'contradiction'
    | 'diagnostics' | 'control_state' | 'planning' | 'execution'
    | 'verification' | 'recovery' | 'reviewer_pass'
  fired: boolean
  reason: string
}

export interface HarnessRunOptions extends HarnessInitOptions {
  /** Identifies this run for checkpointing. Auto-generated if omitted. */
  runId?: string
  experienceStore?: ExperienceStore
  updateChannel?: UpdateChannel
  toolExecutors?: Record<string, () => unknown>
  /** Called after every checkpointable main-loop iteration. Persist the checkpoint here to support resume(). */
  onCheckpoint?: (checkpoint: HarnessCheckpoint) => void | Promise<void>
  /** Return true to stop the run at the next checkpoint instead of running to completion. */
  shouldPause?: (checkpoint: HarnessCheckpoint) => boolean
  /**
   * Optional hook: given the run's objective, return durable facts a caller has already
   * extracted from it. Called once per successfully executed task; each returned fact is
   * written into the world model as an INFERENCE belief (see updateWorldModel), giving World
   * Model/Contradiction/Reviewer real content instead of the observation-only default. The
   * harness itself has no fact-extraction logic of its own — this stays a caller-supplied hook
   * so the generic runtime never depends on any one caller's extraction heuristic.
   */
  factExtractor?: (objective: string) => Array<{ statement: string }>
  /** See TurnComplexitySignal — absent means every Phase 2 gate reads its own conservative default. */
  complexitySignal?: TurnComplexitySignal
  /** Fired or skipped, every one of the 11 harness layers reports itself here each iteration — see LayerActivityEvent. */
  onLayerActivity?: (event: LayerActivityEvent) => void
  /**
   * Per-task rollback hook, keyed like toolExecutors (falls back to 'default'). Called from
   * rollbackAndReplan when a task fails verification/execution — a real rollback action
   * (e.g. restoring a `memoryState.rollback_points` snapshot) instead of the no-op the harness
   * ran before (Phase 2, layer 10 of the harness layer activation plan).
   */
  rollbackExecutors?: Record<string, () => void>
}

export interface HarnessRunResult {
  finalResult: unknown
  outputValidation: OutputValidationResult | null
  stepsUsed: number
  initResult: HarnessInitResult
  nodeExecutionOrder: string[]
}

export type HarnessRunOutcome =
  | { status: 'complete'; result: HarnessRunResult }
  | { status: 'paused'; checkpoint: HarnessCheckpoint }

/** Renders a task's execution output as a short, evidence-obs-sized string — never throws on cyclic/BigInt content. */
function summariseExecutionOutput(output: unknown): string {
  if (typeof output === 'string') return output.slice(0, 200)
  try {
    return JSON.stringify(output)?.slice(0, 200) ?? String(output)
  } catch {
    return String(output)
  }
}

function generateRunId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID) return g.crypto.randomUUID()
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** All mutable state threaded through the main loop — the live counterpart of HarnessCheckpoint. */
interface LoopContext {
  runId: string
  objective: string
  successCriteria: string[]
  maxSteps: number
  depGraphBudget: DepGraphBudget
  processConceptId: string | null

  worldModel: HarnessInitResult['worldModel']
  callerState: HarnessInitResult['callerState']
  controlState: HarnessInitResult['controlState']
  taskGraph: HarnessInitResult['taskGraph']
  diagnostics: HarnessInitResult['diagnostics']
  hypothesisSet: HarnessInitResult['hypothesisSet']
  evidenceStore: HarnessInitResult['evidenceStore']
  memoryState: HarnessInitResult['memoryState']
  strategyState: HarnessInitResult['strategyState']
  failureDiagnostics: HarnessInitResult['failureDiagnostics']
  outputContract: HarnessInitResult['outputContract']
  beliefDepGraph: HarnessInitResult['beliefDepGraph']

  stepsUsed: number
  nodeExecutionOrder: string[]
  finalResult: unknown
  consecutiveReviewFailures: Map<string, number>
  propagationQueue: PropagationQueue

  experienceStore: ExperienceStore
  updateChannel: UpdateChannel
  toolExecutors: Record<string, () => unknown>
  factExtractor?: (objective: string) => Array<{ statement: string }>
  complexitySignal?: TurnComplexitySignal
  onLayerActivity?: (event: LayerActivityEvent) => void
  rollbackExecutors?: Record<string, () => void>
}

function buildInitialContext(
  objective: string,
  successCriteria: string[],
  options: HarnessRunOptions,
  runId: string,
): LoopContext {
  const initResult = initializeHarness(objective, { ...options, successCriteria })
  if (!initResult.valid) {
    throw new Error(`HarnessRuntime: init failed — ${initResult.errors.join('; ')}`)
  }

  const experienceStore = options.experienceStore ?? new UnavailableExperienceStore()
  const ctx: LoopContext = {
    runId,
    objective,
    successCriteria,
    maxSteps: initResult.maxSteps,
    depGraphBudget: initResult.depGraphBudget,
    processConceptId: initResult.processConceptId,

    worldModel: initResult.worldModel,
    callerState: initResult.callerState,
    controlState: initResult.controlState,
    taskGraph: initResult.taskGraph,
    diagnostics: initResult.diagnostics,
    hypothesisSet: initResult.hypothesisSet,
    evidenceStore: initResult.evidenceStore,
    memoryState: initResult.memoryState,
    strategyState: initResult.strategyState,
    failureDiagnostics: initResult.failureDiagnostics,
    outputContract: initResult.outputContract,
    beliefDepGraph: initResult.beliefDepGraph,

    stepsUsed: 0,
    nodeExecutionOrder: [],
    finalResult: null,
    consecutiveReviewFailures: new Map(),
    propagationQueue: { reopenedTaskIds: [] },

    experienceStore,
    updateChannel: options.updateChannel ?? new NoOpUpdateChannel(),
    toolExecutors: options.toolExecutors ?? {},
    factExtractor: options.factExtractor,
    complexitySignal: options.complexitySignal,
    onLayerActivity: options.onLayerActivity,
    rollbackExecutors: options.rollbackExecutors,
  }

  // Warm start from ExperienceStore (no-op if unavailable) — only on a fresh run.
  warmStart(experienceStore, ctx.strategyState, ctx.failureDiagnostics, ctx.depGraphBudget, ctx.taskGraph)

  return ctx
}

function buildResumedContext(checkpoint: HarnessCheckpoint, options: HarnessRunOptions): LoopContext {
  const hydrated = HarnessRunState.fromJSON(checkpoint.runState)

  return {
    runId: checkpoint.runId,
    objective: checkpoint.runConfig.objective,
    successCriteria: checkpoint.runConfig.successCriteria,
    maxSteps: checkpoint.runConfig.maxSteps,
    depGraphBudget: DepGraphBudget.fromJSON(checkpoint.runConfig.depGraphBudget),
    processConceptId: checkpoint.runConfig.processConceptId,

    worldModel: hydrated.worldModel,
    callerState: hydrated.callerState,
    controlState: hydrated.controlState,
    taskGraph: hydrated.taskGraph,
    diagnostics: hydrated.diagnostics,
    hypothesisSet: hydrated.hypothesisSet,
    evidenceStore: hydrated.evidenceStore,
    memoryState: hydrated.memoryState,
    strategyState: hydrated.strategyState,
    failureDiagnostics: hydrated.failureDiagnostics,
    outputContract: hydrated.outputContract,
    beliefDepGraph: hydrated.beliefDepGraph,

    stepsUsed: checkpoint.progress.stepsUsed,
    nodeExecutionOrder: [...checkpoint.progress.nodeExecutionOrder],
    finalResult: checkpoint.progress.finalResult,
    consecutiveReviewFailures: new Map(checkpoint.progress.consecutiveReviewFailures),
    propagationQueue: { reopenedTaskIds: [...checkpoint.progress.propagationQueue.reopenedTaskIds] },

    // Live objects are never serialized — the caller re-attaches them on resume,
    // same as Python's state_store expecting a fresh db_session_factory after load.
    experienceStore: options.experienceStore ?? new UnavailableExperienceStore(),
    updateChannel: options.updateChannel ?? new NoOpUpdateChannel(),
    toolExecutors: options.toolExecutors ?? {},
    factExtractor: options.factExtractor,
    complexitySignal: options.complexitySignal,
    onLayerActivity: options.onLayerActivity,
    rollbackExecutors: options.rollbackExecutors,
  }
}

function toCheckpoint(ctx: LoopContext): HarnessCheckpoint {
  const runState = new HarnessRunState({
    worldModel: ctx.worldModel,
    callerState: ctx.callerState,
    controlState: ctx.controlState,
    diagnostics: ctx.diagnostics,
    taskGraph: ctx.taskGraph,
    outputContract: ctx.outputContract,
    evidenceStore: ctx.evidenceStore,
    hypothesisSet: ctx.hypothesisSet,
    memoryState: ctx.memoryState,
    strategyState: ctx.strategyState,
    failureDiagnostics: ctx.failureDiagnostics,
    experienceStore: ctx.experienceStore,
    beliefDepGraph: ctx.beliefDepGraph,
  }).toJSON()

  const runConfig: HarnessRunConfigData = {
    objective: ctx.objective,
    successCriteria: ctx.successCriteria,
    maxSteps: ctx.maxSteps,
    depGraphBudget: ctx.depGraphBudget.toJSON(),
    processConceptId: ctx.processConceptId,
  }

  const progress: HarnessRunProgressData = {
    stepsUsed: ctx.stepsUsed,
    nodeExecutionOrder: [...ctx.nodeExecutionOrder],
    finalResult: ctx.finalResult,
    consecutiveReviewFailures: [...ctx.consecutiveReviewFailures.entries()],
    propagationQueue: { reopenedTaskIds: [...ctx.propagationQueue.reopenedTaskIds] },
  }

  return { runId: ctx.runId, runState, runConfig, progress }
}

function toInitResultShape(ctx: LoopContext): HarnessInitResult {
  return {
    worldModel: ctx.worldModel,
    callerState: ctx.callerState,
    controlState: ctx.controlState,
    taskGraph: ctx.taskGraph,
    diagnostics: ctx.diagnostics,
    hypothesisSet: ctx.hypothesisSet,
    evidenceStore: ctx.evidenceStore,
    memoryState: ctx.memoryState,
    strategyState: ctx.strategyState,
    failureDiagnostics: ctx.failureDiagnostics,
    outputContract: ctx.outputContract,
    beliefDepGraph: ctx.beliefDepGraph,
    depGraphBudget: ctx.depGraphBudget,
    maxSteps: ctx.maxSteps,
    decompositionGate: ctx.controlState.risk_state !== 'BLOCKED',
    valid: true,
    errors: [],
    processConceptId: ctx.processConceptId,
  }
}

function reportLayer(ctx: LoopContext, layer: LayerActivityEvent['layer'], fired: boolean, reason: string): void {
  ctx.onLayerActivity?.({ layer, fired, reason })
}

/** True once any belief/coverage/verification sub-dimension has crossed CAUTION_THRESHOLD (0.4) — mirrors resolveControlState's own Tier 3 read of these fields. */
function anyDiagnosticSubDimensionCautious(diagnostics: LoopContext['diagnostics']): boolean {
  const healthy = [
    diagnostics.belief_health.freshness, diagnostics.belief_health.consistency, diagnostics.belief_health.support,
    diagnostics.coverage_health.symptom_coverage, diagnostics.coverage_health.explanation_coverage,
    diagnostics.verification_health.strength, diagnostics.verification_health.feasibility,
    diagnostics.execution_health.progress_rate,
  ]
  const inverted = [diagnostics.execution_health.failure_recurrence, diagnostics.execution_health.oscillation_score]
  return healthy.some(v => v < CAUTION_THRESHOLD) || inverted.some(v => v > 1 - CAUTION_THRESHOLD)
}

function resolveAndStamp(ctx: LoopContext): void {
  const newCS = resolveControlState(ctx.diagnostics, ctx.worldModel, ctx.failureDiagnostics)
  ctx.controlState.generation_id = newCS.generation_id
  ctx.controlState.risk_state = newCS.risk_state
  ctx.controlState.escalation_reason = newCS.escalation_reason
  ctx.controlState.block_mask = [...newCS.block_mask]
  ctx.controlState.notes = [...newCS.notes]
}

/**
 * One full pass of the harness main loop, expressed as an async generator so a
 * caller can suspend between iterations. Yields a checkpoint after every
 * iteration that reaches the bottom of the loop body (an iteration that takes
 * an early `continue` — e.g. RESTART_ITERATION — made no task progress, so it
 * isn't checkpointed; the next iteration through this same point will be).
 * Returns normally when the loop exits via `break` (all tasks complete, or no
 * task available). EscalationHalt still propagates as a thrown/rejected error.
 */
async function* driveMainLoop(ctx: LoopContext): AsyncGenerator<HarnessCheckpoint, void, void> {
  while (true) {
    ctx.stepsUsed++
    // Backstop budget check: the "normal path" exhaustion check further down (stepsUsed >=
    // maxSteps) only runs once an iteration reaches the bottom of the loop body, but several
    // branches above `continue` before ever reaching it (action_gate BLOCKED with nothing to
    // recover from, e.g. a low progress_rate on a large task graph with cannotMakeProgress's
    // own history-based stall detection not yet primed — a real, previously-latent deadlock
    // this exposed). Without this, such a branch spins forever instead of ever escalating.
    if (ctx.stepsUsed > ctx.maxSteps) {
      const exhaust = escalateBudgetExhausted(ctx.stepsUsed, ctx.maxSteps)
      throw new EscalationHalt({
        reason: 'budget_exhausted',
        missing_info: exhaust.missing_info,
        current_task_summary: `Exhausted at step ${ctx.stepsUsed} (no iteration reached completion)`,
        escalated_at: new Date().toISOString(),
      })
    }
    ctx.nodeExecutionOrder.push('context_compression')

    contextCompression(
      ctx.memoryState, ctx.worldModel, ctx.beliefDepGraph, ctx.depGraphBudget,
      ctx.hypothesisSet, ctx.taskGraph, ctx.diagnostics, ctx.controlState, ctx.callerState,
    )

    ctx.nodeExecutionOrder.push('check_caller_updates')
    const updateResult = checkCallerUpdates(ctx.callerState, ctx.updateChannel, {
      worldModel: ctx.worldModel, hypothesisSet: ctx.hypothesisSet, taskGraph: ctx.taskGraph,
      diagnostics: ctx.diagnostics, failureDiagnostics: ctx.failureDiagnostics,
      evidenceStore: ctx.evidenceStore, outputContract: ctx.outputContract,
    })
    if (updateResult === RESTART_ITERATION) {
      resolveAndStamp(ctx)
      continue
    }

    // ─── SUB-STEP A ───────────────────────────────────────────────────────

    ctx.nodeExecutionOrder.push('detect_contradictions')
    const contradictionsBefore = ctx.worldModel.contradictions.length
    // Fires automatically once >=2 beliefs exist — detectContradictions is already cheap
    // with fewer, so no separate gate is needed; Phase 1's belief-writing fix is what makes
    // this stop being permanently a no-op (Phase 2, layer 4).
    detectContradictions(ctx.worldModel, ctx.evidenceStore, ctx.hypothesisSet, undefined, ctx.beliefDepGraph)
    if (ctx.worldModel.contradictions.length > contradictionsBefore) {
      reportLayer(ctx, 'contradiction', true, `Heads up — this seems to conflict with something you told me earlier: ${ctx.worldModel.contradictions.at(-1)?.description ?? ''}`)
    } else {
      reportLayer(ctx, 'contradiction', false, ctx.worldModel.beliefs.length >= 2 ? 'checked — no conflicts found' : 'fewer than 2 beliefs — nothing to compare')
    }

    const sig = ctx.complexitySignal
    const hypothesisNotable = (sig?.taskCount ?? 1) > 1 || (sig?.riskLevel ?? 'LOW') !== 'LOW' || ctx.failureDiagnostics.failure_history.length > 0
    ctx.nodeExecutionOrder.push('generate_update_hypotheses')
    // Always computed (never skipped) — diagnostics.coverage_health.explanation_coverage is
    // derived from hypothesisSet's entropy (computeSourceEntropy), which resolveControlState
    // reads for its BLOCKED/CAUTIOUS tiers; eliding this call for a "quiet" turn starves that
    // signal and can wedge the whole run in BLOCKED. What's actually gated per Phase 2, layer 3
    // is only whether this is worth surfacing to the user, not whether the computation runs.
    generateUpdateHypotheses(ctx.worldModel, ctx.evidenceStore, ctx.hypothesisSet, ctx.failureDiagnostics, ctx.memoryState)
    reportLayer(ctx, 'hypothesis', hypothesisNotable && ctx.hypothesisSet.active.length > 1,
      hypothesisNotable && ctx.hypothesisSet.active.length > 1
        ? `Considered ${ctx.hypothesisSet.active.length} ways this request could be understood; going with the most direct one`
        : 'single clear LOW-risk task — no competing explanation worth surfacing')

    ctx.nodeExecutionOrder.push('update_diagnostics')
    updateDiagnostics(ctx.worldModel, ctx.hypothesisSet, ctx.taskGraph, ctx.failureDiagnostics, ctx.beliefDepGraph, ctx.diagnostics)
    reportLayer(ctx, 'diagnostics', true, anyDiagnosticSubDimensionCautious(ctx.diagnostics) ? 'a sub-dimension crossed the caution threshold' : 'Health: nominal')

    ctx.worldModel.incrementGenerationId()
    ctx.nodeExecutionOrder.push('resolve_control_state')
    resolveAndStamp(ctx)
    reportLayer(ctx, 'control_state', ctx.controlState.risk_state !== 'NORMAL', ctx.controlState.risk_state === 'BLOCKED'
      ? `Pausing — ${ctx.controlState.escalation_reason ?? 'blocked'}`
      : ctx.controlState.risk_state === 'CAUTIOUS'
        ? `Proceeding carefully — ${ctx.controlState.escalation_reason ?? 'elevated risk'}`
        : 'NORMAL')

    const allComplete = ctx.taskGraph.tasks.length > 0 &&
      ctx.taskGraph.tasks.every(t => t.status === 'COMPLETE')
    if (allComplete) return

    ctx.nodeExecutionOrder.push('update_task_graph')
    updateTaskGraph(ctx.objective, ctx.worldModel, ctx.hypothesisSet, ctx.taskGraph)

    ctx.nodeExecutionOrder.push('select_task')
    const selectResult = selectTask(ctx.taskGraph, ctx.controlState)

    if (selectResult.escalate) {
      throw new EscalationHalt({
        reason: 'cannot_make_progress',
        missing_info: ['HUMAN_REQUIRED escalation from select_task'],
        current_task_summary: 'task selection triggered escalation',
        escalated_at: new Date().toISOString(),
      })
    }

    if (selectResult.task === null) return

    const currentTask = selectResult.task
    ctx.taskGraph.setStatus(currentTask.id, 'RUNNING')

    ctx.nodeExecutionOrder.push('estimate_risk')
    // module_type reflects what this turn actually does (Phase 2, layer 8) instead of a
    // constant 'business_logic' placeholder — a HIGH-risk turn (a write/send/delete-shaped
    // request) is treated as infrastructure-grade risk; everything else composites normally.
    const riskAction: RiskableAction = {
      module_type: ctx.complexitySignal?.riskLevel === 'HIGH' ? 'infrastructure' : 'business_logic',
      metadata: {},
    }
    estimateRisk(riskAction, ctx.taskGraph, ctx.worldModel)
    reportLayer(ctx, 'execution', true, `module_type=${riskAction.module_type}`)

    ctx.nodeExecutionOrder.push('estimate_voi')
    const voiResult = estimateVOI(ctx.diagnostics, ctx.worldModel, ctx.hypothesisSet, ctx.evidenceStore.tool_availability_manifest)

    ctx.nodeExecutionOrder.push('review_proposed_change')
    const reviewResult = reviewProposedChange(
      { description: currentTask.description },
      currentTask,
      ctx.worldModel,
      ctx.outputContract,
      ctx.hypothesisSet,
      ctx.evidenceStore,
      ctx.consecutiveReviewFailures,
    )

    if (!reviewResult.passed) {
      ctx.taskGraph.setStatus(currentTask.id, 'PENDING', { fromExecutionLayer: false })
      if (reviewResult.escalation_triggered) {
        throw new EscalationHalt({
          reason: 'review_failure',
          missing_info: reviewResult.failed_dimensions.map(d => d.reason),
          current_task_summary: currentTask.description,
          escalated_at: new Date().toISOString(),
        })
      }
      continue
    }

    ctx.nodeExecutionOrder.push('action_gate')
    const gateResult = actionGate(
      { required_resources: [] },
      ctx.controlState,
      ctx.worldModel,
      ctx.diagnostics,
      ctx.failureDiagnostics,
      resolveControlState,
    )

    if (gateResult === 'ESCALATE' || gateResult === 'BLOCK') {
      ctx.taskGraph.setStatus(currentTask.id, 'PENDING', { fromExecutionLayer: false })
      if (cannotMakeProgress(ctx.strategyState, ctx.failureDiagnostics)) {
        throw new EscalationHalt({
          reason: 'cannot_make_progress',
          missing_info: [ctx.strategyState.stall_reason ?? 'unknown'],
          current_task_summary: currentTask.description,
          escalated_at: new Date().toISOString(),
        })
      }
      continue
    }

    ctx.nodeExecutionOrder.push('execute')
    const proposedChange: ProposedExecutionChange = {
      description: currentTask.description,
      change_type: 'file_mutation',
    }
    const toolFn = ctx.toolExecutors[currentTask.id] ?? ctx.toolExecutors['default'] ?? (() => ({ completed: true }))
    const execResult = execute(proposedChange, toolFn, {
      worldModel: ctx.worldModel,
      evidenceStore: ctx.evidenceStore,
      taskGraph: ctx.taskGraph,
      currentTask,
      memoryState: ctx.memoryState,
      beliefDepGraph: ctx.beliefDepGraph,
    })

    // Phase 2, layer 7 (plan sub-item 2.7): dispatch select_task's concurrentTask instead of
    // silently dropping it — real only for a non-HIGH-risk pair (select_task.ts's own
    // hasOverlap/conflict-probability check already guarantees disjoint write domains; never
    // a write_file/run_shell_command pair — those keep serial execution + human approval). The
    // two tasks execute against independently-forked WorldModel branches (this task's
    // ctx.worldModel, and a clone for the concurrent one), reconciled via the already-
    // implemented reconcileParallelBranches/mergeWorldModels right before this iteration's
    // checkpoint. evidenceStore/taskGraph/diagnostics/hypothesisSet stay shared across both
    // branches (reconcileParallelBranches' own design) — only WorldModel forks.
    const concurrentTask = selectResult.concurrentTask
    const parallelEligible = concurrentTask !== null && currentTask.risk_level !== 'HIGH' && concurrentTask.risk_level !== 'HIGH'
    reportLayer(ctx, 'planning', parallelEligible, parallelEligible && concurrentTask
      ? `Reading "${currentTask.description}" and "${concurrentTask.description}" at once`
      : concurrentTask ? 'candidate found but too risky to run in parallel — serial execution' : 'one eligible task — serial execution')

    let branchWorldModel: WorldModel | null = null
    let branchExecSucceeded = false
    if (parallelEligible && concurrentTask) {
      ctx.taskGraph.setStatus(concurrentTask.id, 'RUNNING')
      branchWorldModel = WorldModel.fromJSON(ctx.worldModel.toJSON())
      const branchToolFn = ctx.toolExecutors[concurrentTask.id] ?? ctx.toolExecutors['default'] ?? (() => ({ completed: true }))
      const branchExecResult = execute(
        { description: concurrentTask.description, change_type: 'read-only' },
        branchToolFn,
        {
          worldModel: branchWorldModel,
          evidenceStore: ctx.evidenceStore,
          taskGraph: ctx.taskGraph,
          currentTask: concurrentTask,
          memoryState: ctx.memoryState,
          beliefDepGraph: ctx.beliefDepGraph,
        },
      )
      branchExecSucceeded = branchExecResult.success
      if (branchExecSucceeded) {
        const branchEvidence = gatherEvidence(
          {
            id: `exec-${concurrentTask.id}-${ctx.stepsUsed}`,
            obs: `Task executed: ${concurrentTask.description}`,
            source: 'execution_engine',
            evidence_type: 'OBSERVATION',
            reliability: 'HIGH',
          },
          ctx.evidenceStore,
        )
        if (branchEvidence) {
          updateWorldModel(applyToolReliability(branchEvidence, ctx.evidenceStore, ctx.diagnostics), branchWorldModel, ctx.diagnostics)
        }
      }
    }

    // ─── SUB-STEP B ───────────────────────────────────────────────────────

    ctx.worldModel.incrementGenerationId()

    ctx.nodeExecutionOrder.push('gather_evidence')
    ctx.nodeExecutionOrder.push('apply_tool_reliability')
    ctx.nodeExecutionOrder.push('update_world_model_post_exec')
    if (execResult.success) {
      // Two distinct evidence items per successfully executed task — that a task ran, and
      // what it produced — so evidence_sufficiency's local-scope >=2 bar (verify.ts) is a
      // real threshold instead of one a fresh single-task turn can never clear (Phase 0.1 of
      // the harness layer activation plan).
      const executed = gatherEvidence(
        {
          id: `exec-${currentTask.id}-${ctx.stepsUsed}`,
          obs: `Task executed: ${currentTask.description}`,
          source: 'execution_engine',
          evidence_type: 'OBSERVATION',
          reliability: 'HIGH',
        },
        ctx.evidenceStore,
      )
      if (executed) {
        const capped = applyToolReliability(executed, ctx.evidenceStore, ctx.diagnostics)
        updateWorldModel(capped, ctx.worldModel, ctx.diagnostics)
      }

      const outcome = gatherEvidence(
        {
          id: `result-${currentTask.id}-${ctx.stepsUsed}`,
          obs: `Result: ${summariseExecutionOutput(execResult.output)}`,
          source: 'result_inspection',
          evidence_type: 'OBSERVATION',
          reliability: 'MEDIUM',
        },
        ctx.evidenceStore,
      )
      if (outcome) {
        const cappedOutcome = applyToolReliability(outcome, ctx.evidenceStore, ctx.diagnostics)
        updateWorldModel(cappedOutcome, ctx.worldModel, ctx.diagnostics)
      }

      // Phase 2, layer 2: escalate past the always-on baseline above — register a real
      // tool_reliability_envelope for consequential tools, or when estimate_voi flagged this
      // turn as evidence-poor — instead of every turn paying for it regardless of stakes.
      const evidenceShouldEscalate = (sig?.consequentialTools.size ?? 0) > 0 || voiResult.should_gather_evidence
      if (evidenceShouldEscalate) {
        for (const tool of sig?.consequentialTools ?? []) {
          if (!ctx.evidenceStore.tool_reliability_envelopes[tool]) {
            ctx.evidenceStore.tool_reliability_envelopes[tool] = {
              tool,
              max_observation_reliability: 'MEDIUM',
              max_conclusion_reliability: 'MEDIUM',
            }
          }
        }
        reportLayer(ctx, 'evidence_reasoning', true, `Cross-checking with ${Math.max(1, sig?.consequentialTools.size ?? 0)} source(s) before answering.`)
      } else {
        reportLayer(ctx, 'evidence_reasoning', false, 'single low-stakes observation is sufficient')
      }

      // Phase 0.2: promote caller-extracted facts into real INFERENCE beliefs — the
      // updateWorldModel INFERENCE branch already exists but was never reached because no
      // call site ever passed evidence_type: 'INFERENCE'.
      const facts = ctx.factExtractor?.(ctx.objective) ?? []
      // Phase 2, layer 1: a consequential or multi-task turn still gets an auditable belief
      // trail even with no extracted fact — a plain LOW-risk single task stays observation-only.
      const worldModelShouldFire = facts.length > 0 || (sig?.taskCount ?? 1) > 1 || (sig?.riskLevel ?? 'LOW') !== 'LOW'
      if (worldModelShouldFire) {
        facts.forEach((fact: { statement: string }, i: number) => {
          const factEvidence = gatherEvidence(
            {
              id: `fact-${currentTask.id}-${ctx.stepsUsed}-${i}`,
              obs: fact.statement,
              source: 'fact_extraction',
              evidence_type: 'INFERENCE',
              reliability: 'MEDIUM',
            },
            ctx.evidenceStore,
          )
          if (factEvidence) {
            const cappedFact = applyToolReliability(factEvidence, ctx.evidenceStore, ctx.diagnostics)
            updateWorldModel(cappedFact, ctx.worldModel, ctx.diagnostics, {
              statement: fact.statement,
              derived_from: [factEvidence.id],
            })
          }
        })
        if (facts.length === 0) {
          // No extracted fact, but the turn is consequential/multi-step enough to warrant a
          // trail — derive a belief from the task's own execution observation instead.
          const trailSource = executed ?? outcome
          if (trailSource) {
            const trailEvidence = gatherEvidence(
              {
                id: `belief-${currentTask.id}-${ctx.stepsUsed}`,
                obs: `Completed: ${currentTask.description}`,
                source: 'world_model_trail',
                evidence_type: 'INFERENCE',
                reliability: 'MEDIUM',
              },
              ctx.evidenceStore,
            )
            if (trailEvidence) {
              updateWorldModel(trailEvidence, ctx.worldModel, ctx.diagnostics, {
                statement: `Completed: ${currentTask.description}`,
                derived_from: [trailSource.id],
              })
            }
          }
        }
        reportLayer(ctx, 'world_model', true, facts[0]
          ? `Remembered: ${facts[0].statement}`
          : 'recorded a belief trail for a multi-step/consequential turn')
      } else {
        reportLayer(ctx, 'world_model', false, 'single LOW-risk task, no durable fact stated — observation only')
      }
    }

    // Phase 2, layer 9: 5 of the 9 verification layers hardcode PASS whenever their tool
    // manifest entry is *absent* (isToolAvailable's default) rather than explicitly false —
    // for a personal-assistant turn (always a plain-reply-shaped task; nothing here is a real
    // write_file/pytest-checkable change) those layers should report an honest SKIPPED, not a
    // fabricated PASS. Respects any explicit entry the caller already set.
    for (const tool of ['pytest', 'integration_runner', 'consistency_checker', 'assumption_checker', 'goal_checker']) {
      if (!(tool in ctx.evidenceStore.tool_availability_manifest)) {
        ctx.evidenceStore.tool_availability_manifest[tool] = { available: false, fallback_tool: null }
      }
    }

    ctx.nodeExecutionOrder.push('update_diagnostics_post_exec')
    updateDiagnostics(ctx.worldModel, ctx.hypothesisSet, ctx.taskGraph, ctx.failureDiagnostics, ctx.beliefDepGraph, ctx.diagnostics)

    ctx.nodeExecutionOrder.push('resolve_control_state_b')
    resolveAndStamp(ctx)

    ctx.nodeExecutionOrder.push('verify')
    const verifyResult = verify(
      execResult.output,
      ctx.successCriteria,
      ctx.worldModel.assumptions,
      ctx.evidenceStore,
      currentTask.risk_level,
      ctx.evidenceStore,
      ctx.worldModel,
      ctx.outputContract,
      ctx.hypothesisSet,
    )
    reportLayer(ctx, 'verification', true, verifyResult.has_critical_failure
      ? `verification failed: ${verifyResult.layer_results.find(lr => lr.status === 'FAIL')?.detail ?? 'unknown'}`
      : 'all applicable layers passed')

    ctx.nodeExecutionOrder.push('post_exec_gate')
    const postGatePassed = postExecGate(
      execResult.output,
      verifyResult,
      ctx.controlState,
      ctx.worldModel,
      ctx.diagnostics,
      ctx.failureDiagnostics,
      ctx.outputContract,
      resolveControlState,
    )

    ctx.nodeExecutionOrder.push('update_task_state')
    if (postGatePassed && execResult.success) {
      ctx.taskGraph.setStatus(currentTask.id, 'COMPLETE', { fromExecutionLayer: true })
      ctx.finalResult = execResult.output

      if (ctx.experienceStore.available) {
        ctx.experienceStore.updateExperienceStore(
          `${currentTask.id}-step-${ctx.stepsUsed}`,
          { task_id: currentTask.id, outcome: 'COMPLETE', step: ctx.stepsUsed },
        )
      }
      reportLayer(ctx, 'recovery', false, 'task completed — nothing to recover from')
    } else {
      ctx.nodeExecutionOrder.push('rollback_replan')
      // Phase 2, layer 10: a real per-task rollback hook instead of the no-op the harness ran
      // before — a caller can restore real state (e.g. a memoryState.rollback_points snapshot)
      // when a task actually fails, rather than this being dead plumbing.
      const rollbackFn = ctx.rollbackExecutors?.[currentTask.id] ?? ctx.rollbackExecutors?.['default']
      const rollbackResult = rollbackAndReplan(
        currentTask,
        ctx.strategyState,
        ctx.failureDiagnostics,
        ctx.taskGraph,
        ctx.worldModel,
        ctx.callerState,
        ctx.experienceStore.available ? ctx.experienceStore : null,
        rollbackFn,
      )
      reportLayer(ctx, 'recovery', true, `Trying a different approach — switched to "${rollbackResult.newStrategyState.current_strategy}" (${rollbackResult.replanScope ?? 'local'} replan)`)
    }

    // Reconcile the concurrent-task branch forked off above (layer 7) — done after this
    // task's own SUB-STEP B so both branches' independent WorldModel mutations are complete
    // before merging (reconcileParallelBranches' contract).
    if (branchWorldModel && concurrentTask) {
      const reconciled = reconcileParallelBranches(
        [
          { worldModel: ctx.worldModel, controlState: ctx.controlState },
          { worldModel: branchWorldModel, controlState: ctx.controlState },
        ],
        ctx.taskGraph,
        ctx.diagnostics,
        ctx.failureDiagnostics,
        ctx.evidenceStore,
        ctx.hypothesisSet,
        resolveControlState,
        currentTask.parallel_write_domains.flatMap(
          (da): Array<[string, string]> => (concurrentTask.parallel_write_domains.map(db => [da, db])),
        ),
      )
      ctx.worldModel = reconciled.worldModel
      ctx.controlState.generation_id = reconciled.controlState.generation_id
      ctx.controlState.risk_state = reconciled.controlState.risk_state
      ctx.controlState.escalation_reason = reconciled.controlState.escalation_reason
      ctx.controlState.block_mask = [...reconciled.controlState.block_mask]
      ctx.controlState.notes = [...reconciled.controlState.notes]

      if (branchExecSucceeded && concurrentTask.status !== 'COMPLETE') {
        ctx.taskGraph.setStatus(concurrentTask.id, 'COMPLETE', { fromExecutionLayer: true })
      } else if (concurrentTask.status === 'RUNNING') {
        ctx.taskGraph.setStatus(concurrentTask.id, 'PENDING', { fromExecutionLayer: false })
      }
    }

    ctx.strategyState.completion_history.push(
      ctx.taskGraph.tasks.filter(t => t.status === 'COMPLETE').length,
    )
    ctx.strategyState.risk_state_history.push(ctx.controlState.risk_state)

    if (ctx.stepsUsed >= Math.floor(0.8 * ctx.maxSteps)) {
      ctx.diagnostics.verification_health.feasibility = Math.min(
        ctx.diagnostics.verification_health.feasibility,
        BUDGET_WARNING_FLOOR,
      )
    }

    if (ctx.stepsUsed >= ctx.maxSteps) {
      const exhaust = escalateBudgetExhausted(ctx.stepsUsed, ctx.maxSteps)
      throw new EscalationHalt({
        reason: 'budget_exhausted',
        missing_info: exhaust.missing_info,
        current_task_summary: `Exhausted at step ${ctx.stepsUsed}`,
        escalated_at: new Date().toISOString(),
      })
    }

    yield toCheckpoint(ctx)
  }
}

async function runMainLoopWithCheckpoints(
  ctx: LoopContext,
  options: HarnessRunOptions,
): Promise<{ status: 'completed' } | { status: 'paused'; checkpoint: HarnessCheckpoint }> {
  const gen = driveMainLoop(ctx)
  while (true) {
    const { value: checkpoint, done } = await gen.next()
    if (done) return { status: 'completed' }

    if (options.onCheckpoint) await options.onCheckpoint(checkpoint)
    if (options.shouldPause?.(checkpoint)) return { status: 'paused', checkpoint }
  }
}

async function drive(ctx: LoopContext, options: HarnessRunOptions): Promise<HarnessRunOutcome> {
  const first = await runMainLoopWithCheckpoints(ctx, options)
  if (first.status === 'paused') return first

  // Phase 2, layer 11: the adversarial lens is the expensive BFS-over-beliefs one — worth
  // paying for on a consequential or multi-step turn, not a one-line factual answer. The
  // implementer/reviewer lenses always run (cheap, and now accurate once beliefs are real).
  const sigForReview = ctx.complexitySignal
  const runAdversarialLens = (sigForReview?.riskLevel ?? 'LOW') !== 'LOW' || (sigForReview?.taskCount ?? 1) >= 3

  ctx.nodeExecutionOrder.push('reviewer_pass')
  const reviewPassResult = reviewerPass(
    ctx.worldModel, ctx.successCriteria, ctx.failureDiagnostics, ctx.beliefDepGraph,
    ctx.depGraphBudget, ctx.hypothesisSet, ctx.taskGraph, ctx.diagnostics, ctx.evidenceStore, ctx.propagationQueue,
    runAdversarialLens,
  )
  const allFindings = [...reviewPassResult.implementer_findings, ...reviewPassResult.reviewer_findings, ...reviewPassResult.adversarial_findings]
  reportLayer(ctx, 'reviewer_pass', allFindings.length > 0, allFindings.length > 0 ? allFindings[0] : 'self-review found nothing to flag')

  if (reviewPassResult.reopened_task_ids.length > 0) {
    for (const taskId of reviewPassResult.reopened_task_ids) {
      const task = ctx.taskGraph.getTask(taskId)
      if (task) {
        task.status = 'PENDING'
        ctx.taskGraph.changed = true
      }
    }

    const second = await runMainLoopWithCheckpoints(ctx, options)
    if (second.status === 'paused') return second

    ctx.nodeExecutionOrder.push('reviewer_pass_2')
    reviewerPass(
      ctx.worldModel, ctx.successCriteria, ctx.failureDiagnostics, ctx.beliefDepGraph,
      ctx.depGraphBudget, ctx.hypothesisSet, ctx.taskGraph, ctx.diagnostics, ctx.evidenceStore, ctx.propagationQueue,
      runAdversarialLens,
    )
  }

  ctx.nodeExecutionOrder.push('output_validation')
  const validationResult = outputValidation(ctx.finalResult, ctx.outputContract, ctx.callerState)

  // propagateBeliefs available for introspection but not part of the return
  void propagateBeliefs

  const result: HarnessRunResult = {
    finalResult: ctx.finalResult,
    outputValidation: validationResult,
    stepsUsed: ctx.stepsUsed,
    initResult: toInitResultShape(ctx),
    nodeExecutionOrder: ctx.nodeExecutionOrder,
  }

  // Always emit one final checkpoint on completion so a caller persisting
  // checkpoints ends up with a snapshot of the terminal state, not just the
  // last mid-loop one.
  if (options.onCheckpoint) await options.onCheckpoint(toCheckpoint(ctx))

  return { status: 'complete', result }
}

export class HarnessRuntime {
  async run(
    objective: string,
    successCriteria: string[],
    options: HarnessRunOptions = {},
  ): Promise<HarnessRunOutcome> {
    const runId = options.runId ?? generateRunId()
    const ctx = buildInitialContext(objective, successCriteria, options, runId)
    return drive(ctx, options)
  }

  async resume(checkpoint: HarnessCheckpoint, options: HarnessRunOptions = {}): Promise<HarnessRunOutcome> {
    const ctx = buildResumedContext(checkpoint, options)
    return drive(ctx, options)
  }
}
