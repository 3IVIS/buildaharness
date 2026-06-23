/**
 * RunDrawer — §6 of the v0.8 UI spec.
 *
 * A 420px right-side slide-over that owns the "start a run / see what's
 * happening / replay a past run" experience. Replaces the toolbar's
 * Export-JSON-as-primary affordance with a Run-as-primary affordance.
 *
 * Sections:
 *   1. Inputs  — form derived from flow.state_schema.properties
 *   2. Live trace — every node, status-aware; expand a step to see I/O
 *   3. HITL inline — when a paused step is expanded, the resume form
 *                    renders inline (§14 fold-in of HitlResumePanel)
 *   4. Recent runs — last 10 per-flow, persisted to localStorage
 *
 * Per-flow state lives in localStorage under `buildaharness:runs:<flowId>`.
 * runPoller is responsible for advancing execStats/hitlState/traceUrl —
 * this component is a read-and-display surface, with one POST on submit.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  X, Play, CheckCircle2, Loader2, AlertCircle, Circle, UserCheck, ChevronRight, ChevronDown,
} from 'lucide-react'
import { useCanvasStore, type HitlState, type NodeExecStat } from '../store'
import type { StateField } from '../spec/schema'
import { api, type RunJobResponse } from '../services/api'

// ─── Run-history persistence (localStorage, scoped per flow id) ──────────────

interface RunHistoryEntry {
  jobId:      string
  startedAt:  string
  endedAt:    string | null
  status:     'queued' | 'running' | 'paused' | 'done' | 'error'
  runtime:    string
  traceUrl:   string | null
  durationMs: number | null
}

const HISTORY_KEY  = (flowId: string) => `buildaharness:runs:${flowId}`
const HISTORY_MAX  = 10

function loadHistory(flowId: string): RunHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY(flowId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.slice(0, HISTORY_MAX) : []
  } catch { return [] }
}

function saveHistory(flowId: string, entries: RunHistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY(flowId), JSON.stringify(entries.slice(0, HISTORY_MAX)))
  } catch { /* quota / private mode — ignore */ }
}

function upsertHistory(flowId: string, entry: RunHistoryEntry) {
  const existing = loadHistory(flowId)
  const merged = [entry, ...existing.filter((e) => e.jobId !== entry.jobId)].slice(0, HISTORY_MAX)
  saveHistory(flowId, merged)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function relTime(iso: string | null): string {
  if (!iso) return '—'
  const delta = Date.now() - new Date(iso).getTime()
  if (delta < 60_000)         return `${Math.floor(delta / 1000)}s ago`
  if (delta < 3_600_000)      return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000)     return `${Math.floor(delta / 3_600_000)}h ago`
  return `${Math.floor(delta / 86_400_000)}d ago`
}

function statusColor(status?: NodeExecStat['status']): string {
  switch (status) {
    case 'done':    return 'var(--rt-full)'
    case 'running': return '#60a5fa'
    case 'paused':  return 'var(--c-hitl)'
    case 'error':   return '#ef4444'
    default:        return 'var(--text-tertiary)'
  }
}

// ─── Input section: form derived from state_schema.properties ───────────────

interface InputFormProps {
  schemaProps: Record<string, StateField>
  required:    string[]
  values:      Record<string, unknown>
  onChange:    (key: string, value: unknown) => void
}

