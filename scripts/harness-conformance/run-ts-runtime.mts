// Differential runtime conformance, TS side: runs one scenario (fixtures-runtime/*.json) through HarnessRuntime and prints a
// trace projection as JSON. Driven by compare-runtime.mjs via `npx tsx`; the Python twin is run_py_runtime.py.
import { readFileSync } from 'node:fs'
import { HarnessRuntime } from '../../packages/harness/src/harness-runtime.js'
import { EscalationHalt } from '../../packages/harness/src/nodes/escalate.js'

const sc = JSON.parse(readFileSync(process.argv[2], 'utf8'))

function tool(spec: any) {
  let calls = 0
  return (toolCtx: any) => {
    calls++
    if (spec.kind === 'seeded-fail') {
      // Mirrors packages/harness/src/harness-runtime-stall.test.ts: inject a recurring failure class on the first call, then fail.
      if (calls === 1) {
        const now = new Date().toISOString()
        for (let k = 0; k < (spec.seedFailures ?? 3); k++) {
          toolCtx.failureDiagnostics?.failure_history.push({ id: `inj-${k}`, timestamp: now, failure_class: 'injected_persistent_tool_failure', description: 'injected persistent failure', context: { injected: true } })
        }
        if (toolCtx.failureDiagnostics) toolCtx.failureDiagnostics.matched_pattern = { failure_class: 'injected_persistent_tool_failure', confidence: 1, matched_pattern: 'injected' }
      }
      if (calls <= (spec.failIterations ?? 1)) return { __harnessExecutionStatus: 'failed', error: 'injected: persistent tool failure' }
      return { __harnessExecutionStatus: 'complete', output: spec.output ?? 'recovered answer' }
    }
    const limit = spec.times ?? Infinity
    if (spec.kind === 'fail' && calls <= limit) throw new Error(spec.message ?? 'boom')
    if (spec.kind === 'continue' && calls <= limit) return { __harnessExecutionStatus: 'continue' }
    return spec.output ?? { completed: true }
  }
}

const toolExecutors: Record<string, any> = {}
for (const [id, spec] of Object.entries(sc.tools ?? {})) toolExecutors[id] = tool(spec)

const opts: any = {
  runId: 'diff-run',
  max_steps: sc.maxSteps ?? 50,
  toolExecutors,
  skipReviewerPass: sc.skipReviewerPass ?? true,
  skipVerification: sc.skipVerification ?? false,
  skipControlState: sc.skipControlState ?? false,
  experienceLearning: sc.experienceLearning ?? false,
  callerConstraints: sc.constraints ?? [],
}
if (sc.tasks) opts.initialTasks = sc.tasks.map((t: any) => ({
  id: t.id, description: t.description ?? t.id, status: 'PENDING', risk_level: t.risk_level ?? 'MEDIUM',
  depends_on: t.depends_on ?? [], parallel_write_domains: t.parallel_write_domains ?? [], abstraction_level: t.abstraction_level ?? 1,
  assigned_strategy: null,
}))
if (sc.outputContract) opts.outputContract = sc.outputContract
if (sc.facts) opts.factExtractor = () => sc.facts.map((s: string) => ({ statement: s }))
if (sc.decider) opts.supervisorDecider = async () => sc.decider
if (sc.semanticTaskCompletion) opts.semanticTaskCompletion = async () => sc.semanticTaskCompletion
if (sc.investigation) opts.runInvestigation = async () => sc.investigation.map((c: string) => ({ content: c, tool: 'search', reliability: 'MEDIUM' }))
const log: any[] = []
opts.onVerification = (v: any) => log.push(['verify', v.has_critical_failure])
opts.onGateDecision = (e: any) => log.push(['gate', e.taskId, e.result, e.haltedRun])
opts.onFailureModeSwitch = (e: any) => log.push(['failureModeSwitch', e.taskId])
opts.onSupervisorDirective = (d: any) => log.push(['directive', d.action])
if (sc.askUser) opts.askUser = (q: any) => { log.push(['askUser', q.question]) }
if (sc.contradictionChecker) opts.contradictionChecker = async (news: any[], existing: any[]) => {
  const pool = [...existing, ...news]
  return pool.length >= 2 ? [{ beliefIds: [pool[0].id, pool[1].id], description: sc.contradictionChecker.description ?? 'external conflict', severity: sc.contradictionChecker.severity }] : []
}
if (sc.changeReviewFacts) opts.changeReviewFacts = () => sc.changeReviewFacts.map((x: string) => ({ statement: x }))
if (sc.changeReviewer) { opts.semanticChangeReviewer = async () => sc.changeReviewer; opts.onReviewConflict = (e: any) => log.push(['conflict', e.taskId, e.reason]) }
opts.onTaskNotAccomplished = (e: any) => log.push(['notDone', e.taskId, e.reason])
if (sc.failureMatcher) opts.semanticFailureMatcher = async () => sc.failureMatcher
if (sc.constraintJudge) opts.semanticConstraintJudge = async () => sc.constraintJudge
if (sc.semanticHypotheses) { opts.semanticHypotheses = async () => sc.semanticHypotheses; opts.onSemanticHypothesis = (e: any) => log.push(['semHyp', e.kind, e.id ?? (e.hypotheses ?? []).map((h: any) => h.id).join(',')]) }
if (sc.hypothesisJudge) opts.semanticHypothesisJudge = async () => sc.hypothesisJudge
if (sc.criterionCoverage !== undefined) opts.semanticCriterionCoverage = async (c: string) => { log.push(['coverage', c]); return sc.criterionCoverage }
if (sc.tokenBudget) opts.tokenBudget = { total: sc.tokenBudget.total, used: () => { if (sc.tokenBudget.throws) throw new Error('reader down'); return sc.tokenBudget.used } }
if (sc.reviewerRevision) { opts.reviewerRevision = () => sc.reviewerRevision; opts.onReviewerRevision = (e: any) => log.push(['revision', e.taskId, e.note]) }
if (sc.update) {
  let delivered = false
  opts.updateChannel = { poll: async () => { if (delivered) return null; delivered = true; return { pending_update: sc.update, constraints_changed: true } } }
}

