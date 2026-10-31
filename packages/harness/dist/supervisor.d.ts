import { TrajectoryDigestData } from './trajectory-digest.js';
/** True iff HARNESS_TRAJECTORY_SUPERVISOR is set to a truthy value. Default OFF.
 *  `env` defaults to process.env when available (Node); pass explicitly in the browser. */
export declare function supervisorEnabled(env?: Record<string, string | undefined>): boolean;
export declare const SUPERVISOR_ACTIONS: readonly ["CONTINUE", "REDIRECT_STRATEGY", "REFRAME_PLAN", "GATHER_EVIDENCE", "ASK_USER", "ABORT"];
export type SupervisorAction = (typeof SUPERVISOR_ACTIONS)[number];
export interface InvestigationRequestData {
    question: string;
    suggested_tools: string[];
    budget: number;
}
export declare class InvestigationRequest {
    question: string;
    suggested_tools: string[];
    budget: number;
    constructor(data?: Partial<InvestigationRequestData>);
    toJSON(): InvestigationRequestData;
    static fromJSON(json: unknown): InvestigationRequest | null;
}
export interface UserQuestionData {
    question: string;
    options: string[];
}
export declare class UserQuestion {
    question: string;
    options: string[];
    constructor(data?: Partial<UserQuestionData>);
    toJSON(): UserQuestionData;
    static fromJSON(json: unknown): UserQuestion | null;
}
export interface SupervisorDirectiveData {
    action: SupervisorAction;
    rationale: string;
    strategy_hint: string | null;
    plan_note: string | null;
    investigation: InvestigationRequestData | null;
    question: UserQuestionData | null;
}
export declare class SupervisorDirective {
    action: SupervisorAction;
    rationale: string;
    strategy_hint: string | null;
    plan_note: string | null;
    investigation: InvestigationRequest | null;
    question: UserQuestion | null;
    constructor(data?: Partial<{
        action: SupervisorAction;
        rationale: string;
        strategy_hint: string | null;
        plan_note: string | null;
        investigation: InvestigationRequest | null;
        question: UserQuestion | null;
    }>);
    /** A CONTINUE directive — the deterministic ladder proceeds unchanged. */
    static cont(rationale?: string): SupervisorDirective;
    toJSON(): SupervisorDirectiveData;
    static fromJSON(json: unknown): SupervisorDirective;
}
/** Historically coerced not-yet-wired actions to CONTINUE. Every action is wired as of
 *  S3, so this now returns the directive unchanged. */
export declare function coerceForWiredActions(directive: SupervisorDirective): SupervisorDirective;
/** Run the caller's async decider on a stall digest, coerce the result, and report
 *  it once. Never throws: a decider that rejects, a malformed body, or a throwing
 *  onDirective handler all resolve to a safe CONTINUE. */
export declare function resolveSupervisorDirective(decider: (digest: TrajectoryDigestData) => Promise<Partial<SupervisorDirectiveData> | null>, digest: TrajectoryDigestData, onDirective?: (directive: SupervisorDirective) => void): Promise<SupervisorDirective>;
