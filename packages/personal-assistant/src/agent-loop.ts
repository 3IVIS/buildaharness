import { Budget } from '@buildaharness/harness'
import type {
  MemoryAdapter,
  ILLMClient,
  ChatMessage,
  TokenUsage,
  ToolDefinition,
  ReminderStore,
} from '@buildaharness/runtime'
import type { AssistantSource } from './assistant-source.js'
import type { DebugLogEntry } from './debug-log.js'
import type { TraceEvent } from './trace-events.js'
import type { TurnIntentClassification } from './turn-intent-classifier.js'
import { evaluateToolPolicy } from './tool-policy.js'
import { createTurnControlPlaneState, recordToolOutcome, type TurnControlPlaneState } from './tool-control-plane.js'
import { classifyToolYield, type ToolYield } from './tool-yield-classifier.js'
import {
  FILE_TOOLS,
  executeFileTool,
  type FileToolsContext,
  type ShellExecutionResult,
} from './file-tools.js'
import { WEB_TOOLS, executeWebTool, type WebToolsContext } from './web-tools.js'
import { SHELL_TOOLS, executeShellTool, commandMayLeaveWorkspace, type ShellToolsContext } from './shell-tools.js'
import { ACTION_TOOLS, executeActionTool, type ActionToolsContext } from './action-tools.js'
import { formatEmailApprovalReason } from './email.js'
import { REMINDER_TOOLS, executeReminderTool } from './reminder-tools.js'
import { wrapUntrusted, detectInjectionLikelyWithLLM } from './trust-tagging.js'
import { summarizeToolStep, type AssistantToolStep } from './tool-step.js'

export type ToolLoopResult =
  | { kind: 'final'; content: string; sources: AssistantSource[]; batchBudget?: BatchBudgetTrace }
  | { kind: 'needs_approval'; reason: string; pendingActionId: string; pendingActionKind: 'write' | 'shell' | 'email' | 'batch' }
  | { kind: 'escalated'; reason: string }

// Batch-research tuning constants (dynamic tool-call budget for batch research tasks): a
// self-calibrating alternative to the flat maxSteps cap for the one task shape that needs it —
// an explicit list of N similar lookup targets in one turn. See
// plans/personal_assistant_dynamic_tool_budget_plan.html for the reasoning behind each value.
const BATCH_PROBE_ITEM_CAP = 10 // generous fixed cap for the probe items, before calibration exists yet
const BATCH_PER_ITEM_FLOOR = 2 // never project a per-item budget below this — a cheap probe item can't starve the rest
const BATCH_SLACK_FACTOR = 1.4 // headroom multiplier over the calibrated average
const BATCH_LARGE_PROJECTION_THRESHOLD = 25 // a projection above this needs confirmation before spending it
const BATCH_ABSOLUTE_TURN_CEILING = 40 // hard stop regardless of how favorable calibration looks
const BATCH_DEAD_END_WINDOW = 3 // consecutive dead_end web_search/fetch_url results (see classifyToolYield) before an item's sub-loop gives up early instead of spending its whole per-item budget on a dead page

/** Per-item calibration inputs — see nextItemBudget. */
export interface BatchBudgetState {
  callsPerItemHistory: number[]
  perItemFloor: number
  slackFactor: number
  absoluteTurnCeiling: number
}

/**
 * Drops one min and one max before averaging once there are enough samples for that to be
 * meaningful (fewer than 3 just averages plain) — so a single unusually cheap or expensive item
 * can't swing the projection to either extreme on its own.
 */
export function trimmedAverage(counts: number[]): number {
  if (counts.length === 0) return 0
  if (counts.length < 3) return counts.reduce((sum, c) => sum + c, 0) / counts.length
  const sorted = [...counts].sort((a, b) => a - b)
  const trimmed = sorted.slice(1, -1)
  return trimmed.reduce((sum, c) => sum + c, 0) / trimmed.length
}

/** Budget for the next item to resolve — floored so a suspiciously cheap item can't starve the
 * rest, with slack headroom on top of the calibrated average. */
export function nextItemBudget(state: BatchBudgetState): number {
  const average = Math.max(state.perItemFloor, trimmedAverage(state.callsPerItemHistory))
  return Math.ceil(average * state.slackFactor)
}

/**
 * One batch item's outcome from its own per-item sub-loop (see resolveBatchItem). `exhausted`
 * means the sub-loop ran out of its budget without the model producing a final answer for this
 * item. `status` distinguishes *why* a non-'found' outcome happened: 'not_found' covers both the
 * item-scoped dead-end window tripping early (BATCH_DEAD_END_WINDOW consecutive dead_end tool
 * results) and a needs_approval bail-out; 'truncated_while_productive' means the budget ran out
 * while the trailing window was still turning up plausibly-relevant content.
 */
export interface BatchItemResolution {
  item: string
  content: string
  callsUsed: number
  exhausted: boolean
  status: 'found' | 'not_found' | 'truncated_while_productive'
  sources: AssistantSource[]
}

/**
 * Persisted across the confirmation round trip (see runBatchToolLoop's confirmation gate and
 * ActionApprovalService.resolvePendingBatchConfirmation) so approving resumes with the probe
 * items' real results intact instead of re-probing them, and declining can still return those
 * real results instead of discarding them.
 */
