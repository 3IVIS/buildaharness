import { useState } from 'react'
import { X, Plus, Trash2 } from 'lucide-react'
import { useCanvasStore, type SettingsTab } from '../store'
import type { AgentDef, MemoryStoreDef, ToolDef, StateField } from '../spec/schema'
import type { AdapterName } from '../spec/schema'

// ─── Shared primitives ────────────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label className="field__label">{label}{hint && <span className="field__label-hint">{hint}</span>}</label>
      {children}
    </div>
  )
}
function Input({ value, onChange, mono, placeholder, disabled }: { value: string; onChange?: (v: string) => void; mono?: boolean; placeholder?: string; disabled?: boolean }) {
  return <input className={`field__input${mono ? ' field__input--mono' : ''}`} value={value} onChange={(e) => onChange?.(e.target.value)} placeholder={placeholder} disabled={disabled} />
}
function Textarea({ value, onChange, placeholder, rows = 3 }: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  return <textarea className="field__textarea" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows} />
}
function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return <select className="field__select" value={value} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
}
function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div className="toggle" onClick={() => onChange(!on)}>
      <div className={`toggle__track${on ? ' on' : ''}`}><div className="toggle__knob" /></div>
      <span className="toggle__label">{label}</span>
    </div>
  )
}
function SectionHead({ children }: { children: React.ReactNode }) {
  return <div className="section-head" style={{ marginTop: 8 }}>{children}</div>
}
function RowCard({ children, onDelete }: { children: React.ReactNode; onDelete: () => void }) {
  return (
    <div style={{ background: 'var(--bg-overlay)', borderRadius: 6, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, position: 'relative' }}>
      <button onClick={onDelete} style={{ position: 'absolute', top: 6, right: 6, background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}><Trash2 size={12} /></button>
      {children}
    </div>
  )
}
function AddBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return <button className="btn" style={{ alignSelf: 'flex-start', marginTop: 4 }} onClick={onClick}><Plus size={12} /> {label}</button>
}

// ─── Tab: Meta ────────────────────────────────────────────────────────────────

const ADAPTERS: AdapterName[] = ['langgraph', 'crewai', 'mastra', 'microsoft_agent_framework']
const ADAPTER_LABELS: Record<AdapterName, string> = { langgraph: 'LangGraph', crewai: 'CrewAI', mastra: 'Mastra', microsoft_agent_framework: 'MS Agent Framework' }

function MetaTab() {
  const { flowMeta, setFlowMeta, modelDefaults, setModelDefaults } = useCanvasStore()
  const compat = flowMeta.runtimeHints.compatible ?? []
  function toggleCompat(a: AdapterName) {
    const next = compat.includes(a) ? compat.filter((c) => c !== a) : [...compat, a]
    setFlowMeta({ runtimeHints: { ...flowMeta.runtimeHints, compatible: next } })
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <SectionHead>Flow identity</SectionHead>
      <div className="field__row">
        <Field label="Flow ID" hint="kebab-case"><Input value={flowMeta.id} onChange={(v) => setFlowMeta({ id: v })} mono /></Field>
        <Field label="Name"><Input value={flowMeta.name} onChange={(v) => setFlowMeta({ name: v })} /></Field>
      </div>
      <Field label="Description"><Textarea value={flowMeta.description} onChange={(v) => setFlowMeta({ description: v })} placeholder="What does this flow do?" rows={2} /></Field>

      <SectionHead>Runtime</SectionHead>
      <Field label="Preferred adapter">
        <Select value={flowMeta.runtimeHints.preferred_adapter ?? 'langgraph'} onChange={(v) => setFlowMeta({ runtimeHints: { ...flowMeta.runtimeHints, preferred_adapter: v as AdapterName } })}
          options={ADAPTERS.map((a) => ({ value: a, label: ADAPTER_LABELS[a] }))} />
      </Field>
      <Field label="Compatible runtimes">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
          {ADAPTERS.map((a) => (
            <label key={a} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 12, color: compat.includes(a) ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
              <input type="checkbox" checked={compat.includes(a)} onChange={() => toggleCompat(a)} style={{ accentColor: '#3b82f6' }} />
              {ADAPTER_LABELS[a]}
            </label>
          ))}
        </div>
      </Field>

      <SectionHead>Model defaults</SectionHead>
      <div className="field__row">
        <Field label="Default model"><Input value={(modelDefaults.model as string) ?? ''} onChange={(v) => setModelDefaults({ ...modelDefaults, model: v })} mono placeholder="gpt-4o" /></Field>
        <Field label="Embedding model"><Input value={(modelDefaults.embedding_model as string) ?? ''} onChange={(v) => setModelDefaults({ ...modelDefaults, embedding_model: v })} mono placeholder="text-embedding-3-small" /></Field>
      </div>
    </div>
  )
}

