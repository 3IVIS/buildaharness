import { Text } from 'ink'

/**
 * Minimal inline/line-level markdown rendering for the TUI's committed scrollback — not a full
 * CommonMark parser, just the subset the live terminal comparison
 * (`reports/cli_appearance_comparison_2026-09-17.md`) actually caught printing as literal
 * characters in a real plan-mode reply: `## Headers`, `- [ ]`/`- [x]` checkboxes, `**bold**`, and
 * `` `code spans` ``. Each `LogLine.text` here is already exactly one already-split line (see
 * `EventLogBridge.handleEvent`'s `displayText.split('\n')`), so this operates line-at-a-time —
 * no cross-line constructs (fenced code blocks, tables, nested lists) are attempted.
 */

const HEADER_RE = /^(#{1,6})\s+(.*)$/
const CHECKBOX_RE = /^(\s*[-*]\s)\[([ xX])\]\s+(.*)$/
const INLINE_TOKEN_RE = /\*\*(.+?)\*\*|`([^`]+)`/g

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
  return <Text key={key}>{renderInlineSegments(text)}</Text>
}
