/**
 * createCanvasStore — factory that produces a scoped Zustand store instance.
 *
 * Unlike the app-level singleton (src/store/index.ts), this store:
 *   • Is created fresh per <ItsHarnessCanvas> mount — safe to embed multiple times.
 *   • Has no localStorage persistence (the host app owns persistence).
 *   • Strips app-level concerns: run state, deployment, eval/feedback, navigation.
 *   • Accepts initialSpec to seed the canvas and fires onSpecChange after edits.
 */
import { createStore } from 'zustand'
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

// ─── Types ───────────────────────────────────────────────────────────────────

export type NodeData = Record<string, unknown>

export interface CanvasNode extends XYNode { data: NodeData }

export interface NodeExecStat {
  status:  'pending' | 'running' | 'paused' | 'done' | 'error'
  tokens?: number
  ms?:     number
  /** LLM-as-judge quality score [0, 1] */
  score?:  number
}

interface Snapshot {
  nodes:        CanvasNode[]
  edges:        XYEdge[]
  stateSchema:  StateSchema | null
  agents:       AgentDef[]
  memoryStores: Record<string, MemoryStoreDef>
  tools:        Record<string, ToolDef>
  modelDefaults: ModelDefaults
  flowConfig:   FlowConfig
}

interface FlowMeta {
  id: string; name: string; description: string
  runtimeHints: { preferred_adapter?: AdapterName; compatible?: AdapterName[] }
}

export interface CanvasStore {
  // ── Canvas data ──────────────────────────────────────────────────────────
  nodes:          CanvasNode[]
  edges:          XYEdge[]
  flowMeta:       FlowMeta
  stateSchema:    StateSchema | null
  agents:         AgentDef[]
  memoryStores:   Record<string, MemoryStoreDef>
  tools:          Record<string, ToolDef>
  modelDefaults:  ModelDefaults
  flowConfig:     FlowConfig
  _nodeCounter:   number

  // ── Transient UI ─────────────────────────────────────────────────────────
  selectedNodeId:  string | null
  isPanelOpen:     boolean
  selectedEdgeId:  string | null
  isEdgePanelOpen: boolean
  theme:           'dark' | 'light'
  zodErrors:       z.ZodError | null
  crossRefErrors:  ValidationError[]
  past:            Snapshot[]
  future:          Snapshot[]
  canUndo:         boolean
  canRedo:         boolean
  execStats:       Record<string, NodeExecStat>

  // ── ReactFlow handlers ───────────────────────────────────────────────────
  onNodesChange: (c: NodeChange[]) => void
  onEdgesChange: (c: EdgeChange[]) => void
  onConnect:     (c: Connection) => void

  // ── Node ops ─────────────────────────────────────────────────────────────
  addNode:          (type: NodeType, pos: { x: number; y: number }) => void
  addAnnotation:    (pos: { x: number; y: number }) => void
  insertNodeOnEdge: (edgeId: string, type: NodeType) => void
  updateNodeData:   (id: string, data: Partial<NodeData>) => void
  deleteNode:       (id: string) => void
  selectNode:       (id: string | null) => void
  closePanel:       () => void

  // ── Edge ops ─────────────────────────────────────────────────────────────
  updateEdgeData:  (id: string, data: Partial<Record<string, unknown>>) => void
  selectEdge:      (id: string | null) => void
  closeEdgePanel:  () => void
  deleteEdge:      (id: string) => void

  // ── Flow ops ─────────────────────────────────────────────────────────────
  loadFlow:    (spec: FlowSpec) => void
  exportSpec:  () => FlowSpec | null
  validate:    () => boolean
  newFlow:     () => void
  autoLayout:  () => void
  undo:        () => void
  redo:        () => void