// ─── Tab: State schema ────────────────────────────────────────────────────────

const FIELD_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object']
const REDUCERS    = ['replace', 'append', 'merge', 'custom']

function StateTab() {
  const { stateSchema, setStateSchema } = useCanvasStore()
  const props     = stateSchema?.properties ?? {}
  const required  = stateSchema?.required ?? []
  const fieldKeys = Object.keys(props)

  function setField(key: string, field: StateField) {
    setStateSchema({ type: 'object', properties: { ...props, [key]: field }, required })
  }
  function renameField(oldKey: string, newKey: string) {
    if (!newKey || newKey === oldKey) return
    const next: Record<string, StateField> = {}
    for (const k of fieldKeys) next[k === oldKey ? newKey : k] = props[k]
    setStateSchema({ type: 'object', properties: next, required: required.map((r) => r === oldKey ? newKey : r) })
  }
  function removeField(key: string) {
    const next = { ...props }; delete next[key]
    setStateSchema({ type: 'object', properties: next, required: required.filter((r) => r !== key) })
  }
  function addField() {
    const key = `field_${fieldKeys.length + 1}`
    setField(key, { type: 'string', description: '' })
  }
  function toggleRequired(key: string) {
    const next = required.includes(key) ? required.filter((r) => r !== key) : [...required, key]
    setStateSchema({ type: 'object', properties: props, required: next })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
        Defines the shape of the shared state object passed between nodes. Each field maps to a key in the flow state.
      </div>
      {fieldKeys.map((key) => {
        const f = props[key]
        const type = Array.isArray(f.type) ? f.type[0] : f.type
        return (
          <RowCard key={key} onDelete={() => removeField(key)}>
            <div className="field__row">
              <Field label="Field name">
                <Input value={key} onChange={(v) => renameField(key, v)} mono placeholder="my_field" />
              </Field>
              <Field label="Type">
                <Select value={type as string} onChange={(v) => setField(key, { ...f, type: v as StateField['type'] })}
                  options={FIELD_TYPES.map((t) => ({ value: t, label: t }))} />
              </Field>
            </div>
            <div className="field__row">
              <Field label="Reducer">
                <Select value={f.reducer ?? 'replace'} onChange={(v) => setField(key, { ...f, reducer: v as 'replace' | 'append' | 'merge' | 'custom' })}
                  options={REDUCERS.map((r) => ({ value: r, label: r }))} />
              </Field>
              <Field label="Required" hint="">
                <div style={{ paddingTop: 6 }}>
                  <Toggle on={required.includes(key)} onChange={() => toggleRequired(key)} label={required.includes(key) ? 'yes' : 'no'} />
                </div>
              </Field>
            </div>
            <Field label="Description">
              <Input value={f.description ?? ''} onChange={(v) => setField(key, { ...f, description: v })} placeholder="What is this field for?" />
            </Field>
          </RowCard>
        )
      })}
      <AddBtn label="Add field" onClick={addField} />
    </div>
  )
}

