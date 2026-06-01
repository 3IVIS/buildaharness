// §11 — Library as a full-screen routed page (overlay variant, no router needed).
// Renders over the canvas when isLibraryOpen is true.
// Shows draft + published timestamps per §13 schema.

import { useState, useEffect, useCallback } from 'react'
import {
  ChevronLeft, Save, Trash2, Pencil, Check, FolderOpen,
  History, Play, ChevronDown, RotateCcw, Loader, Plus,
} from 'lucide-react'
import { useLibraryStore, relativeTime } from '../store/library'
import { useCanvasStore } from '../store'
import { useAuthStore }   from '../store/auth'
import { api, type FlowSummary, type VersionSummary } from '../services/api'
import type { FlowSpec } from '../spec/schema'
import { NewFlowChooser } from './NewFlowChooser'

interface Props { onClose: () => void }

export function FlowLibraryPanel({ onClose }: Props) {
  const { entries, saveDraft, deleteFlow, renameFlow, getFlow } = useLibraryStore()
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
  const [search,          setSearch]          = useState('')
  const [chooserOpen,     setChooserOpen]     = useState(false)

  const isRunning = activeJobId !== null || isStarting

  // ── Fetch remote flows ─────────────────────────────────────────────────────
  const fetchRemote = useCallback(async () => {
    if (!token) return
    setRemoteLoading(true)
    try { setRemoteFlows(await api.flows.list()) }
    catch { /* backend may not be running */ }
    finally { setRemoteLoading(false) }
  }, [token])

  useEffect(() => { fetchRemote() }, [fetchRemote])

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !chooserOpen) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, chooserOpen])

  // ── Handlers ───────────────────────────────────────────────────────────────

  async function handleSaveDraft() {
    setSaveError('')
    const spec = exportSpec()
    if (!spec) { setSaveError('Fix validation errors before saving.'); return }
    saveDraft(spec)
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
      const job = await api.run.start(spec, {})
      setActiveJob(job.job_id)
      onClose()
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

  const filtered = entries.filter((e) =>
    !search || e.name.toLowerCase().includes(search.toLowerCase()) || e.id.includes(search.toLowerCase())
  )

  return (
    <>
      <div className="library-page">
        {/* Header */}
        <div className="library-page__head">
          <button className="back-btn" onClick={onClose} title="Back to canvas">
            <ChevronLeft size={16} />
          </button>
          <div>
            <div className="library-page__title">My flows</div>
            <div className="library-page__sub">{entries.length} flow{entries.length !== 1 ? 's' : ''} · sorted by recently modified</div>
          </div>
          <div style={{ flex: 1 }} />
          <input
            className="library-page__search"
            placeholder="Search flows…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {email && (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{email}</span>
          )}
          {token && (
            <button className="btn btn--sm" onClick={logout} style={{ fontSize: 11, padding: '3px 8px' }}>
              Sign out
            </button>
          )}
          <button className="btn btn--primary" onClick={() => setChooserOpen(true)} style={{ gap: 5 }}>
            <Plus size={12} /> New flow
          </button>
        </div>

        {/* Body */}
        <div className="library-page__body">
          {saveError && (
            <div className="error-badge" style={{ marginBottom: 12 }}>{saveError}</div>
          )}

          {/* Current flow quick-save */}
          <div style={{
            display: 'flex', gap: 8, alignItems: 'center', padding: '10px 12px',
            background: 'var(--bg-raised)', borderRadius: 8, border: '0.5px solid var(--border)',
            marginBottom: 20, maxWidth: 640,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>
                {flowMeta.name || 'Untitled flow'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginTop: 1 }}>
                {flowMeta.id} · {currentIsInLibrary ? 'in library' : 'unsaved'}
              </div>
            </div>
            <button className="btn btn--primary" onClick={handleSaveDraft} style={{ gap: 5 }}>
              <Save size={12} /> {currentIsInLibrary ? 'Save draft' : 'Save'}
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

          {/* Cloud workspace */}
          {token && (
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em', paddingBottom: 8 }}>
                Cloud workspace {remoteLoading ? '· syncing…' : `(${remoteFlows.length})`}
              </div>
              {remoteFlows.length === 0 && !remoteLoading ? (
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '8px 0' }}>
                  No flows saved to the server yet.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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

          {/* Local library grid */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em', paddingBottom: 10 }}>
              Local library ({filtered.length}{search ? ` of ${entries.length}` : ''})
            </div>
            {filtered.length === 0 ? (
              <div className="empty-state" style={{ padding: '32px 0' }}>
                <FolderOpen size={28} className="empty-state__icon" />
                <div className="empty-state__title">{search ? 'No matching flows' : 'No local flows'}</div>
                <div className="empty-state__desc">
                  {search ? 'Try a different search term.' : 'Save your current flow or start a new one.'}
                </div>
              </div>
            ) : (
              <div className="library-grid">
                {filtered.map((entry) => (
                  <div
                    key={entry.id}
                    className={`flow-card${entry.id === flowMeta.id ? ' flow-card--active' : ''}`}
                    onClick={() => handleLoadLocal(entry.id)}
                  >
                    <div className="flow-card__name">{entry.name}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                      {entry.id}
                    </div>
                    {/* §11 — node count + runtime chip */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                      {(() => {
                        const nodes = entry.draft?.nodes ?? entry.published?.nodes
                        const rt    = entry.draft?.runtime_hints?.preferred_adapter ?? entry.published?.runtime_hints?.preferred_adapter
                        const RT_COLORS: Record<string, string> = {
                          langgraph: '#8b5cf6', crewai: '#db2777',
                          mastra: '#0ea5a0', microsoft_agent_framework: '#2563eb',
                        }
                        const RT_SHORT: Record<string, string> = {
                          langgraph: 'LG', crewai: 'CA',
                          mastra: 'MA', microsoft_agent_framework: 'MS',
                        }
                        return (
                          <>
                            {nodes != null && (
                              <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
                                {nodes.length} node{nodes.length !== 1 ? 's' : ''}
                              </span>
                            )}
                            {rt && (
                              <span style={{
                                fontSize: 9.5, fontFamily: 'var(--font-mono)', fontWeight: 600,
                                padding: '1px 5px', borderRadius: 4,
                                background: `${RT_COLORS[rt] ?? 'var(--bg-overlay)'}22`,
                                color: RT_COLORS[rt] ?? 'var(--text-tertiary)',
                                border: `0.5px solid ${RT_COLORS[rt] ?? 'var(--border-mid)'}55`,
                              }}>
                                {RT_SHORT[rt] ?? rt}
                              </span>
                            )}
                          </>
                        )
                      })()}
                    </div>
                    <div className="flow-card__stats">
                      {/* §13 — draft + published timestamps */}
                      <div className="flow-card__stat" style={{ color: 'var(--text-tertiary)' }}>
                        draft {relativeTime(entry.draftSavedAt)}
                      </div>
                      {entry.publishedAt && (
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--rt-full, #4ade80)' }}>
                          published v{entry.publishedVersion} · {relativeTime(entry.publishedAt)}
                        </div>
                      )}
                      <div className="flow-card__actions" onClick={(e) => e.stopPropagation()}>
                        {editingId === entry.id ? (
                          <>
                            <input
                              className="field__input"
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitRename(entry.id)
                                if (e.key === 'Escape') setEditingId(null)
                              }}
                              autoFocus
                              style={{ fontSize: 11, padding: '2px 5px', width: 100 }}
                              onClick={(e) => e.stopPropagation()}
                            />
                            <button className="btn btn--icon" onClick={() => commitRename(entry.id)}><Check size={11} /></button>
                          </>
                        ) : (
                          <button className="btn btn--icon" onClick={() => { setEditingId(entry.id); setEditingName(entry.name) }}><Pencil size={11} /></button>
                        )}
                        <button
                          className="btn btn--icon"
                          style={{ color: '#ef4444' }}
                          onClick={() => window.confirm('Delete from local library?') && deleteFlow(entry.id)}
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* §8 — New flow chooser launched from library header */}
      <NewFlowChooser
        open={chooserOpen}
        onClose={() => { setChooserOpen(false); onClose() }}
      />
    </>
  )
}
