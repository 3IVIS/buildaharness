import { useRef, useState } from 'react'
import { CheckCircle, AlertCircle, Settings, Undo2, Redo2, LayoutDashboard, Save, FolderOpen } from 'lucide-react'
import { useCanvasStore } from '../store'
import { useLibraryStore } from '../store/library'
import { ImportDialog } from './ImportDialog'
import { FlowLibraryPanel } from './FlowLibraryPanel'

export function Toolbar() {
  const {
    flowMeta, setFlowMeta, exportSpec, validate, loadFlow, newFlow,
    zodErrors, crossRefErrors, lastModifiedAt,
    openSettings, toggleProblems,
    undo, redo, canUndo, canRedo,
    autoLayout,
  } = useCanvasStore()

  const { saveFlow, lastSavedSpecJson, entries } = useLibraryStore()

  const [showImport,  setShowImport]  = useState(false)
  const [showLibrary, setShowLibrary] = useState(false)

  const errorCount = (zodErrors?.issues.length ?? 0) + crossRefErrors.length

  // Dirty = lastModifiedAt is newer than when we last saved to library
  const lastSavedEntry = entries.find((e) => e.id === flowMeta.id)
  const isDirty = !lastSavedEntry || lastSavedEntry.savedAt < lastModifiedAt

  function handleExport() {
    const spec = exportSpec(); if (!spec) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = `${spec.id}.json`; a.click()
    URL.revokeObjectURL(url)
  }

  function handleSaveToLibrary() {
    const spec = exportSpec(); if (!spec) return
    saveFlow(spec)
  }

  function handleCopy() {
    const spec = exportSpec(); if (!spec) return
    navigator.clipboard.writeText(JSON.stringify(spec, null, 2))
      .then(() => alert('Spec copied to clipboard'))
  }

  return (
    <>
      <div className="toolbar">
        <span className="toolbar__logo">itsharness</span>
        <div className="toolbar__divider" />

        <input className="toolbar__flow-name" value={flowMeta.name}
          onChange={(e) => setFlowMeta({ name: e.target.value })}
          placeholder="Flow name" spellCheck={false} />

        {/* Dirty indicator dot */}
        {isDirty && <div title="Unsaved changes" style={{ width: 6, height: 6, borderRadius: '50%', background: '#f59e0b', flexShrink: 0, marginLeft: -2 }} />}

        <div className="toolbar__divider" />

        {/* Undo / redo */}
        <button className="btn btn--icon" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" style={{ opacity: canUndo ? 1 : 0.35 }}>
          <Undo2 size={13} />
        </button>
        <button className="btn btn--icon" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" style={{ opacity: canRedo ? 1 : 0.35 }}>
          <Redo2 size={13} />
        </button>

        <div className="toolbar__divider" />

        {/* Auto-layout */}
        <button className="btn btn--icon" onClick={autoLayout} title="Auto-layout (dagre LR)">
          <LayoutDashboard size={13} />
        </button>

        {/* Validate */}
        <button className="btn" onClick={() => { validate(); toggleProblems() }} title="Validate spec">
          {errorCount > 0
            ? <><AlertCircle size={13} style={{ color: '#ef4444' }} />{errorCount} error{errorCount !== 1 ? 's' : ''}</>
            : <><CheckCircle size={13} style={{ color: '#22c55e' }} />valid</>}
        </button>

        <div className="toolbar__spacer" />

        {/* Settings */}
        <button className="btn btn--icon" onClick={() => openSettings()} title="Flow settings">
          <Settings size={13} />
        </button>

        {/* Library */}
        <button className="btn btn--icon" onClick={() => setShowLibrary(true)} title="My flows">
          <FolderOpen size={13} />
        </button>

        {/* Save to library */}
        <button
          className="btn"
          onClick={handleSaveToLibrary}
          title="Save to library"
          style={{ gap: 5, color: isDirty ? 'var(--text-primary)' : 'var(--text-tertiary)' }}
        >
          <Save size={12} />
          {isDirty ? 'Save' : 'Saved'}
        </button>

        <button className="btn" onClick={newFlow} title="New flow">New</button>
        <button className="btn" onClick={() => setShowImport(true)} title="Load flow from JSON">Import</button>
        <button className="btn" onClick={handleCopy} title="Copy spec JSON">Copy spec</button>
        <button className="btn btn--primary" onClick={handleExport} title="Download spec JSON">Export JSON</button>
      </div>

      {showImport  && <ImportDialog  onClose={() => setShowImport(false)}  onLoad={(spec) => { loadFlow(spec); setShowImport(false) }} />}
      {showLibrary && <FlowLibraryPanel onClose={() => setShowLibrary(false)} />}
    </>
  )
}
