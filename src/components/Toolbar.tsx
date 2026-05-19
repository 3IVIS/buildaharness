import { useRef, useState } from 'react'
import {
  CheckCircle, AlertCircle, Settings, Undo2, Redo2,
  LayoutDashboard, Save, FolderOpen, GitCompare, Share2, Loader2, Rocket,
} from 'lucide-react'
import { useCanvasStore } from '../store'
import { useLibraryStore } from '../store/library'
import { ImportDialog }    from './ImportDialog'
import { FlowLibraryPanel } from './FlowLibraryPanel'
import { FlowDiffModal }   from './FlowDiffModal'
import { generateAgentCard, downloadAgentCard, A2A_ENABLED } from '../services/a2a'
import { validateCrossRefs } from '../spec/validation'
import { api } from '../services/api'
import type { AdapterName, ValidationError } from '../spec/schema'

const RUNTIME_OPTIONS: { value: AdapterName | ''; label: string }[] = [
  { value: '',                        label: 'All runtimes' },
  { value: 'langgraph',               label: 'LangGraph'    },
  { value: 'crewai',                  label: 'CrewAI'       },
  { value: 'mastra',                  label: 'Mastra'       },
  { value: 'microsoft_agent_framework', label: 'MS Agent Framework' },
]

export function Toolbar() {
  const {
    flowMeta, setFlowMeta, exportSpec, validate, loadFlow, newFlow,
    zodErrors, crossRefErrors, lastModifiedAt,
    openSettings, toggleProblems, isProblemsOpen,
    undo, redo, canUndo, canRedo,
    autoLayout,
    flowConfig,
    setCrossRefErrors,
    a2aDeployment, a2aDeploying,
    setA2ADeployment, setA2ADeploying,
  } = useCanvasStore()

  // Helper: push cross-ref errors into the store without calling exportSpec() again.
  function setErrors(errors: ValidationError[]) {
    setCrossRefErrors(errors)
  }

  const { saveFlow, entries } = useLibraryStore()

  const [showImport,  setShowImport]  = useState(false)
  const [showLibrary, setShowLibrary] = useState(false)
  const [showDiff,    setShowDiff]    = useState(false)
  const [copied,      setCopied]      = useState(false)

  const errorCount = (zodErrors?.issues.length ?? 0) + crossRefErrors.length

  const lastSavedEntry = entries.find((e) => e.id === flowMeta.id)
  const isDirty = !lastSavedEntry || lastSavedEntry.savedAt < lastModifiedAt

  // Show A2A button if feature is enabled and the flow has a2a_config.enabled
  const a2aEnabled = A2A_ENABLED && (flowConfig?.a2a_config?.enabled === true)

  function handleExport() {
    const spec = exportSpec()
    if (!spec) { validate(); return }   // exportSpec sets zodErrors; validate shows them
    // Run cross-ref validation on the already-built spec — don't call exportSpec() again.
    const errors = validateCrossRefs(spec)
    setErrors(errors)
    const url = URL.createObjectURL(new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = `${spec.id}.json`; a.click()
    URL.revokeObjectURL(url)
  }

  function handleSaveToLibrary() {
    const spec = exportSpec()
    if (!spec) { validate(); return }
    const errors = validateCrossRefs(spec)
    setErrors(errors)
    saveFlow(spec)
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
    if (a2aDeploying) return

    // validate() calls exportSpec() internally and populates zodErrors if there
    // are Zod issues.  If validation fails, open the Problems panel so the user
    // can see what needs fixing before deploying.
    if (!validate()) {
      if (!isProblemsOpen) toggleProblems()
      return
    }

    const a2aCfg = flowConfig?.a2a_config
    if (!a2aCfg?.enabled) {
      alert(
        'A2A is not enabled for this flow.\n' +
        'Enable it in Flow Settings → Config → A2A exposure.'
      )
      return
    }

    setA2ADeploying(true)
    try {
      const result = await api.a2a.deploy(flowMeta.id)
      setA2ADeployment({
        flow_id:      result.flow_id,
        endpoint_url: result.endpoint_url,
        agent_card:   result.agent_card,
        deployed_at:  result.deployed_at,
      })
    } catch (err) {
      alert(`Deploy failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setA2ADeploying(false)
    }
  }

  function handleRuntimeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value as AdapterName | ''
    setFlowMeta({
      runtimeHints: {
        ...flowMeta.runtimeHints,
        preferred_adapter: val || undefined,
      },
    })
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

        {isDirty && (
          <div title="Unsaved changes" style={{ width: 6, height: 6, borderRadius: '50%', background: '#f59e0b', flexShrink: 0, marginLeft: -2 }} />
        )}

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

        <div className="toolbar__divider" />

        {/* Runtime selector */}
        <select
          className="runtime-select"
          value={flowMeta.runtimeHints?.preferred_adapter ?? ''}
          onChange={handleRuntimeChange}
          title="Target runtime — pins compat highlighting and routes export"
        >
          {RUNTIME_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>

        <div className="toolbar__spacer" />

        {/* Diff — only shown when there are saved versions to compare */}
        {entries.length >= 1 && (
          <button className="btn btn--icon" onClick={() => setShowDiff(true)} title="Compare versions">
            <GitCompare size={13} />
          </button>
        )}

        {/* A2A buttons — only shown when feature-flagged on */}
        {A2A_ENABLED && (
          <>
            {/* Download AgentCard JSON */}
            <button
              className="btn btn--icon"
              onClick={handleA2ACard}
              title={a2aEnabled ? 'Download A2A AgentCard' : 'A2A not configured for this flow'}
              style={{ opacity: a2aEnabled ? 1 : 0.4 }}
            >
              <Share2 size={13} />
            </button>

            {/* Deploy / re-deploy as A2A agent */}
            <button
              className="btn"
              onClick={handleDeploy}
              disabled={!a2aEnabled || a2aDeploying}
              title={
                !a2aEnabled    ? 'Enable A2A in Flow Settings → Config first' :
                a2aDeployment  ? 'Re-deploy agent (update endpoint)' :
                                 'Deploy flow as A2A agent'
              }
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                opacity: a2aEnabled ? 1 : 0.4,
                color: a2aDeployment ? 'var(--rt-full)' : undefined,
              }}
            >
              {a2aDeploying
                ? <Loader2 size={12} strokeWidth={2} style={{ animation: 'spin 1s linear infinite' }} />
                : <Rocket size={12} strokeWidth={2} />
              }
              {a2aDeploying ? 'Deploying…' : a2aDeployment ? 'Deployed' : 'Deploy'}
            </button>
          </>
        )}

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

        <button
          className="btn"
          onClick={() => {
            if (isDirty && !window.confirm('Discard unsaved changes and start a new flow?')) return
            newFlow()
          }}
          title="New flow"
        >New</button>
        <button className="btn" onClick={() => setShowImport(true)} title="Load flow from JSON">Import</button>
        <button className="btn" onClick={handleCopy} title="Copy spec JSON" style={{ color: copied ? 'var(--green)' : undefined }}>{copied ? 'Copied!' : 'Copy spec'}</button>
        <button className="btn btn--primary" onClick={handleExport} title="Download spec JSON">Export JSON</button>
      </div>

      {showImport  && <ImportDialog onClose={() => setShowImport(false)} onLoad={(spec) => { loadFlow(spec); setShowImport(false) }} />}
      {showLibrary && <FlowLibraryPanel onClose={() => setShowLibrary(false)} />}
      {showDiff    && <FlowDiffModal onClose={() => setShowDiff(false)} />}
    </>
  )
}
