import { describe, expect, it } from 'vitest'
import { cellWidth, displayWidth, toCells, toGrid, WIDE_TAIL } from './display-width.js'
import {
  checkArrowsPointAtBoxes, checkBoxesDrawn, checkEdges, checkLabelsVisible, checkNoOverlap, checkNoStrays, checkPrintable, checkRanksDownward, checkRender, checkWidth,
} from './grid-oracles.js'
import type { Box, Edge } from './types.js'

// Hand-written diagrams (no helper code between the picture and the oracle), so a bug in the oracle cannot hide behind a bug in a builder.
const DIAMOND = [
  '    ┌─────┐    ',
  '    │  A  │    ',
  '    └──┬──┘    ',
  '       │       ',
  '   ┌───┴───┐   ',
  '   │       │   ',
  '   ▼       ▼   ',
  '┌─────┐ ┌─────┐',
  '│  B  │ │  C  │',
  '└──┬──┘ └──┬──┘',
  '   │       │   ',
  '   └───┬───┘   ',
  '       ▼       ',
  '    ┌─────┐    ',
  '    │  D  │    ',
  '    └─────┘    ',
]
const DIAMOND_BOXES: Box[] = [
  { id: 'A', x: 4, y: 0, w: 7, h: 3 }, { id: 'B', x: 0, y: 7, w: 7, h: 3 }, { id: 'C', x: 8, y: 7, w: 7, h: 3 }, { id: 'D', x: 4, y: 13, w: 7, h: 3 },
]
const DIAMOND_EDGES: Edge[] = [{ from: 'A', to: 'B' }, { from: 'A', to: 'C' }, { from: 'B', to: 'D' }, { from: 'C', to: 'D' }]

// A→D and B→C cross; the crossing is drawn with ┼ and must behave as straight-through.
const CROSSING = [
  '┌─────┐   ┌─────┐',
  '│  A  │   │  B  │',
  '└──┬──┘   └──┬──┘',
  '   │         │   ',
  '   └─────────┼─┐ ',
  '   ┌─────────┘ │ ',
  '   │           │ ',
  '   ▼           ▼ ',
  '┌─────┐   ┌─────┐',
  '│  C  │   │  D  │',
  '└─────┘   └─────┘',
]
const CROSSING_BOXES: Box[] = [
  { id: 'A', x: 0, y: 0, w: 7, h: 3 }, { id: 'B', x: 10, y: 0, w: 7, h: 3 }, { id: 'C', x: 0, y: 8, w: 7, h: 3 }, { id: 'D', x: 10, y: 8, w: 7, h: 3 },
]
const CROSSING_EDGES: Edge[] = [{ from: 'A', to: 'D' }, { from: 'B', to: 'C' }]

const mutate = (lines: string[], row: number, col: number, ch: string): string[] => lines.map((l, i) => (i === row ? l.slice(0, col) + ch + l.slice(col + 1) : l))

describe('display width', () => {
  it('counts CJK and emoji as two cells, combining marks as zero', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('数据')).toBe(4)
    expect(displayWidth('データ')).toBe(6)
    expect(displayWidth('🚀')).toBe(2)
    expect(displayWidth('é')).toBe(1)
    expect(cellWidth('─')).toBe(1)
  })
  it('expands wide characters into two cells so grid columns line up', () => {
    expect(toCells('a数b')).toEqual(['a', '数', WIDE_TAIL, 'b'])
    const grid = toGrid(['ab', '数'])
    expect(grid[0]).toHaveLength(grid[1].length)
  })
})