  // ── Registry setters ─────────────────────────────────────────────────────
  setFlowMeta:       (meta: Partial<FlowMeta>) => void
  setStateSchema:    (s: StateSchema | null) => void
  setAgents:         (a: AgentDef[]) => void
  setMemoryStores:   (s: Record<string, MemoryStoreDef>) => void
  setTools:          (t: Record<string, ToolDef>) => void
  setModelDefaults:  (d: ModelDefaults) => void
  setFlowConfig:     (c: FlowConfig) => void
  setCrossRefErrors: (errors: ValidationError[]) => void
  setNodeExecStat:   (nodeId: string, stat: NodeExecStat) => void
  clearExecStats:    () => void

  // ── Theme ────────────────────────────────────────────────────────────────
  setTheme: (t: 'dark' | 'light') => void

  // ── Internal ─────────────────────────────────────────────────────────────
  _pushHistory: () => void
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function defaultMeta(): FlowMeta {
  return {
    id: 'my-flow', name: 'My Flow', description: '',
    runtimeHints: { preferred_adapter: 'langgraph', compatible: ['langgraph'] },
  }
}

function newNodeId(type: NodeType | 'annotation', counter: number) {
  return `${(type as string).replace(/_/g, '-')}-${counter}`
}

const NODE_W = 248
const NODE_H = 86
const MAX_HISTORY = 50

const NODE_DEFAULTS: Partial<Record<NodeType, NodeData>> = {
  input:           { label: 'Input',          output_schema: {} },
  output:          { label: 'Output',         exit_code: 'success' },
  llm_call:        { label: 'LLM call',       prompt_template: '', model_params: { temperature: 0.7, max_tokens: 512 } },
  tool_invoke:     { label: 'Tool invoke',    tool_id: '' },
  condition:       { label: 'Condition',      branches: [{ condition: { type: 'expr', expr: '' }, target: '' }], default_target: '' },
  parallel_fork:   { label: 'Parallel fork',  targets: [] },
  parallel_join:   { label: 'Parallel join',  wait_for: 'all', join_reducer: 'merge' },
  hitl_breakpoint: { label: 'Human review',   prompt: '', on_timeout: 'raise' },
  memory_read:     { label: 'Memory read',    store_id: '', retrieval_mode: 'key_value', output_key: '' },
  memory_write:    { label: 'Memory write',   store_id: '', key_expr: '', value_expr: '', write_mode: 'upsert' },
  subgraph:        { label: 'Subgraph',       flow_ref: '' },
  transform:       { label: 'Transform',      mode: 'mapping', mapping: [] },
  agent_role:      { label: 'Agent role',     config: { agent_ref: '', task_description: '', memory_access: 'isolated', tool_approval: 'auto' } },
  agent_debate:    { label: 'Agent debate',   config: { agents: [], max_rounds: 10, speaker_selection: 'round_robin', allow_repeat_speaker: false } },
}

function computeLayout(nodes: CanvasNode[], edges: XYEdge[]): CanvasNode[] {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 100, marginx: 60, marginy: 60 })
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }))
  edges.forEach((e) => { try { g.setEdge(e.source, e.target) } catch {} })
  dagre.layout(g)
  return nodes.map((n) => {
    const p = g.node(n.id)
    return p ? { ...n, position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 } } : n
  })
}

