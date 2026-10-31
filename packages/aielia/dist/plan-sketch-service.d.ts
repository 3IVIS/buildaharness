import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { AssistantTurnResult } from './assistant-types.js';
import { TraceEvent } from './trace-events.js';
import { AgentLoop } from './agent-loop.js';
/**
 * P9 of the internal plan — the lightweight plan-sketch delegate: one
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
export declare class PlanSketchService {
    private readonly llmClient;
    private readonly model;
    private readonly onTrace;
    private readonly agentLoop?;
    constructor(llmClient: ILLMClient, model: () => string | undefined, onTrace: ((event: TraceEvent) => void) | undefined, agentLoop?: Pick<AgentLoop, "runSupervisorInvestigation"> | undefined);
    sketch(request: string, onUsage: (usage: TokenUsage) => void): Promise<AssistantTurnResult>;
}
