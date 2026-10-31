import { Source } from './article-model.js';
/**
 * Stored source passages (T6): the passage as read, its address, the date and a fingerprint, so a later recheck can tell
 * whether the source changed. Whether a difference MATTERS is a model judgement and is not made here.
 * Source text is data, never instructions; callers must wrap it as untrusted before showing it to a model.
 */
/** A fast, stable 53-bit hash (cyrb53) as hex. Not cryptographic: it only detects change. Whitespace differences do not count as change. */
export declare function fingerprintPassage(passage: string): string;
export type LineRange = {
    from: number;
    to: number;
};
/**
 * A line range from the text a writer types into a field or from a link fragment: "40-60", "40–60", "L40-L60", "lines 40 to 60", "40".
 * It reads the numbers only; the first is the start and the second (if any) the end. Nothing is parsed from the meaning of words.
 */
export declare function parseLineRange(text: string): LineRange | undefined;
/** Only the given lines (1-based, inclusive) of a text; a range past the end is cut at the end, and an empty result means the range misses the text. */
export declare function sliceLines(text: string, range: LineRange): string;
/** What a stored passage holds when the source keeps only some lines: the whole text otherwise. */
export declare function excerptFor(source: Pick<Source, 'lines'>, text: string): string;
/**
 * A link to one file in a GitHub repository (github.com/o/r/blob/ref/path, or raw.githubusercontent.com), with the line range of an #L10-L20 fragment.
 * `rawUrl` is where the file's text is fetched from. Anything else is undefined: such a link is an ordinary web page.
 */
export declare function parseRepoFileLink(address: string): {
    rawUrl: string;
    path: string;
    lines?: LineRange;
} | undefined;
export declare function createSource(input: {
    id: string;
    kind: Source['kind'];
    address?: string;
    passage?: string;
    note?: string;
    lines?: LineRange;
    now: string;
}): Source;
/**
 * Records the result of reading a source again. Same fingerprint: current. Different: changed (the stored passage is
 * kept as read until the writer accepts the new one, so a check never silently moves to new text). Unreadable: unreachable.
 */
export declare function applyRecheck(source: Source, result: {
    passage: string;
} | {
    unreachable: true;
}, now: string): Source;
/** The writer accepts the newly read text: it replaces the stored passage and the fingerprint. */
export declare function acceptNewPassage(source: Source, passage: string, now: string): Source;
/** A PDF or Word file: not text, so the page has to extract its text before it is stored (the extraction needs the browser, so it is not done here). */
export declare function documentFormatForFile(file: {
    name: string;
    type?: string;
}): 'pdf' | 'docx' | undefined;
/**
 * What kind of source a dropped file is, from its name and type: code (program text, so claims about what it does are checked against the
 * code itself), an uploaded text document, or undefined when it cannot be read as text. PDF and Word files count as uploaded documents; the caller reads the file's text (see `documentFormatForFile`).
 */
export declare function sourceKindForFile(file: {
    name: string;
    type?: string;
}): 'code' | 'upload' | undefined;
/**
 * The text of a fetched page made ready to edit: line endings normalised, runs of blank lines cut to one, trailing spaces dropped. The title is the first
 * heading or, failing that, the first short line; the page's host if there is no text line to use.
 */
export declare function pageToArticle(text: string, address: string): {
    title: string;
    markdown: string;
};
/**
 * The stored sources of an article as text for a model: each one's address and the passage as read, cut to its share of a fixed budget so a
 * few large documents cannot crowd out the rest. Empty when no source has text. The passages are data, never instructions.
 */
export declare function renderSourcesForModel(meta: {
    sources: {
        kind: string;
        address?: string;
        passage?: string;
    }[];
}, budget?: number): string;
