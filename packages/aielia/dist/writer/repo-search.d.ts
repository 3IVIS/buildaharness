import { FolderReader } from './local-folder.js';
/**
 * A searchable copy of a repository held in memory for one session, so a model can look things up (search, read some lines, list a folder) instead of being
 * shown a path list and asked to guess. Built from any reader (a local folder or a GitHub repository); nothing is written anywhere. Pure: no node or DOM imports.
 */
/** Files bigger than this are left out (generated or data files that would only drown the search). */
export declare const MAX_INDEXED_FILE_CHARS = 300000;
/** The most characters of text a single search or read answers with. */
export declare const MAX_ANSWER_CHARS = 4000;
export declare const MAX_MATCHES = 30;
export interface RepoIndex {
    /** Number of files held. */
    readonly fileCount: number;
    /** Lines matching a pattern (case-insensitive regular expression; an invalid one is searched as plain text), as `path:line: text`. `glob` narrows the paths (`*.ts`, a folder, or a part of a path). */
    search(pattern: string, glob?: string): string;
    /** The lines `from`..`to` (1-based, inclusive) of a file, numbered; at most MAX_ANSWER_CHARS characters. */
    readLines(path: string, from?: number, to?: number): string;
    /** The files and folders directly under a folder ('' for the top). */
    list(folder?: string): string;
    /** The whole text of a file, or undefined. */
    text(path: string): string | undefined;
    /** Whether the file exists in the index. */
    has(path: string): boolean;
    /** How many files the reader listed, and how many of them could not be read at all (a failed or rate-limited fetch, not an empty or oversized file). */
    readonly listed: number;
    readonly unreadable: number;
}
export declare function createRepoIndex(files: ReadonlyMap<string, string>, stats?: {
    listed?: number;
    unreadable?: number;
}): RepoIndex;
/** Reads every file the reader lists (skipping the oversized and the empty) into an index. */
export declare function buildRepoIndex(reader: FolderReader): Promise<RepoIndex>;
