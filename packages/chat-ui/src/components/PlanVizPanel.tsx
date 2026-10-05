import { useEffect, useRef, useState } from 'react'
import type { PlanSnapshot } from '@buildaharness/aielia'
import { buildStaticHtml, loadStaticTemplate, loadViewerHtml, planExportFilename } from '../plan-viz/plan-viz-assets'

interface Props {
  /** Latest `planToSnapshot(...).snapshot`, or null when no plan exists yet. Re-posted to the page on every change. */
  snapshot: PlanSnapshot | null
  fullscreen: boolean
  onToggleFullscreen: () => void
  onClose: () => void
}

/**
 * Read-only plan graph (plans/plan_visualization_plan.html, P4). Hosts the viewer page in a
 * sandboxed iframe (`allow-scripts` only — no `allow-same-origin`, so the page cannot reach the app's
 * storage) and talks to it purely over postMessage: the page posts `{type:'ready'}`, we answer with the
 * current snapshot and again on every change. The page's assets load lazily the first time this mounts.
 */
export function PlanVizPanel({ snapshot, fullscreen, onToggleFullscreen, onClose }: Props): React.JSX.Element {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const snapshotRef = useRef(snapshot)
  const [srcDoc, setSrcDoc] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    loadViewerHtml().then(
      (html) => { if (!cancelled) setSrcDoc(html) },
      (err: unknown) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err)) },
    )
    return () => { cancelled = true }
  }, [])

  function post(): void {
    const target = frameRef.current?.contentWindow
    if (target && snapshotRef.current) target.postMessage(snapshotRef.current, '*')
  }

  useEffect(() => {
    snapshotRef.current = snapshot
    post()
  }, [snapshot])

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      if (event.source !== frameRef.current?.contentWindow) return
      if ((event.data as { type?: unknown } | null)?.type === 'ready') post()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  async function handleExport(): Promise<void> {
    if (!snapshot) return
    const template = await loadStaticTemplate()
    const goal = Object.values(snapshot.nodes).find((n) => n.node_type === 'goal')
    const html = buildStaticHtml(template, snapshot, {
      goal: goal?.metadata.description ?? '',
      timestamp: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
      tokens: snapshot.tokens,
    })
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    const a = document.createElement('a')
    a.href = url
    a.download = planExportFilename()
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <aside className={`plan-viz-panel${fullscreen ? ' plan-viz-panel--fullscreen' : ''}`} data-testid="plan-viz-panel" aria-label="Plan graph">
      <div className="plan-viz-panel__header">
        <span className="plan-viz-panel__title">Plan graph</span>
        <button type="button" onClick={() => void handleExport()} disabled={!snapshot}>Export HTML snapshot</button>
        <button type="button" onClick={onToggleFullscreen} aria-pressed={fullscreen}>{fullscreen ? 'Dock' : 'Full screen'}</button>
        <button type="button" onClick={onClose} aria-label="Close plan graph">✕</button>
      </div>
      {loadError && <div className="plan-viz-panel__empty">Could not load the plan graph viewer: {loadError}</div>}
      {!loadError && !snapshot && <div className="plan-viz-panel__empty">No plan yet.</div>}
      {srcDoc && (
        <iframe ref={frameRef} className="plan-viz-panel__frame" title="Plan graph" sandbox="allow-scripts" srcDoc={srcDoc} hidden={!snapshot} />
      )}
    </aside>
  )
}
