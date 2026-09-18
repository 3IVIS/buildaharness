import { createTwoFilesPatch } from 'diff'

const DEFAULT_MAX_LINES = 20

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
export function formatWriteDiff(oldContent: string | undefined, newContent: string, maxLines = DEFAULT_MAX_LINES): string {
  if (oldContent === undefined) return previewContent(newContent, maxLines)

  // createTwoFilesPatch always emits a 3-line header ("===...", "--- before", "+++ after")
  // before any hunks — stripped here since the caller already names the path in its own
  // "Proposes writing to X" / "Wrote X" line, so restating it as a diff header is redundant.
  const hunkLines = createTwoFilesPatch('before', 'after', oldContent, newContent, '', '', { context: 3 })
    .split('\n')
    .slice(3)
    .filter((line) => line.length > 0)
  if (hunkLines.length === 0) return '(no changes)'
  return previewLines(hunkLines, maxLines)
}

/** Truncated preview of non-diffable content (a new file's content, an email body) — shared so
 * every "here's what's about to happen" preview in the package truncates the same way. */
export function previewContent(content: string, maxLines = DEFAULT_MAX_LINES): string {
  return previewLines(content.split('\n'), maxLines)
}

function previewLines(lines: string[], maxLines: number): string {
  if (lines.length <= maxLines) return lines.join('\n')
  return `${lines.slice(0, maxLines).join('\n')}\n… (truncated)`
}
