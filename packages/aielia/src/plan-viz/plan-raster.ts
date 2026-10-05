import { BOX_HEIGHT, LABEL_FLOOR, layoutPlan, type LayoutFailure, type LayoutItem, type PlanLayout } from './plan-layout.js'
import { cellWidth, WIDE_TAIL } from './plan-width.js'
import type { Box, Edge, RenderResult, VizNode, VizStatus } from './types.js'

export interface PlanRenderOptions {
  /** Terminal width in cells; labels shrink (down to a floor) until the picture fits. Omit for the natural size. */
  maxCols?: number
  ascii?: boolean
  color?: boolean
  selectedId?: string
}

/** What a successful render returns beyond what the grid oracles need. */
export interface PlanRender extends RenderResult {
  ok: true
  width: number
  height: number
  /** False when even the shortest labels do not fit `maxCols`; the caller pans a viewport over the full grid. */
  fits: boolean
  /** The label text each box shows (after sanitizing and shortening). */
  labels: Record<string, string>
  /** Cells (row, column) every edge is drawn through, keyed `${from}>${to}`. */
  routes: Record<string, Array<[number, number]>>
  /** One entry per terminal cell (a double-width character is followed by WIDE_TAIL) and its SGR parameters ('' = none). */
  cells: string[][]
  styles: string[][]
  warnings: string[]
}

export type PlanRenderFailure = LayoutFailure

export const GLYPHS: Record<VizStatus, string> = { done: '✓', running: '▶', failed: '✗', pending: '○', ready: '◔', awaiting_user: '~', awaiting_input: '⏸', cancelled: '⊘' }
export const ASCII_GLYPHS: Record<VizStatus, string> = { done: '+', running: '>', failed: 'x', pending: 'o', ready: '*', awaiting_user: '~', awaiting_input: '=', cancelled: '/' }
const STATUS_SGR: Record<VizStatus, string> = { done: '32', running: '33', failed: '31', pending: '2', ready: '36', awaiting_user: '35', awaiting_input: '35', cancelled: '2' }

const U = 1
const D = 2
const L = 4
const R = 8
const UNICODE_GLYPH: Record<number, string> = {
  [U]: '│', [D]: '│', [U | D]: '│', [L]: '─', [R]: '─', [L | R]: '─', [D | R]: '┌', [D | L]: '┐', [U | R]: '└', [U | L]: '┘',
  [U | D | R]: '├', [U | D | L]: '┤', [L | R | D]: '┬', [L | R | U]: '┴', [U | D | L | R]: '┼',
}
const LABEL_STEPS = [40, 30, 24, 20, 16, 13, 10, LABEL_FLOOR]

type Cell = [number, number]

interface GapPlan {
  rows: number
  /** Relative to the gap's first row. */
  vlines: Array<{ col: number; r1: number; r2: number; top: boolean; bot: boolean }>
  hlines: Array<{ row: number; c1: number; c2: number }>
  arrows: Array<{ row: number; col: number }>
  routes: Array<{ chain: number; cells: Cell[] }>
  maxCol: number
}

class CannotDraw extends Error {}

const cV = (col: number, r1: number, r2: number): Cell[] => Array.from({ length: r2 - r1 + 1 }, (_, i) => [r1 + i, col] as Cell)
const cH = (row: number, c1: number, c2: number): Cell[] => {
  const lo = Math.min(c1, c2)
  return Array.from({ length: Math.abs(c2 - c1) + 1 }, (_, i) => [row, lo + i] as Cell)
}
const portRange = (it: LayoutItem): [number, number] => (it.virtual ? [it.x, it.x] : [it.x + 1, it.x + it.w - 2])

/**
 * Channel routing for the gap between rank g and g+1. Every edge of the gap is a stem down from its source,
 * an optional bus row, a drop column and an optional bus row on the target, then one arrow column. Columns
 * of stems, drops and arrows are all distinct, so a vertical only ever meets a horizontal as a crossing
 * (┼) and unrelated edges never share a cell. Rows: source buses, target buses, then the arrow row.
 */