describe('checkEdges on correct diagrams', () => {
  it('accepts the diamond (junction glyphs, merging buses)', () => {
    expect(checkEdges(DIAMOND, DIAMOND_BOXES, DIAMOND_EDGES)).toEqual([])
  })
  it('accepts a crossing drawn with ┼ treated as straight-through', () => {
    expect(checkEdges(CROSSING, CROSSING_BOXES, CROSSING_EDGES)).toEqual([])
  })
  it('the full oracle suite accepts both', () => {
    expect(checkRender({ render: { lines: DIAMOND, boxes: DIAMOND_BOXES, edges: DIAMOND_EDGES }, nodes: [], maxCols: 15, labels: { A: 'A', D: 'D' } })).toEqual([])
    expect(checkRender({ render: { lines: CROSSING, boxes: CROSSING_BOXES, edges: CROSSING_EDGES }, nodes: [] })).toEqual([])
  })
})

describe('checkEdges catches broken diagrams (each mutation must be detected)', () => {
  it('a gap in a vertical segment', () => {
    const bad = mutate(DIAMOND, 5, 3, ' ')
    expect(checkEdges(bad, DIAMOND_BOXES, DIAMOND_EDGES).join()).toMatch(/A → B is not drawn/)
  })
  it('a missing arrowhead', () => {
    const bad = mutate(DIAMOND, 12, 7, '│')
    expect(checkEdges(bad, DIAMOND_BOXES, DIAMOND_EDGES).join()).toMatch(/→ D is not drawn/)
  })
  it('an arrowhead drawn two rows above its box, not touching it', () => {
    const bad = mutate(mutate(DIAMOND, 12, 7, ' '), 11, 7, '▼')
    expect(checkEdges(bad, DIAMOND_BOXES, DIAMOND_EDGES).length).toBeGreaterThan(0)
  })
  it('a crossing broken into a plain vertical line cuts the horizontal edge', () => {
    const bad = mutate(CROSSING, 4, 13, '│')
    expect(checkEdges(bad, CROSSING_BOXES, CROSSING_EDGES).join()).toMatch(/A → D is not drawn/)
  })
  it('a crossing broken into a plain horizontal line cuts the vertical edge', () => {
    const bad = mutate(CROSSING, 4, 13, '─')
    expect(checkEdges(bad, CROSSING_BOXES, CROSSING_EDGES).join()).toMatch(/B → C is not drawn/)
  })
  it('a spurious connection: B wrongly joined to the A→C/D bus reaches a node that does not depend on it', () => {
    // add an extra edge in the metadata that is NOT drawn: expected set is smaller than what the drawing reaches
    const fewer = DIAMOND_EDGES.filter((e) => !(e.from === 'A' && e.to === 'C'))
    expect(checkEdges(DIAMOND, DIAMOND_BOXES, fewer).join()).toMatch(/A reaches C .*spurious/)
  })
  it('a dependent drawn above what it depends on (the prior-art ranking bug) is flagged', () => {
    const boxes = DIAMOND_BOXES.map((b) => (b.id === 'D' ? { ...b, y: 4 } : b))
    expect(checkRanksDownward(boxes, DIAMOND_EDGES).join()).toMatch(/D is not drawn below/)
  })
  it('treating ┼ as a junction (turns allowed) would wrongly connect A to C — and the oracle can say so', () => {
    expect(checkEdges(CROSSING, CROSSING_BOXES, CROSSING_EDGES, { crossingIsJunction: true }).join()).toMatch(/spurious/)
  })
})

