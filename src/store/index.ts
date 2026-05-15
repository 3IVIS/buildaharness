import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  type Node as XYNode,
  type Edge as XYEdge,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from '@xyflow/react'
import { z } from 'zod'
import dagre from '@dagrejs/dagre'
import type {
  FlowSpec, NodeType, AdapterName,
  AgentDef, MemoryStoreDef, ToolDef, ModelDefaults, FlowConfig,
  StateSchema,
} from '../spec/schema'
import { parseFlowSpec } from '../spec/schema'
import { validateCrossRefs, type ValidationError } from '../spec/validation'

export type NodeData = Record<string, unknown>
export interface CanvasNode extends XYNode { data: NodeData }

interface Snapshot { nodes: CanvasNode[]; edges: XYEdge[] }

interface FlowMeta {
  id: string; name: string; description: string
  runtimeHints: { preferred_adapter?: AdapterName; compatible?: AdapterName[] }
}

export type SettingsTab = 'meta' | 'state' | 'memory' | 'tools' | 'agents' | 'config'

// ─── PersistedState — the slice written to localStorage ──────────────────────

export interface PersistedState {
  nodes:         CanvasNode[]
  edges:         XYEdge[]
  flowMeta:      FlowMeta
  stateSchema:   StateSchema | null
  agents:        AgentDef[]
  memoryStores:  Record<string, MemoryStoreDef>
  tools:         Record<string, ToolDef>
  modelDefaults: ModelDefaults
  flowConfig:    FlowConfig
  lastModifiedAt: number   // bumped on every spec mutation — used for dirty tracking
}

// ─── Full store shape (persisted + transient) ─────────────────────────────────

interface CanvasStore extends PersistedState {
  // Transient UI state — not persisted
  selectedNodeId:  string | null
  isPanelOpen:     boolean
  selectedEdgeId:  string | null
  isEdgePanelOpen: boolean
  isSettingsOpen:  boolean
  settingsTab:     SettingsTab
  isProblemsOpen:  boolean
  zodErrors:       z.ZodError | null
  crossRefErrors:  ValidationError[]
  past:            Snapshot[]
  future:          Snapshot[]
  canUndo:         boolean
  canRedo:         boolean

  // ReactFlow handlers
  onNodesChange: (c: NodeChange[]) => void
  onEdgesChange: (c: EdgeChange[]) => void
  onConnect:     (c: Connection) => void

  // Node ops
  addNode:        (type: NodeType, pos: { x: number; y: number }) => void
  updateNodeData: (id: string, data: Partial<NodeData>) => void
  deleteNode:     (id: string) => void
  selectNode:     (id: string | null) => void
  closePanel:     () => void

  // Edge ops
  updateEdgeData: (id: string, data: Partial<Record<string, unknown>>) => void
  selectEdge:     (id: string | null) => void
  closeEdgePanel: () => void

  // Settings / panels
  openSettings:   (tab?: SettingsTab) => void
  closeSettings:  () => void
  setSettingsTab: (tab: SettingsTab) => void
  toggleProblems: () => void

  // Flow ops
  loadFlow:   (spec: FlowSpec) => void
  exportSpec: () => FlowSpec | null
  validate:   () => boolean
  newFlow:    () => void
  autoLayout: () => void
  undo:       () => void
  redo:       () => void

