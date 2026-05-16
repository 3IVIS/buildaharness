import { useState, useEffect, useCallback } from 'react'
import {
  X, Save, Trash2, Pencil, Check, FolderOpen,
  History, Play, ChevronDown, RotateCcw, Loader,
} from 'lucide-react'
import { useLibraryStore, relativeTime } from '../store/library'
import { useCanvasStore } from '../store'
import { useAuthStore }   from '../store/auth'
import { api, type FlowSummary, type VersionSummary } from '../services/api'
import type { FlowSpec } from '../spec/schema'

interface Props { onClose: () => void }

export function FlowLibraryPanel({ onClose }: Props) {
  const { entries, saveFlow, deleteFlow, renameFlow, getFlow } = useLibraryStore()
  const { exportSpec, loadFlow, flowMeta } = useCanvasStore()
  const setActiveJob = useCanvasStore((s) => s.setActiveJob)
  const activeJobId  = useCanvasStore((s) => s.activeJobId)
  const { token, email, logout } = useAuthStore()

  const [remoteFlows,     setRemoteFlows]     = useState<FlowSummary[]>([])
  const [remoteLoading,   setRemoteLoading]   = useState(false)
  const [saveError,       setSaveError]       = useState('')
  const [expandedId,      setExpandedId]      = useState<string | null>(null)
  const [versions,        setVersions]        = useState<Record<string, VersionSummary[]>>({})
  const [versionsLoading, setVersionsLoading] = useState<string | null>(null)
  const [editingId,       setEditingId]       = useState<string | null>(null)
  const [editingName,     setEditingName]     = useState('')
  const [isStarting,      setIsStarting]      = useState(false)

  const isRunning = activeJobId !== null || isStarting

  // ── Fetch remote flows ─────────────────────────────────────────────────────
  const fetchRemote = useCallback(async () => {
    if (!token) return
    setRemoteLoading(true)
    try {
      setRemoteFlows(await api.flows.list())
    } catch { /* backend may not be running */ }
    finally { setRemoteLoading(false) }
  }, [token])

  useEffect(() => { fetchRemote() }, [fetchRemote])

  // ── Handlers ───────────────────────────────────────────────────────────────

  async function handleSave() {
    setSaveError('')
    const spec = exportSpec()
    if (!spec) { setSaveError('Fix validation errors before saving.'); return }
    saveFlow(spec)
    if (token) {
      try {
        await api.flows.save(spec)
        await fetchRemote()
      } catch (err) {
        setSaveError(`Backend sync failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  async function handleRun() {
    const spec = exportSpec()
    if (!spec) { setSaveError('Fix validation errors before running.'); return }
    setSaveError('')
    setIsStarting(true)
    try {
      const job = await api.run.start(spec)
      setActiveJob(job.job_id)   // poller in App picks this up
      onClose()                  // close panel so canvas is visible during run
    } catch (err) {
      setSaveError(`Run failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsStarting(false)
    }
  }

  function handleLoadLocal(id: string) {
    const spec = getFlow(id)
    if (spec) { loadFlow(spec); onClose() }
  }

  async function handleLoadRemote(flowId: string) {
    try {
      loadFlow(await api.flows.get(flowId) as FlowSpec)
      onClose()
    } catch (err) {
      setSaveError(`Load failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleDeleteRemote(flowId: string) {
    if (!confirm('Delete this flow from the server?')) return
    try {
      await api.flows.delete(flowId)
      setRemoteFlows((f) => f.filter((x) => x.id !== flowId))
    } catch (err) {
      setSaveError(`Delete failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function toggleVersions(flowId: string) {
    if (expandedId === flowId) { setExpandedId(null); return }
    setExpandedId(flowId)
    if (versions[flowId]) return
    setVersionsLoading(flowId)
    try {
      setVersions((v) => ({ ...v, [flowId]: [] }))
      const vers = await api.flows.versions.list(flowId)
      setVersions((v) => ({ ...v, [flowId]: vers }))
    } catch { /* ignore */ }
    finally { setVersionsLoading(null) }
  }

  async function handleRestore(flowId: string, versionId: string) {
    try {
      await api.flows.versions.restore(flowId, versionId)
      await handleLoadRemote(flowId)
    } catch (err) {
      setSaveError(`Restore failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function commitRename(id: string) {
    if (editingName.trim()) renameFlow(id, editingName.trim())
    setEditingId(null)
  }

  const currentIsInLibrary = entries.some((e) => e.id === flowMeta.id)

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 560, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>

        {/* Header */}
        <div className="modal__header" style={{ flexShrink: 0 }}>
          <span className="modal__title">My flows</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {email && <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginRight: 4 }}>{email}</span>}
            {token && (
              <button className="btn btn--sm" onClick={logout} style={{ fontSize: 11, padding: '3px 8px' }}>
                Sign out
              </button>
            )}
            <button className="config-panel__close" onClick={onClose}><X size={14} /></button>
          </div>
        </div>

        <div className="modal__body" style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>

          {/* Save + Run */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 12px', background: 'var(--bg-overlay)', borderRadius: 8, border: '0.5px solid var(--border)' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>
                {flowMeta.name || 'Untitled flow'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginTop: 1 }}>
                {flowMeta.id} · {currentIsInLibrary ? 'in library' : 'unsaved'}
              </div>
            </div>
            <button className="btn btn--primary" onClick={handleSave} style={{ gap: 5 }}>
              <Save size={12} /> {currentIsInLibrary ? 'Update' : 'Save'}
            </button>
            {token && (
              <button
                className="btn btn--primary"
                onClick={handleRun}
                disabled={isRunning}
                style={{ gap: 5, background: isRunning ? 'var(--bg-overlay)' : '#16a34a', borderColor: isRunning ? 'var(--border)' : '#16a34a' }}
              >
                {isStarting
                  ? <><Loader size={12} style={{ animation: 'spin 1s linear infinite' }} /> Starting…</>
                  : isRunning
                    ? <><Loader size={12} style={{ animation: 'spin 1s linear infinite' }} /> Running…</>
                    : <><Play size={12} /> Run</>}
              </button>
            )}
          </div>

          {saveError && <div className="error-badge" style={{ marginTop: -8 }}>{saveError}</div>}

          {/* ── Cloud workspace ──────────────────────────────────────────────── */}
          {token && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em', paddingBottom: 6 }}>
                Cloud workspace {remoteLoading ? '· syncing…' : `(${remoteFlows.length})`}
              </div>

              {remoteFlows.length === 0 && !remoteLoading ? (
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '8px 0' }}>
                  No flows saved to the server yet.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {remoteFlows.map((flow) => (
                    <div key={flow.id} style={{ borderRadius: 6, border: '0.5px solid var(--border)', overflow: 'hidden' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg-overlay)' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {flow.name}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginTop: 1 }}>
                            {flow.id} · {relativeTime(new Date(flow.updated_at).getTime())}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                          <button className="btn btn--icon" title="Version history" onClick={() => toggleVersions(flow.id)}>
                            {versionsLoading === flow.id
                              ? <Loader size={12} style={{ animation: 'spin 1s linear infinite' }} />
                              : expandedId === flow.id ? <ChevronDown size={12} /> : <History size={12} />}
                          </button>
                          <button className="btn btn--icon" title="Load" style={{ color: '#3b82f6' }} onClick={() => handleLoadRemote(flow.id)}>
                            <FolderOpen size={12} />
                          </button>
                          <button className="btn btn--icon" title="Delete" style={{ color: '#ef4444' }} onClick={() => handleDeleteRemote(flow.id)}>
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>

                      {/* Version drawer */}
                      {expandedId === flow.id && (
                        <div style={{ background: 'var(--bg-base)', borderTop: '0.5px solid var(--border)', padding: '6px 10px 8px' }}>
                          {(versions[flow.id] ?? []).length === 0 ? (
                            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', padding: '4px 0' }}>
                              {versionsLoading === flow.id ? 'Loading…' : 'No versions yet.'}
                            </div>
                          ) : (
                            (versions[flow.id] ?? []).map((ver) => (
                              <div key={ver.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '0.5px solid var(--border)' }}>
                                <div style={{ flex: 1 }}>
                                  <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>v{ver.version_num}</span>
                                  {ver.label && <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 6 }}>{ver.label}</span>}
                                  <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginLeft: 6 }}>{relativeTime(new Date(ver.created_at).getTime())}</span>
                                </div>
                                <button className="btn btn--icon" title="Restore" onClick={() => handleRestore(flow.id, ver.id)}>
                                  <RotateCcw size={11} />
                                </button>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Local library ────────────────────────────────────────────────── */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em', paddingBottom: 6 }}>
              Local library ({entries.length})
            </div>
            {entries.length === 0 ? (
              <div className="empty-state" style={{ padding: '16px 0' }}>
                <FolderOpen size={24} className="empty-state__icon" />
                <div className="empty-state__title">No local flows</div>
                <div className="empty-state__desc">Save your current flow above.</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {entries.map((entry) => (
                  <div key={entry.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 6,
                    background: entry.id === flowMeta.id ? 'rgba(59,130,246,0.06)' : 'var(--bg-overlay)',
                    border: `0.5px solid ${entry.id === flowMeta.id ? 'rgba(59,130,246,0.2)' : 'var(--border)'}`,
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {editingId === entry.id ? (
                        <input className="field__input" value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') commitRename(entry.id); if (e.key === 'Escape') setEditingId(null) }}
                          autoFocus style={{ fontSize: 12, padding: '3px 6px' }} />
                      ) : (
                        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {entry.name}
                        </div>
                      )}
                      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginTop: 1 }}>
                        {entry.id} · {relativeTime(entry.savedAt)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                      {editingId === entry.id
                        ? <button className="btn btn--icon" onClick={() => commitRename(entry.id)}><Check size={12} /></button>
                        : <button className="btn btn--icon" onClick={() => { setEditingId(entry.id); setEditingName(entry.name) }}><Pencil size={12} /></button>}
                      <button className="btn btn--icon" style={{ color: '#3b82f6' }} onClick={() => handleLoadLocal(entry.id)}><FolderOpen size={12} /></button>
                      <button className="btn btn--icon" style={{ color: '#ef4444' }}
                        onClick={() => window.confirm('Delete from local library?') && deleteFlow(entry.id)}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}
