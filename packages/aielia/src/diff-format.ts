import { createTwoFilesPatch } from 'diff'

const DEFAULT_MAX_LINES = 20
// Visually separates diff content from the surrounding chat prose (the "Wrote X." / "Proposes
// writing to X:" line immediately above it) — matches Claude Code/Codex's own indented-diff
// convention. Two spaces, not colored here: this string is consumed by both the plain readline
// CLI and the Ink TUI (markdown-line.tsx), and the TUI applies its own per-line color via real
// Ink `<Text color>` props (see that file) rather than embedded ANSI, which risks colliding with
// Ink's own dimColor/reset handling. Exported so markdown-line.tsx's diff-line recognition can't
// drift from the indent this file actually emits.
export const DIFF_INDENT = '  '

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
    // "\ No newline at end of file" is real, standard unified-diff notation (git/diff -u emit
    // it too) — but it's about the *file*, not the *change* being reviewed, and it reads as
    // confusing noise in a chat reply rather than a real terminal's diff pager. Dropped rather
    // than colored/hidden by the renderer, so both the plain CLI and the TUI never show it.
    .filter((line) => !line.startsWith('\\ No newline'))
    .map((line) => `${DIFF_INDENT}${line}`)
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
