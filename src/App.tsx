import { Component, useEffect, useState, type ReactNode } from 'react'
import { AuthGate }           from './components/AuthGate'
import { Toolbar }            from './components/Toolbar'
import { Sidebar }            from './components/Sidebar'
import { Canvas }             from './canvas/Canvas'
import { ConfigPanel }        from './components/ConfigPanel'
import { EdgeConfigPanel }    from './components/EdgeConfigPanel'
import { FlowSettingsDrawer } from './components/FlowSettingsDrawer'
import { ProblemsPanel }      from './components/ProblemsPanel'
import { CommandPalette }     from './components/CommandPalette'
import { RunDrawer }           from './components/RunDrawer'
import { A2ADeploymentPanel }  from './components/A2ADeploymentPanel'
import { DeploymentPanel }     from './components/DeploymentPanel'
import { FeedbackBar }        from './components/FeedbackBar'
import { ErrorBanner }        from './components/ErrorBanner'
import { FlowLibraryPanel }   from './components/FlowLibraryPanel'
import { useCanvasStore }     from './store'
import { useRunPoller }       from './services/runPoller'

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
    selectedEdgeId, deleteEdge,
    undo, redo, canUndo, canRedo,
    activeJobId, hitlState, traceUrl, a2aDeployment,
    setA2ADeployment,
    unifiedDeployment, setUnifiedDeployment,
    // §6 — Run drawer
    isRunDrawerOpen, openRunDrawer, closeRunDrawer,
    // §11 — Library page
    isLibraryOpen, closeLibrary,
  } = useCanvasStore()

  const [isCmdPaletteOpen, setIsCmdPaletteOpen] = useState(false)

  useRunPoller()

  // §14 — when a run pauses on a hitl_breakpoint, open the Run drawer so the
  // reviewer sees the inline resume form. The inspector stays as-is.
  useEffect(() => {
    if (hitlState && !isRunDrawerOpen) openRunDrawer()
  }, [hitlState, isRunDrawerOpen, openRunDrawer])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target  = e.target as HTMLElement
      const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setIsCmdPaletteOpen(open => !open)
        return
      }

      // §5 — ⌘F opens the in-canvas node search. Always preventDefault to
      // suppress the browser find bar (we own this intent now).
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('itsharness:open-canvas-search'))
        return
      }

      if (e.key === 'Escape') {
        if (isCmdPaletteOpen)  { setIsCmdPaletteOpen(false); return }
        if (isRunDrawerOpen)   { closeRunDrawer(); return }
        if (isSettingsOpen)    { closeSettings(); return }
        if (isLibraryOpen)     { closeLibrary(); return }
        if (isPanelOpen)       { closePanel();    return }
        if (isEdgePanelOpen)   { closeEdgePanel(); return }
        if (unifiedDeployment) { setUnifiedDeployment(null); return }
        if (a2aDeployment)     { setA2ADeployment(null); return }
      }

      if (!inInput) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
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
    isRunDrawerOpen, closeRunDrawer,
    isLibraryOpen, closeLibrary,
    selectedNodeId, selectedEdgeId,
    closePanel, closeEdgePanel, closeSettings, deleteNode, deleteEdge,
    undo, redo, canUndo, canRedo,
    unifiedDeployment, setUnifiedDeployment,
    a2aDeployment, setA2ADeployment,
  ])

  return (
    <ErrorBoundary>
      <AuthGate>
      <div className="app">
        <Toolbar />
        {/* §12 — Error banner: visible when spec has validation errors */}
        <ErrorBanner />
        <div className="workspace">
          <Sidebar />
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', position: 'relative' }}>
            <ErrorBoundary>
              <Canvas />
            </ErrorBoundary>
            {isProblemsOpen && <ProblemsPanel />}
            {isPanelOpen     && <ConfigPanel />}
            {isEdgePanelOpen && <EdgeConfigPanel />}
            {unifiedDeployment && <DeploymentPanel />}
            {a2aDeployment && !unifiedDeployment && <A2ADeploymentPanel />}
            <RunDrawer />
            {/* §11 — Settings drawer (replaces modal; canvas visible behind) */}
            <FlowSettingsDrawer />
          </div>
        </div>
        {/* §11 — Library full-screen page: fixed so it covers toolbar + sidebar too */}
        {isLibraryOpen && <FlowLibraryPanel onClose={closeLibrary} />}
        {isCmdPaletteOpen && <CommandPalette onClose={() => setIsCmdPaletteOpen(false)} />}

        {/* ── Executing toast ─────────────────────────────────────────────── */}
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

        {/* ── HITL paused toast — §14: drawer is the source of truth now ───── */}
        {hitlState && (
          <div
            style={{
              position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
              background: 'var(--bg-overlay)', border: '0.5px solid rgba(251,146,60,0.5)',
              borderRadius: 8, padding: '7px 14px', display: 'flex', alignItems: 'center', gap: 8,
              fontSize: 12, color: 'var(--c-hitl)', zIndex: 9999,
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
              cursor: 'pointer',
            }}
            onClick={() => { if (!isRunDrawerOpen) openRunDrawer() }}
            title="Open the Run drawer to resume"
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--c-hitl)', flexShrink: 0 }} />
            Flow paused — open Run to review
          </div>
        )}

        {/* ── Run complete toast (trace link + feedback bar) ───────────────── */}
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
            {/* FeedbackBar: thumbs up/down for the completed job.
                Renders only when lastCompletedJobId is set (by runPoller). */}
            <FeedbackBar />
          </div>
        )}
      </div>
      </AuthGate>
    </ErrorBoundary>
  )
}