function planGap(layout: PlanLayout, g: number): GapPlan {
  const top = layout.ranks[g]
  const bot = layout.ranks[g + 1]
  const segs: Array<{ a: LayoutItem; b: LayoutItem; chain: number }> = []
  layout.chains.forEach((c, ci) => {
    for (let k = 0; k + 1 < c.items.length; k++) if (c.items[k].rank === g) segs.push({ a: c.items[k], b: c.items[k + 1], chain: ci })
  })
  const outN = new Map<number, number>()
  const inN = new Map<number, number>()
  for (const s of segs) { outN.set(s.a.uid, (outN.get(s.a.uid) ?? 0) + 1); inN.set(s.b.uid, (inN.get(s.b.uid) ?? 0) + 1) }

  const limit = layout.width + 24
  const used = new Set<number>()
  for (const it of [...top, ...bot]) if (it.virtual) used.add(it.x)
  const pickFree = (lo: number, hi: number, pref: number): number | undefined => {
    const p = Math.min(hi, Math.max(lo, pref))
    for (let d = 0; d <= hi - lo; d++) for (const c of d === 0 ? [p] : [p - d, p + d]) if (c >= lo && c <= hi && !used.has(c)) return c
    return undefined
  }
  const sc = new Map<number, number>()
  const tc = new Map<number, number>()
  for (const it of top) if (it.virtual) sc.set(it.uid, it.x)
  for (const it of bot) if (it.virtual) tc.set(it.uid, it.x)

  const straight = new Set<(typeof segs)[number]>()
  for (const s of segs) {
    if (outN.get(s.a.uid) !== 1 || inN.get(s.b.uid) !== 1) continue
    const [alo, ahi] = portRange(s.a)
    const [blo, bhi] = portRange(s.b)
    const lo = Math.max(alo, blo)
    const hi = Math.min(ahi, bhi)
    if (lo > hi) continue
    let c: number | undefined
    if (s.a.virtual || s.b.virtual) c = s.a.virtual ? s.a.x : s.b.x
    else c = pickFree(lo, hi, Math.round((s.a.x + s.a.w / 2 + s.b.x + s.b.w / 2) / 2))
    if (c === undefined || c < lo || c > hi) continue
    used.add(c)
    sc.set(s.a.uid, c)
    tc.set(s.b.uid, c)
    straight.add(s)
  }
  for (const [items, ports, counts] of [[top, sc, outN], [bot, tc, inN]] as const) {
    for (const it of items) {
      if (!counts.get(it.uid) || ports.has(it.uid)) continue
      const [lo, hi] = portRange(it)
      const c = pickFree(lo, hi, Math.round(it.x + it.w / 2))
      if (c === undefined) throw new CannotDraw('no free port column')
      used.add(c)
      ports.set(it.uid, c)
    }
  }

  const dropOf = new Map<(typeof segs)[number], number>()
  const needSrc = new Set<number>()
  const needTgt = new Set<number>()
  for (const s of segs) {
    if (straight.has(s)) continue
    const srcSingle = outN.get(s.a.uid) === 1
    const tgtSingle = inN.get(s.b.uid) === 1
    if (srcSingle && !tgtSingle) { dropOf.set(s, sc.get(s.a.uid)!); needTgt.add(s.b.uid) }
    else if (tgtSingle) { dropOf.set(s, tc.get(s.b.uid)!); needSrc.add(s.a.uid) }
  }
  for (const s of segs) {
    if (straight.has(s) || dropOf.has(s)) continue
    const c = pickFree(0, limit, Math.round((sc.get(s.a.uid)! + tc.get(s.b.uid)!) / 2))
    if (c === undefined) throw new CannotDraw('no free drop column')
    used.add(c)
    dropOf.set(s, c)
    needSrc.add(s.a.uid)
    needTgt.add(s.b.uid)
  }

  const srcRow = new Map<number, number>()
  const tgtRow = new Map<number, number>()
  top.filter((it) => needSrc.has(it.uid)).forEach((it, i) => srcRow.set(it.uid, i))
  bot.filter((it) => needTgt.has(it.uid)).forEach((it, i) => tgtRow.set(it.uid, srcRow.size + i))
  const rows = Math.max(srcRow.size + tgtRow.size + 1, 2)
  const last = rows - 1

  const plan: GapPlan = { rows, vlines: [], hlines: [], arrows: [], routes: [], maxCol: Math.max(0, ...used) }
  const arrive = (b: LayoutItem, col: number): void => { if (!b.virtual) plan.arrows.push({ row: last, col }) }
  for (const s of segs) {
    const a = sc.get(s.a.uid)!
    const t = tc.get(s.b.uid)!
    const botOpen = s.b.virtual
    const cells: Cell[] = []
    if (straight.has(s)) {
      plan.vlines.push({ col: a, r1: 0, r2: last, top: true, bot: botOpen })
      arrive(s.b, a)
      cells.push(...cV(a, 0, last))
    } else {
      const d = dropOf.get(s)!
      const sr = srcRow.get(s.a.uid)
      const tr = tgtRow.get(s.b.uid)
      const haveSrc = sr !== undefined && needSrc.has(s.a.uid) && d !== a
      const haveTgt = tr !== undefined && needTgt.has(s.b.uid) && d !== t
      if (haveSrc) {
        plan.vlines.push({ col: a, r1: 0, r2: sr!, top: true, bot: false })
        plan.hlines.push({ row: sr!, c1: Math.min(a, d), c2: Math.max(a, d) })
        cells.push(...cV(a, 0, sr!), ...cH(sr!, a, d))
      }
      const y1 = haveSrc ? sr! : 0
      const y2 = haveTgt ? tr! : last
      plan.vlines.push({ col: d, r1: y1, r2: y2, top: !haveSrc, bot: !haveTgt && botOpen })
      cells.push(...cV(d, y1, y2))
      if (haveTgt) {
        plan.hlines.push({ row: tr!, c1: Math.min(d, t), c2: Math.max(d, t) })
        plan.vlines.push({ col: t, r1: tr!, r2: last, top: false, bot: botOpen })
        cells.push(...cH(tr!, d, t), ...cV(t, tr!, last))
        arrive(s.b, t)
      } else arrive(s.b, d)
    }
    plan.routes.push({ chain: s.chain, cells })
    plan.maxCol = Math.max(plan.maxCol, ...cells.map((c) => c[1]))
  }
  return plan
}

