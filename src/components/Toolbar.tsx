import { useEffect, useRef, useState } from 'react'
import {
  CheckCircle, AlertCircle, Settings, Undo2, Redo2,
  Save, FolderOpen, GitCompare, Share2, Loader2, Rocket,
  Play, MoreVertical, Download, Copy, Upload, ChevronDown, Check,
} from 'lucide-react'
import { useCanvasStore } from '../store'
import { useLibraryStore } from '../store/library'
import { ImportDialog }    from './ImportDialog'
import { FlowDiffModal }   from './FlowDiffModal'
import { NewFlowChooser, SUPPRESS_KEY } from './NewFlowChooser'
import { generateAgentCard, downloadAgentCard, A2A_ENABLED } from '../services/a2a'
import { validateCrossRefs } from '../spec/validation'
import { api } from '../services/api'
import type { AdapterName, ValidationError } from '../spec/schema'
import { relativeTime } from '../store/library'

// §15 — runtime metadata for the chip dropdown
const RT_META: { value: AdapterName | ''; short: string; name: string; sub: string; color?: string }[] = [
  { value: '',                          short: 'All', name: 'All runtimes',       sub: 'No targeting — export to any adapter' },
  { value: 'langgraph',                 short: 'LG',  name: 'LangGraph',          sub: 'Python · graph state machines',     color: '#8b5cf6' },
  { value: 'crewai',                    short: 'CA',  name: 'CrewAI',             sub: 'Python · role-based crews',          color: '#db2777' },
  { value: 'mastra',                    short: 'MA',  name: 'Mastra',             sub: 'TypeScript · workflows + agents',    color: '#0ea5a0' },
  { value: 'microsoft_agent_framework', short: 'MS',  name: 'MS Agent Framework', sub: '.NET / Python · enterprise agents',  color: '#2563eb' },
]

// §13 — State pill: reflects draft/published state next to the flow name.
function StatePill({
  isDirty,
  publishedVersion,
  publishedAt,
}: {
  isDirty: boolean
  publishedVersion: number
  publishedAt: number | null
}) {
  const isPublished = !!publishedAt

  let cls = 'state-pill'
  let dot = <span className="state-pill__dot" />
  let label: string

  if (isDirty) {
    cls += ' state-pill--draft-unsaved'
    label = 'Draft (unsaved)'
  } else if (!isPublished) {
    cls += ' state-pill--draft-saved'
    label = 'Draft (saved)'
  } else {
    cls += ' state-pill--published'
    label = `Published v${publishedVersion} · ${relativeTime(publishedAt!)}`
  }

  return (
    <span className={cls} title={label}>
      {dot}
      {label}
    </span>
  )
}

