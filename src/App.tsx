import { useEffect, useState } from 'react'
import { AuthGate }          from './components/AuthGate'
import { Toolbar }           from './components/Toolbar'
import { Sidebar }           from './components/Sidebar'
import { Canvas }            from './canvas/Canvas'
import { ConfigPanel }       from './components/ConfigPanel'
import { EdgeConfigPanel }   from './components/EdgeConfigPanel'
import { FlowSettingsModal } from './components/FlowSettingsModal'
import { ProblemsPanel }     from './components/ProblemsPanel'
import { CommandPalette }    from './components/CommandPalette'
import { useCanvasStore }    from './store'
import { useRunPoller }      from './services/runPoller'

export function App() {
  const {
    isPanelOpen, isEdgePanelOpen, isProblemsOpen,
    closePanel, closeEdgePanel, closeSettings, isSettingsOpen,
    selectedNodeId, deleteNode,
    undo, redo, canUndo, canRedo,
    activeJobId,
  } = useCanvasStore()

  const [isCmdPaletteOpen, setIsCmdPaletteOpen] = useState(false)

  // ─── Live execution canvas overlay ────────────────────────────────────────
  useRunPoller()
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      // Cmd+K / Ctrl+K — open command palette (takes priority, works from anywhere)
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setIsCmdPaletteOpen(open => !open)
        return
      }

      if (e.key === 'Escape') {
        if (isCmdPaletteOpen) { setIsCmdPaletteOpen(false); return }
        if (isSettingsOpen)   { closeSettings(); return }
        if (isPanelOpen)      { closePanel();    return }
        if (isEdgePanelOpen)  { closeEdgePanel(); return }
      }

      if (!inInput) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (selectedNodeId) deleteNode(selectedNodeId)
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey && canUndo) {
          e.preventDefault(); undo()
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey)) && canRedo) {
          e.preventDefault(); redo()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isCmdPaletteOpen, isPanelOpen, isEdgePanelOpen, isSettingsOpen, selectedNodeId,
      closePanel, closeEdgePanel, closeSettings, deleteNode, undo, redo, canUndo, canRedo])

  return (
    <AuthGate>
    <div className="app">
      <Toolbar />
      <div className="workspace">
        <Sidebar />
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <Canvas />
          {isProblemsOpen && <ProblemsPanel />}
        </div>
        {isPanelOpen    && <ConfigPanel />}
        {isEdgePanelOpen && <EdgeConfigPanel />}
      </div>
      <FlowSettingsModal />
      {isCmdPaletteOpen && <CommandPalette onClose={() => setIsCmdPaletteOpen(false)} />}

      {/* Run status toast — visible on canvas while job is executing */}
      {activeJobId && (
        <div style={{
          position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-overlay)', border: '0.5px solid rgba(96,165,250,0.35)',
          borderRadius: 8, padding: '7px 14px', display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 12, color: 'var(--text-secondary)', zIndex: 9999,
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          animation: 'execRingPulse 1.4s ease-in-out infinite',
        }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#60a5fa', flexShrink: 0,
            animation: 'execPulse 1s ease-in-out infinite' }} />
          Executing flow…
        </div>
      )}
    </div>
    </AuthGate>
  )
}
