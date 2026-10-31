import { Section } from './article-model.js';
/**
 * Sections from the Markdown (headings define sections) and their re-anchoring after the text changes. Structure only:
 * a section keeps its id when its heading is unchanged, or when it is the one heading that changed in an otherwise
 * unchanged outline. Anything less certain gets a new id and the old record is reported as removed, never dropped silently.
 */
export interface ParsedHeading {
    heading: string;
    level: number;
    start: number;
    end: number;
}
/** ATX headings outside fenced code. Text before the first heading becomes a level-0 "lead" section when it is not blank. */
export declare function parseSections(markdown: string): ParsedHeading[];
export interface ReconcileResult {
    sections: Section[];
    /** Ids kept, with the new heading when it was renamed. */
    kept: {
        id: string;
        renamedFrom?: string;
    }[];
    created: string[];
    /** Previous sections that no longer match anything; shown to the writer, not deleted without that. */
    removed: Section[];
}
export declare function reconcileSections(previous: readonly Section[], markdown: string, newId: (taken: ReadonlySet<string>) => string): ReconcileResult;
