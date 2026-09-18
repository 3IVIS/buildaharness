import { describe, it, expect, afterEach } from 'vitest'
import { renderInk, type TestInkInstance } from './ink-test-render.js'
import { renderMarkdownLine, matchDiffLine, renderDiffLine } from './markdown-line.js'
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
    expect(matchDiffLine('  +goodbye world')).toEqual({ content: '+goodbye world', color: 'green' })
  })

  it('classifies a removed line red', () => {
    expect(matchDiffLine('  -hello world')).toEqual({ content: '-hello world', color: 'red' })
  })

  it('classifies a hunk header cyan', () => {
    expect(matchDiffLine('  @@ -1,1 +1,2 @@')).toEqual({ content: '@@ -1,1 +1,2 @@', color: 'cyan' })
  })

  it('does not classify a context line (falls through to plain rendering)', () => {
    expect(matchDiffLine('   hello world')).toBeUndefined()
  })

  it('does not classify the no-newline marker', () => {
    expect(matchDiffLine('  \\ No newline at end of file')).toBeUndefined()
  })

  it('does not misfire on an ordinary markdown bullet (dash + space, no diff indent)', () => {
    expect(matchDiffLine('- a real bullet point')).toBeUndefined()
  })

  it('does not misfire on text that merely starts with two spaces', () => {
    expect(matchDiffLine('  just an indented sentence')).toBeUndefined()
  })
})

describe('renderDiffLine', () => {
  it('returns undefined for a non-diff line, letting the caller fall back to plain rendering', () => {
    expect(renderDiffLine('just a system message', 0)).toBeUndefined()
  })

  it('returns an element for a diff line — used by both the assistant (post-write) and system (pre-approval preview) LogLine kinds', () => {
    expect(renderDiffLine('  +goodbye world', 0)).toBeDefined()
  })
})

describe('renderMarkdownLine — diff lines render without mangling content', () => {
  it('renders an added line', () => {
    expect(strip(render('  +goodbye world').lastFrame())).toContain('+goodbye world')
  })

  it('renders a removed line', () => {
    expect(strip(render('  -hello world').lastFrame())).toContain('-hello world')
  })

  it('renders a hunk header', () => {
    expect(strip(render('  @@ -1,1 +1,2 @@').lastFrame())).toContain('@@ -1,1 +1,2 @@')
  })

  it('renders formatWriteDiff output end to end', () => {
    const diff = formatWriteDiff('line1\nline2\nline3\n', 'line1\nlineX\nline3\n')
    for (const line of diff.split('\n')) {
      const frame = strip(render(line).lastFrame())
      expect(frame).toContain(line.trimStart())
    }
  })
})