function round(n: number) { return Math.round(n * 1e6) / 1e6 }

try {
  const outcome: any = await new HarnessRuntime().run(sc.objective ?? 'objective', sc.criteria ?? [], opts)
  const r = outcome.result
  const s = r.initResult
  process.stdout.write(JSON.stringify({
    outcome: 'complete',
    nodeOrder: r.nodeExecutionOrder,
    hookLog: log,
    constraints: s.callerState.current_constraints,
    failureMatch: s.failureDiagnostics.matched_pattern?.failure_class ?? null,
    stepsUsed: r.stepsUsed,
    tasks: s.taskGraph.tasks.map((t: any) => [t.id, t.status]),
    finalResult: r.finalResult ?? null,
    strategy: {
      current: s.strategyState.current_strategy,
      switchCount: s.strategyState.switch_count,
      completionHistory: s.strategyState.completion_history,
      riskStateHistory: s.strategyState.risk_state_history,
      switchTriggers: s.strategyState.switch_triggers,
    },
    failureClasses: s.failureDiagnostics.failure_history.map((f: any) => f.failure_class),
    beliefs: s.worldModel.beliefs.map((b: any) => b.statement),
    observationSources: s.worldModel.observations.map((o: any) => o.source),
    contradictions: s.worldModel.contradictions.length,
    controlState: { permission: s.controlState.permission, mode: s.controlState.execution_mode, escalation: s.controlState.escalation },
    activeHypotheses: s.hypothesisSet.active.length,
    journal: s.memoryState.journal.map((j: any) => [j.step, j.action_class, j.outcome]),
    tokenBudget: [s.memoryState.token_budget.total, s.memoryState.token_budget.used],
    generationId: s.worldModel.generation_id,
    diagnostics: {
      progress: round(s.diagnostics.execution_health.progress_rate),
      feasibility: round(s.diagnostics.verification_health.feasibility),
    },
  }))
} catch (err: any) {
  if (err?.name === 'OutputContractError') {
    process.stdout.write(JSON.stringify({ outcome: 'error', hookLog: log, kind: 'OutputContractError', dimension: err.violatedDimension, violations: err.violations }))
    process.exit(0)
  }
  if (!(err instanceof EscalationHalt)) throw err
  process.stdout.write(JSON.stringify({
    outcome: 'halt',
    hookLog: log,
    reason: err.blocker.reason,
    missingInfo: err.blocker.missing_info,
    summary: err.blocker.current_task_summary,
    hasQuestion: !!(err.blocker.question || err.blocker.questions),
  }))
}
