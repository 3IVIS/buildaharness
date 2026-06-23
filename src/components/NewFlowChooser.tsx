// §8 — "Start a new flow" picker with Blank + example flows.
// Shown when the user clicks New in the toolbar, unless they opted out.

import { useState } from 'react'
import { X, Plus, ChevronRight } from 'lucide-react'
import { EXAMPLE_FLOWS } from '../spec/examples'
import { useCanvasStore } from '../store'

export const SUPPRESS_KEY = 'buildaharness:new-chooser-suppressed'

interface Props { open: boolean; onClose: () => void }

export function NewFlowChooser({ open, onClose }: Props) {
  const { newFlow, loadFlow } = useCanvasStore()
  const [suppress, setSuppress] = useState(false)

  function startBlank() {
    if (suppress) localStorage.setItem(SUPPRESS_KEY, '1')
    newFlow()
    onClose()
  }

  function startExample(spec: any) {
    if (suppress) localStorage.setItem(SUPPRESS_KEY, '1')
    loadFlow(spec)
    onClose()
  }

  if (!open) return null

  return (
    <div
      className="new-chooser-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Start a new flow"
    >
      <div
        className="new-chooser"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
      >
        {/* Head */}
        <div className="new-chooser__head">
          <div>Start a new flow</div>
          <button onClick={onClose} aria-label="Close"><X size={13} /></button>
        </div>

        {/* Body */}
        <div className="new-chooser__body">
          {/* Blank */}
          <div
            className="new-chooser-tile new-chooser-tile--blank"
            onClick={startBlank}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') startBlank() }}
          >
            <div className="new-chooser-tile__icon"><Plus size={18} /></div>
            <div style={{ flex: 1 }}>
              <div className="new-chooser-tile__name">Blank flow</div>
              <div className="new-chooser-tile__desc">
                Empty canvas with a single <code>input</code> node placed at (140, 200).
              </div>
            </div>
          </div>

          {/* Examples */}
          {EXAMPLE_FLOWS.length > 0 && (
            <>
              <div className="section-head">Start from an example</div>
              {EXAMPLE_FLOWS.map((ex) => (
                <div
                  key={ex.spec.id}
                  className="new-chooser-tile"
                  onClick={() => startExample(ex.spec)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') startExample(ex.spec) }}
                >
                  <div className="new-chooser-tile__icon" style={{ fontSize: 16 }}>
                    {/* Runtime glyph */}
                    {ex.spec.runtime_hints?.preferred_adapter === 'langgraph'  && '🔷'}
                    {ex.spec.runtime_hints?.preferred_adapter === 'crewai'     && '🤝'}
                    {ex.spec.runtime_hints?.preferred_adapter === 'mastra'     && '⚡'}
                    {!ex.spec.runtime_hints?.preferred_adapter                 && '🧩'}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div className="new-chooser-tile__name">{ex.spec.name}</div>
                    <div className="new-chooser-tile__desc">
                      {ex.spec.nodes.length} node{ex.spec.nodes.length !== 1 ? 's' : ''} · target{' '}
                      {ex.spec.runtime_hints?.preferred_adapter ?? 'all runtimes'}
                    </div>
                  </div>
                  <ChevronRight size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                </div>
              ))}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="new-chooser__footer">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={suppress}
              onChange={(e) => setSuppress(e.target.checked)}
            />
            <span>Don't show again — next "New" goes straight to blank</span>
          </label>
        </div>
      </div>
    </div>
  )
}
