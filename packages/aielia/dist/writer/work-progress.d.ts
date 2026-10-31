/**
 * What Write tells the writer while a model call runs in the background: a short checklist for the kind of job, and the sentence for
 * the stage it is at. Pure, so the browser and desktop builds render the same words. The stages are the real boundaries of the work;
 * nothing here cycles on a timer.
 */
export type WorkKind = 'edit' | 'draft' | 'suggest' | 'answer' | 'verify' | 'check'
/** Any change to the article that saves the text first and reloads it after; the middle step is the action's own label. */
 | 'change' | 'resolve' | 'files' | 'publish' | 'prepare' | 'style' | 'import' | 'page' | 'other';
export interface WorkPlan {
    /** The stages of this kind of job, in order, each a phrase for a checklist ("Reading your request"). */
    steps: readonly string[];
}
/** The checklist for a kind of job; empty when the job is too short to need one. A 'change' is named by the action's own `label`. */
export declare function workPlan(kind: WorkKind, label?: string): WorkPlan;
export type StepState = 'done' | 'current' | 'waiting';
export interface ChecklistItem {
    text: string;
    state: StepState;
}
/** The checklist with `current` as the step in progress: earlier ones done, later ones waiting. An index past the end marks all done. */
export declare function checklistAt(plan: WorkPlan, current: number): ChecklistItem[];
/** The sentence under the checklist for the current stage, in the first person ("Reading your request…"). */
export declare function stageSentence(plan: WorkPlan, current: number): string | undefined;
/** A running time for a job that has been going a while; nothing for the first few seconds, when it would only be noise. */
export declare function elapsedText(ms: number, after?: number): string | undefined;
/**
 * The stretch of `after` that differs from `before`, found from the text both start and end with; null when nothing was added or changed
 * (a pure deletion leaves nothing to light). Used to light the passage a job has just written.
 */
export declare function changedRange(before: string, after: string): {
    start: number;
    end: number;
} | null;
/**
 * The passage to light after a job changed the text: the changed range, unless it is most of the text (a first draft, a full rewrite),
 * where lighting it would only tint the whole article and point at nothing.
 */
export declare function litRange(before: string, after: string, maxShare?: number): {
    start: number;
    end: number;
} | null;
export type ResultTone = 'good' | 'warn' | 'bad';
/** One finished piece of a counted job, shown under the bar as it settles ("Backed: the p99 was 18 ms"). */
export interface ResultLine {
    text: string;
    tone: ResultTone;
}
/** The line for one checked claim: what came of it, then the claim cut to `max` characters. */
export declare function claimResultLine(outcome: string, quote: string, max?: number): ResultLine;
/** The lines kept on show: the newest few, so a long run does not push the rest of the block away. */
export declare function recentResults(lines: readonly ResultLine[], line: ResultLine, keep?: number): ResultLine[];