// ─── Tab: Memory stores ───────────────────────────────────────────────────────

const STORE_BACKENDS = ['in_memory', 'postgres', 'sqlite', 'redis', 'upstash', 'qdrant', 'pinecone', 'azure_ai_search']
const STORE_TYPES    = ['key_value', 'vector', 'hybrid']
const STORE_SCOPES   = ['thread', 'resource', 'global']

function MemoryTab() {
  const { memoryStores, setMemoryStores } = useCanvasStore()
  const ids = Object.keys(memoryStores)

  function upsertStore(id: string, store: MemoryStoreDef) {
    setMemoryStores({ ...memoryStores, [id]: store })
  }
  function renameStore(oldId: string, newId: string) {
    if (!newId || newId === oldId) return
    const next: Record<string, MemoryStoreDef> = {}
    for (const k of ids) next[k === oldId ? newId : k] = memoryStores[k]
    setMemoryStores(next)
  }
  function removeStore(id: string) {
    const next = { ...memoryStores }; delete next[id]; setMemoryStores(next)
  }
  function addStore() {
    const id = `store_${ids.length + 1}`
    upsertStore(id, { type: 'key_value', backend: 'in_memory', scope: 'thread' })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
        Named memory stores referenced by memory_read and memory_write nodes.
      </div>
      {ids.map((id) => {
        const s = memoryStores[id]
        return (
          <RowCard key={id} onDelete={() => removeStore(id)}>
            <div className="field__row">
              <Field label="Store ID"><Input value={id} onChange={(v) => renameStore(id, v)} mono /></Field>
              <Field label="Type"><Select value={s.type} onChange={(v) => upsertStore(id, { ...s, type: v as MemoryStoreDef['type'] })} options={STORE_TYPES.map((t) => ({ value: t, label: t }))} /></Field>
            </div>
            <div className="field__row">
              <Field label="Backend"><Select value={s.backend ?? 'in_memory'} onChange={(v) => upsertStore(id, { ...s, backend: v as MemoryStoreDef['backend'] })} options={STORE_BACKENDS.map((b) => ({ value: b, label: b }))} /></Field>
              <Field label="Scope"><Select value={s.scope ?? 'thread'} onChange={(v) => upsertStore(id, { ...s, scope: v as MemoryStoreDef['scope'] })} options={STORE_SCOPES.map((sc) => ({ value: sc, label: sc }))} /></Field>
            </div>
            {s.type !== 'key_value' && (
              <div className="field__row">
                <Field label="Embedding model"><Input value={s.embedding_model ?? ''} onChange={(v) => upsertStore(id, { ...s, embedding_model: v })} mono placeholder="text-embedding-3-small" /></Field>
                <Field label="Dimensions"><Input value={String(s.dimensions ?? '')} onChange={(v) => upsertStore(id, { ...s, dimensions: parseInt(v) || undefined })} mono placeholder="1536" /></Field>
              </div>
            )}
            <div className="field__row">
              <Field label="Connection env" hint="env var name"><Input value={s.connection_env ?? ''} onChange={(v) => upsertStore(id, { ...s, connection_env: v })} mono placeholder="QDRANT_URL" /></Field>
              <Field label="Namespace"><Input value={s.namespace ?? ''} onChange={(v) => upsertStore(id, { ...s, namespace: v })} mono placeholder="optional" /></Field>
            </div>
            <Field label="Description"><Input value={s.description ?? ''} onChange={(v) => upsertStore(id, { ...s, description: v })} placeholder="What is this store for?" /></Field>
          </RowCard>
        )
      })}
      <AddBtn label="Add store" onClick={addStore} />
    </div>
  )
}

// ─── Tab: Tools ───────────────────────────────────────────────────────────────

const TOOL_SOURCES = ['npm', 'local', 'mcp']

