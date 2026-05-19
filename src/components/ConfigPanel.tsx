import { useState, useEffect } from 'react'
import { X, AlertCircle, CheckCircle } from 'lucide-react'
import { useCanvasStore, type NodeData } from '../store'
import type { NodeType, PromptRef } from '../spec/schema'
import { NODE_ICONS, NODE_HEX, NODE_TYPE_LABELS } from '../canvas/nodes/BaseNode'
import { api, type PromptSummary } from '../services/api'

// ─── Field helpers ───────────────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label className="field__label">
        {label}
        {hint && <span className="field__label-hint">{hint}</span>}
      </label>
      {children}
    </div>
  )
}

function TextInput({ value, onChange, mono, placeholder }: { value: string; onChange: (v: string) => void; mono?: boolean; placeholder?: string }) {
  return (
    <input
      className={`field__input${mono ? ' field__input--mono' : ''}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  )
}

function Textarea({ value, onChange, placeholder, rows = 4 }: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  return (
    <textarea
      className="field__textarea"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
    />
  )
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select className="field__select" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

function SliderField({ label, value, min, max, step = 0.1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <Field label={label}>
      <div className="slider-row">
        <input type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))} />
        <span className="slider-row__val">{value}</span>
      </div>
    </Field>
  )
}

// ─── Per-type panels ─────────────────────────────────────────────────────────

function InputPanel({ data, update }: { data: NodeData; update: (d: Partial<NodeData>) => void }) {
  return (
    <>
      <Field label="Label">
        <TextInput value={(data.label as string) ?? ''} onChange={(v) => update({ label: v })} />
      </Field>
      <Field label="Description">
        <TextInput value={(data.description as string) ?? ''} onChange={(v) => update({ description: v })} placeholder="optional" />
      </Field>
      <div className="section-head">Output schema</div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
        Declare the keys this node introduces to the flow state.
      </div>
    </>
  )
}

function OutputPanel({ data, update }: { data: NodeData; update: (d: Partial<NodeData>) => void }) {
  return (
    <>
      <Field label="Label">
        <TextInput value={(data.label as string) ?? ''} onChange={(v) => update({ label: v })} />
      </Field>
      <Field label="Exit code" hint="default: success">
        <TextInput value={(data.exit_code as string) ?? 'success'} onChange={(v) => update({ exit_code: v })} mono />
      </Field>
    </>
  )
}


// ─── Fail branch config section (shared by LlmCall, ToolInvoke) ──────────────

function FailBranchSection({ data, update }: { data: NodeData; update: (d: Partial<NodeData>) => void }) {
  type FB = { target?: string; retry?: { max_attempts?: number; backoff?: string; delay_ms?: number } }
  const fb = (data.fail_branch as FB | undefined) ?? {}
  const retry = fb.retry ?? {}

  function setFb(patch: Partial<FB>) {
    update({ fail_branch: { ...fb, ...patch } })
  }
  function setRetry(patch: Partial<typeof retry>) {
    setFb({ retry: { ...retry, ...patch } })
  }
  function clearFb() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update({ fail_branch: undefined as any })
  }

  return (
    <>
      <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Error handling</span>
        {fb.target && (
          <button
            onClick={clearFb}
            style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)',
                     fontSize: 10, cursor: 'pointer', padding: '0 2px' }}
            title="Remove fail branch"
          >clear</button>
        )}
      </div>

      <Field label="On-fail target" hint="node ID to route to on error — canvas draws a red dashed edge">
        <TextInput
          value={fb.target ?? ''}
          onChange={(v) => setFb({ target: v || undefined })}
          mono
          placeholder="error-handler-node"
        />
      </Field>

      {fb.target && (
        <>
          <div className="section-head" style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 6 }}>Retry</div>
          <Field label="Max attempts">
            <input
              type="number" min={1} max={10}
              value={retry.max_attempts ?? 3}
              onChange={(e) => setRetry({ max_attempts: Number(e.target.value) })}
              className="cfg-input"
              style={{ width: 64 }}
            />
          </Field>
          <Field label="Backoff">
            <select
              className="cfg-input"
              value={retry.backoff ?? 'exponential'}
              onChange={(e) => setRetry({ backoff: e.target.value })}
            >
              <option value="exponential">exponential</option>
              <option value="fixed">fixed</option>
            </select>
          </Field>
          <Field label="Delay (ms)">
            <input
              type="number" min={0} step={100}
              value={retry.delay_ms ?? 1000}
              onChange={(e) => setRetry({ delay_ms: Number(e.target.value) })}
              className="cfg-input"
              style={{ width: 80 }}
            />
          </Field>
        </>
      )}
    </>
  )
}

function LlmCallPanel({ data, update }: { data: NodeData; update: (d: Partial<NodeData>) => void }) {
  const params    = (data.model_params as Record<string, number>) ?? {}
  const promptRef = data.prompt_ref as PromptRef | undefined
  // isLangfuse=true whenever prompt_ref key is present in node data (even with empty name).
  // Checking promptRef?.name would be false for '' after mode-switch — use key presence instead.
  const isLangfuse = promptRef !== undefined

  // Load prompt list from Langfuse when the user switches to managed mode.
  const [prompts,        setPrompts]        = useState<PromptSummary[]>([])
  const [promptsLoading, setPromptsLoading] = useState(false)
  const [promptsError,   setPromptsError]   = useState<string | null>(null)

  // Preview text for the currently selected prompt (shown below the picker).
  const [preview,        setPreview]        = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  useEffect(() => {
    if (!isLangfuse) return
    setPromptsLoading(true)
    setPromptsError(null)
    api.prompts.list()
      .then((list) => setPrompts(list))
      .catch((err) => setPromptsError(String(err)))
      .finally(() => setPromptsLoading(false))
  }, [isLangfuse])

  // Fetch preview whenever the selected prompt name changes.
  useEffect(() => {
    if (!isLangfuse || !promptRef?.name) { setPreview(null); return }
    setPreviewLoading(true)
    api.prompts.get(promptRef.name)
      .then((detail) => setPreview(detail.prompt))
      .catch(() => setPreview(null))
      .finally(() => setPreviewLoading(false))
  }, [isLangfuse, promptRef?.name])

  function setPromptMode(mode: 'inline' | 'langfuse') {
    if (mode === 'inline') {
      update({ prompt_ref: undefined })
    } else {
      // Switch to Langfuse mode — clear prompt_template to avoid "both set" warning.
      update({ prompt_ref: { name: '', version: undefined, label: undefined }, prompt_template: '' })
    }
  }

  function updateRef(patch: Partial<PromptRef>) {
    update({ prompt_ref: { ...(promptRef ?? { name: '' }), ...patch } })
  }

  // Shared toggle button style
  const toggleBtn = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '4px 8px',
    fontSize: 11,
    fontWeight: 500,
    border: '0.5px solid',
    borderRadius: 5,
    cursor: 'pointer',
    transition: 'background 0.12s, color 0.12s',
    background: active ? 'rgba(167,139,250,0.15)' : 'transparent',
    borderColor: active ? 'rgba(167,139,250,0.4)' : 'var(--border-mid)',
    color:       active ? '#a78bfa' : 'var(--text-tertiary)',
  })

  return (
    <>
      <Field label="Label">
        <TextInput value={(data.label as string) ?? ''} onChange={(v) => update({ label: v })} />
      </Field>
      <Field label="Model" hint="inherits model_defaults if empty">
        <TextInput value={(data.model as string) ?? ''} onChange={(v) => update({ model: v })} mono placeholder="gpt-4o" />
      </Field>

      {/* ── Prompt source ───────────────────────────────────────────────── */}
      <div className="section-head">Prompts</div>

      {/* Toggle: Inline | Langfuse */}
      <div style={{ display: 'flex', gap: 5, marginBottom: 10 }}>
        <button style={toggleBtn(!isLangfuse)} onClick={() => setPromptMode('inline')}>
          Inline
        </button>
        <button style={toggleBtn(isLangfuse)} onClick={() => setPromptMode('langfuse')}>
          ⚡ Langfuse
        </button>
      </div>

      {isLangfuse ? (
        /* ── Langfuse-managed prompt ──────────────────────────────────── */
        <>
          <Field label="Prompt name">
            {promptsLoading
              ? <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Loading prompts…</div>
              : promptsError
              ? <div style={{ fontSize: 11, color: 'var(--red)' }}>{promptsError}</div>
              : (
                <Select
                  value={promptRef?.name ?? ''}
                  onChange={(v) => {
                    if (v === '') return  // placeholder selected — don't clear the name to ''
                    updateRef({ name: v })
                  }}
                  options={[
                    { value: '', label: '— select a prompt —' },
                    ...prompts.map((p) => ({
                      value: p.name,
                      label: `${p.name}${p.labels.length ? ` [${p.labels[0]}]` : ''}`,
                    })),
                  ]}
                />
              )
            }
          </Field>

          <Field label="Version" hint="leave empty for latest (production label)">
            <input
              type="number"
              className="field__input field__input--mono"
              min={1}
              step={1}
              value={promptRef?.version ?? ''}
              onChange={(e) => {
                const parsed = parseInt(e.target.value, 10)
                const v = e.target.value === '' ? undefined : (isNaN(parsed) || parsed < 1 ? undefined : parsed)
                updateRef({ version: v })
              }}
              placeholder="latest"
              style={{ width: 80 }}
            />
          </Field>

          {/* Preview pane */}
          {promptRef?.name && (
            <div style={{
              marginTop: 2, marginBottom: 8,
              padding: '7px 9px',
              background: 'var(--bg-overlay)',
              border: '0.5px solid var(--border)',
              borderRadius: 5,
              fontSize: 11,
              color: 'var(--text-tertiary)',
              lineHeight: 1.55,
              maxHeight: 100,
              overflowY: 'auto',
              fontFamily: 'monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {previewLoading ? 'Loading preview…' : (preview ?? 'No preview available')}
            </div>
          )}

          {prompts.length === 0 && !promptsLoading && !promptsError && (
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 8 }}>
              No prompts found in Langfuse. Create one at{' '}
              <a href="/langfuse" target="_blank" rel="noopener noreferrer"
                 style={{ color: '#a78bfa' }}>
                Langfuse Prompt Management
              </a>.
            </div>
          )}
        </>
      ) : (
        /* ── Inline prompts ─────────────────────────────────────────────── */
        <>
          <Field label="System prompt">
            <Textarea
              value={(data.system_prompt as string) ?? ''}
              onChange={(v) => update({ system_prompt: v })}
              placeholder="You are a helpful assistant…"
              rows={3}
            />
          </Field>
          <Field label="Prompt template" hint="use {{$.state.key}} for state refs">
            <Textarea
              value={(data.prompt_template as string) ?? ''}
              onChange={(v) => update({ prompt_template: v })}
              placeholder="{{$.state.question}}"
              rows={4}
            />
          </Field>
        </>
      )}

      {/* ── Model params ─────────────────────────────────────────────────── */}
      <div className="section-head">Model params</div>
      <SliderField label="Temperature" value={params.temperature ?? 0.7} min={0} max={2}
        onChange={(v) => update({ model_params: { ...params, temperature: v } })} />
      <SliderField label="Max tokens" value={params.max_tokens ?? 512} min={1} max={4096} step={1}
        onChange={(v) => update({ model_params: { ...params, max_tokens: v } })} />
      <Field label="Output key" hint="state key to write answer to">
        <TextInput value={(data.output_key as string) ?? ''} onChange={(v) => update({ output_key: v })} mono placeholder="answer" />
      </Field>
      <FailBranchSection data={data} update={update} />
    </>
  )
}

function ToolInvokePanel({ data, update }: { data: NodeData; update: (d: Partial<NodeData>) => void }) {
  return (
    <>
      <Field label="Label">
        <TextInput value={(data.label as string) ?? ''} onChange={(v) => update({ label: v })} />
      </Field>
      <Field label="Tool ID" hint="must reference tools registry">
        <TextInput value={(data.tool_id as string) ?? ''} onChange={(v) => update({ tool_id: v })} mono placeholder="web_search" />
      </Field>
      <FailBranchSection data={data} update={update} />
    </>
  )
}

function ConditionPanel({ data, update }: { data: NodeData; update: (d: Partial<NodeData>) => void }) {
  const branches = (data.branches as { condition: { type: string; expr?: string }; target: string }[]) ?? []

  function updateBranch(i: number, key: string, value: string) {
    const next = branches.map((b, idx) =>
      idx === i ? (key === 'target' ? { ...b, target: value } : { ...b, condition: { ...b.condition, [key]: value } }) : b
    )
    update({ branches: next })
  }

  function addBranch() {
    update({ branches: [...branches, { condition: { type: 'expr', expr: '' }, target: '' }] })
  }

  function removeBranch(i: number) {
    update({ branches: branches.filter((_, idx) => idx !== i) })
  }

  return (
    <>
      <Field label="Label">
        <TextInput value={(data.label as string) ?? ''} onChange={(v) => update({ label: v })} />
      </Field>
      <div className="section-head">Branches</div>
      {branches.map((b, i) => (
        <div key={i} style={{ background: 'var(--bg-overlay)', borderRadius: 6, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6, position: 'relative' }}>
          <button onClick={() => removeBranch(i)} style={{ position: 'absolute', top: 6, right: 6, background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 11 }}>✕</button>
          <Field label={`Branch ${i + 1} condition`}>
            <TextInput value={b.condition.expr ?? ''} onChange={(v) => updateBranch(i, 'expr', v)} mono placeholder="$.state.severity == 'high'" />
          </Field>
          <Field label="Target node ID">
            <TextInput value={b.target} onChange={(v) => updateBranch(i, 'target', v)} mono placeholder="node-id" />
          </Field>
        </div>
      ))}
      <button className="btn" onClick={addBranch} style={{ alignSelf: 'flex-start' }}>+ Add branch</button>
      <Field label="Default target">
        <TextInput value={(data.default_target as string) ?? ''} onChange={(v) => update({ default_target: v })} mono placeholder="node-id" />
      </Field>
    </>
  )
}

function ParallelForkPanel({ data, update }: { data: NodeData; update: (d: Partial<NodeData>) => void }) {
  const targets = (data.targets as string[]) ?? []
  return (
    <>
      <Field label="Label">
        <TextInput value={(data.label as string) ?? ''} onChange={(v) => update({ label: v })} />
      </Field>
      <Field label="Target node IDs" hint="comma-separated">
        <TextInput value={targets.join(', ')} onChange={(v) => update({ targets: v.split(',').map((s) => s.trim()).filter(Boolean) })} mono placeholder="branch-a, branch-b" />
      </Field>
    </>
  )
}

function ParallelJoinPanel({ data, update }: { data: NodeData; update: (d: Partial<NodeData>) => void }) {
  return (
    <>
      <Field label="Label">
        <TextInput value={(data.label as string) ?? ''} onChange={(v) => update({ label: v })} />
      </Field>
      <Field label="Wait for">
        <Select value={String(data.wait_for ?? 'all')} onChange={(v) => update({ wait_for: v === 'all' || v === 'any' ? v : parseInt(v) })}
          options={[{ value: 'all', label: 'all' }, { value: 'any', label: 'any' }]} />
      </Field>
      <Field label="Join reducer">
        <Select value={(data.join_reducer as string) ?? 'merge'} onChange={(v) => update({ join_reducer: v })}
          options={[{ value: 'merge', label: 'merge' }, { value: 'append', label: 'append' }, { value: 'fn_ref', label: 'fn_ref (custom)' }]} />
      </Field>
      <Field label="Output key">
        <TextInput value={(data.output_key as string) ?? ''} onChange={(v) => update({ output_key: v })} mono placeholder="merged_results" />
      </Field>
    </>
  )
}

function HitlPanel({ data, update }: { data: NodeData; update: (d: Partial<NodeData>) => void }) {
  return (
    <>
      <Field label="Label">
        <TextInput value={(data.label as string) ?? ''} onChange={(v) => update({ label: v })} />
      </Field>
      <Field label="Prompt shown to reviewer">
        <Textarea value={(data.prompt as string) ?? ''} onChange={(v) => update({ prompt: v })} placeholder="Please review this content and make a decision." rows={4} />
      </Field>
      <Field label="Output key">
        <TextInput value={(data.output_key as string) ?? ''} onChange={(v) => update({ output_key: v })} mono placeholder="reviewer_outcome" />
      </Field>
      <Field label="Timeout (seconds)" hint="null = no timeout">
        <TextInput value={String(data.timeout_seconds ?? '')} onChange={(v) => update({ timeout_seconds: v === '' ? null : parseInt(v) })} mono placeholder="86400" />
      </Field>
      <Field label="On timeout">
        <Select value={(data.on_timeout as string) ?? 'raise'} onChange={(v) => update({ on_timeout: v })}
          options={[{ value: 'raise', label: 'raise (error)' }, { value: 'skip', label: 'skip (continue)' }]} />
      </Field>
    </>
  )
}

function MemoryReadPanel({ data, update }: { data: NodeData; update: (d: Partial<NodeData>) => void }) {
  const mode = (data.retrieval_mode as string) ?? 'key_value'
  return (
    <>
      <Field label="Label">
        <TextInput value={(data.label as string) ?? ''} onChange={(v) => update({ label: v })} />
      </Field>
      <Field label="Store ID" hint="must reference memory_stores registry">
        <TextInput value={(data.store_id as string) ?? ''} onChange={(v) => update({ store_id: v })} mono placeholder="knowledge_base" />
      </Field>
      <Field label="Retrieval mode">
        <Select value={mode} onChange={(v) => update({ retrieval_mode: v })}
          options={[{ value: 'key_value', label: 'key_value' }, { value: 'semantic', label: 'semantic' }]} />
      </Field>
      {mode === 'key_value' && (
        <Field label="Key expression" hint="JSONPath">
          <TextInput value={(data.key_expr as string) ?? ''} onChange={(v) => update({ key_expr: v })} mono placeholder="$.state.question" />
        </Field>
      )}
      {mode === 'semantic' && (
        <>
          <Field label="Query expression" hint="JSONPath">
            <TextInput value={(data.query_expr as string) ?? ''} onChange={(v) => update({ query_expr: v })} mono placeholder="$.state.question" />
          </Field>
          <div className="field__row">
            <Field label="Top K">
              <TextInput value={String(data.top_k ?? 5)} onChange={(v) => update({ top_k: parseInt(v) })} mono />
            </Field>
            <Field label="Min score">
              <TextInput value={String(data.min_score ?? '')} onChange={(v) => update({ min_score: parseFloat(v) })} mono placeholder="0.72" />
            </Field>
          </div>
        </>
      )}
      <Field label="Output key">
        <TextInput value={(data.output_key as string) ?? ''} onChange={(v) => update({ output_key: v })} mono placeholder="retrieved_chunks" />
      </Field>
    </>
  )
}

function MemoryWritePanel({ data, update }: { data: NodeData; update: (d: Partial<NodeData>) => void }) {
  return (
    <>
      <Field label="Label">
        <TextInput value={(data.label as string) ?? ''} onChange={(v) => update({ label: v })} />
      </Field>
      <Field label="Store ID">
        <TextInput value={(data.store_id as string) ?? ''} onChange={(v) => update({ store_id: v })} mono placeholder="qa_cache" />
      </Field>
      <Field label="Key expression" hint="JSONPath">
        <TextInput value={(data.key_expr as string) ?? ''} onChange={(v) => update({ key_expr: v })} mono placeholder="$.state.question" />
      </Field>
      <Field label="Value expression" hint="JSONPath">
        <TextInput value={(data.value_expr as string) ?? ''} onChange={(v) => update({ value_expr: v })} mono placeholder="$.state.answer" />
      </Field>
      <Field label="Write mode">
        <Select value={(data.write_mode as string) ?? 'upsert'} onChange={(v) => update({ write_mode: v })}
          options={[{ value: 'upsert', label: 'upsert' }, { value: 'overwrite', label: 'overwrite' }]} />
      </Field>
      <Field label="Tier" hint="CrewAI memory tier">
        <Select value={(data.tier as string) ?? 'short'} onChange={(v) => update({ tier: v })}
          options={[{ value: 'short', label: 'short (ChromaDB)' }, { value: 'long', label: 'long (SQLite)' }, { value: 'entity', label: 'entity (facts)' }, { value: 'user', label: 'user (prefs)' }]} />
      </Field>
    </>
  )
}

function SubgraphPanel({ data, update }: { data: NodeData; update: (d: Partial<NodeData>) => void }) {
  return (
    <>
      <Field label="Label">
        <TextInput value={(data.label as string) ?? ''} onChange={(v) => update({ label: v })} />
      </Field>
      <Field label="Flow reference" hint="ID of another flow">
        <TextInput value={(data.flow_ref as string) ?? ''} onChange={(v) => update({ flow_ref: v })} mono placeholder="my-sub-flow" />
      </Field>
    </>
  )
}

function TransformPanel({ data, update }: { data: NodeData; update: (d: Partial<NodeData>) => void }) {
  const mode    = (data.mode as string) ?? 'mapping'
  const mapping = (data.mapping as { from: string; to: string }[]) ?? []

  function updateMapping(i: number, key: 'from' | 'to', value: string) {
    update({ mapping: mapping.map((m, idx) => idx === i ? { ...m, [key]: value } : m) })
  }

  return (
    <>
      <Field label="Label">
        <TextInput value={(data.label as string) ?? ''} onChange={(v) => update({ label: v })} />
      </Field>
      <Field label="Mode">
        <Select value={mode} onChange={(v) => update({ mode: v })}
          options={[{ value: 'mapping', label: 'mapping (visual)' }, { value: 'fn_ref', label: 'fn_ref (code)' }]} />
      </Field>
      {mode === 'mapping' && (
        <>
          <div className="section-head">Mappings</div>
          {mapping.map((m, i) => (
            <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input className="field__input field__input--mono" style={{ flex: 1 }} value={m.from} onChange={(e) => updateMapping(i, 'from', e.target.value)} placeholder="$.state.x" />
              <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>→</span>
              <input className="field__input field__input--mono" style={{ flex: 1 }} value={m.to} onChange={(e) => updateMapping(i, 'to', e.target.value)} placeholder="$.output.y" />
              <button onClick={() => update({ mapping: mapping.filter((_, idx) => idx !== i) })} style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer' }}>✕</button>
            </div>
          ))}
          <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => update({ mapping: [...mapping, { from: '', to: '' }] })}>+ Add mapping</button>
        </>
      )}
      {mode === 'fn_ref' && (
        <Field label="Function ref" hint="npm or local path">
          <TextInput value={(data.fn_ref as string) ?? ''} onChange={(v) => update({ fn_ref: v })} mono placeholder="@scope/pkg/fn or ./path/to/fn.ts" />
        </Field>
      )}
    </>
  )
}

function AgentRolePanel({ data, update }: { data: NodeData; update: (d: Partial<NodeData>) => void }) {
  const config = (data.config as Record<string, unknown>) ?? {}
  function updateConfig(key: string, value: unknown) {
    update({ config: { ...config, [key]: value } })
  }
  return (
    <>
      <Field label="Label">
        <TextInput value={(data.label as string) ?? ''} onChange={(v) => update({ label: v })} />
      </Field>
      <Field label="Agent ref" hint="must reference agents[] registry">
        <TextInput value={(config.agent_ref as string) ?? ''} onChange={(v) => updateConfig('agent_ref', v)} mono placeholder="researcher" />
      </Field>
      <Field label="Task description">
        <Textarea value={(config.task_description as string) ?? ''} onChange={(v) => updateConfig('task_description', v)} placeholder="Describe the task with {{$.state.key}} state refs" rows={4} />
      </Field>
      <Field label="Expected output">
        <Textarea value={(config.expected_output as string) ?? ''} onChange={(v) => updateConfig('expected_output', v)} placeholder="Describe the expected output format" rows={3} />
      </Field>
      <Field label="Output field">
        <TextInput value={(config.output_field as string) ?? ''} onChange={(v) => updateConfig('output_field', v)} mono placeholder="research_findings" />
      </Field>
      <Field label="Memory access">
        <Select value={(config.memory_access as string) ?? 'isolated'} onChange={(v) => updateConfig('memory_access', v)}
          options={[{ value: 'isolated', label: 'isolated (default)' }, { value: 'shared', label: 'shared (named store)' }]} />
      </Field>
      {config.memory_access === 'shared' && (
        <Field label="Memory store ID">
          <TextInput value={(config.memory_store_id as string) ?? ''} onChange={(v) => updateConfig('memory_store_id', v)} mono placeholder="crew_shared" />
        </Field>
      )}
      <Field label="Tool approval">
        <Select value={(config.tool_approval as string) ?? 'auto'} onChange={(v) => updateConfig('tool_approval', v)}
          options={[{ value: 'auto', label: 'auto (no gate)' }, { value: 'human', label: 'human (approve each call)' }]} />
      </Field>
    </>
  )
}

function AgentDebatePanel({ data, update }: { data: NodeData; update: (d: Partial<NodeData>) => void }) {
  const config = (data.config as Record<string, unknown>) ?? {}
  const agents = (config.agents as string[]) ?? []
  function updateConfig(key: string, value: unknown) {
    update({ config: { ...config, [key]: value } })
  }
  return (
    <>
      <Field label="Label">
        <TextInput value={(data.label as string) ?? ''} onChange={(v) => update({ label: v })} />
      </Field>
      <Field label="Agents" hint="comma-separated agent IDs">
        <TextInput value={agents.join(', ')} onChange={(v) => updateConfig('agents', v.split(',').map((s) => s.trim()).filter(Boolean))} mono placeholder="advocate, devil_advocate, judge" />
      </Field>
      <Field label="Max rounds">
        <TextInput value={String(config.max_rounds ?? 10)} onChange={(v) => updateConfig('max_rounds', parseInt(v))} mono />
      </Field>
      <Field label="Speaker selection">
        <Select value={(config.speaker_selection as string) ?? 'auto'} onChange={(v) => updateConfig('speaker_selection', v)}
          options={[{ value: 'auto', label: 'auto' }, { value: 'round_robin', label: 'round_robin' }, { value: 'custom', label: 'custom (fn_ref)' }]} />
      </Field>
      <Field label="Termination condition" hint="JSONPath expression">
        <TextInput value={((config.termination_condition as { expr?: string })?.expr) ?? ''} onChange={(v) => updateConfig('termination_condition', { type: 'expr', expr: v })} mono placeholder="$.last_message contains 'VERDICT'" />
      </Field>
      <Field label="Output field">
        <TextInput value={(config.output_field as string) ?? ''} onChange={(v) => updateConfig('output_field', v)} mono placeholder="debate_transcript" />
      </Field>
    </>
  )
}

// ─── Panel routing ────────────────────────────────────────────────────────────

const PANEL_MAP: Partial<Record<NodeType, React.ComponentType<{ data: NodeData; update: (d: Partial<NodeData>) => void }>>> = {
  input:           InputPanel,
  output:          OutputPanel,
  llm_call:        LlmCallPanel,
  tool_invoke:     ToolInvokePanel,
  condition:       ConditionPanel,
  parallel_fork:   ParallelForkPanel,
  parallel_join:   ParallelJoinPanel,
  hitl_breakpoint: HitlPanel,
  memory_read:     MemoryReadPanel,
  memory_write:    MemoryWritePanel,
  subgraph:        SubgraphPanel,
  transform:       TransformPanel,
  agent_role:      AgentRolePanel,
  agent_debate:    AgentDebatePanel,
}

// ─── Main ConfigPanel component ───────────────────────────────────────────────

export function ConfigPanel() {
  const { nodes, selectedNodeId, zodErrors, crossRefErrors, updateNodeData, closePanel, deleteNode } = useCanvasStore()

  const selectedNode = nodes.find((n) => n.id === selectedNodeId)

  if (!selectedNode) {
    return (
      <div className="config-panel">
        <div className="empty-state">
          <div className="empty-state__icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 9h6M9 12h6M9 15h4" />
            </svg>
          </div>
          <div className="empty-state__title">No node selected</div>
          <div className="empty-state__desc">Click any node on the canvas to edit its properties here.</div>
        </div>
      </div>
    )
  }

  const nodeType  = selectedNode.type as NodeType
  const PanelComp = PANEL_MAP[nodeType]
  const Icon      = NODE_ICONS[nodeType]
  const hex       = NODE_HEX[nodeType] ?? '#6b7280'

  const nodeErrors = [
    ...(crossRefErrors.filter((e) => e.nodeId === selectedNode.id)),
  ]

  return (
    <div className="config-panel">
      <div className="config-panel__header">
        <div className="config-panel__icon" style={{ background: `${hex}18`, color: hex }}>
          {Icon && <Icon size={14} strokeWidth={1.75} />}
        </div>
        <div className="config-panel__meta">
          <div className="config-panel__type">{NODE_TYPE_LABELS[nodeType] ?? nodeType}</div>
          <div className="config-panel__name">{(selectedNode.data.label as string) || selectedNode.id}</div>
        </div>
        <div className="config-panel__actions">
          <button
            className="config-panel__close"
            title="Delete node"
            onClick={() => deleteNode(selectedNode.id)}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ef4444' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '' }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3,6 5,6 21,6"/><path d="M19,6l-1,14H6L5,6"/>
              <path d="M10,11v6M14,11v6"/><path d="M9,6V4h6v2"/>
            </svg>
          </button>
          <button className="config-panel__close" title="Close panel" onClick={closePanel}>
            <X size={13} />
          </button>
        </div>
      </div>

      <div className="config-panel__body">
        {nodeErrors.length > 0 && (
          <div className="error-badge">
            <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>{nodeErrors.map((e) => e.message).join(' · ')}</div>
          </div>
        )}

        {PanelComp
          ? <PanelComp data={selectedNode.data} update={(d) => updateNodeData(selectedNode.id, d)} />
          : <div style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>No config panel for {nodeType}</div>
        }
      </div>

      {/* Validation footer */}
      <div className="validation-panel">
        {zodErrors === null && crossRefErrors.length === 0
          ? <div className="validation-ok"><CheckCircle size={12} /> Valid spec</div>
          : <div className="error-badge" style={{ fontSize: 11 }}>
              <AlertCircle size={12} style={{ flexShrink: 0 }} />
              {zodErrors ? `Zod: ${zodErrors.issues[0]?.message}` : `${crossRefErrors.length} cross-ref error${crossRefErrors.length > 1 ? 's' : ''}`}
            </div>
        }
      </div>
    </div>
  )
}