function drawOnce(layout: PlanLayout, opts: PlanRenderOptions): PlanRender {
  const ascii = opts.ascii ?? false
  const gaps = layout.ranks.slice(0, -1).map((_, g) => planGap(layout, g))
  const rankY: number[] = [0]
  gaps.forEach((gp, g) => rankY.push(rankY[g] + BOX_HEIGHT + gp.rows))
  const height = rankY[rankY.length - 1] + BOX_HEIGHT
  const width = Math.max(layout.width, ...gaps.map((gp) => gp.maxCol + 1))

  const bits = Array.from({ length: height }, () => new Uint8Array(width))
  const arrows: Cell[] = []
  // Route pieces are ordered along the edge: waypoint rows at even positions, gaps at odd ones.
  const parts: Array<Array<{ at: number; cells: Cell[] }>> = layout.chains.map(() => [])
  gaps.forEach((gp, g) => {
    const y0 = rankY[g] + BOX_HEIGHT
    for (const v of gp.vlines) for (let r = v.r1; r <= v.r2; r++) bits[y0 + r][v.col] |= (r > v.r1 || v.top ? U : 0) | (r < v.r2 || v.bot ? D : 0)
    for (const h of gp.hlines) for (let c = h.c1; c <= h.c2; c++) bits[y0 + h.row][c] |= (c > h.c1 ? L : 0) | (c < h.c2 ? R : 0)
    for (const a of gp.arrows) arrows.push([y0 + a.row, a.col])
    for (const rt of gp.routes) parts[rt.chain].push({ at: g * 2 + 1, cells: rt.cells.map(([r, c]) => [y0 + r, c] as Cell) })
  })
  layout.chains.forEach((ch, ci) => {
    for (const it of ch.items) if (it.virtual) {
      for (let r = 0; r < BOX_HEIGHT; r++) bits[rankY[it.rank] + r][it.x] |= U | D
      parts[ci].push({ at: it.rank * 2, cells: [0, 1, 2].map((r) => [rankY[it.rank] + r, it.x] as Cell) })
    }
  })

  const routes: Record<string, Cell[]> = Object.fromEntries(layout.chains.map((c, ci) => [`${c.from}>${c.to}`, parts[ci].sort((p, q) => p.at - q.at).flatMap((p) => p.cells)]))

  const cells: string[][] = bits.map((row) => Array.from(row, (b) => (b ? (ascii ? (b & (L | R) && b & (U | D) ? '+' : b & (L | R) ? '-' : '|') : UNICODE_GLYPH[b]) : ' ')))
  for (const [r, c] of arrows) cells[r][c] = ascii ? 'v' : '▼'
  const styles: string[][] = cells.map((row) => row.map(() => ''))

  const glyphs = ascii ? ASCII_GLYPHS : GLYPHS
  const boxes: Box[] = []
  const labels: Record<string, string> = {}
  const put = (r: number, c: number, ch: string, style = ''): number => {
    const w = cellWidth(ch)
    if (w === 0) return 0
    cells[r][c] = ch
    styles[r][c] = style
    if (w === 2) { cells[r][c + 1] = WIDE_TAIL; styles[r][c + 1] = style }
    return w
  }
  const color = opts.color ?? false
  for (const node of layout.nodes) {
    const it = layout.byId.get(node.id)!
    const y = rankY[it.rank]
    const { x, w } = it
    boxes.push({ id: node.id, x, y, w, h: BOX_HEIGHT })
    labels[node.id] = it.label!
    const selected = opts.selectedId === node.id
    const [tl, tr, bl, br, h, v] = ascii ? ['+', '+', '+', '+', '-', '|'] : ['┌', '┐', '└', '┘', '─', '│']
    for (let c = x; c < x + w; c++) { put(y, c, c === x ? tl : c === x + w - 1 ? tr : h); put(y + 2, c, c === x ? bl : c === x + w - 1 ? br : h) }
    for (let c = x; c < x + w; c++) put(y + 1, c, ' ', color && selected ? '7' : '')
    put(y + 1, x, v)
    put(y + 1, x + w - 1, v)
    const mid = color && selected ? '7' : ''
    if (selected && !color) put(y + 1, x + 1, '>')
    put(y + 1, x + 2, glyphs[node.status] ?? '?', color ? (selected ? '7;' : '') + STATUS_SGR[node.status] : '')
    let c = x + 4
    for (const ch of it.label!) c += put(y + 1, c, ch, mid)
  }

  if (color && opts.selectedId) {
    for (const [key, route] of Object.entries(routes)) {
      const e = layout.chains.find((ch) => `${ch.from}>${ch.to}` === key)!
      if (e.from === opts.selectedId || e.to === opts.selectedId) for (const [r, c] of route) if (!styles[r][c]) styles[r][c] = '1;36'
    }
  }

  const edges: Edge[] = layout.chains.map((c) => ({ from: c.from, to: c.to }))
  return { ok: true, lines: toLines(cells, styles), boxes, edges, width, height, fits: true, labels, routes, cells, styles, warnings: layout.warnings }
}

