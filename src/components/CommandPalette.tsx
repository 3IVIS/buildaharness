import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { Search } from 'lucide-react'
import { useCanvasStore, type SettingsTab } from '../store'
import type { FlowSpec } from '../spec/schema'
import { EXAMPLE_FLOWS } from '../spec/examples'
import { NODE_ICONS, NODE_HEX } from '../canvas/nodes/BaseNode'
import type { NodeType } from '../spec/schema'

// ─── Data ────────────────────────────────────────────────────────────────────

const PALETTE_TYPES: NodeType[] = [
  'input', 'output', 'llm_call', 'tool_invoke', 'transform',
  'condition', 'parallel_fork', 'parallel_join', 'hitl_breakpoint',
  'subgraph', 'memory_read', 'memory_write', 'agent_role', 'agent_debate',
]

const SETTINGS_ITEMS: { label: string; tab: SettingsTab; hint: string }[] = [
  { label: 'State schema',  tab: 'state',  hint: 'Settings → State'  },
  { label: 'Memory stores', tab: 'memory', hint: 'Settings → Memory' },
  { label: 'Tools',         tab: 'tools',  hint: 'Settings → Tools'  },
  { label: 'Agents',        tab: 'agents', hint: 'Settings → Agents' },
  { label: 'Flow config',   tab: 'config', hint: 'Settings → Config' },
  { label: 'Flow identity', tab: 'meta',   hint: 'Settings → Meta'   },
]

// ─── Result types ─────────────────────────────────────────────────────────────

type Result =
  | { kind: 'node';     id: string; label: string; type: NodeType }
  | { kind: 'settings'; label: string; tab: SettingsTab; hint: string }
  | { kind: 'add';      type: NodeType }
  | { kind: 'example';  label: string; spec: FlowSpec }

function resultKey(r: Result, i: number): string {
  if (r.kind === 'node')     return `node-${r.id}`
  if (r.kind === 'settings') return `settings-${r.tab}`
  if (r.kind === 'add')      return `add-${r.type}`
  return `example-${i}`
}

function resultLabel(r: Result): string {
  if (r.kind === 'node')     return r.label || r.id
  if (r.kind === 'settings') return r.label
  if (r.kind === 'add')      return r.type
  if (r.kind === 'example')  return r.label
  return ''
}

function resultHint(r: Result): string {
  if (r.kind === 'node')     return `${r.type} · ${r.id}`
  if (r.kind === 'settings') return r.hint
  if (r.kind === 'add')      return 'Add to canvas'
  if (r.kind === 'example')  return 'Load example flow'
  return ''
}

function resultBadge(r: Result): { label: string; color: string } {
  if (r.kind === 'node')     return { label: 'node',     color: 'var(--blue)' }
  if (r.kind === 'settings') return { label: 'settings', color: 'var(--text-tertiary)' }
  if (r.kind === 'add')      return { label: 'add',      color: 'var(--green)' }
  if (r.kind === 'example')  return { label: 'flow',     color: 'var(--violet)' }
  return { label: '', color: '' }
}

// ─── Icon ────────────────────────────────────────────────────────────────────

