import { describe, it, expect } from 'vitest'
import { formatWriteDiff, previewContent } from './diff-format.js'

describe('formatWriteDiff', () => {
  it('falls back to a plain preview when there is no old content (new file)', () => {
    expect(formatWriteDiff(undefined, 'line1\nline2')).toBe('line1\nline2')
  })

  it('renders a unified diff for a one-line change to an existing file', () => {
    const result = formatWriteDiff('line1\nline2\nline3\n', 'line1\nlineX\nline3\n')
    expect(result).toContain('@@')
    expect(result).toContain('-line2')
    expect(result).toContain('+lineX')
    expect(result).not.toContain('===')
    expect(result).not.toContain('--- before')
    expect(result).not.toContain('+++ after')
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
