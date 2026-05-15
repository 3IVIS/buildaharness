import { useState } from 'react'
import { X, Save, Trash2, Pencil, Check, FolderOpen } from 'lucide-react'
import { useLibraryStore, relativeTime } from '../store/library'
import { useCanvasStore } from '../store'

interface Props {
  onClose: () => void
}

export function FlowLibraryPanel({ onClose }: Props) {
  const { entries, saveFlow, deleteFlow, renameFlow, getFlow } = useLibraryStore()
  const { exportSpec, loadFlow, flowMeta } = useCanvasStore()
  const [editingId,   setEditingId]   = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [saveError,   setSaveError]   = useState('')

  function handleSave() {
    setSaveError('')
    const spec = exportSpec()
    if (!spec) { setSaveError('Current canvas has validation errors — fix them before saving.'); return }
    saveFlow(spec)
  }

  function handleLoad(id: string) {
    const spec = getFlow(id)
    if (spec) { loadFlow(spec); onClose() }
  }

  function startRename(id: string, currentName: string) {
    setEditingId(id); setEditingName(currentName)
  }

  function commitRename(id: string) {
    if (editingName.trim()) renameFlow(id, editingName.trim())
    setEditingId(null)
  }

  const currentIsInLibrary = entries.some((e) => e.id === flowMeta.id)

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal__header">
          <span className="modal__title">My flows</span>
          <button className="config-panel__close" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="modal__body" style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Save current */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 12px', background: 'var(--bg-overlay)', borderRadius: 8, border: '0.5px solid var(--border)' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>
                {flowMeta.name || 'Untitled flow'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginTop: 1 }}>
                {flowMeta.id} · {currentIsInLibrary ? 'already saved' : 'not in library'}
              </div>
            </div>
            <button className="btn btn--primary" onClick={handleSave} style={{ gap: 5 }}>
              <Save size={12} /> {currentIsInLibrary ? 'Update' : 'Save to library'}
            </button>
          </div>
          {saveError && (
            <div className="error-badge" style={{ marginTop: -8 }}>
              {saveError}
            </div>
          )}

          {/* Library list */}
          {entries.length === 0 ? (
            <div className="empty-state" style={{ padding: '24px 0' }}>
              <FolderOpen size={28} className="empty-state__icon" />
              <div className="empty-state__title">No saved flows yet</div>
              <div className="empty-state__desc">Save your current flow above to start building a library.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em', paddingBottom: 4 }}>
                Saved flows ({entries.length})
              </div>
              {entries.map((entry) => (
                <div key={entry.id} className="library-row" style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px', borderRadius: 6,
                  background: entry.id === flowMeta.id ? 'rgba(59,130,246,0.06)' : 'var(--bg-overlay)',
                  border: `0.5px solid ${entry.id === flowMeta.id ? 'rgba(59,130,246,0.2)' : 'var(--border)'}`,
                  marginBottom: 3,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {editingId === entry.id ? (
                      <input
                        className="field__input"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') commitRename(entry.id); if (e.key === 'Escape') setEditingId(null) }}
                        autoFocus
                        style={{ fontSize: 12, padding: '3px 6px' }}
                      />
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
                    {editingId === entry.id ? (
                      <button className="btn btn--icon" onClick={() => commitRename(entry.id)} title="Save name">
                        <Check size={12} />
                      </button>
                    ) : (
                      <button className="btn btn--icon" onClick={() => startRename(entry.id, entry.name)} title="Rename">
                        <Pencil size={12} />
                      </button>
                    )}
                    <button className="btn btn--icon" onClick={() => handleLoad(entry.id)} title="Load this flow"
                      style={{ color: '#3b82f6' }}>
                      <FolderOpen size={12} />
                    </button>
                    <button className="btn btn--icon" onClick={() => deleteFlow(entry.id)} title="Delete from library"
                      style={{ color: '#ef4444' }}>
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
  )
}