function InputForm({ schemaProps, required, values, onChange }: InputFormProps) {
  const entries = Object.entries(schemaProps)
  if (entries.length === 0) {
    return (
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.55 }}>
        No state schema declared. Define one in <strong>Flow settings → State</strong> and a typed input form
        will render here automatically.
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {entries.map(([key, field]) => {
        const isRequired = required.includes(key)
        const value      = values[key]
        const type       = (field?.type as string) ?? 'string'
        const label = (
          <label className="field__label">
            {key}
            <span className="field__label-hint">
              {type}{isRequired ? ' · required' : ''}
            </span>
          </label>
        )
        if (type === 'boolean') {
          const on = Boolean(value)
          return (
            <div key={key} className="field">
              {label}
              <label className="toggle">
                <span className={`toggle__track${on ? ' on' : ''}`}>
                  <span className="toggle__knob" />
                </span>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => onChange(key, e.target.checked)}
                  style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                />
                <span className="toggle__label">{on ? 'true' : 'false'}</span>
              </label>
            </div>
          )
        }
        if (type === 'number' || type === 'integer') {
          return (
            <div key={key} className="field">
              {label}
              <input
                className="field__input field__input--mono"
                type="number"
                value={(value as number | string) ?? ''}
                onChange={(e) => {
                  const raw = e.target.value
                  onChange(key, raw === '' ? '' : Number(raw))
                }}
                step={type === 'integer' ? 1 : 'any'}
              />
            </div>
          )
        }
        if (type === 'object' || type === 'array') {
          let text: string
          try { text = typeof value === 'string' ? value : JSON.stringify(value ?? (type === 'array' ? [] : {}), null, 2) }
          catch { text = String(value ?? '') }
          return (
            <div key={key} className="field">
              {label}
              <textarea
                className="field__textarea"
                rows={4}
                defaultValue={text}
                onBlur={(e) => {
                  try { onChange(key, JSON.parse(e.target.value)) }
                  catch { onChange(key, e.target.value) }
                }}
                placeholder={type === 'array' ? '[]' : '{}'}
              />
            </div>
          )
        }
        // string / unknown
        return (
          <div key={key} className="field">
            {label}
            <input
              className="field__input"
              value={(value as string) ?? ''}
              onChange={(e) => onChange(key, e.target.value)}
              placeholder={(field?.description as string) ?? ''}
            />
          </div>
        )
      })}
    </div>
  )
}

// ─── HITL inline form (§14 fold-in) ──────────────────────────────────────────

