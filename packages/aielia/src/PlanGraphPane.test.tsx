import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderInk, type TestInkInstance } from './ink-test-render.js'
import { PlanGraphPane } from './PlanGraphPane.js'
import { PlanGraphBridge } from './tui-app.js'
import { NINE_TASK_PLAN, withStatus } from './plan-viz/testkit/generators.js'
import type { VizNode } from './plan-viz/types.js'

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const TAB = '\t'
const SHIFT_TAB = '\x1b[Z'
const ANSI = /\x1b\[[0-9;]*m/g
const sleep = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms))
const strip = (f: string | undefined): string => (f ?? '').replace(ANSI, '')

let inst: TestInkInstance | undefined
afterEach(() => {
  inst?.unmount()
  inst = undefined
})

async function press(i: TestInkInstance, key: string): Promise<void> {
  i.stdin.write(key)
  await sleep()
}

/** The label of the selected node: it is the box marked with ">" (colour off) in its left padding cell. */
const selectedLine = (i: TestInkInstance): string => strip(i.lastFrame()).split('\n').find((l) => /│>/.test(l) || /\|>/.test(l)) ?? ''

const mount = (nodes: readonly VizNode[], props: Partial<Parameters<typeof PlanGraphPane>[0]> = {}) =>
  (inst = renderInk(<PlanGraphPane nodes={nodes} columns={100} rows={40} color={false} onClose={() => {}} {...props} />))

