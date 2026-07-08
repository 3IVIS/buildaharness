import type { RiskLevel, AssistantTrace, AssistantSource, AssistantToolStep, AssistantTurnResult } from '@buildaharness/personal-assistant'

export type ChatEntry =
  | { id: string; kind: 'user'; content: string }
  | {
      id: string
      kind: 'assistant'
      content: string
      riskLevel?: RiskLevel
      trace?: AssistantTrace
      sources?: AssistantSource[]
      toolSteps?: AssistantToolStep[]
      /** Durable plan progress as of this turn — see AssistantTurnResult.planStatus. Powers the plan checklist in the "Run detail" panel (Phase 3.3 of the harness layer activation plan). */
      planStatus?: AssistantTurnResult['planStatus']
    }
  | {
      id: string
      kind: 'approval'
      pendingMessage: string
      reason: string
      riskLevel?: RiskLevel
      resolution?: 'approved' | 'denied'
    }
  | { id: string; kind: 'escalation'; reason: string }
  | { id: string; kind: 'error'; content: string; retryable: boolean; retryMessage: string; retryApproved: boolean }