function ToolsTab() {
  const { tools, setTools } = useCanvasStore()
  const ids = Object.keys(tools)

  function upsertTool(id: string, tool: ToolDef) { setTools({ ...tools, [id]: tool }) }
  function renameTool(oldId: string, newId: string) {
    if (!newId || newId === oldId) return
    const next: Record<string, ToolDef> = {}
    for (const k of ids) next[k === oldId ? newId : k] = tools[k]
    setTools(next)
  }
  function removeTool(id: string) { const n = { ...tools }; delete n[id]; setTools(n) }
  function addTool() {
    const id = `tool_${ids.length + 1}`
    upsertTool(id, { tool_ref: '', source: 'npm', description: '' })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
        Named tools referenced by tool_invoke nodes and assigned to agents.
      </div>
      {ids.map((id) => {
        const t = tools[id]
        const src = t.source ?? 'npm'
        return (
          <RowCard key={id} onDelete={() => removeTool(id)}>
            <div className="field__row">
              <Field label="Tool ID"><Input value={id} onChange={(v) => renameTool(id, v)} mono /></Field>
              <Field label="Source"><Select value={src} onChange={(v) => upsertTool(id, { ...t, source: v as ToolDef['source'] })} options={TOOL_SOURCES.map((s) => ({ value: s, label: s }))} /></Field>
            </div>
            <Field label={src === 'npm' ? 'npm package ref' : src === 'mcp' ? 'MCP tool ref' : 'Local path'} hint="e.g. @langchain/community/tools/TavilySearchResults">
              <Input value={t.tool_ref} onChange={(v) => upsertTool(id, { ...t, tool_ref: v })} mono placeholder={src === 'npm' ? '@scope/pkg/ExportName' : src === 'mcp' ? 'tool-name' : './path/to/tool.ts'} />
            </Field>
            {src === 'mcp' && (
              <Field label="MCP server URL"><Input value={t.mcp_server_url ?? ''} onChange={(v) => upsertTool(id, { ...t, mcp_server_url: v })} mono placeholder="https://mcp.example.com/sse" /></Field>
            )}
            <Field label="Description"><Input value={t.description ?? ''} onChange={(v) => upsertTool(id, { ...t, description: v })} placeholder="What does this tool do?" /></Field>
          </RowCard>
        )
      })}
      <AddBtn label="Add tool" onClick={addTool} />
    </div>
  )
}

// ─── Tab: Agents ──────────────────────────────────────────────────────────────

