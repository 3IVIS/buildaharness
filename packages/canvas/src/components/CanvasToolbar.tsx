import { useEffect, useMemo, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { Minus, Plus, Maximize, LayoutDashboard, Search } from 'lucide-react'
import { useCanvasStore } from '../store/context'

export const CANVAS_SEARCH_EVENT = 'itsharness:open-canvas-search'

export function CanvasToolbar() {
  const { autoLayout } = useCanvasStore((s) => s)
  const { zoomIn, zoomOut, fitView } = useReactFlow()
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    const onOpen = () => setSearchOpen(true)
    window.addEventListener(CANVAS_SEARCH_EVENT, onOpen as EventListener)
    return () => window.removeEventListener(CANVAS_SEARCH_EVENT, onOpen as EventListener)
  }, [])

  return (
    <>
      <div className="canvas-toolbar" role="toolbar" aria-label="Canvas controls">
        <button className="canvas-toolbar__btn" onClick={() => zoomOut()} title="Zoom out">
          <Minus size={13} />
        </button>
        <button className="canvas-toolbar__btn" onClick={() => zoomIn()} title="Zoom in">
          <Plus size={13} />
        </button>
        <button
          className="canvas-toolbar__btn"
          onClick={() => fitView({ padding: 0.2, duration: 200 })}
          title="Fit view"
        >
          <Maximize size={13} />
        </button>
        <span className="canvas-toolbar__sep" />
        <button className="canvas-toolbar__btn" onClick={autoLayout} title="Auto-layout (dagre LR)">
          <LayoutDashboard size={13} />
        </button>
        <span className="canvas-toolbar__sep" />
        <button
          className={`canvas-toolbar__btn${searchOpen ? ' canvas-toolbar__btn--active' : ''}`}
          onClick={() => setSearchOpen((v) => !v)}
          title="Find on canvas (⌘F)"
        >
          <Search size={13} />
        </button>
      </div>
      {searchOpen && <CanvasSearch onClose={() => setSearchOpen(false)} />}
    </>
  )
}

function CanvasSearch({ onClose }: { onClose: () => void }) {
  const nodes      = useCanvasStore((s) => s.nodes)
  const selectNode = useCanvasStore((s) => s.selectNode)
  const { setCenter, getZoom } = useReactFlow()

  const [q, setQ]               = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef                  = useRef<HTMLInputElement>(null)

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return [] as typeof nodes
    return nodes.filter((n) => {
      if (n.type === 'annotation') return false
      const label = String((n.data as { label?: unknown })?.label ?? '').toLowerCase()
      return (
        n.id.toLowerCase().includes(needle) ||
        label.includes(needle) ||
        String(n.type ?? '').toLowerCase().includes(needle)
      )
    })
  }, [q, nodes])

  useEffect(() => setActiveIdx(0), [q])

  useEffect(() => {
    const active = matches[activeIdx]
    if (active) {
      setCenter(active.position.x + 124, active.position.y + 43, { zoom: getZoom(), duration: 200 })
    }
  }, [activeIdx, matches, setCenter, getZoom])

  useEffect(() => {
    const decorate = () => {
      document
        .querySelectorAll('.cf-node--search-hit, .cf-node--search-active')
        .forEach((el) => el.classList.remove('cf-node--search-hit', 'cf-node--search-active'))
      matches.forEach((n, i) => {
        const el = document.querySelector(`.react-flow__node[data-id="${n.id}"] .cf-node`)
        if (!el) return
        el.classList.add('cf-node--search-hit')
        if (i === activeIdx) el.classList.add('cf-node--search-active')
      })
    }
    decorate()
    return () => {
      document
        .querySelectorAll('.cf-node--search-hit, .cf-node--search-active')
        .forEach((el) => el.classList.remove('cf-node--search-hit', 'cf-node--search-active'))
    }
  }, [matches, activeIdx])

  useEffect(() => { inputRef.current?.focus() }, [])

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => (i + 1) % Math.max(matches.length, 1)) }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx((i) => (i - 1 + matches.length) % Math.max(matches.length, 1)) }
    if (e.key === 'Enter') {
      const hit = matches[activeIdx]
      if (hit) selectNode(hit.id)
    }
    if (e.key === 'Escape') { onClose() }
  }

  return (
    <div className="canvas-search" role="search">
      <Search size={13} style={{ color: 'var(--text-tertiary)' }} />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={handleKey}
        placeholder="Find on canvas — id, label, or type"
        aria-label="Find on canvas"
      />
      {q && (
        <span className="canvas-search__count">
          {matches.length ? `${activeIdx + 1} / ${matches.length}` : 'no match'}
        </span>
      )}
      <span className="canvas-search__kbd"><kbd>↑↓</kbd><kbd>Esc</kbd></span>
    </div>
  )
}
