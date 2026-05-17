import { Component, useEffect, useState, type ReactNode } from 'react'
import { AuthGate }          from './components/AuthGate'
import { Toolbar }           from './components/Toolbar'
import { Sidebar }           from './components/Sidebar'
import { Canvas }            from './canvas/Canvas'
import { ConfigPanel }       from './components/ConfigPanel'
import { EdgeConfigPanel }   from './components/EdgeConfigPanel'
import { FlowSettingsModal } from './components/FlowSettingsModal'
import { ProblemsPanel }     from './components/ProblemsPanel'
import { CommandPalette }    from './components/CommandPalette'
import { HitlResumePanel }  from './components/HitlResumePanel'
import { useCanvasStore }    from './store'
import { useRunPoller }      from './services/runPoller'

// ─── Fix #30: Error Boundary ─────────────────────────────────────────────────

interface ErrorBoundaryState { hasError: boolean; message: string }

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, message: '' }
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  override componentDidCatch(error: unknown, info: { componentStack: string }) {
    console.error('[itsharness] unhandled render error:', error, info.componentStack)
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100vh',
          background: 'var(--bg-base)', color: 'var(--text-primary)',
          gap: 12, padding: 32, textAlign: 'center',
        }}>
          <span style={{ fontSize: 28 }}>⚠️</span>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Something went wrong</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', maxWidth: 480, wordBreak: 'break-word' }}>
            {this.state.message}
          </div>
          <button
            className="btn btn--primary"
            onClick={() => this.setState({ hasError: false, message: '' })}
            style={{ marginTop: 8 }}
          >
            Try to recover
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// ─── App ─────────────────────────────────────────────────────────────────────

export function App() {
  const {
    isPanelOpen, isEdgePanelOpen, isProblemsOpen,
    closePanel, closeEdgePanel, closeSettings, isSettingsOpen,
    selectedNodeId, deleteNode,
    selectedEdgeId, deleteEdge,  // Fix #32
    undo, redo, canUndo, canRedo,
    activeJobId, hitlState, traceUrl,
  } = useCanvasStore()

  const [isCmdPaletteOpen, setIsCmdPaletteOpen] = useState(false)

  useRunPoller()

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target  = e.target as HTMLElement
      const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

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
          // Fix #32: delete selected node OR selected edge, whichever is active.
          if (selectedNodeId) deleteNode(selectedNodeId)
          else if (selectedEdgeId) deleteEdge(selectedEdgeId)
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
  }, [
    isCmdPaletteOpen, isPanelOpen, isEdgePanelOpen, isSettingsOpen,
    selectedNodeId, selectedEdgeId,  // Fix #32
    closePanel, closeEdgePanel, closeSettings, deleteNode, deleteEdge,
    undo, redo, canUndo, canRedo,
  ])

  return (
    // Fix #30: wrap the entire app in an ErrorBoundary so a render crash shows a
    // recovery UI instead of a blank screen.
    <ErrorBoundary>
      <AuthGate>
      <div className="app">
        <Toolbar />
        <div className="workspace">
          <Sidebar />
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
            {/* Fix #30: wrap Canvas separately so a node component crash doesn't take down the toolbar */}
            <ErrorBoundary>
              <Canvas />
            </ErrorBoundary>
            {isProblemsOpen && <ProblemsPanel />}
          </div>
          {isPanelOpen     && !hitlState && <ConfigPanel />}
          {isEdgePanelOpen && !hitlState && <EdgeConfigPanel />}
          {hitlState && <HitlResumePanel />}
        </div>
        <FlowSettingsModal />
        {isCmdPaletteOpen && <CommandPalette onClose={() => setIsCmdPaletteOpen(false)} />}

        {activeJobId && !hitlState && (
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
        {hitlState && (
          <div style={{
            position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
            background: 'var(--bg-overlay)', border: '0.5px solid rgba(251,146,60,0.5)',
            borderRadius: 8, padding: '7px 14px', display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 12, color: 'var(--c-hitl)', zIndex: 9999,
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--c-hitl)', flexShrink: 0 }} />
            Flow paused — review panel open
          </div>
        )}
        {traceUrl && !activeJobId && !hitlState && (
          <div style={{
            position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
            background: 'var(--bg-overlay)', border: '0.5px solid rgba(74,222,128,0.3)',
            borderRadius: 8, padding: '6px 13px', display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 12, zIndex: 9999, boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--rt-full)', flexShrink: 0 }} />
            <span style={{ color: 'var(--text-secondary)' }}>Run complete</span>
            <a
              href={traceUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--rt-full)', textDecoration: 'none', fontWeight: 500 }}
            >
              View trace →
            </a>
          </div>
        )}
      </div>
      </AuthGate>
    </ErrorBoundary>
  )
}