function AgentsTab() {
  const { agents, setAgents, tools } = useCanvasStore()
  const toolIds = Object.keys(tools)

  function upsertAgent(idx: number, agent: AgentDef) {
    setAgents(agents.map((a, i) => i === idx ? agent : a))
  }
  function removeAgent(idx: number) { setAgents(agents.filter((_, i) => i !== idx)) }
  function addAgent() {
    setAgents([...agents, { id: `agent_${agents.length + 1}`, role: '', backstory: '', goal: '', max_iter: 10 }])
  }
  function toggleTool(idx: number, tool: string) {
    const a = agents[idx]
    const current = a.tools ?? []
    upsertAgent(idx, { ...a, tools: current.includes(tool) ? current.filter((t) => t !== tool) : [...current, tool] })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
        Agent definitions referenced by agent_role and agent_debate nodes.
      </div>
      {agents.map((a, i) => (
        <RowCard key={i} onDelete={() => removeAgent(i)}>
          <div className="field__row">
            <Field label="Agent ID"><Input value={a.id} onChange={(v) => upsertAgent(i, { ...a, id: v })} mono /></Field>
            <Field label="Role"><Input value={a.role ?? ''} onChange={(v) => upsertAgent(i, { ...a, role: v })} placeholder="Senior Researcher" /></Field>
          </div>
          <Field label="Goal"><Input value={a.goal ?? ''} onChange={(v) => upsertAgent(i, { ...a, goal: v })} placeholder="What should this agent accomplish?" /></Field>
          <Field label="Backstory"><Textarea value={a.backstory ?? ''} onChange={(v) => upsertAgent(i, { ...a, backstory: v })} placeholder="Background context for the agent's persona" rows={2} /></Field>
          <div className="field__row">
            <Field label="Max iterations">
              <Input value={String(a.max_iter ?? 10)} onChange={(v) => upsertAgent(i, { ...a, max_iter: parseInt(v) || 10 })} mono />
            </Field>
            <Field label="Allow delegation">
              <div style={{ paddingTop: 6 }}>
                <Toggle on={a.allow_delegation ?? false} onChange={(v) => upsertAgent(i, { ...a, allow_delegation: v })} label={a.allow_delegation ? 'yes' : 'no'} />
              </div>
            </Field>
          </div>
          {toolIds.length > 0 && (
            <Field label="Tools">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                {toolIds.map((tid) => (
                  <label key={tid} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 11, color: (a.tools ?? []).includes(tid) ? 'var(--text-primary)' : 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                    <input type="checkbox" checked={(a.tools ?? []).includes(tid)} onChange={() => toggleTool(i, tid)} style={{ accentColor: '#3b82f6' }} />
                    {tid}
                  </label>
                ))}
              </div>
            </Field>
          )}
          <Field label="Memory" hint="short-term / long-term / entity / user">
            <div style={{ display: 'flex', gap: 12 }}>
              {(['short_term', 'long_term', 'entity', 'user'] as const).map((k) => {
                const mc = a.memory_config ?? { short_term: false, long_term: false, entity: false, user: false }
                return (
                  <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 11, color: mc[k] ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
                    <input type="checkbox" checked={mc[k]} onChange={() => upsertAgent(i, { ...a, memory_config: { ...mc, [k]: !mc[k] } })} style={{ accentColor: '#3b82f6' }} />
                    {k.replace('_', '-')}
                  </label>
                )
              })}
            </div>
          </Field>
        </RowCard>
      ))}
      <AddBtn label="Add agent" onClick={addAgent} />
    </div>
  )
}

// ─── Tab: Flow config ─────────────────────────────────────────────────────────

