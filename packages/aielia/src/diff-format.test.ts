import { describe, it, expect } from 'vitest'
import { formatWriteDiff, previewContent } from './diff-format.js'

describe('formatWriteDiff', () => {
  it('falls back to a plain preview when there is no old content (new file)', () => {
    expect(formatWriteDiff(undefined, 'line1\nline2')).toBe('line1\nline2')
  })

  it('renders a gutter-numbered diff for a one-line change to an existing file, Claude Code style (line number, then sign, then content) rather than an "@@" hunk header', () => {
    const result = formatWriteDiff('line1\nline2\nline3\n', 'line1\nlineX\nline3\n')
    expect(result).toBe('  1  line1\n  2 -line2\n  2 +lineX\n  3  line3')
    expect(result).not.toContain('@@')
    expect(result).not.toContain('===')
    expect(result).not.toContain('--- before')
    expect(result).not.toContain('+++ after')
  })

  it('right-aligns the gutter to the widest line number in the diff', () => {
    const oldContent = Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n')
    const newContent = oldContent.replace('line9', 'CHANGED')
    const result = formatWriteDiff(oldContent, newContent)
    // The hunk (context: 3 around the changed line) spans both single-digit (7, 8, 9) and
    // two-digit (10, 11, 12) line numbers — every gutter pads to the two-digit width, so the
    // 2-char field right after DIFF_INDENT is always digit-or-padding-space, never anything else.
    for (const line of result.split('\n')) expect(line).toMatch(/^ {2}[ \d]{2} [+\- ]/)
  })

  it('indents every diff line two spaces, visually separating it from the summary line above', () => {
    const result = formatWriteDiff('line1\nline2\nline3\n', 'line1\nlineX\nline3\n')
    for (const line of result.split('\n')) expect(line).toMatch(/^ {2}/)
  })

  it('suppresses the "\\ No newline at end of file" marker — real diff notation about the file, not the change, that reads as noise in a chat reply', () => {
    const result = formatWriteDiff('one', 'one\ntwo')
    expect(result).not.toContain('No newline')
  })

  it('reports no changes when old and new content are identical', () => {
    expect(formatWriteDiff('same\n', 'same\n')).toBe('(no changes)')
  })

  it('truncates a diff longer than maxLines', () => {
    const oldContent = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n')
    const newContent = Array.from({ length: 50 }, (_, i) => (i === 25 ? 'CHANGED' : `line${i}`)).join('\n')
    const result = formatWriteDiff(oldContent, newContent, 5)
    expect(result).toContain('(truncated)')
    expect(result.split('\n').length).toBeLessThanOrEqual(6)
  })
})

describe('previewContent', () => {
  it('returns short content unchanged', () => {
    expect(previewContent('a\nb\nc')).toBe('a\nb\nc')
  })

  it('truncates content past maxLines', () => {
    const content = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n')
    const result = previewContent(content, 3)
    expect(result).toBe('l0\nl1\nl2\n… (truncated)')
  })
})
