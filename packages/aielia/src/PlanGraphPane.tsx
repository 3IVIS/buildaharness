import { useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { renderPlan, toLines } from './plan-viz/plan-raster.js'
import { navModelFrom, planNavigator, type NavKey, type NavState } from './plan-viz/plan-nav.js'
import { followSelection, scrollIndicators, type Viewport } from './plan-viz/plan-viewport.js'
import { planDetailLines } from './plan-viz/plan-detail-lines.js'
import type { VizNode } from './plan-viz/types.js'

/** Width at which the detail drawer docks to the right instead of being toggled. */
export const DRAWER_DOCK_COLUMNS = 120
const DRAWER_WIDTH = 36

export interface PlanGraphPaneProps {
  nodes: readonly VizNode[]
  columns: number
  rows: number
  /** False while an approval prompt owns the keyboard: the pane stays drawn but ignores keys. */
  active?: boolean
  color?: boolean
  ascii?: boolean
  onClose: () => void
}

/**
 * Read-only plan graph pane (plans/plan_visualization_plan.html, R2). Keys: arrows move along edges and ranks,
 * Tab/Shift+Tab walk task order, Enter or d toggles the detail drawer below 120 columns, q or Esc closes.
 * No key edits anything: the plan changes only through the approval gate.
 */
export function PlanGraphPane({ nodes, columns, rows, active = true, color = true, ascii = false, onClose }: PlanGraphPaneProps): React.JSX.Element {
  const docked = columns >= DRAWER_DOCK_COLUMNS
  const [drawerOpen, setDrawerOpen] = useState(false)
  const showDrawer = docked || drawerOpen
  const graphCols = showDrawer ? Math.max(20, columns - DRAWER_WIDTH - 1) : columns
  const graphRows = Math.max(3, rows - 2)

  const [nav, setNav] = useState<NavState | undefined>(undefined)
  const lastIndex = useRef(0)
  const viewport = useRef<Viewport>({ left: 0, top: 0, width: 0, height: 0 })

  // Layout is independent of the selection (boxes never move), so the model comes from an unselected render.
  const base = useMemo(() => renderPlan(nodes, { maxCols: graphCols, ascii, color: false }), [nodes, graphCols, ascii])
  const model = useMemo(() => (base.ok ? navModelFrom(nodes, base.boxes) : undefined), [nodes, base])

  // The selection survives updates; if its node disappeared, fall back to the node now at the same position (clamped).
  let selectedId: string | undefined
  if (model && model.ids.length) {
    if (nav && model.ids.includes(nav.cur)) selectedId = nav.cur
    else selectedId = model.taskOrder[Math.min(lastIndex.current, model.taskOrder.length - 1)]
  }
  if (model && selectedId) lastIndex.current = model.taskOrder.indexOf(selectedId)

  useInput(
    (input, key) => {
      if (key.escape || input === 'q') return onClose()
      if (key.return || input === 'd') return setDrawerOpen((open) => !open)
      if (!model || !selectedId) return
      const k: NavKey | undefined = key.upArrow ? 'up' : key.downArrow ? 'down' : key.leftArrow ? 'left' : key.rightArrow ? 'right' : key.tab ? (key.shift ? 'shiftTab' : 'tab') : undefined
      if (!k) return
      const from: NavState = nav && nav.cur === selectedId ? nav : planNavigator.start(model, selectedId)
      setNav(planNavigator.press(model, from, k))
    },
    { isActive: active },
  )

  if (!base.ok || !model) {
    return (
      <Box flexDirection="column" height={rows}>
        <Text>Plan graph unavailable: {base.ok ? 'nothing to draw' : base.message}</Text>
        <Text dimColor>q / Esc closes</Text>
      </Box>
    )
  }

  const r = renderPlan(nodes, { maxCols: graphCols, ascii, color, selectedId })
  if (!r.ok) return <Text>Plan graph unavailable: {r.message}</Text>
  const box = r.boxes.find((b) => b.id === selectedId)
  const vp = box ? followSelection(viewport.current, box, r, { cols: graphCols, rows: graphRows }) : { left: 0, top: 0, width: Math.min(graphCols, r.width), height: Math.min(graphRows, r.height) }
  viewport.current = vp
  const lines = toLines(r.cells, r.styles, [vp.top, vp.top + vp.height], [vp.left, vp.left + vp.width])
  const more = scrollIndicators(vp, r)
  const arrows = `${more.up ? '↑' : ' '}${more.down ? '↓' : ' '}${more.left ? '←' : ' '}${more.right ? '→' : ' '}`
  const done = nodes.filter((n) => n.status === 'done').length

  return (
    <Box flexDirection="column" height={rows}>
      <Text bold>
        {`Plan graph — ${done}/${nodes.length} done `}<Text dimColor>{arrows}</Text>
      </Text>
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" width={graphCols}>
          {lines.map((line, i) => (
            <Text key={i} wrap="truncate">{line.length ? line : ' '}</Text>
          ))}
        </Box>
        {showDrawer && (
          <Box flexDirection="column" width={DRAWER_WIDTH + 1} paddingLeft={1} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false}>
            {planDetailLines(nodes, selectedId, DRAWER_WIDTH - 2).map((line, i) => (
              <Text key={i} wrap="truncate">{line.length ? line : ' '}</Text>
            ))}
          </Box>
        )}
      </Box>
      <Text dimColor>{docked ? '↑↓←→ move · Tab next · q close' : '↑↓←→ move · Tab next · Enter details · q close'}</Text>
    </Box>
  )
}
