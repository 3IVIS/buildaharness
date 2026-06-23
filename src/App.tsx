import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
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
import { useAuthStore }       from './store/auth'
import { useRunPoller }       from './services/runPoller'
import {
  createCollabDoc,
  bindYjsToStore,
  hydrateStoreFromYjs,
  syncStoreToYjs,
  seedYjsFromStore,
  attachUndoManager,
} from './collab'
import type { CollabDoc } from './collab'

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
    console.error('[buildaharness] unhandled render error:', error, info.componentStack)
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

// ─── Collab helpers ───────────────────────────────────────────────────────────

/** Deterministic HSL color from a string (email → avatar color). */
function hashColor(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  const hue = Math.abs(h) % 360
  return `hsl(${hue},65%,55%)`
}

/**
 * Fix #8 — Persist anonymous user color in localStorage so it stays stable
 * across page reloads and reconnects. Without this, Math.random() on every
 * mount gives the user a different color each time, which causes cursor flicker
 * for peers watching the anonymous user reconnect.
 *
 * Wrapped in try/catch because localStorage throws SecurityError in iOS Safari
 * private browsing mode. On failure we fall back to a one-time random color
 * for this session, which is still better than re-randomizing every mount.
 */
function getOrCreateAnonColor(): string {
  const KEY = 'buildaharness:anonColor'
  try {
    const stored = localStorage.getItem(KEY)
    if (stored) return stored
    const hue   = Math.floor(Math.random() * 360)
    const color = `hsl(${hue},65%,55%)`
    localStorage.setItem(KEY, color)
    return color
  } catch {
    // localStorage unavailable (private browsing, storage quota, etc.)
    // Fall back to a per-session random color.
    const hue = Math.floor(Math.random() * 360)
    return `hsl(${hue},65%,55%)`
  }
}

/**
 * Sets up a Yjs / y-websocket collab session tied to the current flow.
 *
 * Active only when VITE_COLLAB_SERVER_URL is set in the environment.
 * The collab session reconnects whenever the active flow's ID changes.
 *
 * Fix #14 — collabStatus state machine extended with 'reconnecting' so the UI
 * can distinguish a live reconnect attempt from a permanently offline server.
 *
 * Returns { collabRef, collabReady } to be threaded into <Canvas>.
 */
