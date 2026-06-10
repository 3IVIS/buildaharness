import { type ExperienceStore, UnavailableExperienceStore } from './state/experience-store.js'
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

export const BUDGET_WARNING_FLOOR = 0.5

export interface HarnessRunOptions extends HarnessInitOptions {
  experienceStore?: ExperienceStore
  updateChannel?: UpdateChannel
  toolExecutors?: Record<string, () => unknown>
}

export interface HarnessRunResult {
  finalResult: unknown
  outputValidation: OutputValidationResult | null
  stepsUsed: number
  initResult: HarnessInitResult
  nodeExecutionOrder: string[]
}

export class HarnessRuntime {
  run(
    objective: string,
    successCriteria: string[],
    options: HarnessRunOptions = {},
  ): HarnessRunResult {
    const {
      experienceStore = new UnavailableExperienceStore(),
      updateChannel = new NoOpUpdateChannel(),
      toolExecutors = {},
    } = options

    // Initialize all 13 state objects
    const initResult = initializeHarness(objective, {
      ...options,
      successCriteria,
    })

    if (!initResult.valid) {
      throw new Error(`HarnessRuntime: init failed — ${initResult.errors.join('; ')}`)
    }

    const {
      worldModel,
      callerState,
      controlState,
      taskGraph,
      diagnostics,
      hypothesisSet,
      evidenceStore,
      memoryState,
      strategyState,
      failureDiagnostics,
      outputContract,
      beliefDepGraph,
      depGraphBudget,
      maxSteps,
    } = initResult

    // Warm start from ExperienceStore (no-op if unavailable)
    warmStart(experienceStore, strategyState, failureDiagnostics, depGraphBudget, taskGraph)

    const propagationQueue: PropagationQueue = { reopenedTaskIds: [] }
    let stepsUsed = 0
    let finalResult: unknown = null
    const nodeExecutionOrder: string[] = []
    const consecutiveReviewFailures = new Map<string, number>()

    const resolveAndStamp = (): void => {
      const newCS = resolveControlState(diagnostics, worldModel, failureDiagnostics)
      controlState.generation_id = newCS.generation_id
      controlState.risk_state = newCS.risk_state
      controlState.escalation_reason = newCS.escalation_reason
      controlState.block_mask = [...newCS.block_mask]
      controlState.notes = [...newCS.notes]
    }

    const runMainLoop = (): void => {
      while (true) {
        stepsUsed++
        nodeExecutionOrder.push('context_compression')

        // Context compression at top of each iteration
        contextCompression(
          memoryState, worldModel, beliefDepGraph, depGraphBudget,
          hypothesisSet, taskGraph, diagnostics, controlState, callerState,
        )

        // Non-blocking caller update check
        nodeExecutionOrder.push('check_caller_updates')
        const updateResult = checkCallerUpdates(callerState, updateChannel, {
          worldModel, hypothesisSet, taskGraph, diagnostics, failureDiagnostics,
        })
        if (updateResult === RESTART_ITERATION) {
          resolveAndStamp()
          continue
        }

        // ─── SUB-STEP A ───────────────────────────────────────────────────────

        nodeExecutionOrder.push('gather_evidence')
        nodeExecutionOrder.push('update_world_model')
        nodeExecutionOrder.push('detect_contradictions')
        detectContradictions(worldModel, evidenceStore, hypothesisSet)

        nodeExecutionOrder.push('generate_update_hypotheses')
        generateUpdateHypotheses(worldModel, evidenceStore, hypothesisSet, failureDiagnostics, memoryState)

        nodeExecutionOrder.push('update_diagnostics')
        updateDiagnostics(worldModel, hypothesisSet, taskGraph, failureDiagnostics, beliefDepGraph, diagnostics)

        // Sub-step A: worldModel.generation_id++ then resolve_control_state
        worldModel.incrementGenerationId()
        nodeExecutionOrder.push('resolve_control_state')
        resolveAndStamp()

        // Completion check: all tasks complete?
        const allComplete = taskGraph.tasks.length > 0 &&
          taskGraph.tasks.every(t => t.status === 'COMPLETE')
        if (allComplete) break

        nodeExecutionOrder.push('update_task_graph')
        updateTaskGraph(objective, worldModel, hypothesisSet, taskGraph)

        nodeExecutionOrder.push('select_task')
        const selectResult = selectTask(taskGraph, controlState)

        if (selectResult.escalate) {
          throw new EscalationHalt({
            reason: 'cannot_make_progress',
            missing_info: ['HUMAN_REQUIRED escalation from select_task'],
            current_task_summary: 'task selection triggered escalation',
            escalated_at: new Date().toISOString(),
          })
        }

        if (selectResult.task === null) break  // No task available

        const currentTask = selectResult.task
        taskGraph.setStatus(currentTask.id, 'RUNNING')

        // estimate_risk
        nodeExecutionOrder.push('estimate_risk')
        const riskAction: RiskableAction = {
          module_type: 'business_logic',
          metadata: {},
        }
        estimateRisk(riskAction, taskGraph, worldModel)

        // estimate_voi
        nodeExecutionOrder.push('estimate_voi')
        estimateVOI(diagnostics, worldModel, hypothesisSet, evidenceStore.tool_availability_manifest)

        // review_proposed_change
        nodeExecutionOrder.push('review_proposed_change')
        const reviewResult = reviewProposedChange(
          { description: currentTask.description },
          currentTask,
          worldModel,
          outputContract,
          hypothesisSet,
          evidenceStore,
          consecutiveReviewFailures,
        )

        if (!reviewResult.passed) {
          taskGraph.setStatus(currentTask.id, 'PENDING', { fromExecutionLayer: false })
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

        // action_gate
        nodeExecutionOrder.push('action_gate')
        const gateResult = actionGate(
          { required_resources: [] },
          controlState,
          worldModel,
          diagnostics,
          failureDiagnostics,
          resolveControlState,
        )

        if (gateResult === 'ESCALATE' || gateResult === 'BLOCK') {
          taskGraph.setStatus(currentTask.id, 'PENDING', { fromExecutionLayer: false })
          if (cannotMakeProgress(strategyState, failureDiagnostics)) {
            throw new EscalationHalt({
              reason: 'cannot_make_progress',
              missing_info: [strategyState.stall_reason ?? 'unknown'],
              current_task_summary: currentTask.description,
              escalated_at: new Date().toISOString(),
            })
          }
          continue
        }

        // execute
        nodeExecutionOrder.push('execute')
        const proposedChange: ProposedExecutionChange = {
          description: currentTask.description,
          change_type: 'file_mutation',
        }
        const toolFn = toolExecutors[currentTask.id] ?? toolExecutors['default'] ?? (() => ({ completed: true }))
        const execResult = execute(proposedChange, toolFn, {
          worldModel,
          evidenceStore,
          taskGraph,
          currentTask,
          memoryState,
          beliefDepGraph,
        })

        // ─── SUB-STEP B ───────────────────────────────────────────────────────

        // Sub-step B: worldModel.generation_id++
        worldModel.incrementGenerationId()

        // update_world_model (post-execution)
        nodeExecutionOrder.push('update_world_model_post_exec')
        if (execResult.success) {
          const evidence = {
            id: `exec-${currentTask.id}-${stepsUsed}`,
            obs: `Task executed: ${currentTask.description}`,
            reliability: 'HIGH' as const,
            source: currentTask.id,
            evidence_type: 'OBSERVATION' as const,
            freshness: new Date().toISOString(),
          }
          updateWorldModel(evidence, worldModel, diagnostics)
        }

        // update_diagnostics (post-exec)
        nodeExecutionOrder.push('update_diagnostics_post_exec')
        updateDiagnostics(worldModel, hypothesisSet, taskGraph, failureDiagnostics, beliefDepGraph, diagnostics)

        // resolve_control_state (sub-step B)
        nodeExecutionOrder.push('resolve_control_state_b')
        resolveAndStamp()

        // verify
        nodeExecutionOrder.push('verify')
        const verifyResult = verify(
          execResult.output,
          successCriteria,
          worldModel.assumptions,
          evidenceStore,
          currentTask.risk_level,
          evidenceStore,
          worldModel,
          outputContract,
          hypothesisSet,
        )

        // post_exec_gate
        nodeExecutionOrder.push('post_exec_gate')
        const postGatePassed = postExecGate(
          execResult.output,
          verifyResult,
          controlState,
          worldModel,
          diagnostics,
          failureDiagnostics,
          outputContract,
          resolveControlState,
        )

        // update_task_state
        nodeExecutionOrder.push('update_task_state')
        if (postGatePassed && execResult.success) {
          taskGraph.setStatus(currentTask.id, 'COMPLETE', { fromExecutionLayer: true })
          finalResult = execResult.output

          if (experienceStore.available) {
            experienceStore.updateExperienceStore(
              `${currentTask.id}-step-${stepsUsed}`,
              { task_id: currentTask.id, outcome: 'COMPLETE', step: stepsUsed },
            )
          }
        } else {
          nodeExecutionOrder.push('rollback_replan')
          rollbackAndReplan(
            currentTask,
            strategyState,
            failureDiagnostics,
            taskGraph,
            worldModel,
            callerState,
            experienceStore.available ? experienceStore : null,
          )
        }

        // Track history for cannot_make_progress detection
        strategyState.completion_history.push(
          taskGraph.tasks.filter(t => t.status === 'COMPLETE').length,
        )
        strategyState.risk_state_history.push(controlState.risk_state)

        // Budget warning: approaching max_steps
        if (stepsUsed >= Math.floor(0.8 * maxSteps)) {
          diagnostics.verification_health.feasibility = Math.min(
            diagnostics.verification_health.feasibility,
            BUDGET_WARNING_FLOOR,
          )
        }

        // Budget exhausted
        if (stepsUsed >= maxSteps) {
          const exhaust = escalateBudgetExhausted(stepsUsed, maxSteps)
          throw new EscalationHalt({
            reason: 'budget_exhausted',
            missing_info: exhaust.missing_info,
            current_task_summary: `Exhausted at step ${stepsUsed}`,
            escalated_at: new Date().toISOString(),
          })
        }
      }
    }

    // Run main loop
    runMainLoop()

    // Reviewer pass
    nodeExecutionOrder.push('reviewer_pass')
    const reviewPassResult = reviewerPass(
      worldModel, successCriteria, failureDiagnostics, beliefDepGraph,
      depGraphBudget, hypothesisSet, taskGraph, diagnostics, evidenceStore, propagationQueue,
    )

    // If reviewer re-opened tasks, re-enter main loop
    if (reviewPassResult.reopened_task_ids.length > 0) {
      for (const taskId of reviewPassResult.reopened_task_ids) {
        const task = taskGraph.getTask(taskId)
        if (task) {
          task.status = 'PENDING'
          taskGraph.changed = true
        }
      }
      runMainLoop()

      // Second reviewer pass after re-loop
      nodeExecutionOrder.push('reviewer_pass_2')
      reviewerPass(
        worldModel, successCriteria, failureDiagnostics, beliefDepGraph,
        depGraphBudget, hypothesisSet, taskGraph, diagnostics, evidenceStore, propagationQueue,
      )
    }

    // output_validation
    nodeExecutionOrder.push('output_validation')
    let validationResult: OutputValidationResult | null = null
    validationResult = outputValidation(finalResult, outputContract, callerState)

    // propagateBeliefs available for introspection but not part of the return
    void propagateBeliefs

    return {
      finalResult,
      outputValidation: validationResult,
      stepsUsed,
      initResult,
      nodeExecutionOrder,
    }
  }
}
