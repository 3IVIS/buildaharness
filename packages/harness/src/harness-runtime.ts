import { type ExperienceStore, UnavailableExperienceStore } from './state/experience-store.js'
import { gatherEvidence } from './nodes/gather-evidence.js'
import { applyToolReliability } from './nodes/apply-tool-reliability.js'
import { resolveControlState } from './nodes/resolve-control-state.js'
import { updateDiagnostics } from './nodes/update-diagnostics.js'
import { detectContradictions } from './nodes/detect-contradictions.js'
import { generateUpdateHypotheses } from './nodes/generate-update-hypotheses.js'
import { updateWorldModel, propagateBeliefs } from './nodes/update-world-model.js'
import { updateTaskGraph } from './nodes/update-task-graph.js'
import { selectTask } from './nodes/select-task.js'
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
import { DepGraphBudget } from './state/world-model.js'
import type { HarnessCheckpoint, HarnessRunConfigData, HarnessRunProgressData } from './harness-checkpoint.js'

export const BUDGET_WARNING_FLOOR = 0.5

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
    detectContradictions(ctx.worldModel, ctx.evidenceStore, ctx.hypothesisSet, undefined, ctx.beliefDepGraph)

    ctx.nodeExecutionOrder.push('generate_update_hypotheses')
    generateUpdateHypotheses(ctx.worldModel, ctx.evidenceStore, ctx.hypothesisSet, ctx.failureDiagnostics, ctx.memoryState)

    ctx.nodeExecutionOrder.push('update_diagnostics')
    updateDiagnostics(ctx.worldModel, ctx.hypothesisSet, ctx.taskGraph, ctx.failureDiagnostics, ctx.beliefDepGraph, ctx.diagnostics)

    ctx.worldModel.incrementGenerationId()
    ctx.nodeExecutionOrder.push('resolve_control_state')
    resolveAndStamp(ctx)

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
    const riskAction: RiskableAction = { module_type: 'business_logic', metadata: {} }
    estimateRisk(riskAction, ctx.taskGraph, ctx.worldModel)

    ctx.nodeExecutionOrder.push('estimate_voi')
    estimateVOI(ctx.diagnostics, ctx.worldModel, ctx.hypothesisSet, ctx.evidenceStore.tool_availability_manifest)

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

    // ─── SUB-STEP B ───────────────────────────────────────────────────────

    ctx.worldModel.incrementGenerationId()

    ctx.nodeExecutionOrder.push('gather_evidence')
    ctx.nodeExecutionOrder.push('apply_tool_reliability')
    ctx.nodeExecutionOrder.push('update_world_model_post_exec')
    if (execResult.success) {
      const gathered = gatherEvidence(
        {
          id: `exec-${currentTask.id}-${ctx.stepsUsed}`,
          obs: `Task executed: ${currentTask.description}`,
          source: 'execution_engine',
          evidence_type: 'OBSERVATION',
          reliability: 'HIGH',
        },
        ctx.evidenceStore,
      )
      if (gathered) {
        const capped = applyToolReliability(gathered, ctx.evidenceStore, ctx.diagnostics)
        updateWorldModel(capped, ctx.worldModel, ctx.diagnostics)
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
    } else {
      ctx.nodeExecutionOrder.push('rollback_replan')
      rollbackAndReplan(
        currentTask,
        ctx.strategyState,
        ctx.failureDiagnostics,
        ctx.taskGraph,
        ctx.worldModel,
        ctx.callerState,
        ctx.experienceStore.available ? ctx.experienceStore : null,
      )
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

  ctx.nodeExecutionOrder.push('reviewer_pass')
  const reviewPassResult = reviewerPass(
    ctx.worldModel, ctx.successCriteria, ctx.failureDiagnostics, ctx.beliefDepGraph,
    ctx.depGraphBudget, ctx.hypothesisSet, ctx.taskGraph, ctx.diagnostics, ctx.evidenceStore, ctx.propagationQueue,
  )

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