export function Toolbar() {
  const {
    flowMeta, setFlowMeta, exportSpec, validate, loadFlow, newFlow,
    zodErrors, crossRefErrors, lastModifiedAt,
    openSettings, toggleProblems, isProblemsOpen,
    undo, redo, canUndo, canRedo,
    flowConfig,
    setCrossRefErrors,
    unifiedDeployment, unifiedDeploying,
    setUnifiedDeployment, setUnifiedDeploying,
    openRunDrawer,
    // §11 — Library page
    openLibrary,
  } = useCanvasStore()

  function setErrors(errors: ValidationError[]) { setCrossRefErrors(errors) }

  const { saveDraft, publishFlow, entries } = useLibraryStore()

  const [showImport,      setShowImport]      = useState(false)
  const [showDiff,        setShowDiff]        = useState(false)
  const [copied,          setCopied]          = useState(false)
  const [overflowOpen,    setOverflowOpen]    = useState(false)
  const [rtMenuOpen,      setRtMenuOpen]      = useState(false)
  const [chooserOpen,     setChooserOpen]     = useState(false)
  const [publishing,      setPublishing]      = useState(false)
  const overflowRef = useRef<HTMLDivElement>(null)
  const rtRef       = useRef<HTMLDivElement>(null)

  const errorCount     = (zodErrors?.issues.length ?? 0) + crossRefErrors.length
  const lastSavedEntry = entries.find((e) => e.id === flowMeta.id)
  const isDirty        = !lastSavedEntry || lastSavedEntry.draftSavedAt < lastModifiedAt
  const a2aEnabled     = A2A_ENABLED && (flowConfig?.a2a_config?.enabled === true)

  // §13 — publish state for pill
  const publishedVersion = lastSavedEntry?.publishedVersion ?? 0
  const publishedAt      = lastSavedEntry?.publishedAt ?? null

  // Click-outside to close overflow + runtime menus
  useEffect(() => {
    if (!overflowOpen && !rtMenuOpen) return
    function onDoc(e: MouseEvent) {
      if (overflowOpen && overflowRef.current && !overflowRef.current.contains(e.target as Node)) setOverflowOpen(false)
      if (rtMenuOpen   && rtRef.current       && !rtRef.current.contains(e.target as Node))       setRtMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [overflowOpen, rtMenuOpen])

  // ─── Actions ─────────────────────────────────────────────────────────────

  function handleExport() {
    const spec = exportSpec()
    if (!spec) { validate(); return }
    setErrors(validateCrossRefs(spec))
    const url = URL.createObjectURL(new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = `${spec.id}.json`; a.click()
    URL.revokeObjectURL(url)
  }

  // §13 — Save = save draft; replaces old saveFlow call
  function handleSave() {
    const spec = exportSpec()
    if (!spec) { validate(); return }
    setErrors(validateCrossRefs(spec))
    saveDraft(spec)
  }

  // §13 — Publish = validate + freeze version (+ deploy if A2A enabled)
  async function handlePublish() {
    const spec = exportSpec()
    if (!spec) { validate(); return }
    setErrors(validateCrossRefs(spec))
    if (!validate()) {
      if (!isProblemsOpen) toggleProblems()
      return
    }
    setPublishing(true)
    try {
      publishFlow(spec)
      if (flowConfig?.a2a_config?.enabled) {
        await handleDeploy()
      }
    } finally {
      setPublishing(false)
    }
  }

  function handleCopy() {
    const spec = exportSpec(); if (!spec) return
    navigator.clipboard.writeText(JSON.stringify(spec, null, 2))
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }

  function handleA2ACard() {
    const card = generateAgentCard({
      flowId:          flowMeta.id,
      flowName:        flowMeta.name,
      flowDescription: flowMeta.description,
      flowConfig,
    })
    if (!card) {
      alert('A2A is not enabled for this flow.\nSet flow_config.a2a_config.enabled = true in Flow Settings → Config.')
      return
    }
    downloadAgentCard(card, 'agent.json')
  }

  async function handleDeploy() {
    if (unifiedDeploying) return
    if (!validate()) {
      if (!isProblemsOpen) toggleProblems()
      return
    }
    setUnifiedDeploying(true)
    try {
      const result = await api.deploy.unified(flowMeta.id)
      setUnifiedDeployment({
        flow_id:       result.flow_id,
        rest_url:      result.rest_url,
        mcp_url:       result.mcp_url,
        a2a_url:       result.a2a_url,
        shareable_url: result.shareable_url,
        mcp_manifest:  result.mcp_manifest,
        deployed_at:   result.deployed_at,
      })
    } catch (err) {
      alert(`Deploy failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setUnifiedDeploying(false)
    }
  }

  function handleRuntimeChange(val: AdapterName | '') {
    setFlowMeta({
      runtimeHints: {
        ...flowMeta.runtimeHints,
        preferred_adapter: val || undefined,
      },
    })
  }

  function handleRun() { openRunDrawer() }

  // §8 — New button: show chooser unless suppressed
  function handleNewClick() {
    if (isDirty && !window.confirm('Discard unsaved changes and start a new flow?')) return
    if (localStorage.getItem(SUPPRESS_KEY) === '1') {
      newFlow()
    } else {
      setChooserOpen(true)
    }
  }

  return (
    <>
      <div className="toolbar">
        <span className="toolbar__logo">itsharness</span>
        <div className="toolbar__divider" />

        <input
          className="toolbar__flow-name"
          value={flowMeta.name}
          onChange={(e) => setFlowMeta({ name: e.target.value })}
          placeholder="Flow name"
          spellCheck={false}
        />

        {/* §13 — State pill replaces the bare amber dot */}
        <StatePill
          isDirty={isDirty}
          publishedVersion={publishedVersion}
          publishedAt={publishedAt}
        />

        <div className="toolbar__divider" />

        {/* Undo / redo */}
        <button className="btn btn--icon" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" style={{ opacity: canUndo ? 1 : 0.35 }}>
          <Undo2 size={13} />
        </button>
        <button className="btn btn--icon" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" style={{ opacity: canRedo ? 1 : 0.35 }}>
          <Redo2 size={13} />
        </button>

        <div className="toolbar__divider" />

        {/* Validate */}
        <button className="btn" onClick={() => { validate(); toggleProblems() }} title="Validate spec">
          {errorCount > 0
            ? <><AlertCircle size={13} style={{ color: '#ef4444' }} />{errorCount} error{errorCount !== 1 ? 's' : ''}</>
            : <><CheckCircle size={13} style={{ color: '#22c55e' }} />valid</>}
        </button>

        {/* §15 — Runtime targeting chip */}
        <div className="rt-chip-wrap" ref={rtRef}>
          {(() => {
            const cur  = flowMeta.runtimeHints?.preferred_adapter ?? ''
            const meta = RT_META.find((m) => m.value === cur) ?? RT_META[0]
            return (
              <>
                <button
                  className="rt-chip"
                  data-rt={cur || 'all'}
                  onClick={() => setRtMenuOpen((v) => !v)}
                  title="Target runtime — compat highlights on every node update live"
                  aria-haspopup="menu"
                  aria-expanded={rtMenuOpen}
                >
                  <span className="rt-chip__label">Targeting</span>
                  {meta.color
                    ? <span className="rt-chip__glyph" style={{ background: meta.color }}>{meta.short}</span>
                    : <span className="rt-chip__glyph" style={{ background: 'var(--border-hi)', color: 'var(--text-primary)' }}>·</span>}
                  <span className="rt-chip__value">{meta.name}</span>
                  <span className="rt-chip__caret"><ChevronDown size={11} /></span>
                </button>
                {rtMenuOpen && (
                  <div className="rt-menu" role="menu">
                    {RT_META.map((r) => (
                      <div
                        key={r.value}
                        className={`rt-menu__item ${r.value === cur ? 'rt-menu__item--active' : ''}`}
                        onClick={() => { handleRuntimeChange(r.value); setRtMenuOpen(false) }}
                      >
                        {r.color
                          ? <span className="rt-chip__glyph" style={{ background: r.color }}>{r.short}</span>
                          : <span className="rt-chip__glyph" style={{ background: 'var(--border-hi)', color: 'var(--text-primary)' }}>·</span>}
                        <div style={{ flex: 1 }}>
                          <div className="rt-menu__name">{r.name}</div>
                          <div className="rt-menu__sub">{r.sub}</div>
                        </div>
                        {r.value === cur && <Check size={12} style={{ color: 'var(--blue)' }} />}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )
          })()}
        </div>

        <div className="toolbar__spacer" />

        {/* Settings */}
        <button className="btn btn--icon" onClick={() => openSettings()} title="Flow settings">
          <Settings size={13} />
        </button>

        {/* §11 — Library (opens full-screen page) */}
        <button className="btn btn--icon" onClick={openLibrary} title="My flows">
          <FolderOpen size={13} />
        </button>

        {/* §13 — Save (draft) */}
        <button
          className="btn"
          onClick={handleSave}
          title="Save draft to library"
          style={{ gap: 5, color: isDirty ? 'var(--text-primary)' : 'var(--text-tertiary)' }}
        >
          <Save size={12} />
          {isDirty ? 'Save' : 'Saved'}
        </button>

        {/* §13 — Publish (freeze version; accent purple) */}
        <button
          className="btn btn--accent"
          onClick={handlePublish}
          disabled={publishing}
          title="Publish — freezes a version (and deploys if A2A is enabled)"
          style={{ gap: 5 }}
        >
          <Rocket size={12} />
          {publishing ? 'Publishing…' : 'Publish'}
        </button>

        {/* §8 — New */}
        <button className="btn" onClick={handleNewClick} title="New flow">New</button>

        {/* §1 · Overflow menu */}
        <div className="overflow-menu-wrap" ref={overflowRef}>
          <button
            className="btn btn--icon"
            onClick={() => setOverflowOpen((v) => !v)}
            title="More actions"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
          >
            <MoreVertical size={13} />
          </button>
          {overflowOpen && (
            <div className="overflow-menu" role="menu">
              <button className="overflow-menu__item" onClick={() => { handleExport(); setOverflowOpen(false) }}>
                <Download size={13} /> Export JSON
              </button>
              <button className="overflow-menu__item" onClick={() => { handleCopy(); setOverflowOpen(false) }}>
                <Copy size={13} /> {copied ? 'Copied!' : 'Copy spec'}
              </button>
              <button className="overflow-menu__item" onClick={() => { setShowImport(true); setOverflowOpen(false) }}>
                <Upload size={13} /> Import…
              </button>
              {entries.length >= 1 && (
                <>
                  <div className="overflow-menu__sep" />
                  <button className="overflow-menu__item" onClick={() => { setShowDiff(true); setOverflowOpen(false) }}>
                    <GitCompare size={13} /> Compare versions
                  </button>
                </>
              )}
              {A2A_ENABLED && (
                <>
                  <div className="overflow-menu__sep" />
                  <button
                    className="overflow-menu__item"
                    onClick={() => { handleA2ACard(); setOverflowOpen(false) }}
                    disabled={!a2aEnabled}
                    title={a2aEnabled ? 'Download A2A AgentCard JSON' : 'A2A not configured for this flow'}
                  >
                    <Share2 size={13} /> Download A2A AgentCard
                  </button>
                  <button
                    className="overflow-menu__item"
                    onClick={() => { handleDeploy(); setOverflowOpen(false) }}
                    disabled={unifiedDeploying}
                    title={unifiedDeployment ? 'Re-deploy (REST + MCP + A2A)' : 'Deploy flow as REST + MCP + A2A'}
                  >
                    {unifiedDeploying
                      ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
                      : <Rocket size={13} />}
                    {unifiedDeploying ? 'Deploying…' : unifiedDeployment ? 'Re-deploy' : 'Deploy (REST + MCP + A2A)'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Run — primary CTA */}
        <button
          className="btn btn--primary"
          onClick={handleRun}
          title="Run flow"
          style={{ gap: 5 }}
        >
          <Play size={11} fill="currentColor" stroke="none" />
          Run
        </button>
      </div>

      {showImport && <ImportDialog onClose={() => setShowImport(false)} onLoad={(spec) => { loadFlow(spec); setShowImport(false) }} />}
      {showDiff   && <FlowDiffModal onClose={() => setShowDiff(false)} />}

      {/* §8 — New flow chooser */}
      <NewFlowChooser open={chooserOpen} onClose={() => setChooserOpen(false)} />
    </>
  )
}