export interface BatchPendingState {
  userMessage: string
  systemPrompt: string
  sessionId: string
  probedResults: BatchItemResolution[]
  remainingItems: string[]
  /** The projection computed at the confirmation gate — carried across the round trip so the
   * resume/decline paths can report the same number in the batch trace instead of re-deriving
   * it (or leaving it absent) after the fact. */
  projectedTotal: number
}

/**
 * Present only when the batch-research path (batch-list-detector.ts / runBatchToolLoop) drove
 * this turn — absent otherwise, same "absent when unused" convention as sources/usage. Turns
 * `should we raise the ceiling/floor/slack factor` from a guess into a measurement.
 */
export interface BatchBudgetTrace {
  itemCount: number
  callsPerItemHistory: number[]
  projectedTotal: number
  totalCallsUsed: number
  perItemOutcomes: { item: string; status: 'found' | 'not_found' | 'truncated_while_productive'; callsUsed: number }[]
}

/** Builds a batch trace from a batch turn's resolved items — shared by runBatchToolLoop's direct
 * path and both resolvePendingBatchConfirmation outcomes (see ActionApprovalService). */
export function buildBatchBudgetTrace(
  itemCount: number,
  projectedTotal: number,
  resolutions: BatchItemResolution[],
): BatchBudgetTrace {
  return {
    itemCount,
    callsPerItemHistory: resolutions.map((r) => r.callsUsed),
    projectedTotal,
    totalCallsUsed: resolutions.reduce((sum, r) => sum + r.callsUsed, 0),
    perItemOutcomes: resolutions.map((r) => ({ item: r.item, status: r.status, callsUsed: r.callsUsed })),
  }
}

// Some OpenAI-compatible providers/models (observed live: OpenRouter's z-ai/glm-5.2) don't
// reliably populate the structured tool_calls field even when they intend to call a tool —
// they emit their own inline pseudo-XML tool-call syntax as plain content instead (e.g.
// `<tool_call>web_search<arg_key>query</arg_key><arg_value>...</arg_value></tool_call>`).
// parseToolCalls (openai-compatible-client.ts) only ever reads the structured field, so that
// content would otherwise look like an ordinary "no more tool calls" final answer and get
// shown to the user as raw tags instead of a real reply. Detected below and never surfaced.
const UNPARSED_TOOL_CALL_PATTERN = /<tool_call>/i

function looksLikeUnparsedToolCall(content: string): boolean {
  return UNPARSED_TOOL_CALL_PATTERN.test(content)
}

function previewContent(content: string, maxLines = 20): string {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return content
  return `${lines.slice(0, maxLines).join('\n')}\n… (truncated)`
}

/**
 * Builds the shell approval prompt text shared by both the claude-cli backend's `__staged_action`
 * path and the proxy backend's direct executeShellTool path — one function, so the
 * commandMayLeaveWorkspace heads-up applies identically regardless of backend. See
 * commandMayLeaveWorkspace's doc comment (shell-tools.ts) for exactly what it does and doesn't
 * catch.
 */
function shellApprovalReason(command: string, cwd: string): string {
  const base = `Proposes running: ${command}\n  (cwd: ${cwd})`
  if (!commandMayLeaveWorkspace(command)) return base
  return (
    `${base}\n  [Warning: this command references a path outside its working directory — unlike file writes, ` +
    'shell commands are not filesystem-sandboxed once approved; approval is the only gate.]'
  )
}

/** Formats a shell-cache hit (see file-tools.ts's ShellCacheEntry) as a tool result the model can
 * answer a follow-up question from, worded so it's unambiguous that nothing new was executed. */
function formatCachedShellResult(command: string, cwd: string, execution: ShellExecutionResult): string {
  const output = execution.output || '(no output)'
  return (
    `Already ran \`${command}\` in "${cwd}" earlier in this conversation (exit code ${execution.exitCode ?? 'n/a'}` +
    `${execution.timedOut ? ', timed out' : ''}). Output:\n${output}\n\n` +
    'Answer the current question from this instead of re-running it — nothing new was executed.'
  )
}

/**
 * Bounded ReAct loop plus the batch-research sub-loop — the "actually call the model and its
 * tools" half of PersonalAssistant, split out in Phase 4d of the architecture remediation plan.
 * Owns tool-control-plane enforcement (checkToolPolicy, below) as part of the same loop it gates,
 * per Phase 4's design: a deterministic, harness-state-informed check before each call executes,
 * not just advisory classification checked after the fact.
 */
export class AgentLoop {
  constructor(
    private readonly memory: MemoryAdapter,
    private readonly llmClient: ILLMClient,
    private readonly model: () => string | undefined,
    private readonly fileTools: FileToolsContext | undefined,
    private readonly webTools: WebToolsContext | undefined,
    private readonly shellTools: ShellToolsContext | undefined,
    private readonly actionTools: ActionToolsContext | undefined,
    private readonly reminderStore: ReminderStore,
    private readonly maxSteps: number,
    private readonly onTrace: ((event: TraceEvent) => void) | undefined,
    private readonly onDebugLog: ((entry: DebugLogEntry) => void) | undefined,
  ) {}