function _snapshot(s: CanvasStore): Snapshot {
  return {
    nodes:         s.nodes,
    edges:         s.edges,
    stateSchema:   s.stateSchema,
    agents:        s.agents,
    memoryStores:  s.memoryStores,
    tools:         s.tools,
    modelDefaults: s.modelDefaults,
    flowConfig:    s.flowConfig,
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export interface CreateCanvasStoreOpts {
  initialSpec?: FlowSpec
}

export function createCanvasStore(opts: CreateCanvasStoreOpts = {}) {
  // Debounce timer lives outside the store so it isn't serialised.
  let _updateDebounceTimer: ReturnType<typeof setTimeout> | null = null

  return createStore<CanvasStore>()((set, get) => {
    // ── Seed from initialSpec if provided ──────────────────────────────────
    // We'll call loadFlow after creating the store when initialSpec is set,
    // but we also provide sensible defaults here so the store is always valid.
    const initial: Pick<CanvasStore,
      'nodes' | 'edges' | 'flowMeta' | 'stateSchema' | 'agents' |
      'memoryStores' | 'tools' | 'modelDefaults' | 'flowConfig' | '_nodeCounter'
    > = {
      nodes: [], edges: [], flowMeta: defaultMeta(),
      stateSchema: null, agents: [], memoryStores: {}, tools: {},
      modelDefaults: {}, flowConfig: {}, _nodeCounter: 0,
    }

    return {
      ...initial,

      // ── Transient UI ───────────────────────────────────────────────────
      selectedNodeId:  null,
      isPanelOpen:     false,
      selectedEdgeId:  null,
      isEdgePanelOpen: false,
      theme:           'dark',
      zodErrors:       null,
      crossRefErrors:  [],
      past:            [],
      future:          [],
      canUndo:         false,
      canRedo:         false,
      execStats:       {},

      // ── Internal ───────────────────────────────────────────────────────
      _pushHistory: () => {
        const s = get()
        const snap = _snapshot(s)
        set({
          past:     [...s.past, snap].slice(-MAX_HISTORY),
          future:   [],
          canUndo:  true,
          canRedo:  false,
        })
      },

      // ── ReactFlow event handlers ───────────────────────────────────────
      onNodesChange: (changes) => {
        if (changes.some((c) => c.type === 'remove' || c.type === 'add')) get()._pushHistory()
        set((s) => ({ nodes: applyNodeChanges(changes, s.nodes) as CanvasNode[] }))
      },
      onEdgesChange: (changes) => {
        if (changes.some((c) => c.type === 'remove' || c.type === 'add')) get()._pushHistory()
        set((s) => ({ edges: applyEdgeChanges(changes, s.edges) }))
      },
      onConnect: (conn) => {
        get()._pushHistory()
        set((s) => {
          const src = s.nodes.find((n) => n.id === conn.source)
          const edgeType =
            src?.type === 'condition'       ? 'conditional' :
            src?.type === 'parallel_fork'   ? 'parallel'    :
            src?.type === 'hitl_breakpoint' ? 'hitl'        :
            'direct'
          return {
            edges: addEdge(
              { ...conn, type: edgeType, data: { label: '', context_from: [] } },
              s.edges,
            ),
          }
        })
      },

      // ── Node ops ──────────────────────────────────────────────────────
      addNode: (type, position) => {
        get()._pushHistory()
        set((s) => {
          const counter = s._nodeCounter + 1
          const id = newNodeId(type, counter)
          return {
            nodes: [...s.nodes, { id, type, position, data: { ...(NODE_DEFAULTS[type] ?? { label: type }) } }],
            selectedNodeId: id,
            isPanelOpen:    true,
            _nodeCounter:   counter,
          }
        })
      },

      addAnnotation: (position) => {
        set((s) => {
          const counter = s._nodeCounter + 1
          const id = newNodeId('annotation', counter)
          return {
            nodes: [...s.nodes, { id, type: 'annotation', position, data: { text: '', colorKey: 'yellow' } }],
            _nodeCounter: counter,
          }
        })
      },

      insertNodeOnEdge: (edgeId, type) => {
        get()._pushHistory()
        set((s) => {
          const counter = s._nodeCounter + 1
          const nodeId  = newNodeId(type, counter)
          const edge    = s.edges.find((e) => e.id === edgeId)
          if (!edge) return {}
          const src = s.nodes.find((n) => n.id === edge.source)
          const tgt = s.nodes.find((n) => n.id === edge.target)
          const position = src && tgt
            ? {
                x: (src.position.x + NODE_W / 2 + tgt.position.x + NODE_W / 2) / 2 - NODE_W / 2,
                y: (src.position.y + NODE_H / 2 + tgt.position.y + NODE_H / 2) / 2 - NODE_H / 2,
              }
            : { x: 300, y: 200 }
          const newNode = { id: nodeId, type, position, data: { ...(NODE_DEFAULTS[type] ?? { label: type }) } }
          const typeFor = (sourceId: string): string => {
            const n = s.nodes.find((x) => x.id === sourceId)
            return n?.type === 'condition'       ? 'conditional'
                 : n?.type === 'parallel_fork'   ? 'parallel'
                 : n?.type === 'hitl_breakpoint' ? 'hitl'
                 : 'direct'
          }
          const edgeA = { id: `e-${edge.source}-${nodeId}`, source: edge.source, target: nodeId, type: typeFor(edge.source), data: { label: '', context_from: [] } }
          const edgeB = { id: `e-${nodeId}-${edge.target}`, source: nodeId,      target: edge.target, type: 'direct', data: { label: '', context_from: [] } }
          return {
            nodes: [...s.nodes, newNode],
            edges: [...s.edges.filter((e) => e.id !== edgeId), edgeA, edgeB],
            selectedNodeId: nodeId,
            isPanelOpen:    true,
            _nodeCounter:   counter,
          }
        })
      },

      updateNodeData: (id, data) => {
        if (_updateDebounceTimer !== null) clearTimeout(_updateDebounceTimer)
        _updateDebounceTimer = setTimeout(() => {
          get()._pushHistory()
          _updateDebounceTimer = null
        }, 600)
        set((s) => ({
          nodes: s.nodes.map((n) => n.id === id ? { ...n, data: { ...n.data, ...data } } : n),
        }))
      },

      deleteNode: (id) => {
        get()._pushHistory()
        set((s) => {
          const { [id]: _removed, ...remainingStats } = s.execStats
          return {
            nodes:          s.nodes.filter((n) => n.id !== id),
            edges:          s.edges.filter((e) => e.source !== id && e.target !== id),
            selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
            isPanelOpen:    s.selectedNodeId === id ? false : s.isPanelOpen,
            execStats:      remainingStats,
          }
        })
      },

      selectNode: (id) => set({ selectedNodeId: id, isPanelOpen: id !== null, selectedEdgeId: null, isEdgePanelOpen: false }),
      closePanel: ()   => set({ selectedNodeId: null, isPanelOpen: false }),

      // ── Edge ops ──────────────────────────────────────────────────────
      updateEdgeData: (id, data) => {
        if (_updateDebounceTimer !== null) clearTimeout(_updateDebounceTimer)
        _updateDebounceTimer = setTimeout(() => {
          get()._pushHistory()
          _updateDebounceTimer = null
        }, 600)
        set((s) => ({
          edges: s.edges.map((e) => e.id === id ? { ...e, data: { ...(e.data ?? {}), ...data } } : e),
        }))
      },
      selectEdge:     (id) => set({ selectedEdgeId: id, isEdgePanelOpen: id !== null, selectedNodeId: null, isPanelOpen: false }),
      closeEdgePanel: ()   => set({ selectedEdgeId: null, isEdgePanelOpen: false }),
      deleteEdge: (id) => {
        get()._pushHistory()
        set((s) => ({
          edges:           s.edges.filter((e) => e.id !== id),
          selectedEdgeId:  s.selectedEdgeId === id ? null : s.selectedEdgeId,
          isEdgePanelOpen: s.selectedEdgeId === id ? false : s.isEdgePanelOpen,
        }))
      },

      // ── Registry setters ──────────────────────────────────────────────
      setFlowMeta:       (meta)   => set((s) => ({ flowMeta: { ...s.flowMeta, ...meta } })),
      setStateSchema:    (schema) => set({ stateSchema: schema }),
      setAgents:         (agents) => set({ agents }),
      setMemoryStores:   (stores) => set({ memoryStores: stores }),
      setTools:          (tools)  => set({ tools }),
      setModelDefaults:  (d)      => set({ modelDefaults: d }),
      setFlowConfig:     (c)      => set({ flowConfig: c }),
      setCrossRefErrors: (errors) => set({ crossRefErrors: errors }),
      setNodeExecStat:   (nodeId, stat) => set((s) => ({ execStats: { ...s.execStats, [nodeId]: stat } })),
      clearExecStats:    ()       => set({ execStats: {} }),

      // ── Theme ─────────────────────────────────────────────────────────
      // Note: the embeddable canvas applies data-theme to its own root div,
      // not document.documentElement, so the host app's theme is unaffected.
      setTheme: (t) => set({ theme: t }),

      // ── Undo / Redo ───────────────────────────────────────────────────
      undo: () => set((s) => {
        if (!s.past.length) return {}
        const prev   = s.past[s.past.length - 1]
        const past   = s.past.slice(0, -1)
        const future = [_snapshot(s), ...s.future].slice(0, MAX_HISTORY)
        return { ...prev, past, future, canUndo: past.length > 0, canRedo: true, execStats: {} }
      }),
      redo: () => set((s) => {
        if (!s.future.length) return {}
        const next   = s.future[0]
        const future = s.future.slice(1)
        const past   = [...s.past, _snapshot(s)].slice(-MAX_HISTORY)
        return { ...next, past, future, canUndo: true, canRedo: future.length > 0, execStats: {} }
      }),

      // ── Auto-layout ───────────────────────────────────────────────────
      autoLayout: () => {
        get()._pushHistory()
        set((s) => {
          const annotations = s.nodes.filter((n) => n.type === 'annotation')
          const flowNodes   = s.nodes.filter((n) => n.type !== 'annotation')
          const laidOut     = computeLayout(flowNodes, s.edges)
          return { nodes: [...laidOut, ...annotations] }
        })
      },

      // ── Load flow ─────────────────────────────────────────────────────
      loadFlow: (spec) => {
        if (_updateDebounceTimer !== null) {
          clearTimeout(_updateDebounceTimer)
          _updateDebounceTimer = null
        }
        const nodes: CanvasNode[] = spec.nodes.map((n) => {
          const { id, type, position, label, description, runtime_support, ...rest } = n as Record<string, unknown>
          return {
            id: id as string, type: type as string,
            position: (position as { x: number; y: number }) ?? { x: 0, y: 0 },
            data: { label, description, runtime_support, ...rest },
          }
        })

        const edges: XYEdge[] = spec.edges.flatMap((e, i) => {
          if (e.type === 'conditional') {
            const branchEdges: XYEdge[] = e.branches.map((branch, bi) => ({
              id:     `${e.id ?? `e-${i}`}-b${bi}`,
              source: e.from,
              target: branch.to,
              type:   'conditional',
              data:   { label: branch.label ?? '' },
            }))
            const branchTargets = new Set(e.branches.map((b) => b.to))
            if (!branchTargets.has(e.default_target)) {
              branchEdges.push({
                id:     `${e.id ?? `e-${i}`}-default`,
                source: e.from,
                target: e.default_target,
                type:   'conditional',
                data:   { label: 'default' },
              })
            }
            return branchEdges
          }
          const edgeData   = (e as Record<string, unknown>).data as Record<string, unknown> | undefined
          const visualType = (edgeData?.visual_type as string | undefined) ?? 'direct'
          return [{
            id: e.id ?? `e-${i}`, source: e.from, target: e.to,
            type: visualType,
            data: { label: e.label ?? '', context_from: e.context_from ?? [] },
          }]
        })

        const maxCounter = nodes.reduce((max, n) => {
          const m = n.id.match(/\d+$/)
          return m ? Math.max(max, parseInt(m[0], 10)) : max
        }, 0)

        set({
          nodes, edges,
          flowMeta: {
            id: spec.id, name: spec.name ?? spec.id, description: spec.description ?? '',
            runtimeHints: { preferred_adapter: spec.runtime_hints?.preferred_adapter, compatible: spec.runtime_hints?.compatible },
          },
          stateSchema:   spec.state_schema ?? null,
          agents:        spec.agents ?? [],
          memoryStores:  spec.memory_stores ?? {},
          tools:         spec.tools ?? {},
          modelDefaults: spec.model_defaults ?? {},
          flowConfig:    spec.flow_config ?? {},
          selectedNodeId: null, isPanelOpen: false,
          selectedEdgeId: null, isEdgePanelOpen: false,
          zodErrors: null, crossRefErrors: [],
          past: [], future: [], canUndo: false, canRedo: false,
          _nodeCounter: maxCounter,
        })
      },

      // ── Export spec ───────────────────────────────────────────────────
      exportSpec: () => {
        const s = get()

        const conditionNodeIds = new Set(
          s.nodes.filter((n) => n.type === 'condition').map((n) => n.id)
        )

        const serialisedEdges = [
          ...s.nodes
            .filter((n) => n.type === 'condition')
            .map((n) => {
              const d = n.data as Record<string, unknown>
              type RawBranch = { condition: Record<string, unknown>; target: string; label?: string }
              const nodeBranches = (d.branches as RawBranch[] | undefined) ?? []
              return {
                type:           'conditional' as const,
                id:             `ce-${n.id}`,
                from:           n.id,
                branches:       nodeBranches.map((b) => ({ condition: b.condition, to: b.target, label: b.label })),
                default_target: (d.default_target as string) ?? '',
              }
            }),

          ...s.edges
            .filter((e) => !conditionNodeIds.has(e.source))
            .map((e) => {
              const d = (e.data ?? {}) as Record<string, unknown>
              return {
                type:         'direct' as const,
                id:           e.id,
                from:         e.source,
                to:           e.target,
                label:        (d.label as string | undefined) || undefined,
                context_from: (d.context_from as string[] | undefined)?.length ? d.context_from : undefined,
                data:         e.type !== 'direct' ? { ...d, visual_type: e.type } : undefined,
              }
            }),
        ]

        const raw = {
          spec_version:   '0.2.0',
          id:             s.flowMeta.id,
          name:           s.flowMeta.name || undefined,
          description:    s.flowMeta.description || undefined,
          runtime_hints:  Object.keys(s.flowMeta.runtimeHints).length ? s.flowMeta.runtimeHints : undefined,
          state_schema:   s.stateSchema ?? undefined,
          agents:         s.agents.length ? s.agents : undefined,
          memory_stores:  Object.keys(s.memoryStores).length ? s.memoryStores : undefined,
          tools:          Object.keys(s.tools).length ? s.tools : undefined,
          model_defaults: Object.keys(s.modelDefaults).length ? s.modelDefaults : undefined,
          flow_config:    Object.keys(s.flowConfig).length ? s.flowConfig : undefined,
          nodes: s.nodes
            .filter((n) => n.type !== 'annotation')
            .map((n) => ({ id: n.id, type: n.type, position: n.position, ...n.data })),
          edges: serialisedEdges,
        }

        const result = parseFlowSpec(raw)
        if (!result.success) {
          set({ zodErrors: result.error })
          return null
        }
        set({ zodErrors: null })
        return result.data
      },

      // ── Validate ──────────────────────────────────────────────────────
      validate: () => {
        const spec = get().exportSpec()
        if (!spec) { set({ crossRefErrors: [] }); return false }
        const errors = validateCrossRefs(spec)
        set({ crossRefErrors: errors, zodErrors: null })
        return errors.filter((e) => !e.severity || e.severity === 'error').length === 0
      },

      // ── New flow ──────────────────────────────────────────────────────
      newFlow: () => {
        if (_updateDebounceTimer !== null) {
          clearTimeout(_updateDebounceTimer)
          _updateDebounceTimer = null
        }
        const startNode: CanvasNode = {
          id: 'input-1', type: 'input',
          position: { x: 140, y: 200 },
          data: { label: 'Start', output_schema: {} },
        }
        set({
          nodes: [startNode], edges: [], flowMeta: defaultMeta(),
          stateSchema: null, agents: [], memoryStores: {}, tools: {},
          modelDefaults: {}, flowConfig: {},
          selectedNodeId: null, isPanelOpen: false,
          selectedEdgeId: null, isEdgePanelOpen: false,
          zodErrors: null, crossRefErrors: [],
          past: [], future: [], canUndo: false, canRedo: false,
          _nodeCounter: 1,
        })
      },
    }
  })
}

export type CanvasStoreApi = ReturnType<typeof createCanvasStore>
