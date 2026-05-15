import { useState, useRef, useCallback } from 'react'
import { X, Upload, CheckCircle, AlertCircle, AlertTriangle, FileJson } from 'lucide-react'
import { parseFlowSpec, type FlowSpec } from '../spec/schema'
import { validateCrossRefs, type ValidationError } from '../spec/validation'
import type { ZodIssue } from 'zod'

interface ParseResult {
  spec:        FlowSpec
  zodIssues:   ZodIssue[]
  crossRefs:   ValidationError[]
  canLoad:     boolean   // false only when Zod hard-fails
}

interface Props {
  onLoad:  (spec: FlowSpec) => void
  onClose: () => void
}

export function ImportDialog({ onLoad, onClose }: Props) {
  const [result,   setResult]   = useState<ParseResult | null>(null)
  const [fileName, setFileName] = useState<string>('')
  const [rawError, setRawError] = useState<string>('')
  const [isDragging, setIsDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  function parseFile(file: File) {
    setFileName(file.name)
    setRawError('')
    setResult(null)

    const reader = new FileReader()
    reader.onload = (ev) => {
      let raw: unknown
      try {
        raw = JSON.parse(ev.target?.result as string)
      } catch {
        setRawError('File is not valid JSON — check for syntax errors.')
        return
      }

      const zodResult = parseFlowSpec(raw)
      if (!zodResult.success) {
        setResult({
          spec:      raw as FlowSpec,
          zodIssues: zodResult.error.issues,
          crossRefs: [],
          canLoad:   false,
        })
        return
      }

      const crossRefs = validateCrossRefs(zodResult.data)
      setResult({
        spec:      zodResult.data,
        zodIssues: [],
        crossRefs,
        canLoad:   true,
      })
    }
    reader.readAsText(file)
  }

  function handleFiles(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    if (!file.name.endsWith('.json')) {
      setRawError('Only .json files are supported.')
      return
    }
    parseFile(file)
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false)
    handleFiles(e.dataTransfer.files)
  }, [])

  const onDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setIsDragging(true)  }, [])
  const onDragLeave= useCallback((e: React.DragEvent) => { e.preventDefault(); setIsDragging(false) }, [])

  const canConfirm = result?.canLoad

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal__header">
          <span className="modal__title">Import flow</span>
          <button className="config-panel__close" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Drop zone */}
          <div
            className={`import-dropzone${isDragging ? ' dragging' : ''}`}
            onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave}
            onClick={() => fileRef.current?.click()}
          >
            <input ref={fileRef} type="file" accept=".json" style={{ display: 'none' }}
              onChange={(e) => handleFiles(e.target.files)} />
            {fileName
              ? <><FileJson size={20} style={{ color: 'var(--text-secondary)' }} /><span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{fileName}</span><span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>click to change</span></>
              : <><Upload size={20} style={{ color: 'var(--text-tertiary)' }} /><span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Drop a .json file here, or click to browse</span></>
            }
          </div>

          {/* Raw JSON error */}
          {rawError && (
            <div className="error-badge">
              <AlertCircle size={13} style={{ flexShrink: 0 }} />
              {rawError}
            </div>
          )}

          {/* Parse result */}
          {result && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

              {/* Header: valid / invalid */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 6, background: result.canLoad ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)', border: `0.5px solid ${result.canLoad ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}` }}>
                {result.canLoad
                  ? <CheckCircle size={14} style={{ color: '#22c55e', flexShrink: 0 }} />
                  : <AlertCircle size={14} style={{ color: '#ef4444', flexShrink: 0 }} />}
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: result.canLoad ? '#4ade80' : '#f87171' }}>
                    {result.canLoad ? 'Valid spec' : 'Invalid spec — cannot load'}
                  </div>
                  {result.spec && (result.spec as FlowSpec).id && (
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginTop: 1 }}>
                      {(result.spec as FlowSpec).id} · {(result.spec as FlowSpec).nodes?.length ?? 0} nodes · {(result.spec as FlowSpec).edges?.length ?? 0} edges
                    </div>
                  )}
                </div>
              </div>

              {/* Zod errors */}
              {result.zodIssues.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '2px 0' }}>
                    Validation errors ({result.zodIssues.length})
                  </div>
                  {result.zodIssues.map((issue, i) => (
                    <div key={i} className="import-issue import-issue--error">
                      <AlertCircle size={11} style={{ flexShrink: 0, marginTop: 1, color: '#f87171' }} />
                      <div style={{ flex: 1 }}>
                        <span style={{ color: '#fca5a5', fontSize: 11 }}>{issue.message}</span>
                        {issue.path.length > 0 && (
                          <span style={{ color: 'var(--text-tertiary)', fontSize: 10, marginLeft: 8, fontFamily: 'var(--font-mono)' }}>
                            {issue.path.join(' › ')}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Cross-ref warnings */}
              {result.crossRefs.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '2px 0' }}>
                    Cross-reference warnings ({result.crossRefs.length}) — will load but may need fixing
                  </div>
                  {result.crossRefs.map((err, i) => (
                    <div key={i} className="import-issue import-issue--warn">
                      <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 1, color: '#fbbf24' }} />
                      <div style={{ flex: 1 }}>
                        {err.nodeId && (
                          <span style={{ color: '#fcd34d', fontSize: 10, fontFamily: 'var(--font-mono)', marginRight: 6 }}>{err.nodeId}</span>
                        )}
                        <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{err.message}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '0.5px solid var(--border)', paddingTop: 12, marginTop: 4 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button
              className={`btn${canConfirm ? ' btn--primary' : ''}`}
              disabled={!canConfirm}
              style={{ opacity: canConfirm ? 1 : 0.4 }}
              onClick={() => { if (result?.spec) onLoad(result.spec) }}
            >
              {result?.crossRefs.length ? 'Load anyway' : 'Load flow'}
            </button>
          </div>

        </div>
      </div>
    </div>
  )
}