  // Registry setters
  setFlowMeta:      (meta: Partial<FlowMeta>) => void
  setStateSchema:   (s: StateSchema | null) => void
  setAgents:        (a: AgentDef[]) => void
  setMemoryStores:  (s: Record<string, MemoryStoreDef>) => void
  setTools:         (t: Record<string, ToolDef>) => void
  setModelDefaults: (d: ModelDefaults) => void
  setFlowConfig:    (c: FlowConfig) => void
  _pushHistory:     () => void
  _touch:           () => void  // bumps lastModifiedAt
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function defaultMeta(): FlowMeta {
  return {
    id: 'my-flow', name: 'My Flow', description: '',
    runtimeHints: { preferred_adapter: 'langgraph', compatible: ['langgraph'] },
  }
}

let _nodeCounter = 0
function newNodeId(t: NodeType) { return `${t.replace(/_/g, '-')}-${++_nodeCounter}` }

const NODE_DEFAULTS: Partial<Record<NodeType, NodeData>> = {
  input:           { label: 'Input',           output_schema: {} },
  output:          { label: 'Output',          exit_code: 'success' },
  llm_call:        { label: 'LLM call',        prompt_template: '', model_params: { temperature: 0.7, max_tokens: 512 } },
  tool_invoke:     { label: 'Tool invoke',     tool_id: '' },
  condition:       { label: 'Condition',       branches: [{ condition: { type: 'expr', expr: '' }, target: '' }], default_target: '' },
  parallel_fork:   { label: 'Parallel fork',  targets: [] },
  parallel_join:   { label: 'Parallel join',  wait_for: 'all', join_reducer: 'merge' },
  hitl_breakpoint: { label: 'Human review',   prompt: '', on_timeout: 'raise' },
  memory_read:     { label: 'Memory read',    store_id: '', retrieval_mode: 'key_value', output_key: '' },
  memory_write:    { label: 'Memory write',   store_id: '', key_expr: '', value_expr: '', write_mode: 'upsert' },
  subgraph:        { label: 'Subgraph',        flow_ref: '' },
  transform:       { label: 'Transform',       mode: 'mapping', mapping: [] },
  agent_role:      { label: 'Agent role',      config: { agent_ref: '', task_description: '', memory_access: 'isolated', tool_approval: 'auto' } },
  agent_debate:    { label: 'Agent debate',    config: { agents: [], max_rounds: 10, speaker_selection: 'round_robin', allow_repeat_speaker: false } },
}

function computeLayout(nodes: CanvasNode[], edges: XYEdge[]): CanvasNode[] {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 80, marginx: 40, marginy: 40 })
  nodes.forEach((n) => g.setNode(n.id, { width: 220, height: 80 }))
  edges.forEach((e) => { try { g.setEdge(e.source, e.target) } catch {} })
  dagre.layout(g)
  return nodes.map((n) => {
    const p = g.node(n.id)
    return p ? { ...n, position: { x: p.x - 110, y: p.y - 40 } } : n
  })
}

const MAX_HISTORY = 50
const STORAGE_KEY = 'itsharness:current'
const STORAGE_VERSION = 1

// ─── Store ───────────────────────────────────────────────────────────────────

