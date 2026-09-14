import type { RiskLevel, AssistantTrace, AssistantSource, AssistantToolStep, AssistantTurnResult, AnswerClaim } from '@buildaharness/personal-assistant'

export type ChatEntry =
  | { id: string; kind: 'user'; content: string }
  | {
      id: string
      kind: 'assistant'
      content: string
      riskLevel?: RiskLevel
      trace?: AssistantTrace
      /** Set when this turn skipped the harness entirely (a self-contained trivial question) — see AssistantTurnResult.harnessSkipped. Tells the "Why?" panel to explain the skip instead of showing a confidence readout. */
      harnessSkipped?: boolean
      sources?: AssistantSource[]
      toolSteps?: AssistantToolStep[]
      /** Durable plan progress as of this turn — see AssistantTurnResult.planStatus. Powers the plan checklist in the "Run detail" panel (Phase 3.3 of the harness layer activation plan). */
      planStatus?: AssistantTurnResult['planStatus']
      /** Epistemic-honesty signal — see AssistantTurnResult.answerClaim's doc comment. Absent on the triviality fast path, same convention as trace/sources. */
      answerClaim?: AnswerClaim
      /** Which proposer drove this turn — see AssistantTurnResult.proposerKind. A dev/E2E-only test affordance (plans/chat_ui_browser_e2e_plan.html phase B1), rendered as a hidden data-testid element. */
      proposerKind?: AssistantTurnResult['proposerKind']
    }
  | {
      id: string
      kind: 'approval'
      pendingMessage: string
      reason: string
      riskLevel?: RiskLevel
      resolution?: 'approved' | 'denied'
      /** Set when this pause came from a staged write_file/run_shell_command/batch-research
       * action (AssistantTurnResult.pendingActionId) rather than the message-level risk gate.
       * Both Approve and Deny must resume via `turn(pendingMessage, { approved, pendingActionId })`
       * to actually apply or discard the staged action — the message-level gate has no staged
       * action to resolve, and per assistant.ts's own doc comment a decline there never re-enters
       * turn() at all. */
      pendingActionId?: string
      pendingActionKind?: AssistantTurnResult['pendingActionKind']
    }
  | {
      id: string
      kind: 'escalation'
      reason: string
      /** The message that led to this escalation — there's no pendingActionId to resume (see
       * agent-loop.ts's REQUIRE_APPROVAL-with-nothing-concrete-to-stage comment), so the only
       * way forward is resubmitting the same message as a brand new turn. */
      pendingMessage: string
    }
  | {
      id: string
      kind: 'error'
      content: string
      retryable: boolean
      retryMessage: string
      retryApproved: boolean
      /** Carries the same pendingActionId through a retry, so retrying a failed resume of a
       * staged action doesn't silently drop back to a plain (message, approved) turn. */
      retryPendingActionId?: string
    }
