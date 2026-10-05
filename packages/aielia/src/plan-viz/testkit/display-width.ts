/**
 * An intentionally simple, independent terminal cell-width function for the oracles. The production
 * renderer may use a library; checking it against this separate implementation catches width bugs in
 * either (CJK, emoji, combining marks). Covers the ranges that matter for plan labels, not all of Unicode.
 */

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
  // single-codepoint emoji that are East Asian Wide (✅ ❌ ⚡ ⭐ ❓ ➕): drawn two cells wide
  [0x2705, 0x2705], [0x274c, 0x274c], [0x26a1, 0x26a1], [0x2b50, 0x2b50], [0x2753, 0x2755], [0x2795, 0x2797],
]
const ZERO_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [[0x0300, 0x036f], [0x200b, 0x200d], [0xfe00, 0xfe0f]]

export function cellWidth(ch: string): 0 | 1 | 2 {
  const cp = ch.codePointAt(0) ?? 0
  if (ZERO_WIDTH_RANGES.some(([a, b]) => cp >= a && cp <= b)) return 0
  if (WIDE_RANGES.some(([a, b]) => cp >= a && cp <= b)) return 2
  return 1
}

export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += cellWidth(ch)
  return w
}

/** Marks the second cell of a double-width character in a cell grid. */
export const WIDE_TAIL = '\u0000'

/** Expands a line into one entry per terminal cell (a wide character becomes [char, WIDE_TAIL]). */
export function toCells(line: string): string[] {
  const out: string[] = []
  for (const ch of line) {
    const w = cellWidth(ch)
    if (w === 0) continue
    out.push(ch)
    if (w === 2) out.push(WIDE_TAIL)
  }
  return out
}

export function toGrid(lines: readonly string[]): string[][] {
  const rows = lines.map(toCells)
  const width = Math.max(0, ...rows.map((r) => r.length))
  return rows.map((r) => (r.length < width ? [...r, ...Array<string>(width - r.length).fill(' ')] : r))
}
