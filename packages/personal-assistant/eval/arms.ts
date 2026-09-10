/**
 * Benchmark arms. An arm takes a task + a per-task LLM-client factory and produces an
 * `ArmTurnOutput` the grader can score. Same model, same tools across arms — the arm is the
 * independent variable.
 *
 * The client is built per task (given the task's real temp `workspaceRoot`) because the
 * `claude-cli` backend needs to know the workspace up front to wire its out-of-process MCP file
 * server. `MakeLlm` is that factory.
 *
 * Implemented:
 *   - `baseline` / `flagOn` — `PersonalAssistant` (harness runs post-hoc; identical until a phase
 *     ships a flag, at which point `flagOn` sets it).
 *   - `bare` — a minimal ReAct loop, no harness, no staging (see bare-arm.ts).
 * Declared, not built (Plan Phase B follow-on — see eval/README.md):
 *   - `langgraph` — the equivalent FlowSpec compiled to LangGraph (Python; separate runner).
 */
import type { ILLMClient } from '@buildaharness/runtime'
import { InMemoryAdapter } from '@buildaharness/runtime'
import { PersonalAssistant } from '../src/assistant.js'
import type { TaskSpec } from './corpus/schema.js'
import type { ArmTurnOutput } from './graders.js'
import { buildToolContexts, makeWorkspace, withFirstReadFailure } from './fixtures.js'
import { bareArm } from './bare-arm.js'
import { wrapRecordingClient, mergeTranscriptEvents, scrubSecrets, type TranscriptEvent } from './transcript-capture.js'

export { bareArm }

export type ArmName =
  | 'baseline'
  | 'bare'
  | 'langgraph'
  | 'flagOn'
  | 'supervisorOn'
  | 'contradictionOff'
  | 'injectionDetectOff'
  | 'failureMatchOff'

/** Builds the LLM client for one task, given its real workspace directory. */
export type MakeLlm = (opts: { workspaceRoot: string; task: TaskSpec }) => ILLMClient

export interface Arm {
  name: ArmName
  label: string
  run(task: TaskSpec, makeLlm: MakeLlm): Promise<ArmTurnOutput | null>
}

export type InjectedFailureKind = NonNullable<TaskSpec['injectedFailure']>

/** Arms that run the R2–R4 harness-driven proposer (`oneLoopMode === 'enabled'`). */
const ONE_LOOP_ARMS: readonly ArmName[] = [
  'flagOn',
  'supervisorOn',
  'contradictionOff',
  'injectionDetectOff',
  'failureMatchOff',
]

/**
 * Whether a corpus task's `injectedFailure` mechanism actually fires for `arm` under the
 * **claude-cli backend the benchmark runs on**. Both mechanisms are simulated *above* the fs
 * backend, so neither is a real filesystem error the model retries past:
 *
 *   - `persistent_tool_failure` — `wrapProposerWithInjectedFailure` (assistant.ts:619) wraps the
 *     one-loop proposer; it is a no-op with no `oneLoopProposer`, i.e. for `bare` and for the
 *     pre-one-loop `baseline` path.
 *   - `first_tool_call_throws` — `withFirstReadFailure` (fixtures.ts) wraps the `FsBackend`, which
 *     claude-cli's out-of-process MCP reads never touch. Fires for no arm here (the wrapper is
 *     kept only for proxy-backend unit tests).
 *
 * A benchmark comparison is only fair if every arm in it can honour a task's injected failure —
 * otherwise one arm is stress-tested and the other runs clean. `runBenchmark` (runner.ts) skips
 * a task that fails this for any arm in the run and records it in `report.skippedForAsymmetry`.
 * See plans/feature_audit_fair_comparison_plan.html (Defect 1 / F0).
 */
export function armHonorsInjectedFailure(arm: ArmName, kind: InjectedFailureKind): boolean {
  if (kind === 'persistent_tool_failure') return ONE_LOOP_ARMS.includes(arm)
  // 'first_tool_call_throws' — proxy-backend fs wrapper, inert under claude-cli for every arm.
  return false
}