/** Joins cells into text lines, emitting SGR sequences only where the style changes. Trailing blanks are dropped. */
export function toLines(cells: readonly string[][], styles: readonly string[][], rows?: [number, number], cols?: [number, number]): string[] {
  const [r0, r1] = rows ?? [0, cells.length]
  const out: string[] = []
  for (let r = r0; r < r1; r++) {
    const row = cells[r]
    const [c0, c1] = cols ?? [0, row.length]
    let end = c1
    while (end > c0 && (row[end - 1] === ' ' && !styles[r][end - 1])) end--
    let line = ''
    let cur = ''
    for (let c = c0; c < end; c++) {
      if (row[c] === WIDE_TAIL) continue
      if (styles[r][c] !== cur) { line += cur ? '\u001b[0m' : ''; cur = styles[r][c]; line += cur ? `\u001b[${cur}m` : '' }
      line += row[c]
    }
    out.push(line + (cur ? '\u001b[0m' : ''))
  }
  return out
}

/**
 * Lays out and draws a plan. Labels shrink (down to a floor) until the picture fits `maxCols`; when it still
 * does not, the full-size grid is returned with `fits: false` so the caller can pan over it. Never throws:
 * a plan that cannot be drawn comes back as `{ ok: false, reason, message }` and the caller shows the checklist.
 */
export function renderPlan(nodes: readonly VizNode[], opts: PlanRenderOptions = {}): PlanRender | PlanRenderFailure {
  try {
    let result: PlanRender | undefined
    for (const labelMax of LABEL_STEPS) {
      const layout = layoutPlan(nodes, labelMax)
      if (!layout.ok) return layout
      result = drawOnce(layout, opts)
      if (opts.maxCols === undefined || result.width <= opts.maxCols) return result
    }
    return { ...result!, fits: false }
  } catch (err) {
    return { ok: false, reason: 'cannot_draw', message: err instanceof Error ? err.message : String(err) }
  }
}
