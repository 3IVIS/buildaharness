/**
 * ItsHarnessCanvas — embeddable flow canvas.
 *
 * Usage
 * -----
 * import { ItsHarnessCanvas } from '@itsharness/canvas'
 * import '@itsharness/canvas/styles.css'
 *
 * <ItsHarnessCanvas
 *   initialSpec={spec}
 *   onSpecChange={(updated) => saveToBackend(updated)}
 *   onNodeSelect={(id) => setInspectorNode(id)}
 * />
 *
 * The canvas is self-contained: it manages its own undo/redo history, node
 * selection, and focus mode. The host app controls persistence and the
 * inspector/config panel (if any) by responding to the callbacks.
 *
 * execStats can be injected from the host to show run-time status rings:
 *
 * <ItsHarnessCanvas
 *   execStats={runState.nodeStats}
 * />
 *
 * Yjs collab (Phase 4 item 6) will be added as an optional `provider` prop
 * once this component is shipped — the clean context boundary makes it a
 * one-line addition.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { CanvasStoreProvider } from './store/context'
import { createCanvasStore, type CanvasStoreApi, type NodeExecStat } from './store/create'
import { Canvas } from './canvas/Canvas'
import type { FlowSpec } from './spec/schema'

export interface ItsHarnessCanvasProps {
  /**
   * Flow spec to load into the canvas on mount (or when the reference changes).
   * If omitted the canvas starts with a single "Start" input node.
   */
  initialSpec?: FlowSpec

  /**
   * Called with the full FlowSpec after every user edit (debounced ~300 ms on
   * rapid changes like dragging). Return value is ignored.
   */
  onSpecChange?: (spec: FlowSpec) => void

  /**
   * Called when the user clicks a node (or deselects with null).
   * Use this to render your own config/inspector panel alongside the canvas.
   */
  onNodeSelect?: (nodeId: string | null) => void

  /**
   * Called when the user clicks an edge (or deselects with null).
   */
  onEdgeSelect?: (edgeId: string | null) => void

  /**
   * Run-time node status badges. The host app can push execution progress
   * here; the canvas renders token counts, latency, and quality scores on
   * each node without knowing anything about the execution engine.
   */
  execStats?: Record<string, NodeExecStat>

  /** Visual theme. Defaults to 'dark'. */
  theme?: 'dark' | 'light'

  /** Extra CSS class applied to the canvas root div. */
  className?: string

  /** Inline styles applied to the canvas root div. */
  style?: React.CSSProperties
}

export function ItsHarnessCanvas({
  initialSpec,
  onSpecChange,
  onNodeSelect,
  onEdgeSelect,
  execStats,
  theme = 'dark',
  className,
  style,
}: ItsHarnessCanvasProps) {
  // ── Create store once per mount ──────────────────────────────────────────
  // useMemo (not useState) so the store is synchronously available on the
  // first render without a double-render cycle. createCanvasStore is pure.
  const store: CanvasStoreApi = useMemo(
    () => createCanvasStore({ initialSpec }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [], // intentionally stable — initialSpec only seeds the first render
  )

  // ── Load a fresh spec when initialSpec reference changes ─────────────────
  const isFirstRender = useRef(true)
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return }
    if (initialSpec) store.getState().loadFlow(initialSpec)
  }, [store, initialSpec])

  // ── onSpecChange — subscribe to state mutations ──────────────────────────
  // We subscribe at the store level rather than wiring each action, so the
  // callback fires once per mutation batch regardless of how many set() calls
  // the action makes internally.
  useEffect(() => {
    if (!onSpecChange) return
    let timer: ReturnType<typeof setTimeout> | null = null

    const unsub = store.subscribe((state, prev) => {
      // Only fire when canvas data changes — not transient UI state.
      if (
        state.nodes        === prev.nodes &&
        state.edges        === prev.edges &&
        state.flowMeta     === prev.flowMeta &&
        state.stateSchema  === prev.stateSchema &&
        state.agents       === prev.agents &&
        state.memoryStores === prev.memoryStores &&
        state.tools        === prev.tools &&
        state.modelDefaults === prev.modelDefaults &&
        state.flowConfig   === prev.flowConfig
      ) return

      // Debounce 300 ms to collapse rapid mutations (e.g. drag-move)
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        const spec = store.getState().exportSpec()
        if (spec) onSpecChange(spec)
        timer = null
      }, 300)
    })

    return () => {
      if (timer !== null) clearTimeout(timer)
      unsub()
    }
  }, [store, onSpecChange])

  // ── onNodeSelect / onEdgeSelect — subscribe to selection state ───────────
  // Zustand vanilla createStore() only supports the 1-arg subscribe(listener).
  // The 2-arg (selector, listener) form requires subscribeWithSelector middleware.
  // We track the previous value manually to avoid calling the host on every mutation.
  useEffect(() => {
    if (!onNodeSelect) return
    let prev = store.getState().selectedNodeId
    return store.subscribe((state) => {
      if (state.selectedNodeId !== prev) {
        prev = state.selectedNodeId
        onNodeSelect(prev)
      }
    })
  }, [store, onNodeSelect])

  useEffect(() => {
    if (!onEdgeSelect) return
    let prev = store.getState().selectedEdgeId
    return store.subscribe((state) => {
      if (state.selectedEdgeId !== prev) {
        prev = state.selectedEdgeId
        onEdgeSelect(prev)
      }
    })
  }, [store, onEdgeSelect])

  // ── Sync execStats from host into the store ──────────────────────────────
  useEffect(() => {
    if (!execStats) return
    const { setNodeExecStat, clearExecStats } = store.getState()
    clearExecStats()
    for (const [nodeId, stat] of Object.entries(execStats)) {
      setNodeExecStat(nodeId, stat)
    }
  }, [store, execStats])

  // ── Apply theme to the canvas root element (not document.documentElement) ─
  const rootRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    rootRef.current?.setAttribute('data-theme', theme)
    store.getState().setTheme(theme)
  }, [store, theme])

  return (
    <CanvasStoreProvider store={store}>
      <div
        ref={rootRef}
        data-itsharness-canvas
        data-theme={theme}
        className={['itsharness-canvas', className].filter(Boolean).join(' ')}
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          // Scope CSS variable overrides to this element so the canvas
          // styles don't leak into the host app's DOM.
          contain: 'layout style',
          ...style,
        }}
      >
        <ReactFlowProvider>
          <Canvas />
        </ReactFlowProvider>
      </div>
    </CanvasStoreProvider>
  )
}
