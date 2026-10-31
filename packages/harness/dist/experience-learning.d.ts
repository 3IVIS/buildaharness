import { ExperienceStore } from './state/experience-store.js';
import { JournalEntry } from './state/memory-state.js';
import { StrategyEvent } from './strategy-evidence.js';
import { StrategyType } from './state/strategy-state.js';
/**
 * Cross-run learning for the harness — the feed that `warmStart` and `buildStrategyOrdering` were written to read.
 *
 * Both consumers existed long before anything wrote to the store: `getStrategyWeights()` / `getClassPriors()` were `{}` in
 * practice, so the recovery ladder never left its default order and the reviewer's "high prior for failure class" finding could
 * never fire. This is the missing half, opt-in (`HarnessRunOptions.experienceLearning`):
 *
 *  1. Every executed task appends a journal entry (`journalEntryFor`): the strategy in effect, the outcome, and — for a failure —
 *     the failure class, in the form `failed:<class>` (an unmatched failure has the empty class, exactly the key
 *     `buildStrategyOrdering` looks up for it).
 *  2. When the run ends, `learnFromJournal` reads the journal back. An entry that FOLLOWS a failure is a recovery attempt: the
 *     ladder switched strategy in answer to that failure, so the strategy in effect for the next executed task was tried against
 *     class X, and it worked (the entry succeeded) or it did not. The strategy is run-global, so the credit goes to it even when
 *     the next task is a different one (a rebuilt task, or a sibling) — an approximation, and the one the ladder's own switching
 *     implies. That moves `strategyWeights["S:X"]` toward 1 or 0. Failure-class priors move toward 1 for a class seen this run and toward
 *     0 for one not seen.
 *
 * Weights are an exponential moving average, so they stay in [0,1] and a run's evidence counts for `LEARNING_RATE` of the
 * total. The first time a class is learned about, EVERY strategy's weight for it is initialised to `PRIOR` — otherwise an untried
 * strategy (weight 0) would rank below one that had already failed (0.2), and the ladder would stop exploring.
 */
export declare const LEARNING_RATE = 0.3;
export declare const PRIOR = 0.5;
/** The journal entry for one executed task. `failureClass` is the class of a failure ('' if unmatched); absent means it succeeded. */
export declare function journalEntryFor(input: {
    step: number;
    strategy: StrategyType;
    success: boolean;
    failureClass?: string;
    output?: unknown;
}): JournalEntry;
/** The failure class a journal entry recorded, or null if it did not fail. */
export declare function failureClassOf(entry: JournalEntry): string | null;
export interface RecoveryAttempt {
    strategy: StrategyType;
    failureClass: string;
    success: boolean;
}
/** Every entry that came directly after a failure, paired with the class of the failure it answered. */
export declare function recoveryAttempts(journal: JournalEntry[]): RecoveryAttempt[];
export interface LearnOptions {
    /**
     * `single` (default, the legacy rule): one success moves the weight. `sample`: attempts are recorded as evidence and the weight
     * is written only once the strategy has `minAttempts` and a Wilson lower bound above its alternatives' baseline; otherwise it
     * is "recorded, not used". A strategy that falls below the bar (or hits a failure streak) is demoted back to unused (weight 0).
     */
    rule?: 'single' | 'sample';
    minAttempts?: number;
    runId?: string;
    /** Context fingerprint (tool set, model, task family). Evidence from another context starts over. */
    context?: string;
    now?: number;
    /** Receives a `strategy_promoted` / `strategy_demoted` event with the numbers that justified it. */
    onEvent?: (event: StrategyEvent) => void;
}
/** Updates the store from one finished run's journal. A no-op on an unavailable store or an empty journal. */
export declare function learnFromJournal(journal: JournalEntry[], store: ExperienceStore, options?: LearnOptions): void;
