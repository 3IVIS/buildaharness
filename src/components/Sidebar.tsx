import { useState } from 'react'
import type { NodeType } from '../spec/schema'
import { EXAMPLE_FLOWS } from '../spec/examples'
import { useCanvasStore, type SettingsTab } from '../store'
import { useLibraryStore, relativeTime } from '../store/library'

interface PaletteEntry { type: NodeType; color: string; group: string }

const PALETTE: PaletteEntry[] = [
  { type: 'input',           color: 'var(--c-input)',  group: 'I/O' },
  { type: 'output',          color: 'var(--c-output)', group: 'I/O' },
  { type: 'llm_call',        color: 'var(--c-llm)',    group: 'Core' },
  { type: 'tool_invoke',     color: 'var(--c-tool)',   group: 'Core' },
  { type: 'transform',       color: 'var(--c-xform)',  group: 'Core' },
  { type: 'condition',       color: 'var(--c-cond)',   group: 'Control' },
  { type: 'parallel_fork',   color: 'var(--c-fork)',   group: 'Control' },
  { type: 'parallel_join',   color: 'var(--c-join)',   group: 'Control' },
  { type: 'hitl_breakpoint', color: 'var(--c-hitl)',   group: 'Control' },
  { type: 'subgraph',        color: 'var(--c-sub)',    group: 'Control' },
  { type: 'memory_read',     color: 'var(--c-memr)',   group: 'Memory' },
  { type: 'memory_write',    color: 'var(--c-memw)',   group: 'Memory' },
  { type: 'agent_role',      color: 'var(--c-agent)',  group: 'Agents' },
  { type: 'agent_debate',    color: 'var(--c-debate)', group: 'Agents' },
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
  const { loadFlow, openSettings, memoryStores, tools, agents, stateSchema } = useCanvasStore()
  const { entries, getFlow, deleteFlow } = useLibraryStore()
  const [showExamples, setShowExamples] = useState(true)

  const stateCounts: Record<SettingsTab, number> = {
    meta:   0,
    state:  Object.keys(stateSchema?.properties ?? {}).length,
    memory: Object.keys(memoryStores).length,
    tools:  Object.keys(tools).length,
    agents: agents.length,
    config: 0,
  }

  return (
    <div className="sidebar">
      <div className="sidebar__scroll">
        {/* Node palette */}
        {GROUPS.map((group) => (
          <div key={group} className="sidebar__section">
            <div className="sidebar__label">{group}</div>
            {PALETTE.filter((p) => p.group === group).map(({ type, color }) => (
              <div key={type} className="palette-item" draggable onDragStart={(e) => onDragStart(e, type)} title={`Drag to add ${type}`}>
                <div className="palette-item__dot" style={{ background: color }} />
                <span className="palette-item__name">{type}</span>
              </div>
            ))}
          </div>
        ))}

        {/* Registry shortcuts */}
        <div className="sidebar__section">
          <div className="sidebar__label">Registries</div>
          {REGISTRY_SHORTCUTS.map(({ label, tab }) => (
            <div key={tab} className="flow-item" onClick={() => openSettings(tab)} title={`Edit ${label}`}>
              <span className="flow-item__num" style={{ color: stateCounts[tab] > 0 ? '#3b82f6' : undefined, fontVariantNumeric: 'tabular-nums' }}>
                {stateCounts[tab] > 0 ? stateCounts[tab] : '—'}
              </span>
              <span className="flow-item__name">{label}</span>
            </div>
          ))}
        </div>

        {/* My flows */}
        {entries.length > 0 && (
          <div className="sidebar__section">
            <div className="sidebar__label">My flows ({entries.length})</div>
            {entries.slice(0, 8).map((entry) => (
              <div key={entry.id} className="flow-item" style={{ gap: 0 }}
                title={`${entry.id} · saved ${relativeTime(entry.savedAt)}`}>
                <div style={{ flex: 1, overflow: 'hidden' }} onClick={() => {
                  const spec = getFlow(entry.id)
                  if (spec) loadFlow(spec)
                }}>
                  <div className="flow-item__name" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingLeft: 0 }}>{entry.name}</div>
                  <div style={{ fontSize: 9, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', paddingLeft: 0 }}>{relativeTime(entry.savedAt)}</div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteFlow(entry.id) }}
                  style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', padding: '2px 4px', opacity: 0, fontSize: 10 }}
                  className="flow-item__delete"
                  title="Remove from library"
                >✕</button>
              </div>
            ))}
          </div>
        )}

        {/* Example flows */}
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
      </div>
    </div>
  )
}