interface RunArmOpts {
  /** Sets HARNESS_TRAJECTORY_SUPERVISOR=enabled around the turn — the `supervisorOn` arm. */
  supervisor?: boolean
  /**
   * Extra env vars set (and restored) around the turn — a Batch B audit arm toggles exactly one
   * feature flag this way. E.g. `{ AUDIT_SEMANTIC_CONTRADICTION: '0' }` for `contradictionOff`.
   */
  env?: Record<string, string>
}

async function runAssistant(
  task: TaskSpec,
  makeLlm: MakeLlm,
  oneLoopMode: 'enabled' | 'disabled',
  opts: RunArmOpts = {},
): Promise<ArmTurnOutput | null> {
  if (task.tools.web) return null // web arm not wired — see eval/README.md

  // Feature flags are gated on env vars, read in both twins (the trajectory supervisor —
  // plans/harness_trajectory_supervisor_plan.html — and the Batch B audit arms —
  // plans/feature_audit_automation_plan.html). Arms run sequentially (runner.ts), so a
  // set/restore around the turn is safe. harness-bridge.ts reads these flags to decide which
  // host hooks to wire, so e.g. `supervisorOn` / `contradictionOff` genuinely diverge from
  // `flagOn` — the differential is one feature.
  const overrides: Record<string, string> = { ...opts.env }
  if (opts.supervisor) overrides.HARNESS_TRAJECTORY_SUPERVISOR = 'enabled'
  const prior: Record<string, string | undefined> = {}
  for (const key of Object.keys(overrides)) {
    prior[key] = process.env[key]
    process.env[key] = overrides[key]
  }
  try {
    return await runAssistantInner(task, makeLlm, oneLoopMode)
  } finally {
    for (const key of Object.keys(overrides)) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
  }
}

