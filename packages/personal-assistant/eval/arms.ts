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
 * Declared, not built (Plan Phase B follow-on — see eval/README.md):
 *   - `bare`      — a minimal ReAct loop, no harness.
 *   - `langgraph` — the equivalent FlowSpec compiled to LangGraph (Python; separate runner).
 */
import type { ILLMClient } from '@buildaharness/runtime'
import { InMemoryAdapter } from '@buildaharness/runtime'
import { PersonalAssistant } from '../src/assistant.js'
import type { TaskSpec } from './corpus/schema.js'
import type { ArmTurnOutput } from './graders.js'
import { buildToolContexts, makeWorkspace, withFirstReadFailure } from './fixtures.js'

export type ArmName = 'baseline' | 'bare' | 'langgraph' | 'flagOn'

/** Builds the LLM client for one task, given its real workspace directory. */
export type MakeLlm = (opts: { workspaceRoot: string; task: TaskSpec }) => ILLMClient

export interface Arm {
  name: ArmName
  label: string
  run(task: TaskSpec, makeLlm: MakeLlm): Promise<ArmTurnOutput | null>
}

async function runAssistant(task: TaskSpec, makeLlm: MakeLlm): Promise<ArmTurnOutput | null> {
  if (task.tools.web) return null // web arm not wired — see eval/README.md

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
  run: runAssistant,
}

export const flagOnArm: Arm = {
  name: 'flagOn',
  label: 'PersonalAssistant with the current phase flag on (identical to baseline until a flag exists)',
  run: runAssistant,
}

export const bareArm: Arm = {
  name: 'bare',
  label: 'Minimal ReAct loop, no harness (not implemented — Plan Phase B follow-on)',
  run: async () => {
    throw new Error('bare arm not implemented — Plan Phase B follow-on')
  },
}

export const langgraphArm: Arm = {
  name: 'langgraph',
  label: 'Equivalent FlowSpec compiled to LangGraph (not implemented — separate Python runner)',
  run: async () => {
    throw new Error('langgraph arm not implemented — Plan Phase B follow-on (adapter/eval/)')
  },
}

export const IMPLEMENTED_ARMS: Arm[] = [baselineArm, flagOnArm]
export const ALL_ARMS: Arm[] = [baselineArm, flagOnArm, bareArm, langgraphArm]
