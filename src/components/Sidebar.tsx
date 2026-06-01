import { useEffect, useMemo, useRef, useState } from 'react'
import { StickyNote, Store } from 'lucide-react'
import type { NodeType } from '../spec/schema'
import { NODE_SUPPORT_MATRIX } from '../spec/schema'
import { EXAMPLE_FLOWS } from '../spec/examples'
import { useCanvasStore, type SettingsTab } from '../store'
import { useLibraryStore, relativeTime } from '../store/library'
import { NODE_ICONS, NODE_HEX } from '../canvas/nodes/BaseNode'
import { MarketplacePanel } from './MarketplacePanel'

type SidebarTab = 'nodes' | 'marketplace'

// §2 — every palette entry carries a one-line description for the hover
// tooltip. Wording vetted against UI Changes Spec §2.
interface PaletteEntry { type: NodeType; group: string; description: string }

const PALETTE: PaletteEntry[] = [
  { type: 'input',           group: 'I/O',     description: 'Entry point — initial state passed in from the caller.' },
  { type: 'output',          group: 'I/O',     description: 'Terminal node — return value emitted to the caller.' },
  { type: 'llm_call',        group: 'Core',    description: 'Call an LLM with a prompt and structured output schema.' },
  { type: 'tool_invoke',     group: 'Core',    description: 'Invoke a registered tool with mapped arguments.' },
  { type: 'transform',       group: 'Core',    description: 'Reshape state — JSONPath mapping or pure function ref.' },
  { type: 'condition',       group: 'Control', description: 'Route to one of N branches by predicate.' },
  { type: 'parallel_fork',   group: 'Control', description: 'Run multiple branches concurrently.' },
  { type: 'parallel_join',   group: 'Control', description: 'Wait for parallel branches, then merge state.' },
  { type: 'hitl_breakpoint', group: 'Control', description: 'Pause for a human-in-the-loop review and resume.' },
  { type: 'subgraph',        group: 'Control', description: 'Embed another flow as a single composable step.' },
  { type: 'memory_read',     group: 'Memory',  description: 'Read from a long-term store into local state.' },
  { type: 'memory_write',    group: 'Memory',  description: 'Persist values from local state into a store.' },
  { type: 'agent_role',      group: 'Agents',  description: 'Dispatch to a registered role-based agent.' },
  { type: 'agent_debate',    group: 'Agents',  description: 'Multi-agent debate with N rounds and a judge.' },
]

const GROUPS = ['I/O', 'Core', 'Control', 'Memory', 'Agents']

function onDragStart(e: React.DragEvent, type: NodeType) {
  e.dataTransfer.setData('application/itsharness-node', type)
  e.dataTransfer.effectAllowed = 'move'
}

interface RegistryShortcut { label: string; tab: SettingsTab }
const REGISTRY_SHORTCUTS: RegistryShortcut[] = [
  { label: 'State schema', tab: 'state'  },
  { label: 'Memory stores', tab: 'memory' },
  { label: 'Tools',         tab: 'tools'  },
  { label: 'Agents',        tab: 'agents' },
]

