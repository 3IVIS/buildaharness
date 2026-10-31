import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { SupervisorDirectiveData, TrajectoryDigestData } from '@buildaharness/harness';
export declare function decideSupervisorDirective(digest: TrajectoryDigestData, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<Partial<SupervisorDirectiveData> | null>;