function ConfigTab() {
  const { flowConfig, setFlowConfig } = useCanvasStore()
  const cp  = flowConfig.checkpoint  ?? { enabled: false }
  const str = flowConfig.streaming   ?? { enabled: false }
  const tel = flowConfig.telemetry   ?? { enabled: false }
  const a2a = flowConfig.a2a_config  ?? { enabled: false }
  const [a2aSkillId,  setA2aSkillId]  = useState('')
  const [a2aSkillName, setA2aSkillName] = useState('')
  const [a2aSkillDesc, setA2aSkillDesc] = useState('')

  const upd = (patch: Partial<typeof flowConfig>) => setFlowConfig({ ...flowConfig, ...patch })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Checkpoint */}
      <SectionHead>Checkpoint</SectionHead>
      <Toggle on={cp.enabled} onChange={(v) => upd({ checkpoint: { ...cp, enabled: v } })} label="Enable checkpointing" />
      {cp.enabled && (
        <>
          <div className="field__row">
            <Field label="Backend">
              <Select value={cp.backend ?? 'in_memory'} onChange={(v) => upd({ checkpoint: { ...cp, backend: v as typeof cp.backend } })}
                options={[{ value: 'in_memory', label: 'in_memory' }, { value: 'sqlite', label: 'sqlite' }, { value: 'postgres', label: 'postgres' }, { value: 'redis', label: 'redis' }]} />
            </Field>
            <Field label="Namespace"><Input value={cp.namespace ?? ''} onChange={(v) => upd({ checkpoint: { ...cp, namespace: v } })} mono placeholder="optional" /></Field>
          </div>
          <Field label="Connection env var" hint="for postgres/redis">
            <Input value={cp.connection_env ?? ''} onChange={(v) => upd({ checkpoint: { ...cp, connection_env: v } })} mono placeholder="DATABASE_URL" />
          </Field>
        </>
      )}

      {/* Streaming */}
      <SectionHead>Streaming</SectionHead>
      <Toggle on={str.enabled} onChange={(v) => upd({ streaming: { ...str, enabled: v } })} label="Enable streaming" />
      {str.enabled && (
        <Field label="Mode">
          <Select value={str.mode ?? 'updates'} onChange={(v) => upd({ streaming: { ...str, mode: v as typeof str.mode } })}
            options={[{ value: 'updates', label: 'updates (state diffs)' }, { value: 'tokens', label: 'tokens (LLM stream)' }, { value: 'debug', label: 'debug (everything)' }]} />
        </Field>
      )}

      {/* Telemetry */}
      <SectionHead>Telemetry</SectionHead>
      <Toggle on={tel.enabled} onChange={(v) => upd({ telemetry: { ...tel, enabled: v } })} label="Enable telemetry" />
      {tel.enabled && (
        <>
          <div className="field__row">
            <Field label="Provider">
              <Select value={tel.provider ?? 'langsmith'} onChange={(v) => upd({ telemetry: { ...tel, provider: v as typeof tel.provider } })}
                options={[{ value: 'langsmith', label: 'LangSmith' }, { value: 'langfuse', label: 'Langfuse' }, { value: 'otel', label: 'OpenTelemetry' }, { value: 'azure_monitor', label: 'Azure Monitor' }]} />
            </Field>
            <Field label="Project name"><Input value={tel.project ?? ''} onChange={(v) => upd({ telemetry: { ...tel, project: v } })} placeholder="my-project" /></Field>
          </div>
          <Field label="Endpoint env var" hint="overrides default">
            <Input value={tel.endpoint_env ?? ''} onChange={(v) => upd({ telemetry: { ...tel, endpoint_env: v } })} mono placeholder="LANGFUSE_HOST" />
          </Field>
          <Toggle on={tel.trace_all_nodes ?? true} onChange={(v) => upd({ telemetry: { ...tel, trace_all_nodes: v } })} label="Trace all nodes" />
        </>
      )}

      {/* Process type */}
      <SectionHead>Process type</SectionHead>
      <Field label="Crew process type">
        <Select value={flowConfig.process_type ?? 'sequential'} onChange={(v) => upd({ process_type: v as typeof flowConfig.process_type })}
          options={[{ value: 'sequential', label: 'sequential' }, { value: 'hierarchical', label: 'hierarchical (manager agent)' }, { value: 'consensual', label: 'consensual (group decision)' }]} />
      </Field>
      {flowConfig.process_type === 'hierarchical' && (
        <Field label="Manager agent ref"><Input value={flowConfig.manager_agent_ref ?? ''} onChange={(v) => upd({ manager_agent_ref: v })} mono placeholder="manager" /></Field>
      )}

      {/* A2A */}
      <SectionHead>A2A exposure</SectionHead>
      <Toggle on={a2a.enabled} onChange={(v) => upd({ a2a_config: { ...a2a, enabled: v } })} label="Expose as A2A agent" />
      {a2a.enabled && (
        <>
          <div className="field__row">
            <Field label="Agent name"><Input value={a2a.agent_name ?? ''} onChange={(v) => upd({ a2a_config: { ...a2a, agent_name: v } })} placeholder="My Agent" /></Field>
            <Field label="Version"><Input value={a2a.version ?? '1.0.0'} onChange={(v) => upd({ a2a_config: { ...a2a, version: v } })} mono /></Field>
          </div>
          <Field label="Description"><Textarea value={a2a.agent_description ?? ''} onChange={(v) => upd({ a2a_config: { ...a2a, agent_description: v } })} rows={2} /></Field>
          <Field label="Authentication">
            <Select value={a2a.authentication ?? 'api_key'} onChange={(v) => upd({ a2a_config: { ...a2a, authentication: v as typeof a2a.authentication } })}
              options={[{ value: 'api_key', label: 'API key' }, { value: 'oauth2', label: 'OAuth2' }, { value: 'none', label: 'none (open)' }]} />
          </Field>
          <Field label="Capabilities">
            <div style={{ display: 'flex', gap: 12 }}>
              {(['streaming', 'pushNotifications', 'stateTransitionHistory'] as const).map((cap) => {
                const caps = a2a.capabilities ?? []
                return (
                  <label key={cap} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 11, color: caps.includes(cap) ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
                    <input type="checkbox" checked={caps.includes(cap)} style={{ accentColor: '#3b82f6' }}
                      onChange={() => upd({ a2a_config: { ...a2a, capabilities: caps.includes(cap) ? caps.filter((c) => c !== cap) : [...caps, cap] } })} />
                    {cap}
                  </label>
                )
              })}
            </div>
          </Field>
          <SectionHead>Skills</SectionHead>
          {(a2a.skills ?? []).map((sk, i) => (
            <RowCard key={i} onDelete={() => upd({ a2a_config: { ...a2a, skills: (a2a.skills ?? []).filter((_, j) => j !== i) } })}>
              <div className="field__row">
                <Field label="Skill ID"><Input value={sk.id} onChange={(v) => upd({ a2a_config: { ...a2a, skills: (a2a.skills ?? []).map((s, j) => j === i ? { ...s, id: v } : s) } })} mono /></Field>
                <Field label="Name"><Input value={sk.name} onChange={(v) => upd({ a2a_config: { ...a2a, skills: (a2a.skills ?? []).map((s, j) => j === i ? { ...s, name: v } : s) } })} /></Field>
              </div>
            </RowCard>
          ))}
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 1 }}>
              <label className="field__label">New skill ID</label>
              <input className="field__input field__input--mono" value={a2aSkillId} onChange={(e) => setA2aSkillId(e.target.value)} placeholder="my-skill" />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label className="field__label">Name</label>
              <input className="field__input" value={a2aSkillName} onChange={(e) => setA2aSkillName(e.target.value)} placeholder="My Skill" />
            </div>
            <button className="btn" onClick={() => {
              if (!a2aSkillId || !a2aSkillName) return
              upd({ a2a_config: { ...a2a, skills: [...(a2a.skills ?? []), { id: a2aSkillId, name: a2aSkillName, description: a2aSkillDesc }] } })
              setA2aSkillId(''); setA2aSkillName(''); setA2aSkillDesc('')
            }}>Add</button>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Modal shell ─────────────────────────────────────────────────────────────

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'meta',   label: 'Flow' },
  { id: 'state',  label: 'State schema' },
  { id: 'memory', label: 'Memory stores' },
  { id: 'tools',  label: 'Tools' },
  { id: 'agents', label: 'Agents' },
  { id: 'config', label: 'Config' },
]

const TAB_CONTENT: Record<SettingsTab, React.ComponentType> = {
  meta:   MetaTab,
  state:  StateTab,
  memory: MemoryTab,
  tools:  ToolsTab,
  agents: AgentsTab,
  config: ConfigTab,
}

export function FlowSettingsModal() {
  const { isSettingsOpen, settingsTab, setSettingsTab, closeSettings } = useCanvasStore()
  if (!isSettingsOpen) return null

  const ActiveTab = TAB_CONTENT[settingsTab]

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) closeSettings() }}>
      <div className="modal">
        <div className="modal__header">
          <span className="modal__title">Flow settings</span>
          <button className="config-panel__close" onClick={closeSettings}><X size={14} /></button>
        </div>
        <div className="modal__tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`modal__tab${settingsTab === t.id ? ' active' : ''}`} onClick={() => setSettingsTab(t.id)}>{t.label}</button>
          ))}
        </div>
        <div className="modal__body">
          <ActiveTab />
        </div>
      </div>
    </div>
  )
}
