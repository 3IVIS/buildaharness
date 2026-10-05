import { displayWidth, toGrid, WIDE_TAIL } from './display-width.js'
import type { Box, Edge, RenderResult, VizNode } from './types.js'

/**
 * Oracles for a rendered plan diagram: they look only at the text grid plus the box and edge metadata the
 * renderer reports, never at how it was produced, so they can judge any rasterizer.
 *
 * The central one is `checkEdges`. It follows the drawn line characters like a pen would — leaving each
 * node's bottom border, moving down or sideways (never up), going straight through a crossing, and
 * stopping at an arrowhead above a box — and demands that the set of boxes reached from node X is
 * *exactly* the set of nodes that depend on X. That one check catches a missing segment, a misplaced
 * arrowhead, a line through the wrong box, two unrelated edges accidentally joined, and a node ranked
 * above something it depends on (the prior-art renderer bug found in V8).
 *
 * Drawing rules the oracle relies on (the rasterizer must follow them; see the plan, section 5.2):
 *  - edges leave a box from its bottom border and enter a box through an arrowhead directly above its top border;
 *  - a four-way glyph (`┼`) is only ever a crossing of one vertical and one horizontal line, never a junction;
 *  - junctions use T-shaped glyphs (`├ ┤ ┬ ┴`), corners use `┌ ┐ └ ┘`.
 */

const U = 1
const D = 2
const L = 4
const R = 8
type Dir = 'U' | 'D' | 'L' | 'R'
const BIT: Record<Dir, number> = { U, D, L, R }
const DELTA: Record<Dir, readonly [number, number]> = { U: [-1, 0], D: [1, 0], L: [0, -1], R: [0, 1] }
const OPPOSITE: Record<Dir, Dir> = { U: 'D', D: 'U', L: 'R', R: 'L' }

const UNICODE_BITS: Record<string, number> = {
  '│': U | D, '─': L | R, '┌': D | R, '┐': D | L, '└': U | R, '┘': U | L,
  '├': U | D | R, '┤': U | D | L, '┬': L | R | D, '┴': L | R | U, '┼': U | D | L | R, '▼': U,
}
const ASCII_BITS: Record<string, number> = { '|': U | D, '-': L | R, '+': U | D | L | R, v: U }
const ARROWS = new Set(['▼', 'v'])
const CROSSING = '┼'
const LINE_GLYPHS = new Set([...Object.keys(UNICODE_BITS), '|', '-', '+'])
/** Box-drawing glyphs only: a plain '-', '|' or '+' inside a label ("sign-off") is text, not a line (oracle fix, see grid-oracles.test.ts). */
const UNICODE_LINE_GLYPHS = new Set(Object.keys(UNICODE_BITS))

export interface OracleOptions {
  /** The diagram uses the ASCII glyph set (`| - + v`). `+` is ambiguous, so edge checks become connectivity-only. */
  ascii?: boolean
  /** Require reached = expected exactly (default true; forced off for ASCII). */
  exact?: boolean
  /** Treat `┼` as a junction (turns allowed). Default false: a crossing is straight-through only. */
  crossingIsJunction?: boolean
}

function bitsOf(ch: string, ascii: boolean): number {
  return (ascii ? ASCII_BITS[ch] : UNICODE_BITS[ch]) ?? 0
}

class Grid {
  readonly cells: string[][]
  readonly rows: number
  readonly cols: number
  constructor(lines: readonly string[], readonly boxes: readonly Box[], readonly ascii: boolean) {
    this.cells = toGrid(lines)
    this.rows = this.cells.length
    this.cols = this.rows ? this.cells[0].length : 0
  }
  boxAt(r: number, c: number): Box | undefined {
    return this.boxes.find((b) => c >= b.x && c < b.x + b.w && r >= b.y && r < b.y + b.h)
  }
  glyph(r: number, c: number): string {
    return r < 0 || c < 0 || r >= this.rows || c >= this.cols ? ' ' : this.cells[r][c]
  }
  /** Line bits of a cell outside every box (box cells never carry lines). */
  bits(r: number, c: number): number {
    return r < 0 || c < 0 || r >= this.rows || c >= this.cols || this.boxAt(r, c) ? 0 : bitsOf(this.cells[r][c], this.ascii)
  }
}

interface Trace {
  reached: Set<string>
  visited: Set<string>
}