export function Sidebar() {
  const { loadFlow, openSettings, memoryStores, tools, agents, stateSchema, addAnnotation, flowMeta } = useCanvasStore()
  const { entries, getFlow, deleteFlow } = useLibraryStore()
  const [showExamples, setShowExamples] = useState(true)
  const [query, setQuery]               = useState('')
  const [tab, setTab]                   = useState<SidebarTab>('nodes')
  // §2 — hover tooltip key; debounced to ~250ms in PaletteItem
  const [tipKey, setTipKey]             = useState<string | null>(null)
  // §15 — currently targeted runtime drives dim/`!` decoration on items
  const runtime = flowMeta.runtimeHints?.preferred_adapter ?? null

  const stateCounts: Record<SettingsTab, number> = {
    meta:       0,
    state:      Object.keys(stateSchema?.properties ?? {}).length,
    memory:     Object.keys(memoryStores).length,
    tools:      Object.keys(tools).length,
    agents:     agents.length,
    config:     0,
    appearance: 0,
  }

  // Filter palette by search query
  const q = query.trim().toLowerCase()
  const filtered = useMemo(() =>
    q ? PALETTE.filter((p) => p.type.includes(q) || p.group.toLowerCase().includes(q)) : null,
  [q])

  // Groups to render — collapsed when searching (show flat list instead)
  const renderedGroups = filtered ? null : GROUPS

  return (
    <div className="sidebar">

      {/* Tab bar */}
      <div style={{
        display: 'flex',
        borderBottom: '0.5px solid var(--border)',
        flexShrink: 0,
      }}>
        <button
          onClick={() => setTab('nodes')}
          style={{
            flex: 1, padding: '7px 0', fontSize: 10, fontWeight: 600,
            letterSpacing: '0.05em', textTransform: 'uppercase',
            background: 'none', border: 'none', cursor: 'pointer',
            borderBottom: tab === 'nodes' ? '1.5px solid #8b5cf6' : '1.5px solid transparent',
            color: tab === 'nodes' ? 'var(--text-primary)' : 'var(--text-tertiary)',
            transition: 'color 0.1s',
          }}
        >
          Nodes
        </button>
        <button
          onClick={() => setTab('marketplace')}
          style={{
            flex: 1, padding: '7px 0', fontSize: 10, fontWeight: 600,
            letterSpacing: '0.05em', textTransform: 'uppercase',
            background: 'none', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
            borderBottom: tab === 'marketplace' ? '1.5px solid #8b5cf6' : '1.5px solid transparent',
            color: tab === 'marketplace' ? 'var(--text-primary)' : 'var(--text-tertiary)',
            transition: 'color 0.1s',
          }}
        >
          <Store size={10} strokeWidth={2} />
          Community
        </button>
      </div>

      {/* Marketplace tab */}
      {tab === 'marketplace' && (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <MarketplacePanel />
        </div>
      )}

      {/* Nodes tab */}
      {tab === 'nodes' && (
      <div className="sidebar__scroll">

        {/* Search */}
        <div style={{ padding: '10px 10px 6px', position: 'relative' }}>
          <input
            className="sidebar-search"
            placeholder="Search nodes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              style={{ position: 'absolute', right: 18, top: '50%', transform: 'translateY(-50%)',
                       background: 'none', border: 'none', color: 'var(--text-tertiary)',
                       cursor: 'pointer', fontSize: 14, padding: 0 }}
            >×</button>
          )}
        </div>

        {/* Flat search results */}
        {filtered && (
          <div className="sidebar__section">
            {filtered.length === 0
              ? <div style={{ fontSize: 11, color: 'var(--text-tertiary)', padding: '4px 4px' }}>No results</div>
              : filtered.map((entry) => (
                  <PaletteItem key={entry.type} entry={entry}
                    runtime={runtime} tipKey={tipKey} setTipKey={setTipKey} />
                ))
            }
          </div>
        )}

        {/* Grouped palette */}
        {!filtered && renderedGroups!.map((group) => (
          <div key={group} className="sidebar__section">
            <div className="sidebar__label">{group}</div>
            {PALETTE.filter((p) => p.group === group).map((entry) => (
              <PaletteItem key={entry.type} entry={entry}
                runtime={runtime} tipKey={tipKey} setTipKey={setTipKey} />
            ))}
          </div>
        ))}

        {/* Canvas tools */}
        {!filtered && (
          <div className="sidebar__section">
            <div className="sidebar__label">Canvas</div>
            <div
              className="palette-item"
              onClick={() => addAnnotation({ x: 200, y: 200 })}
              title="Add a sticky note to the canvas"
              style={{ cursor: 'pointer' }}
            >
              <span className="palette-item__icon" style={{ color: '#ca8a04' }}>
                <StickyNote size={13} strokeWidth={1.75} />
              </span>
              <span className="palette-item__name">annotation</span>
            </div>
          </div>
        )}

        {/* Registry shortcuts */}
        {!filtered && (
          <div className="sidebar__section">
            <div className="sidebar__label">Registries</div>
            {REGISTRY_SHORTCUTS.map(({ label, tab }) => (
              <div key={tab} className="flow-item" onClick={() => openSettings(tab)} title={`Edit ${label}`}>
                <span className="flow-item__num" style={{ color: stateCounts[tab] > 0 ? '#3b82f6' : undefined }}>
                  {stateCounts[tab] > 0 ? stateCounts[tab] : '—'}
                </span>
                <span className="flow-item__name">{label}</span>
              </div>
            ))}
          </div>
        )}

        {/* My flows */}
        {!filtered && entries.length > 0 && (
          <div className="sidebar__section">
            <div className="sidebar__label">My flows ({entries.length})</div>
            {entries.slice(0, 8).map((entry) => (
              <div key={entry.id} className="flow-item" style={{ gap: 0 }}
                title={`${entry.id} · saved ${relativeTime(entry.draftSavedAt)}`}>
                <div style={{ flex: 1, overflow: 'hidden' }} onClick={() => {
                  const spec = getFlow(entry.id)
                  if (spec) loadFlow(spec)
                }}>
                  <div className="flow-item__name" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.name}</div>
                  <div style={{ fontSize: 9, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>{relativeTime(entry.draftSavedAt)}</div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteFlow(entry.id) }}
                  style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)',
                           cursor: 'pointer', padding: '2px 4px', opacity: 0, fontSize: 10 }}
                  className="flow-item__delete"
                  title="Remove from library"
                >✕</button>
              </div>
            ))}
          </div>
        )}

        {/* Example flows */}
        {!filtered && (
          <div className="sidebar__section">
            <div className="sidebar__label" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
              onClick={() => setShowExamples(!showExamples)}>
              Examples
              <span style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>{showExamples ? '▲' : '▼'}</span>
            </div>
            {showExamples && EXAMPLE_FLOWS.map((flow, i) => (
              <div key={flow.spec.id} className="flow-item" onClick={() => loadFlow(flow.spec)} title={flow.spec.description}>
                <span className="flow-item__num">0{i + 1}</span>
                <span className="flow-item__name">{flow.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      )} {/* end nodes tab */}
    </div>
  )
}

function PaletteItem({
  entry, runtime, tipKey, setTipKey,
}: {
  entry: PaletteEntry
  runtime: string | null
  tipKey: string | null
  setTipKey: (k: string | null) => void
}) {
  const { type, description } = entry
  const Icon  = NODE_ICONS[type]
  const color = NODE_HEX[type]

  // §15 — compat for the targeted runtime
  const compat = runtime
    ? (NODE_SUPPORT_MATRIX[type]?.[runtime as keyof typeof NODE_SUPPORT_MATRIX[typeof type]] ?? 'missing')
    : 'full'
  const dim    = !!runtime && compat === 'missing'

  // §2 — debounced tooltip on hover (~250ms)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onEnter = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setTipKey(type), 250)
  }
  const onLeave = () => {
    if (timer.current) clearTimeout(timer.current)
    setTipKey(null)
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  return (
    <div
      className={`palette-item${dim ? ' palette-item--dim' : ''}`}
      draggable
      onDragStart={(e) => onDragStart(e, type)}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <span className="palette-item__icon" style={{ color }}>
        <Icon size={13} strokeWidth={1.75} />
      </span>
      <span className="palette-item__name">{type}</span>
      {dim && (
        <span
          className="palette-item__warn"
          title={`Not supported in ${runtime}`}
        >!</span>
      )}
      {tipKey === type && (
        <div className="palette-tip">
          <div className="palette-tip__type">{type}</div>
          {description}
        </div>
      )}
    </div>
  )
}