async function runAssistantInner(
  task: TaskSpec,
  makeLlm: MakeLlm,
  oneLoopMode: 'enabled' | 'disabled',
): Promise<ArmTurnOutput | null> {

  const ws = makeWorkspace(task)
  const declaredPaths = [
    ...task.workspace.map((f) => f.path),
    ...task.followups.flatMap((fu) => fu.addWorkspace.map((f) => f.path)),
  ]

  let backend = ws.backend
  let firedProbe: (() => boolean) | undefined
  if (task.injectedFailure === 'first_tool_call_throws') {
    const wrapped = withFirstReadFailure(ws.backend)
    backend = wrapped.backend
    firedProbe = wrapped.fired
  }

  const ctx = buildToolContexts(task, ws, backend)

  // INV-22 / S7 signal: count Trajectory Supervisor consults this turn (one
  // layer_activity:'supervisor' event per stall-edge consult — harness-bridge.ts).
  let supervisorConsults = 0
  const supervisorDirectives: string[] = []

  // Plan A1 — full-conversation capture. The recording client records every LLM request/response;
  // onTrace + onDebugLog carry the trace + real tool content; all three are time-merged below.
  const recording = wrapRecordingClient(makeLlm({ workspaceRoot: ws.root, task }))
  const sideEvents: TranscriptEvent[] = []

  const assistant = new PersonalAssistant({
    llmClient: recording.client,
    memory: new InMemoryAdapter({ scope: 'thread', namespace: `eval-mem-${task.id}` }),
    checkpointStore: new InMemoryAdapter({ scope: 'thread', namespace: `eval-ckpt-${task.id}` }),
    fileTools: ctx.fileTools,
    shellTools: ctx.shellTools,
    oneLoopMode,
    onTrace: (e) => {
      sideEvents.push({ t: Date.now(), kind: 'trace', detail: e })
      if (e.kind === 'layer_activity' && e.layer === 'supervisor') {
        supervisorConsults += 1
        supervisorDirectives.push((e.reason ?? '').split(':')[0].trim())
      }
    },
    onDebugLog: (entry) => {
      sideEvents.push({ t: Date.now(), kind: 'debug', tool: entry.kind, result: scrubSecrets(entry.content) })
    },
  })
  const drainTranscript = (): TranscriptEvent[] => mergeTranscriptEvents(recording.drain(), sideEvents)

  // S7 stall induction — see benchmark-injected-failure.ts. Only meaningful on the
  // one-loop proposer path (oneLoopMode === 'enabled'); the wrapper's `onInjected` callback
  // fires only when it genuinely runs, which is the real `injectedFailureFired` signal (F2).
  const sessionId = `eval-${task.id}`
  let persistentFailureFired = false
  const injectedFor = (
    inj: TaskSpec['injectedFailure'],
    count: number | undefined,
  ): Parameters<typeof assistant.turn>[1] => {
    const o: Parameters<typeof assistant.turn>[1] = { sessionId }
    if (inj === 'persistent_tool_failure') {
      o.__benchmarkInjectedFailure = {
        failIterations: count ?? 1,
        seedFailures: 3,
        onInjected: () => {
          persistentFailureFired = true
        },
      }
    }
    return o
  }

  // Turn 1 = the task prompt; then each followup, sent to the same session.
  const turns = [
    { prompt: task.prompt, addWorkspace: [], injectedFailure: task.injectedFailure, injectedFailureCount: task.injectedFailureCount },
    ...task.followups,
  ]
  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
  let sawUsage = false

  const started = Date.now()
  try {
    let result: Awaited<ReturnType<typeof assistant.turn>> | undefined
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i]
      if (i > 0) {
        for (const f of t.addWorkspace) ws.addFile(f.path, f.content)
        sideEvents.push({ t: Date.now(), kind: 'trace', detail: { kind: 'turn_boundary', turn: i + 1, prompt: t.prompt } })
      }
      result = await assistant.turn(t.prompt, injectedFor(t.injectedFailure, t.injectedFailureCount))
      if (result.usage) {
        sawUsage = true
        usage.inputTokens += result.usage.inputTokens ?? 0
        usage.outputTokens += result.usage.outputTokens ?? 0
        usage.costUsd += result.usage.costUsd ?? 0
      }
    }
    if (!result) throw new Error('no turns executed')

    const out: ArmTurnOutput = {
      // An escalated turn has `reply: null` and puts its clarifying question / blocker
      // detail in `reason` — surface that as the gradable text so a clarification-slice
      // grader's question regex matches a structured escalation the same as an in-band ask.
      reply: result.reply ?? result.reason ?? '',
      status: result.status,
      escalationReason: result.status === 'escalated' ? result.reason : undefined,
      answerClaimStatus: result.answerClaim?.verification_status,
      workspaceAfter: ws.snapshot(declaredPaths),
      stagedMutation: result.status === 'needs_approval' || result.pendingActionId !== undefined,
      inputTokens: sawUsage ? usage.inputTokens : undefined,
      outputTokens: sawUsage ? usage.outputTokens : undefined,
      costUsd: sawUsage ? usage.costUsd : undefined,
      latencyMs: Date.now() - started,
      turns: turns.length,
      // F2: a real fired-signal only — `withFirstReadFailure`'s probe for `first_tool_call_throws`,
      // the injected-failure wrapper's `onInjected` for `persistent_tool_failure`. A task that
      // merely *declares* an injectedFailure the arm can't honour reports `undefined` here, so it
      // never inflates `recoveryRate`.
      injectedFailureFired: firedProbe ? firedProbe() : persistentFailureFired ? true : undefined,
      supervisorConsults,
      supervisorDirectives: supervisorDirectives.length > 0 ? supervisorDirectives : undefined,
      transcript: drainTranscript(),
    }
    return out
  } catch (err) {
    return {
      reply: '',
      status: 'error',
      workspaceAfter: ws.snapshot(declaredPaths),
      stagedMutation: false,
      latencyMs: Date.now() - started,
      turns: turns.length,
      errorMessage: err instanceof Error ? err.message : String(err),
      injectedFailureFired: firedProbe ? firedProbe() : persistentFailureFired ? true : undefined,
      supervisorConsults,
      transcript: drainTranscript(),
    }
  } finally {
    ws.cleanup()
  }
}

export const baselineArm: Arm = {
  name: 'baseline',
  label: "PersonalAssistant as shipped — harness runs post-hoc over the model's reply",
  run: (task, makeLlm) => runAssistant(task, makeLlm, 'disabled'),
}

export const flagOnArm: Arm = {
  name: 'flagOn',
  label: 'PersonalAssistant with ASSISTANT_ONE_LOOP=enabled (R2-R4 harness-driven proposer)',
  run: (task, makeLlm) => runAssistant(task, makeLlm, 'enabled'),
}

