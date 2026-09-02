import type { ILLMClient, MemoryAdapter, TokenUsage, FsBackend } from '@buildaharness/runtime'
import {
  applyPendingAction,
  discardPendingAction,
  loadPendingAction,
  type FileToolsContext,
} from './file-tools.js'
import { recordShellCacheEntry } from './file-tools.js'
import type { ShellToolsContext } from './shell-tools.js'
import { commandLooksLikeNetworkRequest } from './shell-tools.js'
import { wrapUntrusted, detectInjectionLikelyWithLLM } from './trust-tagging.js'
import type { AssistantTurnResult } from './assistant-types.js'
import type { AssistantSession } from './assistant-session.js'
import type { AgentLoop, BatchPendingState } from './agent-loop.js'
import { buildBatchBudgetTrace } from './agent-loop.js'
import type { AssistantTrace } from './assistant-types.js'
import { classifyAndTraceExecutionMode } from './execution-mode.js'
import type { TraceEvent } from './trace-events.js'
import { SYNTHESIS_SYSTEM_PROMPT } from './system-prompt.js'

/** Formats a preview of staged write content, or a proposed shell command, shared by
 * loadChainedApproval below and, previously, runToolIterations — small enough to duplicate the
 * one-line truncation locally rather than add a shared micro-util module. */
function previewContent(content: string, maxLines = 20): string {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return content
  return `${lines.slice(0, maxLines).join('\n')}\n… (truncated)`
}

/**
 * Owns the "approval-by-ID" pattern: a staged write/shell/revert/batch-research action resolved
 * by ID, never re-derived from a second LLM call (see T4 of the file-tools plan). Split out in
 * Phase 4d of the architecture remediation plan — do not change this behavior when relocating it,
 * only where the code lives.
 */
export class ActionApprovalService {
  constructor(
    private readonly memory: MemoryAdapter,
    private readonly llmClient: ILLMClient,
    private readonly model: () => string | undefined,
    private readonly fileTools: FileToolsContext | undefined,
    private readonly shellTools: ShellToolsContext | undefined,
    private readonly session: AssistantSession,
    private readonly agentLoop: AgentLoop,
    private readonly onTrace: ((event: TraceEvent) => void) | undefined,
  ) {}

