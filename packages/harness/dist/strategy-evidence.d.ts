/**
 * Evidence behind a learned recovery strategy (memory observability plan, X1).
 *
 * A strategy is a bet about what works, not a fact. The legacy rule ("one success moves the weight") can promote a strategy on
 * a single lucky run. The sample rule records the evidence and lets a strategy influence ordering only once it has a minimum
 * number of attempts AND a Wilson lower bound above the baseline success rate of the alternatives it would displace. Below that
 * it is "recorded, not used": the entry exists and can be shown, the weight consumers read stays untouched.
 */
/** Evidence for one `${strategy}:${failureClass}` key. */
export interface StrategyEvidence {
    attempts: number;
    successes: number;
    /** Exponentially decayed counts: recent attempts weigh more. Used for the promotion bound. */
    weightedAttempts: number;
    weightedSuccesses: number;
    lastUsedAt: number;
    /** Context fingerprint (tool set, model, task family) the attempts were observed in. */
    context: string;
    /** Latest outcomes, newest last, bounded to `RECENT_WINDOW`. */
    recent: boolean[];
    /** Bounded list of run ids that contributed, so a number can be traced to runs. */
    runIds: string[];
    promoted: boolean;
}
export declare const MIN_ATTEMPTS = 5;
export declare const DECAY = 0.9;
export declare const RECENT_WINDOW = 10;
export declare const MAX_RUN_REFS = 20;
/** Baseline when no alternative has any evidence: a coin flip. */
export declare const DEFAULT_BASELINE = 0.5;
/** This many failures in a row demote a promoted strategy. */
export declare const DEMOTION_STREAK = 3;
/** Lower bound of the Wilson score interval (95%) for `successes` of `n`. 0 when n is 0. */
export declare function wilsonLowerBound(successes: number, n: number): number;
export declare function emptyEvidence(context: string): StrategyEvidence;
/** Returns a new evidence record with one attempt folded in. A different context starts a fresh record (scope, not universality). */
export declare function recordAttempt(prior: StrategyEvidence | undefined, input: {
    success: boolean;
    runId?: string;
    now: number;
    context: string;
}): StrategyEvidence;
/** Success rate of the alternatives: the pooled (decayed) rate of every other strategy for the same class, or the default. */
export declare function baselineFor(others: StrategyEvidence[]): number;
export interface PromotionDecision {
    promoted: boolean;
    lowerBound: number;
    baseline: number;
    attempts: number;
}
/** Whether a strategy may influence ordering: enough attempts and a lower bound above the baseline; a failure streak demotes. */
export declare function decidePromotion(e: StrategyEvidence, others: StrategyEvidence[], minAttempts?: number): PromotionDecision;
export interface StrategyEvent {
    type: 'strategy_promoted' | 'strategy_demoted';
    key: string;
    attempts: number;
    successes: number;
    lowerBound: number;
    baseline: number;
    runId?: string;
}