function trace(grid: Grid, src: Box, crossingIsJunction: boolean): Trace {
  const reached = new Set<string>()
  const visitedCells = new Set<string>()
  const seen = new Set<string>()
  const queue: Array<{ r: number; c: number; d: Dir }> = []
  const startRow = src.y + src.h
  for (let c = src.x + 1; c <= src.x + src.w - 2; c++) if (grid.bits(startRow, c) & U) queue.push({ r: startRow, c, d: 'D' })
  while (queue.length) {
    const { r, c, d } = queue.shift()!
    const key = `${r},${c},${d}`
    if (seen.has(key)) continue
    seen.add(key)
    visitedCells.add(`${r},${c}`)
    const glyph = grid.glyph(r, c)
    if (ARROWS.has(glyph)) {
      const below = grid.boxAt(r + 1, c)
      if (below && r + 1 === below.y) reached.add(below.id)
      continue
    }
    const bits = grid.bits(r, c)
    let dirs = (['D', 'L', 'R'] as Dir[]).filter((dd) => bits & BIT[dd] && dd !== OPPOSITE[d])
    if (glyph === CROSSING && !crossingIsJunction) dirs = dirs.filter((dd) => dd === d)
    for (const dd of dirs) {
      const nr = r + DELTA[dd][0]
      const nc = c + DELTA[dd][1]
      if (grid.bits(nr, nc) & BIT[OPPOSITE[dd]]) queue.push({ r: nr, c: nc, d: dd })
    }
  }
  return { reached, visited: visitedCells }
}

/** Exactness: from every node, following drawn lines reaches precisely the nodes that depend on it. */
export function checkEdges(lines: readonly string[], boxes: readonly Box[], edges: readonly Edge[], opts: OracleOptions = {}): string[] {
  const ascii = opts.ascii ?? false
  const exact = ascii ? false : opts.exact ?? true
  const grid = new Grid(lines, boxes, ascii)
  const expected = new Map<string, Set<string>>(boxes.map((b) => [b.id, new Set<string>()]))
  for (const e of edges) expected.get(e.from)?.add(e.to)
  const problems: string[] = []
  for (const b of boxes) {
    const { reached } = trace(grid, b, opts.crossingIsJunction ?? false)
    const want = expected.get(b.id) ?? new Set<string>()
    for (const t of want) if (!reached.has(t)) problems.push(`edge ${b.id} → ${t} is not drawn as a connected path ending in an arrowhead`)
    if (exact) for (const t of reached) if (!want.has(t)) problems.push(`${b.id} reaches ${t} through drawn lines but ${t} does not depend on ${b.id} (spurious connection)`)
  }
  return problems
}

/** Line glyphs outside every box that no edge traversal passes through: leftovers such as the prototype's stray segments. */
export function checkNoStrays(lines: readonly string[], boxes: readonly Box[], opts: OracleOptions = {}): string[] {
  const ascii = opts.ascii ?? false
  const grid = new Grid(lines, boxes, ascii)
  const used = new Set<string>()
  for (const b of boxes) for (const cell of trace(grid, b, opts.crossingIsJunction ?? false).visited) used.add(cell)
  const problems: string[] = []
  for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
    if (grid.boxAt(r, c)) continue
    const g = grid.cells[r][c]
    if (LINE_GLYPHS.has(g) && !used.has(`${r},${c}`)) problems.push(`stray '${g}' at row ${r}, column ${c} belongs to no edge`)
  }
  return problems
}

/** Every arrowhead must sit directly above the top border of some box. */
export function checkArrowsPointAtBoxes(lines: readonly string[], boxes: readonly Box[], opts: OracleOptions = {}): string[] {
  const grid = new Grid(lines, boxes, opts.ascii ?? false)
  const problems: string[] = []
  for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
    if (grid.boxAt(r, c) || !ARROWS.has(grid.cells[r][c])) continue
    if (opts.ascii && grid.cells[r][c] === 'v' && !(grid.bits(r - 1, c) & D)) continue // a letter, not an arrowhead
    const below = grid.boxAt(r + 1, c)
    if (!below || below.y !== r + 1) problems.push(`arrowhead at row ${r}, column ${c} does not point at a box`)
  }
  return problems
}

/** No two boxes overlap, and boxes in the same rows keep at least `minGap` empty columns between them. */
export function checkNoOverlap(boxes: readonly Box[], minGap = 1): string[] {
  const problems: string[] = []
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]
    const b = boxes[j]
    const sepX = a.x + a.w + minGap <= b.x || b.x + b.w + minGap <= a.x
    const sepY = a.y + a.h <= b.y || b.y + b.h <= a.y
    if (!sepX && !sepY) problems.push(`boxes ${a.id} and ${b.id} overlap or touch`)
  }
  return problems
}