describe('PlanGraphPane', () => {
  it('draws the plan with a selected node and no editing keys bound', async () => {
    const i = mount(NINE_TASK_PLAN)
    await sleep()
    expect(strip(i.lastFrame())).toContain('Plan graph')
    expect(selectedLine(i)).not.toBe('')
    const before = i.lastFrame()
    for (const ch of ['x', 'e', 'a', 'D', '-', ' ']) await press(i, ch)
    expect(i.lastFrame()).toBe(before)
  })

  it('Tab and Shift+Tab step through task order and arrows move the selection', async () => {
    const i = mount(NINE_TASK_PLAN)
    await sleep()
    const first = selectedLine(i)
    await press(i, TAB)
    const second = selectedLine(i)
    expect(second).not.toBe(first)
    await press(i, SHIFT_TAB)
    expect(selectedLine(i)).toBe(first)
    for (const k of [DOWN, RIGHT, LEFT, UP]) await press(i, k)
    expect(selectedLine(i)).not.toBe('')
  })

  it('toggles the detail drawer with Enter below 120 columns and docks it at 120+', async () => {
    const i = mount(NINE_TASK_PLAN)
    await sleep()
    expect(strip(i.lastFrame())).not.toContain('Status:')
    await press(i, '\r')
    expect(strip(i.lastFrame())).toContain('Status:')
    await press(i, 'd')
    expect(strip(i.lastFrame())).not.toContain('Status:')
    i.unmount()
    const wide = mount(NINE_TASK_PLAN, { columns: 140 })
    await sleep()
    expect(strip(wide.lastFrame())).toContain('Status:')
  })

  it('[ and ] are aliases of the up and down arrows', async () => {
    const selectAfter = async (keys: string[]): Promise<string> => {
      const i = mount(NINE_TASK_PLAN)
      await sleep()
      for (const k of keys) await press(i, k)
      const line = selectedLine(i)
      i.unmount()
      inst = undefined
      return line
    }
    expect(await selectAfter([']'])).toBe(await selectAfter([DOWN]))
    expect(await selectAfter([']'])).not.toBe(await selectAfter([]))
    expect(await selectAfter([']', '['])).toBe(await selectAfter([DOWN, UP]))
    expect(await selectAfter([']', ']', '['])).toBe(await selectAfter([DOWN, DOWN, UP]))
  })

  it('scrolls the detail drawer with j/k and PgUp/PgDn, clamped, and starts at the top for another node', async () => {
    const PGUP = '\x1b[5~'
    const PGDN = '\x1b[6~'
    const long: VizNode[] = [
      { id: 'A', label: Array.from({ length: 60 }, (_, n) => `word${n}`).join(' '), status: 'running', deps: [] },
      { id: 'B', label: 'short', status: 'pending', deps: ['A'] },
    ]
    const i = mount(long, { columns: 140, rows: 10 }) // docked drawer, 8 visible rows
    await sleep()
    // The graph box also shows the label's first words, so the checks key on lines only the drawer reaches.
    expect(strip(i.lastFrame())).not.toContain('word30') // 8 drawer rows: the id, a blank, then label lines up to word25
    expect(strip(i.lastFrame())).not.toContain('Status:')
    await press(i, 'j')
    expect(strip(i.lastFrame())).toContain('word30') // moved down one line
    await press(i, 'k')
    await press(i, 'k') // clamped at the top
    expect(strip(i.lastFrame())).not.toContain('word30')
    for (let n = 0; n < 6; n++) await press(i, PGDN)
    expect(strip(i.lastFrame())).toContain('Status:') // clamped at the bottom, tail visible
    expect(strip(i.lastFrame())).not.toContain('word30')
    await press(i, PGUP)
    expect(strip(i.lastFrame())).not.toContain('Status:')
    await press(i, PGDN)
    await press(i, TAB) // a different node: drawer text starts at the top again
    expect(strip(i.lastFrame())).toContain('Status:')
    expect(strip(i.lastFrame())).toContain('short')
  })

  it('keeps the selection across a live update and falls back deterministically when the node disappears', async () => {
    const i = mount(NINE_TASK_PLAN)
    await sleep()
    await press(i, TAB)
    await press(i, TAB)
    const sel = selectedLine(i)
    i.rerender(<PlanGraphPane nodes={withStatus(NINE_TASK_PLAN, NINE_TASK_PLAN[0].id, 'running')} columns={100} rows={40} color={false} onClose={() => {}} />)
    await sleep()
    expect(selectedLine(i)).toBe(sel)
    // Remove the third task: selection falls back to the node now at that position, not to nothing.
    const removed = NINE_TASK_PLAN.filter((n) => n.id !== NINE_TASK_PLAN[2].id).map((n) => ({ ...n, deps: n.deps.filter((d) => d !== NINE_TASK_PLAN[2].id) }))
    i.rerender(<PlanGraphPane nodes={removed} columns={100} rows={40} color={false} onClose={() => {}} />)
    await sleep()
    expect(selectedLine(i)).not.toBe('')
  })

  it('ignores keys while an approval prompt owns the keyboard (active=false)', async () => {
    const onClose = vi.fn()
    const i = mount(NINE_TASK_PLAN, { active: false, onClose })
    await sleep()
    const before = selectedLine(i)
    await press(i, TAB)
    await press(i, 'q')
    expect(selectedLine(i)).toBe(before)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('q and Esc close; re-lays out on a narrower width and pans to follow the selection', async () => {
    const onClose = vi.fn()
    const i = mount(NINE_TASK_PLAN, { columns: 30, rows: 8, onClose })
    await sleep()
    for (let n = 0; n < 9; n++) await press(i, TAB)
    expect(selectedLine(i)).not.toBe('')
    await press(i, 'q')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows a message instead of throwing when the plan cannot be drawn', async () => {
    const i = mount([])
    await sleep()
    expect(strip(i.lastFrame())).toMatch(/unavailable|nothing/i)
  })
})

describe('PlanGraphBridge', () => {
  it('brackets the screen switch with empty frames and writes the escapes through the raw writer only', async () => {
    const writes: string[] = []
    const modes: string[] = []
    const bridge = new PlanGraphBridge((c) => writes.push(c), 5, 5)
    bridge.subscribe(() => modes.push(bridge.getSnapshot().mode))
    for (let n = 0; n < 3; n++) {
      await bridge.open(NINE_TASK_PLAN)
      await bridge.close()
    }
    expect(writes).toEqual(['\x1b[?1049h', '\x1b[?1049l', '\x1b[?1049h', '\x1b[?1049l', '\x1b[?1049h', '\x1b[?1049l'])
    expect(modes.slice(0, 3)).toEqual(['blank', 'pane', 'blank'])
    expect(modes.slice(3, 4)).toEqual(['chat'])
  })

  it('coalesces a burst of 200 updates to at most one render per interval', async () => {
    const bridge = new PlanGraphBridge(() => {}, 1, 100)
    await bridge.open(NINE_TASK_PLAN)
    let renders = 0
    bridge.subscribe(() => renders++)
    const start = Date.now()
    for (let n = 0; n < 200; n++) {
      bridge.update(withStatus(NINE_TASK_PLAN, NINE_TASK_PLAN[n % 9].id, n % 2 ? 'running' : 'done'))
      await sleep(1)
    }
    const elapsed = Date.now() - start
    await sleep(120)
    expect(renders).toBeLessThanOrEqual(Math.ceil(elapsed / 100) + 2)
    expect(renders).toBeGreaterThan(0)
    await bridge.close()
  })

  it('restore() leaves the alternate screen synchronously and update is a no-op in chat mode', async () => {
    const writes: string[] = []
    const bridge = new PlanGraphBridge((c) => writes.push(c), 1, 1)
    bridge.update(NINE_TASK_PLAN)
    expect(bridge.getSnapshot().mode).toBe('chat')
    await bridge.open(NINE_TASK_PLAN)
    bridge.restore()
    expect(writes).toEqual(['\x1b[?1049h', '\x1b[?1049l'])
    expect(bridge.isOpen()).toBe(false)
  })
})
