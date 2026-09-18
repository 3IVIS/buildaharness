import { describe, it, expect, afterEach } from 'vitest'
import { renderInk, type TestInkInstance } from './ink-test-render.js'
import { renderMarkdownLine, matchDiffLine, renderDiffLine, renderNeedsApprovalLine } from './markdown-line.js'
import { formatWriteDiff } from './diff-format.js'

// Same isolation reason as tui-input.test.tsx — see vite.config.ts's exclude comment for this file.

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g
function strip(frame: string | undefined): string {
  return (frame ?? '').replace(ANSI, '')
}

const instances: TestInkInstance[] = []

function render(text: string): TestInkInstance {
  const instance = renderInk(<>{renderMarkdownLine(text, 'k')}</>)
  instances.push(instance)
  return instance
}

afterEach(() => {
  instances.forEach((i) => i.unmount())
  instances.length = 0
})

// matchDiffLine is the actual color decision — asserted directly here since chalk's color-support
// detection reads the real process (not ink-test-render.ts's injected fake stdout), so no Ink test
// in this package ever observes real ANSI codes in a rendered frame; every one strips them instead.
describe('matchDiffLine', () => {
  it('classifies an added line green', () => {
    expect(matchDiffLine('  2 +goodbye world')).toEqual({ content: '2 +goodbye world', color: 'green' })
  })

  it('classifies a removed line red', () => {
    expect(matchDiffLine('  2 -hello world')).toEqual({ content: '2 -hello world', color: 'red' })
  })

  it('classifies a context line with no color — still short-circuits so it is never mistaken for ordinary prose (which would get ASSISTANT_BULLET prepended)', () => {
    expect(matchDiffLine('  1  hello world')).toEqual({ content: '1  hello world', color: undefined })
  })

  it('pads a single-digit gutter the same as multi-digit ones in the same diff', () => {
    expect(matchDiffLine('  10 +hello world')).toEqual({ content: '10 +hello world', color: 'green' })
  })

  it('does not classify the no-newline marker (formatWriteDiff drops it entirely, but matchDiffLine is defensive on its own)', () => {
    expect(matchDiffLine('  \\ No newline at end of file')).toBeUndefined()
  })

  it('does not misfire on an ordinary markdown bullet (dash + space, no line-number gutter)', () => {
    expect(matchDiffLine('- a real bullet point')).toBeUndefined()
  })

  it('does not misfire on text that merely starts with two spaces', () => {
    expect(matchDiffLine('  just an indented sentence')).toBeUndefined()
  })

  it('does not misfire on a plain number with no sign character after it', () => {
    expect(matchDiffLine('  42 is the answer')).toBeUndefined()
  })
})

describe('renderDiffLine', () => {
  it('returns undefined for a non-diff line, letting the caller fall back to plain rendering', () => {
    expect(renderDiffLine('just a system message', 0)).toBeUndefined()
  })

  it('returns an element for a diff line — used by both the assistant (post-write) and system (pre-approval preview) LogLine kinds', () => {
    expect(renderDiffLine('  2 +goodbye world', 0)).toBeDefined()
  })
})

describe('renderMarkdownLine — plain prose gets a leading "- " marker', () => {
  it('prefixes an ordinary line with "- "', () => {
    expect(strip(render('hello there').lastFrame())).toContain('- hello there')
  })

  it('does not prefix a blank line (a paragraph break, not a bullet)', () => {
    expect(strip(render('').lastFrame())).not.toContain('-')
  })

  it('does not double up the bullet on a checkbox line (checkbox branch is checked first and keeps its own original "- ")', () => {
    const frame = strip(render('- [x] done').lastFrame())
    expect(frame).toBe('- ☑ done')
  })

  it('does not prefix a header line', () => {
    const frame = strip(render('## Heading').lastFrame())
    expect(frame).toContain('Heading')
    expect(frame).not.toContain('- Heading')
  })
})

describe('renderNeedsApprovalLine', () => {
  it('returns undefined for a line with no "[needs approval …]" tag', () => {
    expect(renderNeedsApprovalLine('just some system text', 0)).toBeUndefined()
  })

  it('recognizes the tag regardless of what kind of approval it is', () => {
    expect(renderNeedsApprovalLine('[needs approval — write] Proposes writing to "x.txt":', 0)).toBeDefined()
    expect(renderNeedsApprovalLine('[needs approval — HIGH] some risky thing', 0)).toBeDefined()
  })

  it('keeps the reason text after the tag intact', () => {
    const instance = renderInk(<>{renderNeedsApprovalLine('[needs approval — write] Proposes writing to "x.txt":', 0)}</>)
    instances.push(instance)
    expect(strip(instance.lastFrame())).toContain('[needs approval — write] Proposes writing to "x.txt":')
  })
})

describe('renderMarkdownLine — diff lines render without mangling content', () => {
  it('renders an added line', () => {
    expect(strip(render('  2 +goodbye world').lastFrame())).toContain('2 +goodbye world')
  })

  it('renders a removed line', () => {
    expect(strip(render('  2 -hello world').lastFrame())).toContain('2 -hello world')
  })

  it('renders a context line without prepending ASSISTANT_BULLET to it', () => {
    const frame = strip(render('  1  hello world').lastFrame())
    expect(frame).toContain('1  hello world')
    expect(frame).not.toContain('- 1')
  })

  it('renders formatWriteDiff output end to end, including its context lines, with no stray "- " bullets anywhere', () => {
    const diff = formatWriteDiff('line1\nline2\nline3\n', 'line1\nlineX\nline3\n')
    for (const line of diff.split('\n')) {
      const frame = strip(render(line).lastFrame())
      expect(frame).toContain(line.trimStart())
      expect(frame).not.toMatch(/^- /)
    }
  })
})
