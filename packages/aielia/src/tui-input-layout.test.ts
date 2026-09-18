import { describe, it, expect } from 'vitest'
import {
  wrapDraftIntoRows,
  offsetToRowCol,
  rowColToOffset,
  homeOffset,
  endOffset,
  computeViewportStart,
} from './tui-input.js'

describe('wrapDraftIntoRows', () => {
  it('returns a single empty row for an empty draft', () => {
    expect(wrapDraftIntoRows('', 10)).toEqual([{ text: '', start: 0, end: 0, wraps: false }])
  })

  it('keeps a short line as one row, not wrapped', () => {
    expect(wrapDraftIntoRows('hello', 10)).toEqual([{ text: 'hello', start: 0, end: 5, wraps: false }])
  })

  it('wraps a line longer than the column width into multiple rows', () => {
    expect(wrapDraftIntoRows('abcdefgh', 3)).toEqual([
      { text: 'abc', start: 0, end: 3, wraps: true },
      { text: 'def', start: 3, end: 6, wraps: true },
      { text: 'gh', start: 6, end: 8, wraps: false },
    ])
  })

  it('splits on explicit newlines as separate logical lines, each independently wrapped', () => {
    expect(wrapDraftIntoRows('ab\ncd', 10)).toEqual([
      { text: 'ab', start: 0, end: 2, wraps: false },
      { text: 'cd', start: 3, end: 5, wraps: false },
    ])
  })

  it('treats an empty logical line (blank line between two newlines) as its own empty row', () => {
    expect(wrapDraftIntoRows('a\n\nb', 10)).toEqual([
      { text: 'a', start: 0, end: 1, wraps: false },
      { text: '', start: 2, end: 2, wraps: false },
      { text: 'b', start: 3, end: 4, wraps: false },
    ])
  })
})

describe('offsetToRowCol / rowColToOffset', () => {
  it('places the cursor at the end of a wrapped row as the start of the next row, not the tail of this one', () => {
    const rows = wrapDraftIntoRows('abcdef', 3) // 'abc' (wraps) + 'def'
    expect(offsetToRowCol(rows, 3)).toEqual({ row: 1, col: 0 })
  })

  it('keeps the cursor at the tail of a logical line (real newline boundary), not the start of the next line', () => {
    const rows = wrapDraftIntoRows('abc\ndef', 10)
    expect(offsetToRowCol(rows, 3)).toEqual({ row: 0, col: 3 })
  })

  it('resolves the very end of the draft to the last row', () => {
    const rows = wrapDraftIntoRows('abc\ndef', 10)
    expect(offsetToRowCol(rows, 7)).toEqual({ row: 1, col: 3 })
  })

  it('round-trips row/col back to the same offset', () => {
    const rows = wrapDraftIntoRows('hello\nworld', 10)
    const offset = rowColToOffset(rows, 1, 2)
    expect(offsetToRowCol(rows, offset)).toEqual({ row: 1, col: 2 })
  })

  it('clamps col to the target row length when the source row is longer', () => {
    const rows = wrapDraftIntoRows('hello\nhi', 10)
    expect(rowColToOffset(rows, 1, 4)).toBe(rows[1]!.start + 2)
  })
})

describe('homeOffset / endOffset', () => {
  it('Home jumps to the start of the current logical line, not the current visual row', () => {
    expect(homeOffset('line one\nline two', 14)).toBe(9)
  })

  it('End jumps to the end of the current logical line', () => {
    expect(endOffset('line one\nline two', 2)).toBe(8)
  })

  it('End on the last line goes to the end of the whole draft', () => {
    expect(endOffset('line one\nline two', 12)).toBe(17)
  })
})

describe('computeViewportStart', () => {
  it('never scrolls when the draft fits within maxRows', () => {
    expect(computeViewportStart(0, 2, 4, 5)).toBe(0)
  })

  it('scrolls down the minimum amount to keep the cursor row in view', () => {
    expect(computeViewportStart(0, 6, 7, 5)).toBe(2)
  })

  it('scrolls up when the cursor moves above the current viewport', () => {
    expect(computeViewportStart(4, 1, 7, 5)).toBe(1)
  })

  it('clamps the viewport so it never scrolls past the last full page', () => {
    expect(computeViewportStart(10, 6, 7, 5)).toBe(2)
  })
})