describe('other oracles', () => {
  it('checkNoStrays flags a dangling segment that no edge uses', () => {
    expect(checkNoStrays(DIAMOND, DIAMOND_BOXES)).toEqual([])
    const bad = mutate(DIAMOND, 5, 6, '─')
    expect(checkNoStrays(bad, DIAMOND_BOXES).join()).toMatch(/stray '─' at row 5, column 6/)
  })
  it('checkArrowsPointAtBoxes flags an arrowhead pointing at nothing', () => {
    expect(checkArrowsPointAtBoxes(DIAMOND, DIAMOND_BOXES)).toEqual([])
    const bad = mutate(DIAMOND, 3, 7, '▼')
    expect(checkArrowsPointAtBoxes(bad, DIAMOND_BOXES).join()).toMatch(/does not point at a box/)
  })
  it('checkNoOverlap flags overlapping and touching boxes', () => {
    expect(checkNoOverlap(DIAMOND_BOXES)).toEqual([])
    expect(checkNoOverlap([{ id: 'a', x: 0, y: 0, w: 5, h: 3 }, { id: 'b', x: 3, y: 1, w: 5, h: 3 }]).join()).toMatch(/overlap/)
    expect(checkNoOverlap([{ id: 'a', x: 0, y: 0, w: 5, h: 3 }, { id: 'b', x: 5, y: 0, w: 5, h: 3 }]).join()).toMatch(/touch/)
    expect(checkNoOverlap([{ id: 'a', x: 0, y: 0, w: 5, h: 3 }, { id: 'b', x: 0, y: 3, w: 5, h: 3 }])).toEqual([]) // stacked boxes are fine
  })
  it('checkBoxesDrawn flags a missing corner, a broken side, and a line running through a box', () => {
    expect(checkBoxesDrawn(DIAMOND, DIAMOND_BOXES)).toEqual([])
    expect(checkBoxesDrawn(mutate(DIAMOND, 0, 4, ' '), DIAMOND_BOXES).join()).toMatch(/missing a corner/)
    expect(checkBoxesDrawn(mutate(DIAMOND, 1, 4, ' '), DIAMOND_BOXES).join()).toMatch(/broken side/)
    expect(checkBoxesDrawn(mutate(DIAMOND, 1, 7, '│'), DIAMOND_BOXES).join()).toMatch(/runs through box A/)
  })
  it('checkLabelsVisible checks the text inside the right box, wide characters included', () => {
    expect(checkLabelsVisible(DIAMOND, DIAMOND_BOXES, { A: 'A', B: 'B' })).toEqual([])
    expect(checkLabelsVisible(DIAMOND, DIAMOND_BOXES, { A: 'Z' }).join()).toMatch(/does not show "Z"/)
    const cjkBox: Box = { id: 'X', x: 0, y: 0, w: 10, h: 3 }
    const lines = ['┌────────┐', '│ 数据   │', '└────────┘']
    // a CJK label occupies two cells per character; the frame above is 10 cells wide only when counted that way
    expect(displayWidth(lines[1])).toBe(10)
    expect(checkLabelsVisible(lines, [cjkBox], { X: '数据' })).toEqual([])
  })
  it('checkWidth measures cells, not characters', () => {
    expect(checkWidth(['数据数据'], 7).join()).toMatch(/8 cells wide/)
    expect(checkWidth(['数据数据'], 8)).toEqual([])
    expect(checkWidth(['x'.repeat(81)], 80)).toHaveLength(1)
  })
  it('checkPrintable rejects stray control characters but allows ANSI colour', () => {
    expect(checkPrintable(['plain', '\u001b[31mred\u001b[0m'])).toEqual([])
    expect(checkPrintable(['bell\u0007'])).toHaveLength(1)
    expect(checkPrintable(['tab\there'])).toHaveLength(1)
  })
})

describe('ASCII glyph set', () => {
  const lines = ['+-----+', '|  A  |', '+--|--+', '   |   ', '   v   ', '+-----+', '|  B  |', '+-----+']
  const boxes: Box[] = [{ id: 'A', x: 0, y: 0, w: 7, h: 3 }, { id: 'B', x: 0, y: 5, w: 7, h: 3 }]
  it('verifies connectivity for the ASCII set', () => {
    expect(checkEdges(lines, boxes, [{ from: 'A', to: 'B' }], { ascii: true })).toEqual([])
    expect(checkBoxesDrawn(lines, boxes, { ascii: true })).toEqual([])
    expect(checkArrowsPointAtBoxes(lines, boxes, { ascii: true })).toEqual([])
  })
  it('detects a broken ASCII edge', () => {
    expect(checkEdges(mutate(lines, 3, 3, ' '), boxes, [{ from: 'A', to: 'B' }], { ascii: true }).join()).toMatch(/A → B/)
  })
})
