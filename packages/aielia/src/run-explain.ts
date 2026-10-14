import type { AssistantTrace, AssistantSource, AssistantTurnResult } from './assistant.js'
import type { AnswerClaim } from './answer-claim.js'
import type { MemoryInjection } from './memory-service.js'
import type { AssistantToolStep } from './tool-step.js'
import { summarizeSettledToolStep } from './tool-step.js'
import { formatMemoryInjection } from './cli-session.js'
import { lowerConfidenceSourceLines } from './source-reliability.js'
import { buildWhyChain, LAYER_ORDER, LAYER_DISPLAY_NAME } from './node-display-names.js'

/**
 * The one place that explains a finished turn ("why", "layers", "sources", "steps", "plan").
 * The CLI prints these lines and chat-ui shows the same lines in a panel, so what the user is told
 * about a turn cannot drift between surfaces. Everything here is a pure function of data the turn
 * already produced — no I/O, no UI.
 */

/** What a surface remembers about the last turn. All fields are optional: a staged, declined or fast-path turn has no trace. */
export interface TurnExplainInput {
  trace?: AssistantTrace
  /** True when the turn skipped the harness entirely (a self-contained trivial question). */
  harnessSkipped?: boolean
  /** Why there is no trace, when the surface knows a more specific reason than the generic one. */
  noTraceReason?: string
  answerClaim?: AnswerClaim
  memoryInjection?: MemoryInjection
  sources?: AssistantSource[]
  toolSteps?: AssistantToolStep[]
  planStatus?: AssistantTurnResult['planStatus']
}

export const FAST_PATH_REASON =
  'No harness trace — the last turn was a simple, self-contained question answered directly without activating the harness (fast path).'
export const GENERIC_NO_TRACE_REASON = 'No harness trace for the last turn (nothing to explain yet, or it took the fast path).'
export const NO_SOURCES_TEXT = 'No sources for the last turn (it used no file/web tool calls).'
export const NO_STEPS_TEXT = 'No tool steps for the last turn.'
export const NO_PLAN_TEXT = 'No active plan for this session.'

/** Slash commands that open the explanations. Shared so the CLI's dispatch table and chat-ui's composer recognise the same words. */
export const EXPLAIN_COMMANDS = ['/why', '/layers', '/sources', '/steps', '/plan'] as const
export type ExplainCommand = (typeof EXPLAIN_COMMANDS)[number]

// Buckets the harness's 0–1 verification scores into plain language rather than surfacing raw floats — this is a confidence readout, not a debug metric.
export function verificationHealthLabel({ strength, feasibility }: AssistantTrace['verificationHealth']): string {
  const confidence = Math.min(strength, feasibility)
  if (confidence >= 0.7) return 'High confidence'
  if (confidence >= 0.4) return 'Reasonably confident'
  return 'Worth double-checking'
}

/**
 * Turns AnswerClaim's mechanically-derived verification_status into the "this is true" vs "I found X
 * but couldn't independently verify it" text. One pure function so a future change can't silently
 * collapse the four branches back into one generic phrasing.
 */
export function answerClaimLabel(claim: AnswerClaim): string {
  switch (claim.verification_status) {
    case 'verified':
      return 'Checked against the source material I read — the reply matches it.'
    case 'unverified_attempted':
      if (claim.grounding_note) return `I found evidence for this, but the reply doesn't fully match it: ${claim.grounding_note}`
      return "I found evidence for this, but couldn't independently verify it."
    case 'contradicted':
      return 'This conflicts with something I already believe — worth double-checking.'
    case 'no_evidence':
      return 'This is my own reasoning, not backed by anything I looked up.'
  }
}

type BatchBudget = NonNullable<AssistantTrace['batchBudget']>

/** One-line found / not found / truncated tally for a batch-research turn (absent on every other turn). */
export function batchBudgetSummaryLine(batchBudget: BatchBudget): string {
  const count = (status: BatchBudget['perItemOutcomes'][number]['status']): number => batchBudget.perItemOutcomes.filter((o) => o.status === status).length
  return (
    `Batch: ${batchBudget.itemCount} items — ${count('found')} found, ${count('not_found')} not found, ${count('truncated_while_productive')} truncated ` +
    `(${batchBudget.totalCallsUsed} calls used, projected ~${Math.ceil(batchBudget.projectedTotal)})`
  )
}

const BATCH_STATUS_ICON: Record<BatchBudget['perItemOutcomes'][number]['status'], string> = {
  found: '✓', not_found: '✗', truncated_while_productive: '~',
}

const PLAN_TASK_STATUS_ICON: Record<string, string> = {
  PENDING: '○', RUNNING: '▶', COMPLETE: '✓', FAILED: '✗', BLOCKED: '✗', HUMAN_REQUIRED: '~',
}

const SOURCE_TOOL_LABEL: Record<AssistantSource['tool'], string> = {
  read_file: 'Read',
  list_directory: 'Listed',
  web_search: 'Searched',
  fetch_url: 'Fetched',
}