export const useCanvasStore = create<CanvasStore>()(
  persist(
    (set, get) => ({
      // ── Persisted initial values ──────────────────────────────────────────
      nodes: [], edges: [],
      flowMeta: defaultMeta(), stateSchema: null,
      agents: [], memoryStores: {}, tools: {}, modelDefaults: {}, flowConfig: {},
      lastModifiedAt: Date.now(),

      // ── Transient initial values ──────────────────────────────────────────
      selectedNodeId: null, isPanelOpen: false,
      selectedEdgeId: null, isEdgePanelOpen: false,
      isSettingsOpen: false, settingsTab: 'meta' as SettingsTab,
      isProblemsOpen: false,
      zodErrors: null, crossRefErrors: [],
      past: [], future: [], canUndo: false, canRedo: false,

      // ── Internal helpers ──────────────────────────────────────────────────
      _touch: () => set({ lastModifiedAt: Date.now() }),
      _pushHistory: () => set((s) => ({
        past: [...s.past, { nodes: s.nodes, edges: s.edges }].slice(-MAX_HISTORY),
        future: [], canUndo: true, canRedo: false,
        lastModifiedAt: Date.now(),
      })),

      // ── ReactFlow handlers ────────────────────────────────────────────────
      onNodesChange: (changes) => {
        if (changes.some((c) => c.type === 'remove' || c.type === 'add')) get()._pushHistory()
        set((s) => ({
          nodes: applyNodeChanges(changes, s.nodes) as CanvasNode[],
          lastModifiedAt: Date.now(),
        }))
      },
      onEdgesChange: (changes) => {
        if (changes.some((c) => c.type === 'remove' || c.type === 'add')) get()._pushHistory()
        set((s) => ({ edges: applyEdgeChanges(changes, s.edges), lastModifiedAt: Date.now() }))
      },
      onConnect: (conn) => {
        get()._pushHistory()
        set((s) => ({
          edges: addEdge({ ...conn, type: 'direct', data: { label: '', context_from: [] } }, s.edges),
          lastModifiedAt: Date.now(),
        }))
      },

      // ── Node ops ──────────────────────────────────────────────────────────
      addNode: (type, position) => {
        get()._pushHistory()
        const id = newNodeId(type)
        set((s) => ({
          nodes: [...s.nodes, { id, type, position, data: { ...(NODE_DEFAULTS[type] ?? { label: type }) } }],
          lastModifiedAt: Date.now(),
        }))
      },
      updateNodeData: (id, data) => set((s) => ({
        nodes: s.nodes.map((n) => n.id === id ? { ...n, data: { ...n.data, ...data } } : n),
        lastModifiedAt: Date.now(),
      })),
      deleteNode: (id) => {
        get()._pushHistory()
        set((s) => ({
          nodes:          s.nodes.filter((n) => n.id !== id),
          edges:          s.edges.filter((e) => e.source !== id && e.target !== id),
          selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
          isPanelOpen:    s.selectedNodeId === id ? false : s.isPanelOpen,
          lastModifiedAt: Date.now(),
        }))
      },
      selectNode:     (id) => set({ selectedNodeId: id, isPanelOpen: id !== null, selectedEdgeId: null, isEdgePanelOpen: false }),
      closePanel:     ()   => set({ selectedNodeId: null, isPanelOpen: false }),

      // ── Edge ops ──────────────────────────────────────────────────────────
      updateEdgeData: (id, data) => set((s) => ({
        edges: s.edges.map((e) => e.id === id ? { ...e, data: { ...(e.data ?? {}), ...data } } : e),
        lastModifiedAt: Date.now(),
      })),
      selectEdge:     (id) => set({ selectedEdgeId: id, isEdgePanelOpen: id !== null, selectedNodeId: null, isPanelOpen: false }),
      closeEdgePanel: ()   => set({ selectedEdgeId: null, isEdgePanelOpen: false }),

      // ── Settings ──────────────────────────────────────────────────────────
      openSettings:   (tab = 'meta') => set({ isSettingsOpen: true,  settingsTab: tab }),
      closeSettings:  ()             => set({ isSettingsOpen: false }),
      setSettingsTab: (tab)          => set({ settingsTab: tab }),
      toggleProblems: ()             => set((s) => ({ isProblemsOpen: !s.isProblemsOpen })),

      // ── Registry setters ──────────────────────────────────────────────────
      setFlowMeta:      (meta)   => set((s) => ({ flowMeta: { ...s.flowMeta, ...meta }, lastModifiedAt: Date.now() })),
      setStateSchema:   (schema) => set({ stateSchema: schema, lastModifiedAt: Date.now() }),
      setAgents:        (agents) => set({ agents, lastModifiedAt: Date.now() }),
      setMemoryStores:  (stores) => set({ memoryStores: stores, lastModifiedAt: Date.now() }),
      setTools:         (tools)  => set({ tools, lastModifiedAt: Date.now() }),
      setModelDefaults: (d)      => set({ modelDefaults: d, lastModifiedAt: Date.now() }),
      setFlowConfig:    (c)      => set({ flowConfig: c, lastModifiedAt: Date.now() }),

      // ── Undo / Redo ───────────────────────────────────────────────────────
      undo: () => set((s) => {
        if (!s.past.length) return {}
        const prev   = s.past[s.past.length - 1]
        const past   = s.past.slice(0, -1)
        const future = [{ nodes: s.nodes, edges: s.edges }, ...s.future].slice(0, MAX_HISTORY)
        return { ...prev, past, future, canUndo: past.length > 0, canRedo: true, lastModifiedAt: Date.now() }
      }),
      redo: () => set((s) => {
        if (!s.future.length) return {}
        const next   = s.future[0]
        const future = s.future.slice(1)
        const past   = [...s.past, { nodes: s.nodes, edges: s.edges }].slice(-MAX_HISTORY)
        return { ...next, past, future, canUndo: true, canRedo: future.length > 0, lastModifiedAt: Date.now() }
      }),

      // ── Auto-layout ───────────────────────────────────────────────────────
      autoLayout: () => {
        get()._pushHistory()
        set((s) => ({ nodes: computeLayout(s.nodes, s.edges), lastModifiedAt: Date.now() }))
      },

      // ── Load flow ─────────────────────────────────────────────────────────
      loadFlow: (spec) => {
        _nodeCounter = 0
        const nodes: CanvasNode[] = spec.nodes.map((n) => {
          const { id, type, position, label, description, runtime_support, ...rest } = n as Record<string, unknown>
          return {
            id: id as string, type: type as string,
            position: (position as { x: number; y: number }) ?? { x: 0, y: 0 },
            data: { label, description, runtime_support, ...rest },
          }
        })
        const edges: XYEdge[] = spec.edges.map((e, i) =>
          e.type === 'direct'
            ? { id: e.id ?? `e-${i}`, source: e.from, target: e.to, type: 'direct', data: { label: e.label ?? '', context_from: e.context_from ?? [] } }
            : { id: e.id ?? `e-${i}`, source: e.from, target: e.branches[0]?.to ?? '', type: 'conditional', data: { branches: e.branches, default_target: e.default_target } }
        )
        set({
          nodes, edges,
          flowMeta: { id: spec.id, name: spec.name ?? spec.id, description: spec.description ?? '', runtimeHints: { preferred_adapter: spec.runtime_hints?.preferred_adapter, compatible: spec.runtime_hints?.compatible } },
          stateSchema: spec.state_schema ?? null, agents: spec.agents ?? [],
          memoryStores: spec.memory_stores ?? {}, tools: spec.tools ?? {},
          modelDefaults: spec.model_defaults ?? {}, flowConfig: spec.flow_config ?? {},
          selectedNodeId: null, isPanelOpen: false, selectedEdgeId: null, isEdgePanelOpen: false,
          zodErrors: null, crossRefErrors: [], past: [], future: [], canUndo: false, canRedo: false,
          lastModifiedAt: Date.now(),
        })
      },

      // ── Export spec ───────────────────────────────────────────────────────
      exportSpec: () => {
        const s = get()
        const raw = {
          spec_version: '0.2.0', id: s.flowMeta.id,
          name: s.flowMeta.name || undefined, description: s.flowMeta.description || undefined,
          runtime_hints: Object.keys(s.flowMeta.runtimeHints).length ? s.flowMeta.runtimeHints : undefined,
          state_schema:   s.stateSchema ?? undefined,
          agents:         s.agents.length ? s.agents : undefined,
          memory_stores:  Object.keys(s.memoryStores).length ? s.memoryStores : undefined,
          tools:          Object.keys(s.tools).length ? s.tools : undefined,
          model_defaults: Object.keys(s.modelDefaults).length ? s.modelDefaults : undefined,
          flow_config:    Object.keys(s.flowConfig).length ? s.flowConfig : undefined,
          nodes: s.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, ...n.data })),
          edges: s.edges.map((e) => {
            if (e.type === 'direct') {
              const d = (e.data ?? {}) as Record<string, unknown>
              return { type: 'direct', id: e.id, from: e.source, to: e.target, label: d.label || undefined, context_from: (d.context_from as string[] | undefined)?.length ? d.context_from : undefined }
            }
            return { type: 'conditional', id: e.id, from: e.source, ...(e.data ?? {}) }
          }),
        }
        const result = parseFlowSpec(raw)
        if (!result.success) { set({ zodErrors: result.error }); return null }
        set({ zodErrors: null })
        return result.data
      },

      // ── Validate ──────────────────────────────────────────────────────────
      validate: () => {
        const spec = get().exportSpec()
        if (!spec) return false
        const errors = validateCrossRefs(spec)
        set({ crossRefErrors: errors })
        return errors.length === 0
      },

      // ── New flow ──────────────────────────────────────────────────────────
      newFlow: () => {
        _nodeCounter = 0
        set({
          nodes: [], edges: [], flowMeta: defaultMeta(), stateSchema: null,
          agents: [], memoryStores: {}, tools: {}, modelDefaults: {}, flowConfig: {},
          selectedNodeId: null, isPanelOpen: false, selectedEdgeId: null, isEdgePanelOpen: false,
          zodErrors: null, crossRefErrors: [], past: [], future: [], canUndo: false, canRedo: false,
          lastModifiedAt: Date.now(),
        })
      },
    }),

    // ── Persist config ────────────────────────────────────────────────────────
    {
      name:    STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: STORAGE_VERSION,

      // Only persist the spec-state slice. UI state, undo/redo, validation
      // errors are intentionally transient — they don't survive a reload.
      partialize: (state): PersistedState => ({
        nodes:          state.nodes,
        edges:          state.edges,
        flowMeta:       state.flowMeta,
        stateSchema:    state.stateSchema,
        agents:         state.agents,
        memoryStores:   state.memoryStores,
        tools:          state.tools,
        modelDefaults:  state.modelDefaults,
        flowConfig:     state.flowConfig,
        lastModifiedAt: state.lastModifiedAt,
      }),

      // If the schema changes between versions, migrate here.
      migrate: (persisted, version) => {
        if (version === 0) {
          // v0 → v1: add lastModifiedAt if missing
          return { ...(persisted as object), lastModifiedAt: Date.now() }
        }
        return persisted
      },

      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.warn('[itsharness] failed to restore previous session:', error)
        } else if (state) {
          console.info('[itsharness] session restored from localStorage')
        }
      },
    }
  )
)
