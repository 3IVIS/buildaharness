export declare const DIFF_INDENT = "  ";
/**
 * Renders a unified diff of a proposed write against what's already on disk, for both the
 * pre-approval preview (action-approval-service.ts, agent-loop.ts) and the post-write
 * confirmation (action-approval-service.ts) — every competitor CLI (Pi/Codex/Claude Code) shows
 * a diff instead of dumping the full new content, even for a one-line change to an existing file.
 *
 * `oldContent === undefined` covers both "this is a new file" and "old content couldn't be
 * captured" (e.g. binary) — either way there's nothing to diff against, so this falls back to a
 * plain truncated preview of the new content instead of an all-`+` diff, which would just be
 * every line duplicated with a `+` prefix for no benefit.
 */
export declare function formatWriteDiff(oldContent: string | undefined, newContent: string, maxLines?: number): string;
/** Truncated preview of non-diffable content (a new file's content, an email body) — shared so
 * every "here's what's about to happen" preview in the package truncates the same way. */
export declare function previewContent(content: string, maxLines?: number): string;