  /**
   * Phase 4c: builds one fresh, turn-scoped live ControlState (tool-control-plane.ts), seeded
   * with the same tool-name list runToolLoop/resolveBatchItem already build internally — kept
   * here rather than in the sequencer (assistant.ts) so the caller never needs to re-import
   * FILE_TOOLS/WEB_TOOLS/SHELL_TOOLS/REMINDER_TOOLS just to construct this; AgentLoop already
   * privately owns which tools are configured. Call once per turn (when a tool loop will run)
   * and thread the result through runToolLoop/runBatchToolLoop so it's shared across every tool
   * call the turn makes, including across batch items.
   */
  createControlPlaneState(): TurnControlPlaneState {
    const toolNames = [
      ...(this.fileTools ? FILE_TOOLS : []),
      ...(this.webTools ? WEB_TOOLS : []),
      ...(this.shellTools ? SHELL_TOOLS : []),
      ...(this.actionTools ? ACTION_TOOLS : []),
      ...REMINDER_TOOLS,
    ].map((tool) => tool.name)
    return createTurnControlPlaneState(toolNames)
  }

  /**
   * Phase 4/4c: the deterministic, harness-state-informed authority for whether `toolName` may
   * proceed — see tool-policy.ts. `controlState` is the live, per-turn ControlState built by
   * tool-control-plane.ts and threaded down from runTurn (see createTurnControlPlaneState);
   * `undefined` at the very first tool call of a turn (nothing recorded yet — the pre-evidence
   * baseline tool-policy.ts's own doc comment describes) or for a caller that never wired one in.
   */
  private checkToolPolicy(
    toolName: string,
    riskHint: TurnIntentClassification['riskLevel'],
    controlState?: TurnControlPlaneState['controlState'],
  ): ReturnType<typeof evaluateToolPolicy> {
    const result = evaluateToolPolicy({ toolName, riskHint, controlState })
    this.onTrace?.({ kind: 'tool_policy_decision', tool: toolName, decision: result.decision, reason: result.reason })
    return result
  }