// web_search/fetch_url pull in untrusted external content (see trust-tagging.ts) — flagged so a reply's sources make clear which ones the assistant doesn't vouch for the same way it does its own workspace files.
const EXTERNAL_SOURCE_TOOLS: ReadonlySet<AssistantSource['tool']> = new Set(['web_search', 'fetch_url'])

/** The trace to explain: a fast-path turn has none, even if a surface kept an empty placeholder. */
function effectiveTrace(input: TurnExplainInput): AssistantTrace | undefined {
  return input.harnessSkipped ? undefined : input.trace
}

function noTraceReason(input: TurnExplainInput): string {
  return input.noTraceReason ?? (input.harnessSkipped ? FAST_PATH_REASON : GENERIC_NO_TRACE_REASON)
}

/** `/why` — confidence, whether the reply was checked against what was read, the layers that fired (in order), and what memory the prompt held. */
export function explainWhy(input: TurnExplainInput): string[] {
  const memoryLine = formatMemoryInjection(input.memoryInjection)
  const trace = effectiveTrace(input)
  if (!trace) return [noTraceReason(input), memoryLine]
  const lines = [verificationHealthLabel(trace.verificationHealth)]
  if (input.answerClaim) {
    lines.push(answerClaimLabel(input.answerClaim), ...lowerConfidenceSourceLines(input.answerClaim))
  }
  // Only the layers that actually fired, each once and in the order they first fired — quiet otherwise, matching the "don't badge LOW risk" convention. /layers shows all 11.
  const chain = buildWhyChain(trace.layerActivity).filter((item, i, all) => all.findIndex((other) => other.layer === item.layer) === i)
  if (chain.length > 0) {
    lines.push('What I checked:')
    for (const item of chain) lines.push(`  ${LAYER_DISPLAY_NAME[item.layer]}: ${item.reason}`)
    lines.push('(/layers shows every layer, /sources shows what was read.)')
  }
  if (trace.batchBudget) lines.push(batchBudgetSummaryLine(trace.batchBudget))
  lines.push(memoryLine)
  return lines
}

/** `/layers` — every one of the 11 layers: fired or not, and why; plus the per-item batch breakdown on a batch turn. */
export function explainLayers(input: TurnExplainInput): string[] {
  const trace = effectiveTrace(input)
  if (!trace) return [noTraceReason(input)]
  const byLayer = new Map(trace.layerActivity.map((e) => [e.layer, e]))
  const lines = LAYER_ORDER.map((layer) => {
    const e = byLayer.get(layer)
    return `[${e?.fired ? '✓' : '·'}] ${LAYER_DISPLAY_NAME[layer].padEnd(22)} ${e?.reason ?? 'not evaluated this turn'}`
  })
  if (trace.batchBudget) {
    lines.push('', batchBudgetSummaryLine(trace.batchBudget))
    for (const o of trace.batchBudget.perItemOutcomes) lines.push(`  [${BATCH_STATUS_ICON[o.status]}] ${o.item.padEnd(30)} ${o.status} (${o.callsUsed} calls)`)
  }
  return lines
}

/** `/sources` — the files and URLs the turn consulted, each once. */
export function explainSources(input: TurnExplainInput): string[] {
  const unique = (input.sources ?? []).filter((s, i, all) => all.findIndex((o) => o.tool === s.tool && o.path === s.path) === i)
  if (unique.length === 0) return [NO_SOURCES_TEXT]
  return unique.map((s) => `- ${SOURCE_TOOL_LABEL[s.tool]} ${s.path}${EXTERNAL_SOURCE_TOOLS.has(s.tool) ? ' (external)' : ''}`)
}

/** `/steps` — the tool calls the turn made, in order. */
export function explainSteps(input: TurnExplainInput): string[] {
  const steps = input.toolSteps ?? []
  if (steps.length === 0) return [NO_STEPS_TEXT]
  return steps.map((step, i) => `${i + 1}. ${step.deniedReason ? step.summary : summarizeSettledToolStep(step.tool, step.input)}`)
}

/** `/plan` — the active plan's task checklist. */
export function explainPlan(input: TurnExplainInput): string[] {
  const plan = input.planStatus
  if (!plan) return [NO_PLAN_TEXT]
  return [
    `Plan: ${plan.templateName ?? 'custom plan'} (${plan.completionPct.toFixed(1)}% complete)`,
    ...plan.tasks.flatMap((task) => [
      `  ${PLAN_TASK_STATUS_ICON[task.status] ?? '?'} [${task.status}] ${task.id} — ${task.description}`,
      ...(task.note ? [`      not accepted as done: ${task.note}`] : []),
    ]),
    `Success criteria: ${plan.successCriteria}`,
  ]
}

/** Dispatches a bare slash command to its explainer; undefined for anything else (including `/plan graph` and other arguments, which are not explanations). */
export function explainCommand(message: string, input: TurnExplainInput): string[] | undefined {
  switch (message.trim()) {
    case '/why': return explainWhy(input)
    case '/layers': return explainLayers(input)
    case '/sources': return explainSources(input)
    case '/steps': return explainSteps(input)
    case '/plan': return explainPlan(input)
    default: return undefined
  }
}