/** Edge direction: a dependent is drawn strictly below the node it depends on. */
export function checkRanksDownward(boxes: readonly Box[], edges: readonly Edge[]): string[] {
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const problems: string[] = []
  for (const e of edges) {
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    if (!a || !b) problems.push(`edge ${e.from} → ${e.to} refers to a node with no box`)
    else if (b.y < a.y + a.h + 1) problems.push(`${e.to} is not drawn below ${e.from} (it depends on it)`)
  }
  return problems
}

/** Borders are intact and nothing but label text sits inside a box. */
export function checkBoxesDrawn(lines: readonly string[], boxes: readonly Box[], opts: OracleOptions = {}): string[] {
  const ascii = opts.ascii ?? false
  const grid = new Grid(lines, boxes, ascii)
  const corner = (g: string, uni: string): boolean => g === uni || (ascii && g === '+')
  const problems: string[] = []
  for (const b of boxes) {
    const g = (r: number, c: number): string => grid.glyph(r, c)
    if (!corner(g(b.y, b.x), '┌') || !corner(g(b.y, b.x + b.w - 1), '┐') || !corner(g(b.y + b.h - 1, b.x), '└') || !corner(g(b.y + b.h - 1, b.x + b.w - 1), '┘')) problems.push(`box ${b.id} is missing a corner`)
    for (let r = b.y + 1; r < b.y + b.h - 1; r++) if (!['│', '|'].includes(g(r, b.x)) || !['│', '|'].includes(g(r, b.x + b.w - 1))) problems.push(`box ${b.id} has a broken side at row ${r}`)
    for (let r = b.y + 1; r < b.y + b.h - 1; r++) for (let c = b.x + 1; c < b.x + b.w - 1; c++) if (!ascii && UNICODE_LINE_GLYPHS.has(g(r, c))) problems.push(`a line character '${g(r, c)}' runs through box ${b.id}`)
  }
  return problems
}

/** Each node's label text (already truncated by the renderer, if it truncates) appears inside its own box. */
export function checkLabelsVisible(lines: readonly string[], boxes: readonly Box[], expected: Readonly<Record<string, string>>): string[] {
  const grid = new Grid(lines, boxes, false)
  const problems: string[] = []
  for (const b of boxes) {
    const want = expected[b.id]
    if (want === undefined) continue
    const row = Array.from({ length: b.w - 2 }, (_, i) => grid.glyph(b.y + 1, b.x + 1 + i)).filter((ch) => ch !== WIDE_TAIL).join('')
    if (!row.includes(want)) problems.push(`box ${b.id} does not show "${want}" (shows "${row.trim()}")`)
  }
  return problems
}

/** No output line is wider than the terminal, measured in cells (CJK and emoji count as two). */
export function checkWidth(lines: readonly string[], maxCols: number): string[] {
  const problems: string[] = []
  lines.forEach((line, i) => {
    const w = displayWidth(line)
    if (w > maxCols) problems.push(`line ${i} is ${w} cells wide (limit ${maxCols})`)
  })
  return problems
}

/** Output must be plain printable text: no stray control characters or newlines inside a line. */
export function checkPrintable(lines: readonly string[]): string[] {
  // eslint-disable-next-line no-control-regex
  return lines.flatMap((line, i) => (/[\u0000-\u001f\u007f]/.test(line.replace(/\u001b\[[0-9;]*m/g, '')) ? [`line ${i} contains a control character`] : []))
}

export interface RenderCheckInput {
  render: RenderResult
  nodes: readonly VizNode[]
  /** Terminal width the render was asked for; width is only checked when given. */
  maxCols?: number
  /** Expected visible label text per node id (after any truncation); omit to skip. */
  labels?: Readonly<Record<string, string>>
  opts?: OracleOptions
}

/** Runs every grid oracle and returns all violations (empty = the diagram is correct). */
export function checkRender({ render, maxCols, labels, opts = {} }: RenderCheckInput): string[] {
  const { lines, boxes, edges } = render
  return [
    ...checkNoOverlap(boxes),
    ...checkRanksDownward(boxes, edges),
    ...checkBoxesDrawn(lines, boxes, opts),
    ...checkEdges(lines, boxes, edges, opts),
    ...checkNoStrays(lines, boxes, opts),
    ...checkArrowsPointAtBoxes(lines, boxes, opts),
    ...checkPrintable(lines),
    ...(maxCols !== undefined ? checkWidth(lines, maxCols) : []),
    ...(labels ? checkLabelsVisible(lines, boxes, labels) : []),
  ]
}