export const supervisorOnArm: Arm = {
  name: 'supervisorOn',
  label:
    'PersonalAssistant with HARNESS_TRAJECTORY_SUPERVISOR=enabled — the S7 supervisor-vs-no-supervisor differential arm',
  // Same one-loop config as `flagOn`; the only difference is the trajectory supervisor being
  // consulted on the cannotMakeProgress() stall edge. The Rule 6 comparison for the flag
  // default-on flip is `flagOn` vs `supervisorOn` (isolates the supervisor), run over the S7
  // `--slice=` corpus multi-seed — see eval/README.md.
  run: (task, makeLlm) => runAssistant(task, makeLlm, 'enabled', { supervisor: true }),
}

export const contradictionOffArm: Arm = {
  name: 'contradictionOff',
  label:
    'PersonalAssistant (flagOn) with AUDIT_SEMANTIC_CONTRADICTION=0 — the semantic contradiction-checker LLM call disabled, lexical pass only',
  // Batch B feature-value audit (plans/feature_audit_automation_plan.html A4). Same one-loop
  // config as `flagOn`; the only difference is harness-bridge.ts wiring no host
  // `contradictionChecker` hook, so the harness's always-on lexical / negation-pair check runs
  // alone. Baseline for this feature is `flagOn`; slice `audit_contradiction_semantic`.
  run: (task, makeLlm) => runAssistant(task, makeLlm, 'enabled', { env: { AUDIT_SEMANTIC_CONTRADICTION: '0' } }),
}

export const injectionDetectOffArm: Arm = {
  name: 'injectionDetectOff',
  label:
    'PersonalAssistant (flagOn) with AUDIT_LLM_INJECTION_DETECT=0 — the per-tool-output LLM injection-detection call disabled, deterministic regex/pattern pass only',
  // Batch B feature-value audit (plans/feature_audit_automation_plan.html A5). Same one-loop config
  // as `flagOn`; the only difference is trust-tagging.ts's detectInjectionLikelyWithLLM short-circuiting
  // after the regex pass instead of escalating to the LLM classifier on every fetched page / shell
  // output. Baseline for this feature is `flagOn`; slice `audit_injection_llm`.
  run: (task, makeLlm) => runAssistant(task, makeLlm, 'enabled', { env: { AUDIT_LLM_INJECTION_DETECT: '0' } }),
}

export const failureMatchOffArm: Arm = {
  name: 'failureMatchOff',
  label:
    'PersonalAssistant (flagOn) with AUDIT_SEMANTIC_FAILURE_MATCH=0 — the semantic failure-mode-matcher LLM call disabled, FailureModeLibrary.match() exact-string-overlap only',
  // Batch B feature-value audit (plans/feature_audit_automation_plan.html A6). Same one-loop config
  // as `flagOn`; the only difference is harness-bridge.ts wiring no host `semanticFailureMatcher`
  // hook, so the harness classifies a failure only when an observed symptom string overlaps a
  // curated one byte-for-byte. Baseline for this feature is `flagOn`; slice
  // `audit_failure_match_semantic`.
  run: (task, makeLlm) => runAssistant(task, makeLlm, 'enabled', { env: { AUDIT_SEMANTIC_FAILURE_MATCH: '0' } }),
}

export const langgraphArm: Arm = {
  name: 'langgraph',
  label: 'Equivalent FlowSpec compiled to LangGraph (not implemented — separate Python runner)',
  run: async () => {
    throw new Error('langgraph arm not implemented — Plan Phase B follow-on (adapter/eval/)')
  },
}

export const IMPLEMENTED_ARMS: Arm[] = [
  baselineArm,
  flagOnArm,
  bareArm,
  supervisorOnArm,
  contradictionOffArm,
  injectionDetectOffArm,
  failureMatchOffArm,
]
export const ALL_ARMS: Arm[] = [
  baselineArm,
  flagOnArm,
  bareArm,
  supervisorOnArm,
  contradictionOffArm,
  injectionDetectOffArm,
  failureMatchOffArm,
  langgraphArm,
]