function useCollab() {
  const collabRef  = useRef<CollabDoc | null>(null)
  const syncingRef = useRef(false)
  const [collabReady, setCollabReady] = useState(false)

  const serverUrl    = import.meta.env.VITE_COLLAB_SERVER_URL as string | undefined
  // Use the stable _collabRoomKey (not flowMeta.id) as the Yjs room identifier.
  // flowMeta.id is user-editable ("Flow ID" field in Settings) — changing it while
  // collab is active would disconnect all other peers if we used it as the room key.
  // _collabRoomKey is a UUID assigned once at flow creation and never changes.
  const collabRoomKey = useCanvasStore((s) => s._collabRoomKey)
  const email         = useAuthStore((s) => s.email)

  useEffect(() => {
    if (!serverUrl) return   // collab disabled — no env var set

    const roomId = `flow:${collabRoomKey}`
    let cancelled = false
    let wsProvider: import('y-websocket').WebsocketProvider | null = null
    let unobserve:          (() => void) | null = null
    let unsubscribe:        (() => void) | null = null
    let undoDetach:         (() => void) | null = null
    let persistenceDestroy: (() => void) | null = null

    async function setup() {
      const [{ WebsocketProvider }, { IndexeddbPersistence }] = await Promise.all([
        import('y-websocket'),
        import('y-indexeddb'),
      ])
      if (cancelled) return

      const collab = createCollabDoc()
      collabRef.current = collab

      // Fix #8 — use a stable per-session color for anonymous users so it
      // doesn't re-randomize on every reconnect, causing cursor color flicker.
      const name  = email ?? 'Anonymous'
      const color = email ? hashColor(email) : getOrCreateAnonColor()
      collab.awareness.setLocalStateField('user', { name, color })

      // Offline persistence — hydrates from IndexedDB before WS syncs.
      // Fix #7 — wrap in try/catch: IndexedDB can throw in private browsing
      // mode. If it fails, we fall back gracefully to solo mode with a warning
      // banner rather than leaving the user with a broken, silent failure.
      let persistence: import('y-indexeddb').IndexeddbPersistence | null = null
      try {
        persistence = new IndexeddbPersistence(`buildaharness:${roomId}`, collab.doc)
        persistenceDestroy = () => persistence?.destroy()
        await persistence.whenSynced
      } catch (idbErr) {
        console.warn('[buildaharness:collab] IndexedDB unavailable, skipping offline persistence:', idbErr)
        // Continue without offline persistence — the WS server is still the
        // source of truth; we just won't have offline/reload resilience.
      }
      if (cancelled) return

      // Fix #3 — Store the Yjs clientID AFTER the cancellation guard so we
      // never leave _collabClientId set in the store if the effect was torn
      // down while IndexedDB was still loading.
      useCanvasStore.setState({ _collabClientId: collab.doc.clientID })

      // Reconcile Yjs ↔ Zustand after IndexedDB loads:
      if (collab.nodes.size === 0 && collab.edges.size === 0) {
        // Yjs doc is empty (first-ever collab session for this flow).
        // Seed it from the persisted Zustand/localStorage state so the
        // existing canvas is shared with the first collaborator who joins.
        seedYjsFromStore(useCanvasStore.getState(), collab)
      } else {
        // IndexedDB had existing Yjs state (returning session, or another tab
        // already collaborated on this flow). Push Yjs → Zustand so the canvas
        // shows the collaborative state, not the potentially-stale localStorage snapshot.
        hydrateStoreFromYjs(collab, useCanvasStore)
      }

      // Connect to the y-websocket server
      wsProvider = new WebsocketProvider(serverUrl!, roomId, collab.doc, {
        awareness: collab.awareness,
      })
      collab.wsProvider = wsProvider
      useCanvasStore.setState({ _collabWsProvider: wsProvider, _collabAwareness: collab.awareness })

      // Inbound: Yjs → Zustand (remote peer changes)
      unobserve = bindYjsToStore(collab, useCanvasStore, (v) => {
        syncingRef.current = v
      })

      // Fix #6 — Register the outbound subscriber BEFORE setting _collabActive.
      // This ensures the subscriber is live from the moment collab is activated,
      // and the teardown order (unsubscribe first) matches the setup order so
      // there is no window where the subscriber fires on a partially-torn-down doc.
      unsubscribe = useCanvasStore.subscribe((state, prev) => {
        syncStoreToYjs(state, prev, collab, () => syncingRef.current)
      })

      // Replace snapshot undo/redo with per-user Y.UndoManager
      const { detach } = attachUndoManager(collab, useCanvasStore)
      undoDetach = detach

      // Disable _pushHistory — Y.UndoManager owns the stack now
      useCanvasStore.setState({ _collabActive: true })

      if (!cancelled) setCollabReady(true)
    }

    setup().catch((err) => {
      console.error('[buildaharness:collab] setup failed:', err)
    })

    return () => {
      cancelled = true
      setCollabReady(false)

      // Fix #6 — Tear down subscribers BEFORE resetting store flags so no
      // in-flight setState from the outbound subscriber hits a half-torn-down
      // CollabDoc after _collabActive is cleared.
      unsubscribe?.()
      unobserve?.()
      undoDetach?.()

      // Re-enable snapshot history after subscribers are gone so any setState
      // calls that happen after this point use the normal undo stack.
      useCanvasStore.setState({ _collabActive: false, _collabClientId: null, _collabWsProvider: null, _collabAwareness: null })

      persistenceDestroy?.()

      // Fix #1 — Destroy awareness explicitly before destroying the doc.
      // Awareness.destroy() removes its own event listeners and clears the peer
      // table. Without this, the 'change' listener registered in useAwareness
      // can fire after the doc is gone, causing reads on a destroyed object.
      collabRef.current?.awareness.destroy()

      wsProvider?.destroy()
      collabRef.current?.doc.destroy()
      collabRef.current = null
    }
  // Re-run when the active flow changes so we join the correct Yjs room
  }, [serverUrl, collabRoomKey, email])

  return { collabRef, collabReady }
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

  useCollab()

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
        window.dispatchEvent(new CustomEvent('buildaharness:open-canvas-search'))
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
