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

export { bareArm }

export type ArmName = 'baseline' | 'bare' | 'langgraph' | 'flagOn' | 'supervisorOn'

/** Builds the LLM client for one task, given its real workspace directory. */
export type MakeLlm = (opts: { workspaceRoot: string; task: TaskSpec }) => ILLMClient

export interface Arm {
  name: ArmName
  label: string
  run(task: TaskSpec, makeLlm: MakeLlm): Promise<ArmTurnOutput | null>
}

async function runAssistant(
  task: TaskSpec,
  makeLlm: MakeLlm,
  oneLoopMode: 'enabled' | 'disabled',
  supervisor = false,
): Promise<ArmTurnOutput | null> {
  if (task.tools.web) return null // web arm not wired — see eval/README.md

  // The trajectory supervisor (plans/harness_trajectory_supervisor_plan.html) is gated on this
  // env flag in both twins. Arms run sequentially (runner.ts), so a set/restore around the turn
  // is safe. NOTE: until the S5 follow-up wires `supervisorDecider` into harness-bridge.ts, this
  // flag has no observable effect from the PA path — `supervisorOn` is currently ≡ `flagOn`.
  const priorFlag = process.env.HARNESS_TRAJECTORY_SUPERVISOR
  if (supervisor) process.env.HARNESS_TRAJECTORY_SUPERVISOR = 'enabled'
  try {
    return await runAssistantInner(task, makeLlm, oneLoopMode)
  } finally {
    if (supervisor) {
      if (priorFlag === undefined) delete process.env.HARNESS_TRAJECTORY_SUPERVISOR
      else process.env.HARNESS_TRAJECTORY_SUPERVISOR = priorFlag
    }
  }
}

async function runAssistantInner(
  task: TaskSpec,
  makeLlm: MakeLlm,
  oneLoopMode: 'enabled' | 'disabled',
): Promise<ArmTurnOutput | null> {

  const ws = makeWorkspace(task)
  const declaredPaths = task.workspace.map((f) => f.path)

  let backend = ws.backend
  let firedProbe: (() => boolean) | undefined
  if (task.injectedFailure === 'first_tool_call_throws') {
    const wrapped = withFirstReadFailure(ws.backend)
    backend = wrapped.backend
    firedProbe = wrapped.fired
  }

  const ctx = buildToolContexts(task, ws, backend)
  const assistant = new PersonalAssistant({
    llmClient: makeLlm({ workspaceRoot: ws.root, task }),
    memory: new InMemoryAdapter({ scope: 'thread', namespace: `eval-mem-${task.id}` }),
    checkpointStore: new InMemoryAdapter({ scope: 'thread', namespace: `eval-ckpt-${task.id}` }),
    fileTools: ctx.fileTools,
    shellTools: ctx.shellTools,
    oneLoopMode,
  })

  const started = Date.now()
  try {
    const result = await assistant.turn(task.prompt, { sessionId: `eval-${task.id}` })
    const out: ArmTurnOutput = {
      reply: result.reply ?? '',
      status: result.status,
      answerClaimStatus: result.answerClaim?.verification_status,
      workspaceAfter: ws.snapshot(declaredPaths),
      stagedMutation: result.status === 'needs_approval' || result.pendingActionId !== undefined,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      costUsd: result.usage?.costUsd,
      latencyMs: Date.now() - started,
      injectedFailureFired: firedProbe?.(),
    }
    return out
  } catch (err) {
    return {
      reply: '',
      status: 'error',
      workspaceAfter: ws.snapshot(declaredPaths),
      stagedMutation: false,
      latencyMs: Date.now() - started,
      errorMessage: err instanceof Error ? err.message : String(err),
      injectedFailureFired: firedProbe?.(),
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
  // Not in IMPLEMENTED_ARMS yet: the S5 follow-up (wire `supervisorDecider` into harness-bridge.ts)
  // must land before this arm diverges from `flagOn`. Select it explicitly with
  // `--arms=baseline,supervisorOn` once that wiring exists. See plan S5 "Still TODO" + S7.
  run: (task, makeLlm) => runAssistant(task, makeLlm, 'enabled', true),
}

export const langgraphArm: Arm = {
  name: 'langgraph',
  label: 'Equivalent FlowSpec compiled to LangGraph (not implemented — separate Python runner)',
  run: async () => {
    throw new Error('langgraph arm not implemented — Plan Phase B follow-on (adapter/eval/)')
  },
}

export const IMPLEMENTED_ARMS: Arm[] = [baselineArm, flagOnArm, bareArm]
export const ALL_ARMS: Arm[] = [baselineArm, flagOnArm, bareArm, supervisorOnArm, langgraphArm]