  /** Resumes a staged action by ID instead of re-deriving *what to run* from a second LLM call — see T4 of the file-tools plan. `userMessage` is only used to synthesize an answer from a shell command's real output (see below); the command/content actually applied always comes from the staged record, never from a fresh model call. */
  async resolvePendingAction(sessionId: string, transcriptKey: string, pendingActionId: string, approved: boolean, userMessage: string): Promise<AssistantTurnResult> {
    // A batch-confirmation pause (see AgentLoop.runBatchToolLoop) is staged in `this.memory`, not
    // under a file/shell workspace backend — check for it first so a webTools-only assistant (no
    // fileTools/shellTools configured at all) can still resume/decline one without hitting the
    // "neither configured" guard below, which is specific to write/shell staged actions.
    const batchState = (await this.memory.get(`batch-pending:${pendingActionId}`)) as BatchPendingState | undefined
    if (batchState) {
      return this.resolvePendingBatchConfirmation(transcriptKey, pendingActionId, approved, batchState)
    }

    const fileTools = this.fileTools
    const shellTools = this.shellTools
    // A pending action is staged under whichever workspace it belongs to — fileTools and
    // shellTools are configured independently but, in practice, share the same backend/
    // workspaceRoot pair (see PersonalAssistantOptions.shellTools's doc comment).
    const backend = fileTools?.backend ?? shellTools?.backend
    const workspaceRoot = fileTools?.workspaceRoot ?? shellTools?.workspaceRoot
    if (!backend || !workspaceRoot) {
      throw new Error('turn() received pendingActionId but neither fileTools nor shellTools are configured')
    }

    if (!approved) {
      // write_file/run_shell_command proposals already have the user's originating request
      // logged (the tool loop's needs_approval branch appends it before ever returning here) —
      // but /undo-action <id> is staged directly by the CLI/UI, never by the model (see
      // pendingActionKind's doc comment), so there is no earlier turn where that request was
      // recorded. Without this, a declined revert would leave an orphaned "Cancelled ..."
      // assistant message in the transcript/export with no paired user turn.
      const record = await loadPendingAction(backend, workspaceRoot, pendingActionId)
      if (record?.kind === 'revert') {
        await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: `/undo-action ${record.revertedEntryId}` })
      }
      await discardPendingAction(backend, workspaceRoot, pendingActionId)
      // A chained (non-first) action from a multi-action turn may be declined after an earlier
      // action in the same chain already ran (see PendingActionRecord.chainedFrom's doc comment)
      // — claiming "nothing was written or run" in that case is simply false, so scope the claim
      // to just this action instead.
      const reply = record?.chainedFrom ? 'Cancelled — that additional action was not run.' : 'Cancelled — nothing was written or run.'
      await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'assistant', content: reply })
      if (record?.nextPendingActionId) {
        const chained = await this.loadChainedApproval(backend, workspaceRoot, record.nextPendingActionId, reply)
        if (chained) return chained
      }
      return { status: 'ok', reply }
    }

    const applied = await applyPendingAction(backend, workspaceRoot, pendingActionId, {
      executeShell: shellTools
        ? (command, cwd) =>
            shellTools.executeCommand(command, cwd, {
              timeoutMs: shellTools.timeoutMs,
              networkAllowlist: shellTools.networkAllowlist,
            })
        : undefined,
    })

    let reply: string
    let transcriptContent: string
    // Set by the shell branch's injection check and/or synthesis call below — absent for a
    // write confirmation or a cancelled action, same "absent when unused" convention elsewhere.
    let usage: TokenUsage | undefined
    const accumulateLocalUsage = (u: TokenUsage): void => {
      usage = {
        inputTokens: (usage?.inputTokens ?? 0) + u.inputTokens,
        outputTokens: (usage?.outputTokens ?? 0) + u.outputTokens,
        costUsd: u.costUsd !== undefined ? (usage?.costUsd ?? 0) + u.costUsd : usage?.costUsd,
      }
    }
    if (applied.kind === 'write') {
      reply = `Wrote "${applied.path}".`
      transcriptContent = reply
    } else if (applied.kind === 'revert') {
      const parts: string[] = []
      if (applied.restore.length > 0) parts.push(`restored ${applied.restore.map((r) => `"${r.path}"`).join(', ')}`)
      if (applied.remove.length > 0) parts.push(`removed ${applied.remove.map((p) => `"${p}"`).join(', ')}`)
      reply = `Reverted "${applied.revertedEntryId}" — ${parts.join(' and ')}.`
      transcriptContent = reply
      // Same orphan-transcript-message fix as the decline branch above, for the approved path.
      await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: `/undo-action ${applied.revertedEntryId}` })
    } else {
      // Record this resolution in the shell cache BEFORE anything else — this is the only place
      // a shell command is ever actually executed, regardless of which backend proposed it (the
      // claude-cli backend's MCP server only ever stages, never runs for real), so it's the only
      // place that can populate the cache executeShellTool/the MCP server both check to answer an
      // identical repeat without a fresh approval. See file-tools.ts's shell-result-cache doc
      // comment.
      await recordShellCacheEntry(backend, workspaceRoot, {
        command: applied.command,
        cwd: applied.cwd,
        execution: applied.execution,
        resolvedAt: new Date().toISOString(),
      })

      // Command output is untrusted external content exactly the same way a fetched web
      // page is — it can carry the same injection-shaped text (e.g. a `cat`'d file or a
      // `curl`'d page) — so it gets the same detectInjectionLikelyWithLLM treatment as
      // web_search/fetch_url results. The <untrusted_external_content> boundary tags
      // themselves are a signal for a *future model call* reading this back out of the
      // transcript (see trust-tagging.ts and SYSTEM_PROMPT) — not for the human, who would
      // otherwise see literal tag markup printed into their chat bubble, indistinguishable
      // from a garbled raw page dump. So the tags go into what's saved to transcript memory,
      // not into the reply actually shown to the user.
      let rawOutput = applied.execution.output || '(no output)'
      // See commandLooksLikeNetworkRequest's doc comment: the synthesis call below never sees
      // run_shell_command's tool description, so without this note it has no way to know a
      // deny-all network allowlist turned any request in this command into a local 403 —
      // confirmed live to otherwise misattribute the block to the destination server.
      if (!shellTools?.networkAllowlist?.length && commandLooksLikeNetworkRequest(applied.command)) {
        rawOutput +=
          '\n\n[network-containment note: outbound network access from this command is denied by default ' +
          '(no hosts on the configured allowlist) — any HTTP response code or connection failure shown above for ' +
          'an external host came from this local restriction, not from the destination itself.]'
      }
      const injection = await detectInjectionLikelyWithLLM(rawOutput, this.llmClient, this.model(), accumulateLocalUsage)
      const body = injection.flagged
        ? `[Warning: this content contains instruction-like text and may be an injection attempt — ${injection.reason}]\n${rawOutput}`
        : rawOutput
      const statusLine = `Ran \`${applied.command}\` (exit code ${applied.execution.exitCode ?? 'n/a'}${applied.execution.timedOut ? ', timed out' : ''}):`

      // Fallback shape if synthesis below fails or returns nothing — same clean-reply/
      // tagged-transcript split as a write confirmation would otherwise skip needing.
      reply = `${statusLine}\n${body}`
      transcriptContent = `${statusLine}\n${wrapUntrusted(body)}`

      // Synthesize an actual answer from the real output instead of just handing back the
      // raw dump — a bare command's stdout often can't answer what was actually asked (e.g.
      // "tell me if these are wired reasonably" from a `grep -rl` file listing). This is the
      // one real LLM call T4's "no second call" reasoning was about avoiding for *re-deriving
      // the staged action* — that reasoning doesn't apply here, since the command/content
      // itself is never re-derived, only interpreted after the fact.
      try {
        const synthesized = await this.llmClient.callChatSync(
          [
            { role: 'system', content: SYNTHESIS_SYSTEM_PROMPT },
            { role: 'user', content: `My request: "${userMessage}"\n\n${statusLine}\n${wrapUntrusted(body)}` },
          ],
          { model: this.model(), onUsage: accumulateLocalUsage },
        )
        if (synthesized.trim()) {
          reply = synthesized
          transcriptContent = synthesized
        }
      } catch {
        // Falls back to the raw dump already assigned above — a broken synthesis call must
        // never mean no reply at all.
      }
    }

    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'assistant', content: transcriptContent })
    if (applied.nextPendingActionId) {
      const chained = await this.loadChainedApproval(backend, workspaceRoot, applied.nextPendingActionId, reply)
      if (chained) return chained
    }
    return { status: 'ok', reply, usage }
  }

  /**
   * After resolvePendingAction resolves one staged action (approved or declined), checks whether
   * it was chained to a second approval-gated action staged from the same originating turn (see
   * file-tools-mcp-server.mjs's stagePendingAction doc comment — e.g. a single "run X AND write
   * Y" request). Without this, the second action sat in `.pending-actions/` forever: never
   * surfaced for approval, never executed, never even mentioned as still pending.
   * `previousOutcome` (the reply text already computed for the just-resolved action) is folded
   * into the next prompt's `reason` so cli.ts's recursive needs_approval → handleTurn flow reads
   * as one continuous exchange rather than jumping straight to an unexplained second question.
   * Returns undefined if the linked record is missing or of a kind that's never legitimately
   * chained ('revert', staged only by /undo-action, alone) — a broken link must never crash the
   * turn, just stop chaining and fall back to the caller's own `status: 'ok'`.
   */
  private async loadChainedApproval(
    backend: FsBackend,
    workspaceRoot: string,
    nextPendingActionId: string,
    previousOutcome: string,
  ): Promise<AssistantTurnResult | undefined> {
    const next = await loadPendingAction(backend, workspaceRoot, nextPendingActionId)
    if (!next) return undefined
    const reason =
      next.kind === 'write'
        ? `${previousOutcome}\n\nNext, it also proposes writing to "${next.path}":\n${previewContent(next.content)}`
        : next.kind === 'shell'
          ? `${previousOutcome}\n\nNext, it also proposes running: ${next.command}\n  (cwd: ${next.cwd})`
          : undefined
    if (!reason) return undefined
    return {
      status: 'needs_approval',
      reply: null,
      reason,
      riskLevel: 'HIGH',
      pendingActionId: next.id,
      pendingActionKind: next.kind,
    }
  }

  /**
   * Resolves a batch confirmation pause (see AgentLoop.runBatchToolLoop's confirmation gate)
   * once the caller resumes via `turn(message, { approved, pendingActionId })`. Declining
   * resolves the turn immediately with only the probed items' real results, explicitly listing
   * every unprobed item as not attempted. Approving continues resolving the remaining items with
   * zero re-probing — the probe results loaded from `batchState` are reused as-is.
   */
  private async resolvePendingBatchConfirmation(
    transcriptKey: string,
    pendingActionId: string,
    approved: boolean,
    batchState: BatchPendingState,
  ): Promise<AssistantTurnResult> {
    await this.memory.delete(`batch-pending:${pendingActionId}`)
    classifyAndTraceExecutionMode(this.onTrace, { isPlanCancelBypass: false, isBatchResearch: true, isTrivial: false, requiresApproval: false })

    // Both outcomes below skip the per-turn HarnessRuntime run entirely (same as the triviality
    // fast path) — an empty nodeExecutionOrder/verificationHealth/layerActivity plus a populated
    // batchBudget, rather than an absent trace, so a "Why?"/run-detail panel still has something
    // to render.
    if (!approved) {
      const findingsBlock = batchState.probedResults.map((r) => `### ${r.item}\n${r.content}`).join('\n\n')
      const notAttemptedBlock = batchState.remainingItems.map((i) => `- ${i}`).join('\n')
      const reply = `Here's what I found before stopping, as requested:\n\n${findingsBlock}\n\nNot attempted:\n${notAttemptedBlock}`
      await this.session.appendTranscriptMessage(batchState.sessionId, transcriptKey, { role: 'assistant', content: reply })
      const trace: AssistantTrace = {
        nodeExecutionOrder: [],
        verificationHealth: { strength: 0, feasibility: 0 },
        layerActivity: [],
        batchBudget: buildBatchBudgetTrace(
          batchState.probedResults.length + batchState.remainingItems.length,
          batchState.projectedTotal,
          batchState.probedResults,
        ),
      }
      return { status: 'ok', reply, harnessSkipped: true, trace }
    }

    // Absent (stays undefined) if none of the resumed calls report usage — same "absent when
    // unused" convention as runTurn's own accumulateUsage/usageTotal.
    let usage: TokenUsage | undefined
    const accumulateLocalUsage = (u: TokenUsage): void => {
      usage = {
        inputTokens: (usage?.inputTokens ?? 0) + u.inputTokens,
        outputTokens: (usage?.outputTokens ?? 0) + u.outputTokens,
        costUsd: u.costUsd !== undefined ? (usage?.costUsd ?? 0) + u.costUsd : usage?.costUsd,
      }
    }

    const { resolutions, notAttempted } = await this.agentLoop.resolveRemainingBatchItems(
      batchState.probedResults,
      batchState.remainingItems,
      batchState.systemPrompt,
      batchState.sessionId,
      undefined,
      accumulateLocalUsage,
    )
    const reply = await this.agentLoop.synthesizeBatchReply(
      batchState.userMessage,
      batchState.systemPrompt,
      resolutions,
      notAttempted,
      undefined,
      accumulateLocalUsage,
    )
    await this.session.appendTranscriptMessage(batchState.sessionId, transcriptKey, { role: 'assistant', content: reply })
    const trace: AssistantTrace = {
      nodeExecutionOrder: [],
      verificationHealth: { strength: 0, feasibility: 0 },
      layerActivity: [],
      batchBudget: buildBatchBudgetTrace(
        batchState.probedResults.length + batchState.remainingItems.length,
        batchState.projectedTotal,
        resolutions,
      ),
    }
    return { status: 'ok', reply, usage, harnessSkipped: true, trace }
  }
}