function HitlInline({ hitl }: { hitl: HitlState }) {
  const setHitlState   = useCanvasStore((s) => s.setHitlState)
  const setActiveJob   = useCanvasStore((s) => s.setActiveJob)
  const clearExecStats = useCanvasStore((s) => s.clearExecStats)
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [isResuming, setIsResuming]   = useState(false)
  const [error,      setError]        = useState<string | null>(null)

  async function handleResume() {
    setIsResuming(true); setError(null)
    try {
      const payload: Record<string, unknown> = {}
      for (const k of hitl.resumeFields) {
        const v = fieldValues[k] ?? ''
        if (v !== '') payload[k] = v
      }
      await api.run.resume(hitl.jobId, payload)
      setHitlState(null); setFieldValues({})
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Resume failed')
    } finally { setIsResuming(false) }
  }
  function handleCancel() {
    setHitlState(null); setActiveJob(null); clearExecStats(); setFieldValues({}); setError(null)
  }

  return (
    <div className="hitl-inline">
      {hitl.prompt && <div className="hitl-inline__prompt">{hitl.prompt}</div>}
      {hitl.resumeFields.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {hitl.resumeFields.map((f) => (
            <div key={f} className="field">
              <label className="field__label" htmlFor={`hitl-inline-${f}`}>{f}</label>
              <input
                id={`hitl-inline-${f}`}
                className="field__input field__input--mono"
                value={fieldValues[f] ?? ''}
                onChange={(e) => setFieldValues((p) => ({ ...p, [f]: e.target.value }))}
                placeholder={`Enter ${f}…`}
                autoComplete="off"
              />
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
          No input fields declared — click Resume to continue.
        </div>
      )}
      {error && <div className="hitl-panel__error" style={{ marginTop: 10 }}>{error}</div>}
      <div className="hitl-inline__row">
        <button className="btn" onClick={handleCancel} disabled={isResuming}>Cancel run</button>
        <button className="btn btn--hitl" onClick={handleResume} disabled={isResuming}>
          {isResuming
            ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
            : <Play size={11} />}
          {isResuming ? 'Resuming…' : 'Resume'}
        </button>
      </div>
    </div>
  )
}

// ─── Drawer ──────────────────────────────────────────────────────────────────

export function RunDrawer() {
  const {
    isRunDrawerOpen, closeRunDrawer,
    nodes, stateSchema, flowMeta,
    execStats, activeJobId, hitlState, traceUrl, jobError, jobResult, lastCompletedJobId,
    exportSpec, validate,
    setActiveJob, clearExecStats, isProblemsOpen, toggleProblems,
  } = useCanvasStore()

  // Form values keyed by state-schema property name
  const [inputValues, setInputValues] = useState<Record<string, unknown>>({})
  // Which step row is expanded
  const [expanded, setExpanded] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting,  setSubmitting]  = useState(false)
  const [history, setHistory] = useState<RunHistoryEntry[]>([])
  // History detail view: jobId → fetched job or loading/expired sentinel
  const [historyExpanded, setHistoryExpanded] = useState<string | null>(null)
  const [historyFetched, setHistoryFetched] = useState<Record<string, RunJobResponse | 'loading' | 'expired'>>({})

  // Parse the job result — strip optional "[warnings]…\n\n" prefix, try JSON
  const parsedResult = useMemo((): { type: 'json'; data: Record<string, unknown> } | { type: 'raw'; data: string } | null => {
    if (!jobResult) return null
    const content = /^\[warnings\]/.test(jobResult)
      ? jobResult.replace(/^\[warnings\][\s\S]*?\n\n/, '')
      : jobResult
    try {
      const parsed = JSON.parse(content)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { type: 'json', data: parsed as Record<string, unknown> }
      }
    } catch { /* not JSON */ }
    return { type: 'raw', data: jobResult }
  }, [jobResult])

  // Auto-expand the paused step when HITL state arrives (§14)
  useEffect(() => {
    if (hitlState) setExpanded(hitlState.nodeId)
  }, [hitlState])

  // Reload history when the drawer opens or the flow changes
  useEffect(() => {
    if (isRunDrawerOpen) setHistory(loadHistory(flowMeta.id))
  }, [isRunDrawerOpen, flowMeta.id])

  // Persist the active job into history whenever its status/traceUrl changes
  useEffect(() => {
    if (!activeJobId) return
    const status = hitlState ? 'paused' : 'running'
    upsertHistory(flowMeta.id, {
      jobId: activeJobId,
      startedAt: new Date().toISOString(),
      endedAt:   null,
      status,
      runtime:   flowMeta.runtimeHints?.preferred_adapter ?? 'langgraph',
      traceUrl,
      durationMs: null,
    })
    setHistory(loadHistory(flowMeta.id))
  }, [activeJobId, hitlState, traceUrl, flowMeta.id, flowMeta.runtimeHints?.preferred_adapter])

  // When a job completes, fetch its final status and update the history entry
  useEffect(() => {
    if (!lastCompletedJobId) return
    api.run.status(lastCompletedJobId)
      .then((job) => {
        upsertHistory(flowMeta.id, {
          jobId: lastCompletedJobId,
          startedAt: job.started_at,
          endedAt: job.ended_at,
          status: job.status as RunHistoryEntry['status'],
          runtime: job.runtime,
          traceUrl: job.trace_url,
          durationMs: job.ended_at && job.started_at
            ? new Date(job.ended_at).getTime() - new Date(job.started_at).getTime()
            : null,
        })
        setHistory(loadHistory(flowMeta.id))
      })
      .catch(() => { /* job may be expired — ignore */ })
  }, [lastCompletedJobId, flowMeta.id])

  // When a structured JSON result arrives, populate the form fields with output values
  useEffect(() => {
    if (!parsedResult || parsedResult.type !== 'json') return
    setInputValues((prev) => ({ ...prev, ...parsedResult.data }))
  }, [parsedResult])

  const schemaProps = stateSchema?.properties ?? {}
  const required    = stateSchema?.required ?? []

  const trace = useMemo(() => {
    return nodes.map((n) => ({
      nodeId: n.id,
      label:  (n.data.label as string) || n.id,
      type:   (n.type ?? '') as string,
      stat:   execStats[n.id],
    }))
  }, [nodes, execStats])

  function handleHistoryClick(jobId: string) {
    if (historyExpanded === jobId) { setHistoryExpanded(null); return }
    setHistoryExpanded(jobId)
    if (historyFetched[jobId]) return
    setHistoryFetched((prev) => ({ ...prev, [jobId]: 'loading' }))
    api.run.status(jobId)
      .then((job) => setHistoryFetched((prev) => ({ ...prev, [jobId]: job })))
      .catch(() => setHistoryFetched((prev) => ({ ...prev, [jobId]: 'expired' })))
  }

  async function handleSubmit() {
    setSubmitError(null)
    const spec = exportSpec()
    if (!spec) { validate(); setSubmitError('Spec is invalid — open the Problems panel to fix.'); return }
    setSubmitting(true)
    try {
      const runtime = flowMeta.runtimeHints?.preferred_adapter
      const res = await api.run.start(spec, inputValues as Record<string, unknown>, runtime)
      setActiveJob(res.job_id)
      clearExecStats()
      upsertHistory(flowMeta.id, {
        jobId:      res.job_id,
        startedAt:  new Date().toISOString(),
        endedAt:    null,
        status:     'queued',
        runtime:    res.runtime,
        traceUrl:   null,
        durationMs: null,
      })
      setHistory(loadHistory(flowMeta.id))
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Failed to start run')
    } finally { setSubmitting(false) }
  }

  if (!isRunDrawerOpen) return null

  const headerStatus = hitlState ? 'paused — awaiting reviewer'
                     : activeJobId ? 'running'
                     : 'idle'

  return (
    <>
      <div className="run-drawer__backdrop" onClick={closeRunDrawer} />
      <aside className="run-drawer" aria-label="Run flow">
        <div className="run-drawer__head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="run-drawer__title">Run flow</div>
            <div className="run-drawer__sub">
              {activeJobId ? `${activeJobId} · ` : ''}
              {flowMeta.runtimeHints?.preferred_adapter ?? 'no target'} · {headerStatus}
            </div>
          </div>
          <button className="run-drawer__icon" onClick={closeRunDrawer} title="Close (Esc)">
            <X size={14} />
          </button>
        </div>

        <div className="run-drawer__body">
          {/* Input section */}
          <section className="run-section">
            <div className="run-section__label">
              <span>Inputs</span>
              <span style={{ color: 'var(--text-tertiary)' }}>from state_schema</span>
            </div>
            <InputForm
              schemaProps={schemaProps}
              required={required}
              values={inputValues}
              onChange={(k, v) => setInputValues((p) => ({ ...p, [k]: v }))}
            />
            {submitError && <div className="hitl-panel__error" style={{ marginTop: 10 }}>{submitError}</div>}
            <button
              className="btn btn--primary"
              onClick={handleSubmit}
              disabled={submitting || Boolean(activeJobId)}
              style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
            >
              {submitting
                ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                : <Play size={11} />}
              {activeJobId ? 'Run in flight…' : submitting ? 'Starting…' : 'Run flow'}
            </button>
            {(zodErrCount() > 0) && (
              <button
                className="btn"
                onClick={() => { if (!isProblemsOpen) toggleProblems() }}
                style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
              >
                <AlertCircle size={12} style={{ color: '#ef4444' }} />
                Spec has validation errors — view problems
              </button>
            )}
          </section>

          {/* Live trace */}
          {(activeJobId || Object.keys(execStats).length > 0) && (
            <section className="run-section">
              <div className="run-section__label">
                <span>Live trace</span>
                {hitlState && <span style={{ color: 'var(--c-hitl)' }}>paused</span>}
              </div>
              {trace.map((row) => {
                const isOpen = expanded === row.nodeId
                const status = row.stat?.status ?? 'pending'
                const isPaused = Boolean(hitlState && hitlState.nodeId === row.nodeId)
                return (
                  <div key={row.nodeId} className="run-step">
                    <div className="run-step__row" onClick={() => setExpanded(isOpen ? null : row.nodeId)}>
                      <span className={`run-step__icon run-step__icon--${isPaused ? 'paused' : status}`}>
                        {isPaused ? <UserCheck size={9} />
                          : status === 'done'    ? <CheckCircle2 size={9} />
                          : status === 'running' ? <Loader2 size={9} style={{ animation: 'spin 1s linear infinite' }} />
                          : status === 'error'   ? <AlertCircle size={9} />
                          : <Circle size={6} />}
                      </span>
                      <span className="run-step__label">{row.label}</span>
                      <span className="run-step__type">{row.type}</span>
                      {row.stat?.ms != null   && <span className="run-step__meta">{fmtDuration(row.stat.ms)}</span>}
                      {row.stat?.tokens != null && <span className="run-step__meta">· {row.stat.tokens} tok</span>}
                      {isOpen ? <ChevronDown size={11} style={{ color: 'var(--text-tertiary)' }} />
                              : <ChevronRight size={11} style={{ color: 'var(--text-tertiary)' }} />}
                    </div>
                    {/* HITL inline form (§14) */}
                    {isOpen && isPaused && hitlState && <HitlInline hitl={hitlState} />}
                    {/* Generic expand — status, error detail, trace link */}
                    {isOpen && !isPaused && (
                      <div className="run-step__expand">
                        <div className="run-step__expand-label">status</div>
                        <pre>{status}{row.stat?.score != null ? ` · score ${row.stat.score.toFixed(2)}` : ''}</pre>
                        {/* Per-node error message from adapter (e.g. LangGraph node throw) */}
                        {status === 'error' && row.stat?.errorMessage && (
                          <>
                            <div className="run-step__expand-label" style={{ color: '#ef4444' }}>error</div>
                            <pre style={{
                              color: '#fca5a5',
                              background: 'rgba(239,68,68,0.08)',
                              border: '1px solid rgba(239,68,68,0.2)',
                              borderRadius: 4,
                              padding: '6px 8px',
                              fontSize: 10.5,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              maxHeight: 160,
                              overflowY: 'auto',
                            }}>{row.stat.errorMessage}</pre>
                          </>
                        )}
                        {traceUrl && (
                          <>
                            <div className="run-step__expand-label">trace</div>
                            <a href={traceUrl} target="_blank" rel="noopener noreferrer"
                               style={{ color: 'var(--rt-full)', fontSize: 11, textDecoration: 'none' }}>
                              View in Langfuse →
                            </a>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </section>
          )}

          {/* Run output — shown once a job completes */}
          {!activeJobId && parsedResult && (
            <section className="run-section">
              <div className="run-section__label">
                <span>Output</span>
                <span style={{ color: 'var(--text-tertiary)' }}>
                  {parsedResult.type === 'json' ? 'state fields' : 'raw'}
                </span>
              </div>
              {parsedResult.type === 'raw' ? (
                <pre style={{
                  fontSize: 10.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  background: 'var(--bg-surface)', border: '1px solid var(--border)',
                  borderRadius: 4, padding: '8px 10px', maxHeight: 260, overflowY: 'auto', margin: 0,
                }}>{parsedResult.data}</pre>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {Object.entries(parsedResult.data).map(([k, v]) => {
                    const text = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
                    return (
                      <div key={k} className="field">
                        <label className="field__label">{k}</label>
                        <pre style={{
                          fontSize: 10.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                          background: 'var(--bg-surface)', border: '1px solid var(--border)',
                          borderRadius: 4, padding: '6px 8px', maxHeight: 160, overflowY: 'auto', margin: 0,
                        }}>{text || '—'}</pre>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )}

          {/* Job-level error banner — shown when the run ended in error but no
               individual node carried an error_message (e.g. compile failure,
               network error, adapter crash before any node ran). */}
          {!activeJobId && jobError && (
            <section className="run-section">
              <div className="run-section__label">
                <AlertCircle size={12} style={{ color: '#ef4444' }} />
                <span style={{ color: '#ef4444' }}>Run failed</span>
              </div>
              <pre style={{
                color: '#fca5a5',
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.2)',
                borderRadius: 4,
                padding: '8px 10px',
                fontSize: 10.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 200,
                overflowY: 'auto',
                margin: 0,
              }}>{jobError}</pre>
            </section>
          )}

          {/* Recent runs (last 10, persisted per flow) */}
          <section className="run-section">
            <div className="run-section__label">
              <span>Recent runs</span>
              <span style={{ color: 'var(--text-tertiary)' }}>{history.length} stored</span>
            </div>
            {history.length === 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.55 }}>
                No runs yet for this flow. They'll show up here as you run.
              </div>
            )}
            {history.map((h) => {
              const isExpanded = historyExpanded === h.jobId
              const fetched = historyFetched[h.jobId]
              return (
                <div key={h.jobId}>
                  <div
                    className="run-history-row"
                    onClick={() => handleHistoryClick(h.jobId)}
                    style={{ cursor: 'pointer' }}
                  >
                    <span className="run-history-row__dot" style={{ background: statusColor(h.status as NodeExecStat['status']) }} />
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-primary)' }}>{h.jobId.slice(0, 10)}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{h.status}</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)' }}>
                      {fmtDuration(h.durationMs)}
                    </span>
                    <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{relTime(h.startedAt)}</span>
                    {isExpanded
                      ? <ChevronDown size={11} style={{ color: 'var(--text-tertiary)' }} />
                      : <ChevronRight size={11} style={{ color: 'var(--text-tertiary)' }} />}
                  </div>
                  {isExpanded && (
                    <div style={{
                      margin: '4px 0 8px', padding: '8px 10px',
                      background: 'var(--bg-surface)', border: '1px solid var(--border)',
                      borderRadius: 4, fontSize: 10.5,
                    }}>
                      {fetched === 'loading' && (
                        <span style={{ color: 'var(--text-tertiary)' }}>
                          <Loader2 size={10} style={{ animation: 'spin 1s linear infinite', display: 'inline' }} /> Loading…
                        </span>
                      )}
                      {fetched === 'expired' && (
                        <span style={{ color: 'var(--text-tertiary)' }}>Run expired (results are only kept for a few hours)</span>
                      )}
                      {fetched && fetched !== 'loading' && fetched !== 'expired' && (() => {
                        const job = fetched as RunJobResponse
                        if (job.status === 'error') {
                          return <pre style={{ color: '#fca5a5', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 200, overflowY: 'auto', margin: 0 }}>{job.error ?? 'Unknown error'}</pre>
                        }
                        if (!job.result) {
                          return <span style={{ color: 'var(--text-tertiary)' }}>No output recorded</span>
                        }
                        const content = /^\[warnings\]/.test(job.result)
                          ? job.result.replace(/^\[warnings\][\s\S]*?\n\n/, '')
                          : job.result
                        return <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflowY: 'auto', margin: 0 }}>{content}</pre>
                      })()}
                    </div>
                  )}
                </div>
              )
            })}
          </section>
        </div>
      </aside>
    </>
  )
}

// Local helper — avoid pulling zodErrors into the destructure above just for one read
function zodErrCount(): number {
  const z = useCanvasStore.getState().zodErrors
  return z?.issues.length ?? 0
}