  /**
   * Bounded ReAct loop: calls callChatStructured with whichever of file/web/shell/reminder
   * tools are configured, executing real (non-mutating) tool calls and looping, until
   * either a final text reply comes back, a write_file/run_shell_command call needs
   * staging + approval, or the iteration cap is hit. Only ever invoked when `fileTools`,
   * `webTools`, or `shellTools` is configured (reminder tools ride along whenever any of
   * those does, since `reminderStore` always exists).
   */
  async runToolLoop(
    sessionId: string,
    transcript: ChatMessage[],
    userMessage: string,
    systemPrompt: string,
    onToken?: (token: string) => void,
    onToolStep?: (step: AssistantToolStep) => void,
    onUsage?: (usage: TokenUsage) => void,
    riskHint: TurnIntentClassification['riskLevel'] = 'LOW',
    controlPlaneState?: TurnControlPlaneState,
  ): Promise<ToolLoopResult> {
    const tools = [
      ...(this.fileTools ? FILE_TOOLS : []),
      ...(this.webTools ? WEB_TOOLS : []),
      ...(this.shellTools ? SHELL_TOOLS : []),
      ...(this.actionTools ? ACTION_TOOLS : []),
      ...REMINDER_TOOLS,
    ]
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...transcript,
      { role: 'user', content: userMessage },
    ]
    const { result } = await this.runToolIterations(messages, this.maxSteps, tools, sessionId, userMessage, onToken, onToolStep, onUsage, undefined, riskHint, controlPlaneState)
    return result
  }

  /**
   * The actual ReAct-style tool-calling loop, factored out of runToolLoop so a batch sub-loop
   * (resolveBatchItem, below) can run the exact same iteration logic — including the
   * looksLikeUnparsedToolCall retry guard and write/shell staging — scoped to its own message
   * history and its own (usually much smaller) iteration budget, instead of duplicating it.
   * `maxIterations` replaces runToolLoop's former direct use of `this.maxSteps`; passing
   * `this.maxSteps` here reproduces that method's exact prior behavior unchanged.
   *
   * `onToolResult`, when provided, is called after every tool result is folded into `messages`
   * and may return `'stop'` to end the loop immediately (see resolveBatchItem's item-scoped
   * dead-end window) — a caller that never passes it (runToolLoop, the flat non-batch path)
   * gets today's unmodified behavior: the loop only ever ends via a final answer, an
   * needs_approval bail-out, or maxIterations.
   */
  private async runToolIterations(
    messages: ChatMessage[],
    maxIterations: number,
    tools: ToolDefinition[],
    sessionId: string,
    userMessage: string,
    onToken?: (token: string) => void,
    onToolStep?: (step: AssistantToolStep) => void,
    onUsage?: (usage: TokenUsage) => void,
    onToolResult?: (toolName: string, resultText: string) => 'continue' | 'stop',
    // Phase 4: advisory input to ToolPolicy (tool-policy.ts) — never itself the gate. Defaults to
    // 'LOW' for callers that don't have a per-turn classification in scope (resolveBatchItem's
    // batch sub-loop below), which is conservative-neutral: it only affects ToolPolicy's
    // fail-safe 'UNKNOWN' branch, and a batch item's own turn already passed the message-level
    // requiresApproval gate before ever reaching here.
    riskHint: TurnIntentClassification['riskLevel'] = 'LOW',
    // Phase 4c: shared, turn-scoped live ControlState (tool-control-plane.ts), constructed once
    // by runTurn and threaded through every sub-loop that dispatches tool calls within the same
    // turn — including across batch items, so a failure pattern discovered in one item's sub-loop
    // is visible to the next item's, not reset per call. `undefined` for callers that never wire
    // one in (e.g. resolvePendingBatchConfirmation's resume path — see tool-control-plane.ts's own
    // doc comment on why that's a deliberate scope boundary, not an oversight).
    controlPlaneState?: TurnControlPlaneState,
  ): Promise<{ result: ToolLoopResult; iterationsUsed: number; deadEndStopped?: boolean }> {
    const sources: AssistantSource[] = []

    // Reports a step immediately, before the call executes — a caller wants to see "reading
    // notes.txt" while it's happening, not just after the fact.
    const reportStep = (tool: string, input: Record<string, unknown>): void => {
      onToolStep?.({ tool, input, summary: summarizeToolStep(tool, input) })
    }

    // True once this loop has manually dispatched at least one tool call and pushed its
    // result into `messages` (the proxy backend's shape — one call per tool round trip,
    // enriching `messages` with real tool_use/tool_result blocks each time). Stays false
    // for the claude-cli backend's typical shape, where Claude Code's own agentic loop
    // resolves every tool call invisibly inside a single callChatStructured call and
    // `messages` is never touched — see the "no more tool calls" branch below for why this
    // distinction matters.
    let dispatchedAnyToolCall = false

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // For the claude-cli backend, this one call may run several tool round trips
      // internally (Claude Code's own agentic loop) before returning — onToolStep here is
      // what makes those otherwise-invisible calls show up live; for the proxy backend,
      // this backend option is simply never invoked (one call = one round trip, already
      // visible below), so reportStep covers it there instead.
      const response = await this.llmClient.callChatStructured(messages, tools, {
        model: this.model(),
        onToolStep: onToolStep ? (event) => reportStep(event.tool, event.input) : undefined,
        onUsage,
        // Phase D0: for a backend that can intercept its own internal tool loop before a
        // read-only call executes (currently ClaudeCliLLMClient — see its own doc comment),
        // this is the propose→gate half of propose→gate→execute: the exact same deterministic
        // checkToolPolicy gate the manual dispatch loop below already runs for every call it
        // makes directly, now also covering the calls this backend used to resolve invisibly.
        // A backend without such an internal loop (the proxy client) never calls this — its
        // calls come back as response.toolCalls and are gated inline below instead.
        onToolProposal: async (tool) => {
          const policy = this.checkToolPolicy(tool, riskHint, controlPlaneState?.controlState)
          if (policy.decision === 'ALLOW') return { decision: 'allow' }
          return { decision: 'deny', reason: policy.reason }
        },
      })

      if (!response.toolCalls || response.toolCalls.length === 0) {
        if (looksLikeUnparsedToolCall(response.content)) {
          // Never show this to the user as if it were a real answer — nudge the model to
          // either call a tool properly or answer in plain text, and retry. Bounded by the
          // same maxIterations cap as any other iteration: a model that keeps doing this falls
          // through to the 'escalated' return below instead of ever reaching the user.
          messages.push({ role: 'assistant', content: response.content })
          messages.push({
            role: 'user',
            content: 'Your last reply contained unparsed tool-call syntax (a literal "<tool_call>" tag) instead of either a real tool call or a plain-text answer. Do not include any tool-call-like tags in your reply — either call a tool, or answer in plain text.',
          })
          continue
        }

        if (!onToken) return { result: { kind: 'final', content: response.content, sources }, iterationsUsed: iteration + 1 }

        if (!dispatchedAnyToolCall) {
          // No tool result was ever manually folded into `messages` this turn — true for
          // the claude-cli backend, whose own agentic loop resolves every tool call
          // invisibly inside the one callChatStructured call already made above. Re-asking
          // via callChat here would replay the *original* question with none of that
          // context (and, for ClaudeCliLLMClient specifically, --mcp-config stripped back
          // to zero tools — see EMPTY_MCP_CONFIG), so it isn't "the same answer, streamed"
          // at all — it's the model's ungrounded blind guess, silently overwriting a
          // correct, tool-grounded reply with a wrong one. Just deliver the already-correct
          // content through onToken directly; no second call, no risk of losing grounding.
          onToken(response.content)
          return { result: { kind: 'final', content: response.content, sources }, iterationsUsed: iteration + 1 }
        }

        // Re-request the same final answer as a real streamed completion — only
        // reached once this loop has actually dispatched a tool call itself (the proxy
        // backend's shape), where `messages` already carries the enriched tool-result
        // history, so re-asking here gets an equally-grounded answer, just delivered
        // token-by-token instead of all at once.
        let streamed = ''
        for await (const token of this.llmClient.callChat(messages, { model: this.model(), onUsage })) {
          streamed += token
          onToken(token)
        }
        return { result: { kind: 'final', content: streamed, sources }, iterationsUsed: iteration + 1 }
      }

      // The Claude CLI backend's own agentic loop resolves read/list/web calls internally
      // within one subprocess call, and — because write_file/run_shell_command must never
      // execute inline for that backend either — its MCP tool handler already staged the
      // action itself before returning here. It signals that with this synthetic tool name
      // instead of write_file/run_shell_command, so we adopt the id it already staged rather
      // than staging a second, redundant pending action.
      const alreadyStagedCall = response.toolCalls.find(call => call.name === '__staged_action')
      if (alreadyStagedCall) {
        const { id, kind, ...payload } = alreadyStagedCall.input as { id: string; kind: 'write' | 'shell' | 'email' } & Record<string, unknown>
        if (kind === 'write') {
          const { path, content } = payload as { path: string; content: string }
          return {
            result: {
              kind: 'needs_approval',
              reason: `Proposes writing to "${path}":\n${previewContent(content)}`,
              pendingActionId: id,
              pendingActionKind: 'write',
            },
            iterationsUsed: iteration + 1,
          }
        }
        if (kind === 'email') {
          const { to, subject, body } = payload as { to: string; subject: string; body: string }
          return {
            result: {
              kind: 'needs_approval',
              reason: formatEmailApprovalReason({ to, subject, body }),
              pendingActionId: id,
              pendingActionKind: 'email',
            },
            iterationsUsed: iteration + 1,
          }
        }
        const { command, cwd } = payload as { command: string; cwd: string }
        return {
          result: {
            kind: 'needs_approval',
            reason: shellApprovalReason(command, cwd),
            pendingActionId: id,
            pendingActionKind: 'shell',
          },
          iterationsUsed: iteration + 1,
        }
      }

      const writeCall = response.toolCalls.find(call => call.name === 'write_file')
      if (writeCall) {
        if (!this.fileTools) throw new Error('write_file tool call received but fileTools is not configured')
        reportStep('write_file', writeCall.input)
        // Stop immediately — don't execute any other tool calls from this same
        // response — and stage the write rather than ever touching real disk.
        const result = await executeFileTool(this.fileTools, 'write_file', writeCall.input)
        if (result.kind !== 'staged_write') {
          throw new Error('write_file executor returned an unexpected result kind')
        }
        return {
          result: {
            kind: 'needs_approval',
            reason: `Proposes writing to "${result.path}":\n${previewContent(result.content)}`,
            pendingActionId: result.id,
            pendingActionKind: 'write',
          },
          iterationsUsed: iteration + 1,
        }
      }

      const shellCall = response.toolCalls.find(call => call.name === 'run_shell_command')
      if (shellCall) {
        if (!this.shellTools) throw new Error('run_shell_command tool call received but shellTools is not configured')
        reportStep('run_shell_command', shellCall.input)
        // Every genuinely new run_shell_command call is gated, full stop — there is no "safe
        // subset" that skips staging. An identical repeat of an already-resolved (command, cwd)
        // pair is different: executeShellTool returns 'cached_shell' for that (see file-tools.ts's
        // shell-result-cache doc comment), so it's answered from the cached result as an ordinary
        // tool result below instead of re-opening an approval prompt.
        const result = await executeShellTool(this.shellTools, 'run_shell_command', shellCall.input)
        if (result.kind === 'cached_shell') {
          messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls })
          dispatchedAnyToolCall = true
          messages.push({
            role: 'tool',
            content: formatCachedShellResult(result.command, result.cwd, result.execution),
            toolCallId: shellCall.id,
          })
          continue
        }
        return {
          result: {
            kind: 'needs_approval',
            reason: shellApprovalReason(result.command, result.cwd),
            pendingActionId: result.id,
            pendingActionKind: 'shell',
          },
          iterationsUsed: iteration + 1,
        }
      }

      const emailCall = response.toolCalls.find(call => call.name === 'send_email')
      if (emailCall) {
        if (!this.actionTools) throw new Error('send_email tool call received but actionTools is not configured')
        reportStep('send_email', emailCall.input)
        // Same as write_file/run_shell_command: stop immediately, stage the proposal, never deliver
        // inline. executeActionTool throws InvalidEmailArgsError on a malformed recipient — that
        // propagates and the loop's own error handling turns it into a tool error the model sees.
        const result = await executeActionTool(this.actionTools, 'send_email', emailCall.input)
        return {
          result: {
            kind: 'needs_approval',
            reason: formatEmailApprovalReason(result),
            pendingActionId: result.id,
            pendingActionKind: 'email',
          },
          iterationsUsed: iteration + 1,
        }
      }

      messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls })
      dispatchedAnyToolCall = true
      for (const call of response.toolCalls) {
        reportStep(call.name, call.input)
        // Phase 4/4c: deterministic, harness-state-informed gate, checked before this call
        // executes rather than only classified in advance and never re-checked — see
        // tool-policy.ts. controlPlaneState?.controlState is the live ControlState built from
        // every earlier tool call this turn (see recordToolOutcome below) — undefined only for
        // this turn's very first tool call, or a caller that never wired one in.
        const policy = this.checkToolPolicy(call.name, riskHint, controlPlaneState?.controlState)
        if (policy.decision === 'DENY') {
          const resultText = `Denied by tool policy: ${policy.reason}`
          messages.push({ role: 'tool', content: resultText, toolCallId: call.id })
          this.onTrace?.({ kind: 'tool_call', tool: call.name, ok: false })
          continue
        }
        if (policy.decision === 'REQUIRE_APPROVAL') {
          // Unlike write_file/run_shell_command (which stage a concrete, resumable action by ID
          // — see file-tools.ts's stagePendingAction), a read-only tool call ToolPolicy flags here
          // has nothing concrete to stage: the harness's own control state, not a specific
          // pending mutation, is what's asking for a human to look at this turn before more tool
          // use continues. Surfaced as an escalation (same shape maxIterations exhaustion already
          // uses below) rather than a fabricated needs_approval with no real pendingActionId
          // behind it.
          return {
            result: { kind: 'escalated', reason: policy.reason },
            iterationsUsed: iteration + 1,
          }
        }
        let resultText: string
        let toolOk = true
        try {
          resultText = await this.executeToolCall(call.name, call.input, userMessage, onUsage)
          this.onTrace?.({ kind: 'tool_call', tool: call.name, ok: true })
          this.onDebugLog?.({
            kind: 'tool_call',
            sessionId,
            content: `${call.name}(${JSON.stringify(call.input)}) →\n${resultText.slice(0, 4000)}${resultText.length > 4000 ? `\n… (truncated, ${resultText.length} chars total)` : ''}`,
          })
          // Only a call that actually succeeded grounds the reply in something
          // real — a rejected path/URL or tool error below is reported to the
          // model but isn't a source.
          if (call.name === 'read_file' || call.name === 'list_directory') {
            sources.push({ tool: call.name, path: String(call.input.path) })
          } else if (call.name === 'web_search' || call.name === 'fetch_url') {
            sources.push({ tool: call.name, path: String(call.input.query ?? call.input.url) })
          }
        } catch (err) {
          // A rejected path or tool error is reported back to the model as a
          // tool result, not thrown — matches the "clear decline, never a
          // silent no-op dressed up as success" baseline this plan preserves.
          // Also logged here (not just fed to the model) — this catch otherwise leaves the
          // real cause invisible everywhere: it never reaches App.tsx's own catch (no
          // exception propagates past this point), and the model's own paraphrase of the
          // error in its final reply is rarely the actual message.
          console.error(`[tool call failed] ${call.name}`, err)
          this.onTrace?.({ kind: 'tool_call', tool: call.name, ok: false })
          resultText = `Error: ${err instanceof Error ? err.message : String(err)}`
          this.onDebugLog?.({ kind: 'tool_call', sessionId, content: `${call.name}(${JSON.stringify(call.input)}) → ${resultText}` })
          toolOk = false
        }
        // Phase 4c: feed this call's outcome into the same live ControlState checkToolPolicy
        // reads at the top of the next iteration of this loop — a short summary only, never the
        // full resultText (which can be large or come from untrusted web content).
        if (controlPlaneState) {
          recordToolOutcome(controlPlaneState, {
            toolName: call.name,
            ok: toolOk,
            summary: toolOk ? `${call.name} succeeded` : `${call.name} failed: ${resultText.slice(0, 200)}`,
          })
        }
        messages.push({ role: 'tool', content: resultText, toolCallId: call.id })

        if (onToolResult && onToolResult(call.name, resultText) === 'stop') {
          return { result: { kind: 'final', content: response.content, sources }, iterationsUsed: iteration + 1, deadEndStopped: true }
        }
      }
    }

    return {
      result: { kind: 'escalated', reason: `Tool loop exceeded ${maxIterations} iterations without producing a final answer.` },
      iterationsUsed: maxIterations,
    }
  }

  /**
   * Resolves one batch item in its own bounded sub-loop — structurally the same
   * runToolIterations call the flat loop uses, just seeded with a single-item-focused user
   * message and a per-item budget instead of the whole conversation and `this.maxSteps`.
   *
   * The dead-end window (`toolYields`) is a local array, created fresh on every call to this
   * method — never shared across items: a hard item that trips BATCH_DEAD_END_WINDOW
   * consecutive dead_end results only stops *this* item's sub-loop early (rather than spending
   * the rest of its budget on a dead page) and can never poison an easier item queued behind it.
   */
  private async resolveBatchItem(
    item: string,
    budget: number,
    batchItems: string[],
    systemPrompt: string,
    sessionId: string,
    onToolStep?: (step: AssistantToolStep) => void,
    onUsage?: (usage: TokenUsage) => void,
    controlPlaneState?: TurnControlPlaneState,
  ): Promise<BatchItemResolution> {
    const tools = [
      ...(this.fileTools ? FILE_TOOLS : []),
      ...(this.webTools ? WEB_TOOLS : []),
      ...(this.shellTools ? SHELL_TOOLS : []),
      ...(this.actionTools ? ACTION_TOOLS : []),
      ...REMINDER_TOOLS,
    ]
    const itemPrompt =
      `You are working through one item from a batch research request covering ${batchItems.length} similar ` +
      `items in total. Find the requested information for just this one item, using the available tools as ` +
      `needed:\n\n"${item}"\n\nAnswer only for this item — a separate pass handles the others. Be concise and ` +
      'ground your answer in what the tools actually returned; say plainly if nothing could be found.'
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: itemPrompt },
    ]

    const toolYields: ToolYield[] = []
    const trackYield = (toolName: string, resultText: string): 'continue' | 'stop' => {
      if (toolName !== 'web_search' && toolName !== 'fetch_url') return 'continue'
      toolYields.push(classifyToolYield(toolName, resultText))
      const trailing = toolYields.slice(-BATCH_DEAD_END_WINDOW)
      return trailing.length === BATCH_DEAD_END_WINDOW && trailing.every((y) => y === 'dead_end') ? 'stop' : 'continue'
    }

    const { result, iterationsUsed, deadEndStopped } = await this.runToolIterations(
      messages, budget, tools, sessionId, itemPrompt, undefined, onToolStep, onUsage, trackYield, undefined, controlPlaneState,
    )

    if (deadEndStopped) {
      const sources = result.kind === 'final' ? result.sources : []
      return {
        item,
        content:
          `No results found for "${item}" after ${BATCH_DEAD_END_WINDOW} consecutive unproductive searches — ` +
          'treating as not found rather than continuing to spend this item\'s budget.',
        callsUsed: iterationsUsed,
        exhausted: false,
        status: 'not_found',
        sources,
      }
    }
    if (result.kind === 'final') {
      return { item, content: result.content, callsUsed: iterationsUsed, exhausted: false, status: 'found', sources: result.sources }
    }
    if (result.kind === 'escalated') {
      // maxIterations was reached without a final answer, but the dead-end window above never
      // tripped — this item was still turning up plausibly-relevant content when its budget ran
      // out, not stuck on a dead page.
      return { item, content: `(Could not resolve within budget: ${result.reason})`, callsUsed: iterationsUsed, exhausted: true, status: 'truncated_while_productive', sources: [] }
    }
    // 'needs_approval': a write_file/run_shell_command call inside a batch item is out of scope
    // for a batch-research turn (there is no per-item place to route an approval prompt) — surfaced
    // as an unresolved item rather than silently dropping the request or applying it unreviewed.
    return { item, content: `(Could not resolve — this item's tool call needs approval: ${result.reason})`, callsUsed: iterationsUsed, exhausted: true, status: 'not_found', sources: [] }
  }

  /**
   * Resolves every item in `remainingItems` in its own sub-loop, recalibrating the per-item
   * budget after each one via nextItemBudget instead of freezing it at the initial probe
   * average, and stopping once the running total hits BATCH_ABSOLUTE_TURN_CEILING regardless of
   * how favorable calibration still looks. Returns every resolution so far (probed + newly
   * resolved) plus the names of any items never attempted because the ceiling was hit first.
   * Public — also called by ActionApprovalService.resolvePendingBatchConfirmation on the
   * approved-continuation path.
   */
  async resolveRemainingBatchItems(
    probedResults: BatchItemResolution[],
    remainingItems: string[],
    systemPrompt: string,
    sessionId: string,
    onToolStep?: (step: AssistantToolStep) => void,
    onUsage?: (usage: TokenUsage) => void,
    controlPlaneState?: TurnControlPlaneState,
  ): Promise<{ resolutions: BatchItemResolution[]; notAttempted: string[] }> {
    const resolutions: BatchItemResolution[] = [...probedResults]
    const budgetState: BatchBudgetState = {
      callsPerItemHistory: probedResults.map((r) => r.callsUsed),
      perItemFloor: BATCH_PER_ITEM_FLOOR,
      slackFactor: BATCH_SLACK_FACTOR,
      absoluteTurnCeiling: BATCH_ABSOLUTE_TURN_CEILING,
    }
    // Aggregate turn-wide ceiling, tracked via the generic Budget type (packages/harness) rather
    // than a bare counter compared against the module constant — same isExhausted()/consume()
    // shape as adapter/harness/recovery.py's RecoveryBudget. Only the `calls` dimension is used
    // here; cost/time/parallelism stay at their default-unbounded value since batch-research
    // doesn't track those today.
    let turnBudget = new Budget({ maxCalls: BATCH_ABSOLUTE_TURN_CEILING }).consume({
      calls: budgetState.callsPerItemHistory.reduce((sum, c) => sum + c, 0),
    })
    const allItems = [...probedResults.map((r) => r.item), ...remainingItems]

    for (const item of remainingItems) {
      if (turnBudget.isExhausted()) break
      const budget = Math.max(1, Math.min(nextItemBudget(budgetState), turnBudget.remaining('calls')))
      const resolution = await this.resolveBatchItem(item, budget, allItems, systemPrompt, sessionId, onToolStep, onUsage, controlPlaneState)
      resolutions.push(resolution)
      budgetState.callsPerItemHistory.push(resolution.callsUsed)
      turnBudget = turnBudget.consume({ calls: resolution.callsUsed })
    }

    const notAttempted = remainingItems.slice(resolutions.length - probedResults.length)
    return { resolutions, notAttempted }
  }

  /**
   * Synthesizes one final reply from every item's per-item findings — same shape as the flat
   * loop's own final-answer call, just seeded with structured per-item results instead of raw
   * tool-call history for every item at once.
   *
   * Any item in `notAttempted` (the absolute ceiling was hit before it was ever reached) is
   * appended as a deterministic, guaranteed-present list rather than left to the synthesis
   * call's prose — an LLM asked to "write one well-organized reply" over many items can drop one
   * from its summary the same way it can drop one from a longer todo list; the per-item
   * `resolutions` themselves stay inside the model's synthesis (their found/not_found/
   * truncated_while_productive wording is already baked into `content` by resolveBatchItem, so
   * the model has no need to invent that part), but which items were never even attempted this
   * turn is a plain fact, not something worth trusting to how well the model followed
   * instructions. Public — also called by ActionApprovalService.
   */
  async synthesizeBatchReply(
    userMessage: string,
    systemPrompt: string,
    resolutions: BatchItemResolution[],
    notAttempted: string[],
    onToken?: (token: string) => void,
    onUsage?: (usage: TokenUsage) => void,
  ): Promise<string> {
    const findingsBlock = resolutions.map((r) => `### ${r.item}\n${r.content}`).join('\n\n')
    const notAttemptedNote =
      notAttempted.length > 0
        ? `\n\nThe following items were not attempted this turn (ran out of room) and are appended to the reply ` +
          `separately — do not mention them yourself: ${notAttempted.join(', ')}`
        : ''
    const synthesisPrompt =
      `The user's original batch research request: "${userMessage}"\n\n` +
      `Per-item findings gathered so far:\n${findingsBlock}${notAttemptedNote}\n\n` +
      "Write one well-organized reply covering every item above. For any item whose findings couldn't be " +
      'resolved, say so plainly — never invent or guess a value.'

    let finalContent = ''
    for await (const token of this.llmClient.callChat(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: synthesisPrompt }],
      { model: this.model(), onUsage },
    )) {
      finalContent += token
      onToken?.(token)
    }

    if (notAttempted.length === 0) return finalContent
    const guaranteedNotAttempted = `\n\nNot yet checked this turn (ran out of room): ${notAttempted.join(', ')}`
    onToken?.(guaranteedNotAttempted)
    return finalContent + guaranteedNotAttempted
  }

  /**
   * Gated entry point for the batch-research path: probes the first 1-2 items (keeping at least
   * one item unprobed so a single sample can't swing the whole projection), calibrates a
   * per-item budget off their real cost, and either pauses for confirmation (a large projection)
   * or resolves every remaining item and synthesizes the final reply.
   */
  async runBatchToolLoop(
    items: string[],
    sessionId: string,
    userMessage: string,
    systemPrompt: string,
    onToken?: (token: string) => void,
    onToolStep?: (step: AssistantToolStep) => void,
    onUsage?: (usage: TokenUsage) => void,
    controlPlaneState?: TurnControlPlaneState,
  ): Promise<ToolLoopResult> {
    // Probe phase: N==3 probes just item[0] so at least one item stays unprobed even for the
    // smallest qualifying batch; larger batches probe the first two.
    const probeCount = items.length === 3 ? 1 : 2
    const probeItems = items.slice(0, probeCount)
    const remainingItems = items.slice(probeCount)

    const probeResolutions: BatchItemResolution[] = []
    for (const item of probeItems) {
      probeResolutions.push(await this.resolveBatchItem(item, BATCH_PROBE_ITEM_CAP, items, systemPrompt, sessionId, onToolStep, onUsage, controlPlaneState))
    }

    // Calibrate.
    const callsPerItemHistory = probeResolutions.map((r) => r.callsUsed)
    const callsPerItem = Math.max(BATCH_PER_ITEM_FLOOR, trimmedAverage(callsPerItemHistory))
    const projectedTotal = callsPerItem * remainingItems.length * BATCH_SLACK_FACTOR

    // Confirmation gate: a large projection pauses instead of silently spending it, reusing the
    // same needs_approval shape risk-classifier.ts's bulk-reminder gate already established.
    // Probed results are persisted (not discarded) so approving resumes without re-probing, and
    // declining still returns them as real findings.
    if (remainingItems.length > 0 && projectedTotal > BATCH_LARGE_PROJECTION_THRESHOLD) {
      const pendingActionId = crypto.randomUUID()
      const pendingState: BatchPendingState = {
        userMessage,
        systemPrompt,
        sessionId,
        probedResults: probeResolutions,
        remainingItems,
        projectedTotal,
      }
      await this.memory.set(`batch-pending:${pendingActionId}`, pendingState)
      return {
        kind: 'needs_approval',
        reason:
          `This looks like it'll take ~${Math.ceil(projectedTotal)} more searches to cover the remaining ` +
          `${remainingItems.length} item(s) — continue, or should I do a quick pass first?`,
        pendingActionId,
        pendingActionKind: 'batch',
      }
    }

    // Remaining items.
    const { resolutions, notAttempted } = await this.resolveRemainingBatchItems(
      probeResolutions,
      remainingItems,
      systemPrompt,
      sessionId,
      onToolStep,
      onUsage,
      controlPlaneState,
    )
    const content = await this.synthesizeBatchReply(userMessage, systemPrompt, resolutions, notAttempted, onToken, onUsage)
    const sources = resolutions.flatMap((r) => r.sources)
    return { kind: 'final', content, sources, batchBudget: buildBatchBudgetTrace(items.length, projectedTotal, resolutions) }
  }

  /**
   * Dispatches one tool call by name to its executor. web_search/fetch_url results
   * are wrapped as untrusted external content (and flagged if they look like an
   * injection attempt) before they ever reach the model — file and reminder results
   * are not, since they're the assistant's own workspace/state, not adversarial input.
   */
  private async executeToolCall(name: string, input: Record<string, unknown>, userMessage: string, onUsage?: (usage: TokenUsage) => void): Promise<string> {
    if (name === 'read_file' || name === 'list_directory') {
      if (!this.fileTools) throw new Error(`Tool "${name}" called but fileTools is not configured`)
      const result = await executeFileTool(this.fileTools, name, input)
      return result.kind === 'text' ? result.text : ''
    }
    if (name === 'web_search' || name === 'fetch_url') {
      if (!this.webTools) throw new Error(`Tool "${name}" called but webTools is not configured`)
      const result = await executeWebTool(this.webTools, name, input)
      const text = result.kind === 'text' ? result.text : ''
      const injection = await detectInjectionLikelyWithLLM(text, this.llmClient, this.model(), onUsage)
      const body = injection.flagged
        ? `[Warning: this content contains instruction-like text and may be an injection attempt — ${injection.reason}]\n${text}`
        : text
      return wrapUntrusted(body)
    }
    if (name === 'create_reminder' || name === 'list_reminders') {
      return executeReminderTool(this.reminderStore, name, input, userMessage)
    }
    throw new Error(`Unknown tool: ${name}`)
  }
}

