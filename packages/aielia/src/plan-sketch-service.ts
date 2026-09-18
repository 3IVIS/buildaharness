import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import { sketchPlan } from './plan-sketch.js'
import type { AssistantTurnResult } from './assistant-types.js'
import type { TraceEvent } from './trace-events.js'
import type { AgentLoop } from './agent-loop.js'

/** Same bounded read_file/list_directory walk budget P3's from-scratch drafting grounds with (PlanDraftingService.draftTurn) — one shared cap, not a second tuning knob. */
const SKETCH_GROUNDING_BUDGET = 8

/**
 * P9 of plans/ask_question_and_plan_mode_plan.html — the lightweight plan-sketch delegate: one
 * bounded LLM call (grounded, best-effort, via the same read_file/list_directory investigation
 * walk P3's from-scratch drafting reuses — AgentLoop.runSupervisorInvestigation, not a new search
 * engine) that returns a plain proposed task list in the chat reply itself. Deliberately NOT
 * PlanDraftingService: it never touches PlanService/PlanRecord, never calls
 * AssistantSession.enterPlanMode, and stages nothing for PlanApprovalService to see (INV-35) —
 * advice for one turn, not a commitment to execute. Kept in its own module/class, same
 * single-purpose-collaborator discipline every other plan-mode service in this package follows,
 * so a caller that only wants the free-form sketch never pulls in the stateful drafting/approval
 * machinery at all.
 */
export class PlanSketchService {
  constructor(
    private readonly llmClient: ILLMClient,
    private readonly model: () => string | undefined,
    private readonly onTrace: ((event: TraceEvent) => void) | undefined,
    // Optional, same "absent means skip grounding" convention as PlanDraftingService's own
    // agentLoop dependency — a caller that doesn't wire this (e.g. a unit test) just gets a
    // sketch from conversation text alone.
    private readonly agentLoop?: Pick<AgentLoop, 'runSupervisorInvestigation'>,
  ) {}

  async sketch(request: string, onUsage: (usage: TokenUsage) => void): Promise<AssistantTurnResult> {
    let groundingContext: string | undefined
    if (this.agentLoop) {
      const findings = await this.agentLoop.runSupervisorInvestigation(
        { question: request, suggested_tools: ['read_file', 'list_directory'], budget: SKETCH_GROUNDING_BUDGET },
        { riskHint: 'LOW' },
      )
      if (findings.length > 0) groundingContext = findings.map((f) => `[${f.tool}] ${f.content}`).join('\n\n')
    }

    const result = await sketchPlan(this.llmClient, request, groundingContext, this.model(), onUsage)
    this.onTrace?.({ kind: 'plan_sketch', requestPreview: request.slice(0, 120) })
    if (!result) {
      return { status: 'ok', reply: "I couldn't sketch a plan for that — could you rephrase the request?", riskLevel: 'LOW', harnessSkipped: true }
    }
    return { status: 'ok', reply: result.reply, riskLevel: 'LOW', harnessSkipped: true }
  }
}
