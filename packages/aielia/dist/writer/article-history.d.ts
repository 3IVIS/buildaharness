import { ArticleMeta, SourceStatus } from './article-model.js';
import { Readiness, Snapshot } from './article-rules.js';
/**
 * Versions and what changed between them (article-model plan, section 7). Pure functions: a line diff of the text, the claims
 * whose shown status changed, the sources added, removed or changed, and the readiness counts side by side.
 */
export type DiffLine = {
    type: 'same' | 'add' | 'del';
    text: string;
};
/** Line diff by longest common subsequence. Articles are small, so the quadratic table is fine; very long inputs fall back to "all replaced". */
export declare function diffLines(before: string, after: string): DiffLine[];
export interface VersionSide {
    markdown: string;
    meta: ArticleMeta;
}
export interface VersionComparison {
    text: DiffLine[];
    changedLines: number;
    claims: {
        quote: string;
        from: SourceStatus | 'absent';
        to: SourceStatus | 'absent';
    }[];
    sources: {
        id: string;
        address?: string;
        change: 'added' | 'removed' | 'changed';
    }[];
    readiness: {
        from: Readiness;
        to: Readiness;
    };
}
export declare function compareVersions(from: VersionSide, to: VersionSide): VersionComparison;
export interface ChangeSummary {
    /** No earlier version to compare with. */
    first: boolean;
    added: number;
    removed: number;
    /** Headings of the sections whose text changed, were added or were removed. */
    sections: string[];
    /** Claims whose shown status changed, appeared or disappeared. */
    claims: number;
    /** Sources added, removed or changed. */
    sources: number;
}
/** What changed from one version to the next, in a form short enough for one line of a list. `from` is undefined for the first version. */
export declare function summarizeChange(from: VersionSide | undefined, to: VersionSide): ChangeSummary;
export declare const MAX_CHECKPOINTS = 20;
/** The label of a version the page saved by itself, and how many of those are kept (the oldest go first). They do not count towards MAX_CHECKPOINTS. */
export declare const AUTOSAVE_LABEL = "Autosaved";
export declare const MAX_AUTOSAVES = 30;
/** Adds a snapshot, keeping every published one, at most MAX_CHECKPOINTS of the newest checkpoints the writer or an action made, and at most MAX_AUTOSAVES of the newest autosaved ones. */
export declare function addSnapshot(snapshots: readonly Snapshot[], snapshot: Snapshot, maxCheckpoints?: number): Snapshot[];
/** True when a new text differs enough from the last one that the writer would want to be able to go back: at least 5 changed lines and 40% of the longer text. */
export declare function isLargeChange(before: string, after: string): boolean;
export interface InlinePart {
    type: 'same' | 'del' | 'add';
    text: string;
}
/** One line of a change as shown to the writer: a line only in one version, or a line changed in place with its words marked. */
export type DisplayLine = {
    type: 'add' | 'del';
    text: string;
} | {
    type: 'change';
    parts: InlinePart[];
};
/** The words of a line changed into the words of another, as one run of parts; undefined when the two lines have too little in common to read as an edit of each other. */
export declare function inlineDiff(before: string, after: string): InlinePart[] | undefined;
/** The changed lines of a comparison, without the unchanged ones; a removed line and an added line that is an edit of it become one line with the changed words marked. */
export declare function diffForDisplay(lines: readonly DiffLine[]): DisplayLine[];