function ResultIcon({ r }: { r: Result }) {
  if (r.kind === 'node' || r.kind === 'add') {
    const Icon  = NODE_ICONS[r.type]
    const color = NODE_HEX[r.type]
    return (
      <span className="cmd-row__icon" style={{ color, opacity: r.kind === 'add' ? 0.65 : 1 }}>
        <Icon size={13} strokeWidth={1.75} />
      </span>
    )
  }
  if (r.kind === 'settings') {
    return <span className="cmd-row__icon cmd-row__icon--sym">⚙</span>
  }
  return <span className="cmd-row__icon cmd-row__icon--sym">◈</span>
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="cmd-section-label">{label}</div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props { onClose: () => void }

export function CommandPalette({ onClose }: Props) {
  // §7 — `nodes` no longer needed; Cmd+F (CanvasToolbar) finds nodes. We
  // keep `selectNode` only because the Result union still includes 'node'
  // for type-safety; that branch is now unreachable in practice.
  const { selectNode, addNode, openSettings, loadFlow } = useCanvasStore()
  const [query, setQuery] = useState('')
  const [idx, setIdx]     = useState(0)
  const inputRef          = useRef<HTMLInputElement>(null)
  const listRef           = useRef<HTMLDivElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const q = query.trim().toLowerCase()

  // ── Build results ────────────────────────────────────────────────────────

  const results = useMemo<Result[]>(() => {
    // Empty query → show all settings shortcuts as quick-access
    if (!q) {
      return SETTINGS_ITEMS.map(s => ({ kind: 'settings' as const, ...s }))
    }

    const out: Result[] = []

    // §7 — Cmd+K no longer surfaces canvas nodes. Cmd+F (in-canvas search)
    // owns that intent now. Result set is commands + settings + flow switching.

    // Settings tabs
    SETTINGS_ITEMS.forEach(s => {
      if (s.label.toLowerCase().includes(q) || s.tab.includes(q)) {
        out.push({ kind: 'settings', ...s })
      }
    })

    // Node types to add
    PALETTE_TYPES.forEach(type => {
      if (type.replace(/_/g, ' ').includes(q) || type.includes(q)) {
        out.push({ kind: 'add', type })
      }
    })

    // Example flows
    EXAMPLE_FLOWS.forEach(f => {
      if (
        f.label.toLowerCase().includes(q) ||
        (f.spec as { id: string }).id.includes(q)
      ) {
        out.push({ kind: 'example', label: f.label, spec: f.spec as FlowSpec })
      }
    })

    return out
  }, [q])

  // Clamp active index when results change
  useEffect(() => { setIdx(0) }, [results.length])

  // Scroll active row into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${idx}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  // ── Actions ──────────────────────────────────────────────────────────────

  const activate = useCallback((r: Result | undefined) => {
    if (!r) return
    if (r.kind === 'node') {
      selectNode(r.id)
    } else if (r.kind === 'settings') {
      openSettings(r.tab)
    } else if (r.kind === 'add') {
      // Scatter slightly so multiple adds don't land on top of each other
      // Scatter around canvas centre with enough radius to avoid pile-ups
      // but tight enough that nodes land in the visible viewport on first load.
      addNode(r.type, {
        x: 340 + (Math.random() - 0.5) * 320,
        y: 240 + (Math.random() - 0.5) * 200,
      })
    } else if (r.kind === 'example') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      loadFlow(r.spec)
    }
    onClose()
  }, [selectNode, openSettings, addNode, loadFlow, onClose])

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(results[idx])
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  // ── Group results by kind for section headers ─────────────────────────────

  type Section = { header: string; items: { result: Result; absIdx: number }[] }
  const sections = useMemo<Section[]>(() => {
    if (!q) return [{ header: 'Quick access', items: results.map((r, i) => ({ result: r, absIdx: i })) }]

    const groups: Record<string, { header: string; items: { result: Result; absIdx: number }[] }> = {}
    const order: string[] = []

    results.forEach((r, i) => {
      const key = r.kind === 'node' ? 'On canvas' :
                  r.kind === 'settings' ? 'Settings' :
                  r.kind === 'add' ? 'Add node' : 'Example flows'
      if (!groups[key]) { groups[key] = { header: key, items: [] }; order.push(key) }
      groups[key].items.push({ result: r, absIdx: i })
    })

    return order.map(k => groups[k])
  }, [results, q])

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="cmd-overlay" onClick={onClose}>
      <div
        className="cmd-palette"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
        aria-modal="true"
      >
        {/* Input */}
        <div className="cmd-input-wrap">
          <Search size={13} className="cmd-search-icon" />
          <input
            ref={inputRef}
            className="cmd-input"
            placeholder="Jump to node, add type, open settings, load example…"
            value={query}
            onChange={e => { setQuery(e.target.value); setIdx(0) }}
            onKeyDown={handleKey}
            spellCheck={false}
            autoComplete="off"
          />
          {query && (
            <button className="cmd-clear" onClick={() => { setQuery(''); inputRef.current?.focus() }} aria-label="Clear">
              ×
            </button>
          )}
        </div>

        {/* Results */}
        {results.length > 0 && (
          <div className="cmd-results" ref={listRef}>
            {sections.map(sec => (
              <div key={sec.header}>
                <SectionHeader label={sec.header} />
                {sec.items.map(({ result: r, absIdx: i }) => {
                  const badge = resultBadge(r)
                  return (
                    <div
                      key={resultKey(r, i)}
                      data-idx={i}
                      className={`cmd-row${i === idx ? ' cmd-row--active' : ''}`}
                      onMouseEnter={() => setIdx(i)}
                      onClick={() => activate(r)}
                    >
                      <ResultIcon r={r} />
                      <div className="cmd-row__body">
                        <span className="cmd-row__label">{resultLabel(r)}</span>
                        <span className="cmd-row__hint">{resultHint(r)}</span>
                      </div>
                      <span className="cmd-row__badge" style={{ color: badge.color }}>
                        {badge.label}
                      </span>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}

        {results.length === 0 && q && (
          <div className="cmd-empty">No results for "{query}"</div>
        )}

        {/* Footer hints — §7: highlight the ⌘K vs ⌘F split */}
        <div className="cmd-footer">
          <span><kbd>⌘K</kbd> commands</span>
          <span><kbd>⌘F</kbd> find on canvas</span>
          <span style={{ marginLeft: 'auto' }}>
            <kbd>↵</kbd> select <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
