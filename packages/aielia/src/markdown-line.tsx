import { Text } from 'ink'
import { DIFF_INDENT } from './diff-format.js'

/**
 * Minimal inline/line-level markdown rendering for the TUI's committed scrollback — not a full
 * CommonMark parser, just the subset the live terminal comparison
 * (`reports/cli_appearance_comparison_2026-09-17.md`) actually caught printing as literal
 * characters in a real plan-mode reply: `## Headers`, `- [ ]`/`- [x]` checkboxes, `**bold**`, and
 * `` `code spans` ``. Each `LogLine.text` here is already exactly one already-split line (see
 * `EventLogBridge.handleEvent`'s `displayText.split('\n')`), so this operates line-at-a-time —
 * no cross-line constructs (fenced code blocks, tables, nested lists) are attempted.
 *
 * Phase 5 follow-up: a write/edit confirmation's diff (`diff-format.ts`'s `formatWriteDiff`) is
 * plain, uncolored text — it's an ordinary assistant-reply string consumed by both the plain
 * readline CLI and this TUI, so `diff-format.ts` can't embed ANSI itself (see its own
 * `DIFF_INDENT` comment). Recognized here the same way headers/checkboxes are: by shape, not by a
 * `LogLine.kind` of its own.
 */

const HEADER_RE = /^(#{1,6})\s+(.*)$/
const CHECKBOX_RE = /^(\s*[-*]\s)\[([ xX])\]\s+(.*)$/
// diff-format.ts's gutter format: a right-aligned line number, a separator space, then the
// unified-diff sign character (`+`/`-`/a plain space for context) immediately against content.
const DIFF_LINE_RE = /^(\s*\d+) ([+\- ])(.*)$/
const INLINE_TOKEN_RE = /\*\*(.+?)\*\*|`([^`]+)`/g
// Mirrors the user side's own "you>"/"> " convention (readline's prompt, the persistent
// approval-record line) with a marker on the assistant's side too, on ordinary prose lines only —
// a header/checkbox/diff line already carries its own leading glyph, and doubling up would read
// as two markers stacked on one line.
const ASSISTANT_BULLET = '- '

/**
 * Recognizes one line of `diff-format.ts`'s output by shape: `DIFF_INDENT` followed by a
 * right-aligned line number and a unified-diff sign character. That combination — a fixed
 * two-space indent no ordinary assistant prose produces, paired with a line-number gutter no
 * markdown construct produces — doesn't occur in natural writing (a markdown bullet is always
 * `- text`, dash *then* a space with no number in front, which `CHECKBOX_RE`/plain rendering
 * already own), so this can't misfire on a real bullet list. Context lines (sign is a plain
 * space) are recognized too, with `color: undefined` — they still need to short-circuit
 * `renderMarkdownLine`'s plain-text fallback below (which would otherwise prepend `ASSISTANT_BULLET`
 * to them as if they were ordinary prose), they just aren't colored the way a real diff tool
 * doesn't color its context lines either.
 */
export function matchDiffLine(text: string): { content: string; color: 'green' | 'red' | undefined } | undefined {
  if (!text.startsWith(DIFF_INDENT)) return undefined
  const rest = text.slice(DIFF_INDENT.length)
  const match = DIFF_LINE_RE.exec(rest)
  if (!match) return undefined
  const sign = match[2]
  return { content: rest, color: sign === '+' ? 'green' : sign === '-' ? 'red' : undefined }
}

/**
 * Renders one line as colored diff content if `matchDiffLine` recognizes it, otherwise
 * `undefined` so the caller falls back to its own plain/markdown rendering. Used by
 * `renderMarkdownLine` below (the `'assistant'`-kind, post-write confirmation) and by
 * `tui-app.tsx`'s `'system'`-kind branch (the pre-approval preview) — the two `LogLine` kinds a
 * `formatWriteDiff()` string actually reaches, per `classifyLineKind`.
 */
export function renderDiffLine(text: string, key: React.Key): React.JSX.Element | undefined {
  const diffLine = matchDiffLine(text)
  if (!diffLine) return undefined
  return (
    <Text key={key} color={diffLine.color}>
      {DIFF_INDENT}
      {diffLine.content}
    </Text>
  )
}

const NEEDS_APPROVAL_RE = /^(\[needs approval[^\]]*\])(.*)$/

/**
 * Colors the `[needs approval — write/shell command/…]`/`[needs approval — HIGH/…]` tag
 * `cli.ts` prints ahead of every approval prompt (see its own `console.log` call sites) yellow —
 * the same "worth your attention" color `StatusLine`'s own `⚠`-prefixed indicators already use —
 * leaving the reason text after it in the default color. This line is `'system'`-classified (see
 * `classifyLineKind`), not `'assistant'`, so it's checked from `tui-app.tsx`'s own `'system'`
 * branch rather than from `renderMarkdownLine`.
 */
export function renderNeedsApprovalLine(text: string, key: React.Key): React.JSX.Element | undefined {
  const match = NEEDS_APPROVAL_RE.exec(text)
  if (!match) return undefined
  return (
    <Text key={key}>
      <Text color="yellow">{match[1]}</Text>
      {match[2]}
    </Text>
  )
}

/** Splits a line's text on `**bold**`/`` `code` `` tokens into plain strings and styled `<Text>` spans, preserving order. */
function renderInlineSegments(text: string): React.ReactNode[] {
  const segments: React.ReactNode[] = []
  let lastIndex = 0
  let key = 0
  INLINE_TOKEN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = INLINE_TOKEN_RE.exec(text)) !== null) {
    if (match.index > lastIndex) segments.push(text.slice(lastIndex, match.index))
    if (match[1] !== undefined) {
      segments.push(
        <Text key={key++} bold>
          {match[1]}
        </Text>,
      )
    } else if (match[2] !== undefined) {
      segments.push(
        <Text key={key++} color="cyan">
          {match[2]}
        </Text>,
      )
    }
    lastIndex = INLINE_TOKEN_RE.lastIndex
  }
  if (lastIndex < text.length || segments.length === 0) segments.push(text.slice(lastIndex))
  return segments
}

/**
 * Renders one committed line of assistant/system text, recognizing a leading `#`/`##`/… header or
 * `- [ ]`/`- [x]` checkbox before falling back to plain inline-styled text. `key` is the React key
 * for the returned element (the caller already has a per-line index from `<Static>`'s own render
 * prop — see `tui-app.tsx`'s `LogLineText`).
 */
export function renderMarkdownLine(text: string, key: React.Key): React.JSX.Element {
  const diffElement = renderDiffLine(text, key)
  if (diffElement) return diffElement
  const headerMatch = HEADER_RE.exec(text)
  if (headerMatch) {
    return (
      <Text key={key} bold underline>
        {renderInlineSegments(headerMatch[2]!)}
      </Text>
    )
  }
  const checkboxMatch = CHECKBOX_RE.exec(text)
  if (checkboxMatch) {
    const checked = checkboxMatch[2]!.toLowerCase() === 'x'
    return (
      <Text key={key}>
        {checkboxMatch[1]}
        {checked ? '☑' : '☐'} {renderInlineSegments(checkboxMatch[3]!)}
      </Text>
    )
  }
  // Blank lines (paragraph breaks within a multi-line reply) stay bare — a lone "- " with
  // nothing after it would read as a stray bullet, not a paragraph break.
  if (text.length === 0) return <Text key={key}> </Text>
  return (
    <Text key={key}>
      {ASSISTANT_BULLET}
      {renderInlineSegments(text)}
    </Text>
  )
}
