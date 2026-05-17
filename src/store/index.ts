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

// Fix #28: Snapshot now captures the full spec state so undo/redo is complete.
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

export type SettingsTab = 'meta' | 'state' | 'memory' | 'tools' | 'agents' | 'config'

// ─── PersistedState — the slice written to localStorage ──────────────────────

export interface PersistedState {
  nodes:          CanvasNode[]
  edges:          XYEdge[]
  flowMeta:       FlowMeta
  stateSchema:    StateSchema | null
  agents:         AgentDef[]
  memoryStores:   Record<string, MemoryStoreDef>
  tools:          Record<string, ToolDef>
  modelDefaults:  ModelDefaults
  flowConfig:     FlowConfig
  // Fix #26: counter persisted inside the store so HMR resets don't cause
  // duplicate node IDs. Previously lived as a module-level mutable.
  _nodeCounter:   number
  lastModifiedAt: number
}

// ─── Full store shape (persisted + transient) ─────────────────────────────────

export interface NodeExecStat {
  status:  'pending' | 'running' | 'paused' | 'done' | 'error'
  tokens?: number
  ms?:     number
}

export interface HitlState {
  jobId:        string
  nodeId:       string
  prompt:       string
  resumeFields: string[]
}

interface CanvasStore extends PersistedState {
  // Transient UI state — not persisted
  selectedNodeId:  string | null
  isPanelOpen:     boolean
  selectedEdgeId:  string | null
  isEdgePanelOpen: boolean
  isSettingsOpen:  boolean
  settingsTab:     SettingsTab
  isProblemsOpen:  boolean
  // Fix #29: zodErrors and crossRefErrors are set only by validate(), not by exportSpec()
  zodErrors:       z.ZodError | null
  crossRefErrors:  ValidationError[]
  setCrossRefErrors: (errors: ValidationError[]) => void
  past:            Snapshot[]
  future:          Snapshot[]
  canUndo:         boolean
  canRedo:         boolean
  execStats:       Record<string, NodeExecStat>
  activeJobId:     string | null
  hitlState:       HitlState | null
  traceUrl:        string | null

  // ReactFlow handlers
  onNodesChange: (c: NodeChange[]) => void
  onEdgesChange: (c: EdgeChange[]) => void
  onConnect:     (c: Connection) => void

  // Node ops
  addNode:            (type: NodeType, pos: { x: number; y: number }) => void
  addAnnotation:      (pos: { x: number; y: number }) => void
  insertNodeOnEdge:   (edgeId: string, type: NodeType) => void
  updateNodeData:     (id: string, data: Partial<NodeData>) => void
  deleteNode:         (id: string) => void
  selectNode:         (id: string | null) => void
  closePanel:         () => void

  // Edge ops
  updateEdgeData:  (id: string, data: Partial<Record<string, unknown>>) => void
  selectEdge:      (id: string | null) => void
  closeEdgePanel:  () => void
  deleteEdge:      (id: string) => void   // Fix #32: delete selected edge

  // Settings / panels
  openSettings:   (tab?: SettingsTab) => void
  closeSettings:  () => void
  setSettingsTab: (tab: SettingsTab) => void
  toggleProblems:    () => void
  setNodeExecStat:   (nodeId: string, stat: NodeExecStat) => void
  clearExecStats:    () => void
  setActiveJob:      (jobId: string | null) => void
  setHitlState:      (state: HitlState | null) => void
  setTraceUrl:       (url: string | null) => void

  // Flow ops
  loadFlow:   (spec: FlowSpec) => void
  // Fix #29: exportSpec no longer mutates zodErrors as a side-effect.
  // Call validate() explicitly to surface validation errors in the UI.
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
  _touch:           () => void
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function defaultMeta(): FlowMeta {
  return {
    id: 'my-flow', name: 'My Flow', description: '',
    runtimeHints: { preferred_adapter: 'langgraph', compatible: ['langgraph'] },
  }
}

// Fix #26: ID generation now reads/writes the persisted _nodeCounter from the store.
// Called via get()._nodeCounter inside set() — see addNode, addAnnotation.
function newNodeId(type: NodeType | 'annotation', counter: number) {
  return `${(type as string).replace(/_/g, '-')}-${counter}`
}

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
  g.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 100, marginx: 60, marginy: 60 })
  nodes.forEach((n) => g.setNode(n.id, { width: 248, height: 86 }))
  edges.forEach((e) => { try { g.setEdge(e.source, e.target) } catch {} })
  dagre.layout(g)
  return nodes.map((n) => {
    const p = g.node(n.id)
    return p ? { ...n, position: { x: p.x - 124, y: p.y - 43 } } : n
  })
}

// Fix #28: capture full spec state for undo, not just nodes+edges.
function _snapshot(s: PersistedState): Snapshot {
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

// Fix #15: debounce timer for updateNodeData history pushes.
// Typing in a text field calls updateNodeData on every keystroke; pushing a
// snapshot per keystroke fills the 50-entry undo history in seconds.
// We wait 600 ms of inactivity before committing a snapshot.
let _updateDebounceTimer: ReturnType<typeof setTimeout> | null = null
const MAX_HISTORY     = 50  // Fix: MAX_HISTORY was referenced but never defined — undo/redo crashed at runtime
const STORAGE_KEY    = 'itsharness:current'
const STORAGE_VERSION = 2   // bumped from 1 → 2 for Snapshot schema change

// ─── Store ───────────────────────────────────────────────────────────────────

export const useCanvasStore = create<CanvasStore>()(
  persist(
    (set, get) => ({
      // ── Persisted initial values ──────────────────────────────────────────
      nodes: [], edges: [],
      flowMeta: defaultMeta(), stateSchema: null,
      agents: [], memoryStores: {}, tools: {}, modelDefaults: {}, flowConfig: {},
      _nodeCounter:   0,   // Fix #26
      lastModifiedAt: Date.now(),

      // ── Transient initial values ──────────────────────────────────────────
      selectedNodeId: null, isPanelOpen: false,
      selectedEdgeId: null, isEdgePanelOpen: false,
      isSettingsOpen: false, settingsTab: 'meta' as SettingsTab,
      isProblemsOpen: false,
      execStats: {},
      activeJobId: null, hitlState: null, traceUrl: null, zodErrors: null, crossRefErrors: [],
      past: [], future: [], canUndo: false, canRedo: false,

      // ── Internal helpers ──────────────────────────────────────────────────
      _touch: () => set({ lastModifiedAt: Date.now() }),
      _pushHistory: () => set((s) => ({
        // Fix #28: use full snapshot
        past: [...s.past, _snapshot(s)].slice(-MAX_HISTORY),
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
            lastModifiedAt: Date.now(),
          }
        })
      },

      // ── Node ops ──────────────────────────────────────────────────────────
      addNode: (type, position) => {
        get()._pushHistory()
        set((s) => {
          const counter = s._nodeCounter + 1
          const id      = newNodeId(type, counter)
          return {
            nodes: [...s.nodes, { id, type, position, data: { ...(NODE_DEFAULTS[type] ?? { label: type }) } }],
            _nodeCounter:   counter,
            lastModifiedAt: Date.now(),
          }
        })
      },

      addAnnotation: (position) => {
        get()._pushHistory()
        set((s) => {
          const counter = s._nodeCounter + 1
          const id      = `annotation-${counter}`
          return {
            nodes: [...s.nodes, { id, type: 'annotation', position, data: { text: '', colorKey: 'yellow' } }],
            _nodeCounter:   counter,
            lastModifiedAt: Date.now(),
          }
        })
      },

      insertNodeOnEdge: (edgeId, type) => {
        get()._pushHistory()
        set((s) => {
          const edge = s.edges.find((e) => e.id === edgeId)
          if (!edge) return {}
          const counter = s._nodeCounter + 1
          const nodeId  = newNodeId(type, counter)
          const src = s.nodes.find((n) => n.id === edge.source)
          const tgt = s.nodes.find((n) => n.id === edge.target)
          // Fix #31: account for node dimensions (248×86) when computing midpoint.
          const NODE_W = 248, NODE_H = 86
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
          const edgeB = { id: `e-${nodeId}-${edge.target}`, source: nodeId, target: edge.target, type: 'direct', data: { label: '', context_from: [] } }
          return {
            nodes: [...s.nodes, newNode],
            edges: [...s.edges.filter((e) => e.id !== edgeId), edgeA, edgeB],
            selectedNodeId: nodeId, isPanelOpen: true,
            _nodeCounter:   counter,
            lastModifiedAt: Date.now(),
          }
        })
      },

      // Fix #15: updateNodeData uses a debounced history push so that typing in a
      // config panel field doesn't create one undo snapshot per character.
      // The snapshot is committed 600 ms after the last consecutive keystroke.
      updateNodeData: (id, data) => {
        if (_updateDebounceTimer !== null) clearTimeout(_updateDebounceTimer)
        _updateDebounceTimer = setTimeout(() => {
          get()._pushHistory()
          _updateDebounceTimer = null
        }, 600)
        set((s) => ({
          nodes: s.nodes.map((n) => n.id === id ? { ...n, data: { ...n.data, ...data } } : n),
          lastModifiedAt: Date.now(),
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
            lastModifiedAt: Date.now(),
          }
        })
      },
      selectNode:    (id) => set({ selectedNodeId: id, isPanelOpen: id !== null, selectedEdgeId: null, isEdgePanelOpen: false }),
      closePanel:    ()   => set({ selectedNodeId: null, isPanelOpen: false }),

      // ── Edge ops ──────────────────────────────────────────────────────────
      updateEdgeData: (id, data) => {
        // Push history so edge label / context_from edits are undoable.
        // Use the same debounce pattern as updateNodeData so typing in the
        // EdgeConfigPanel doesn't create one snapshot per character.
        if (_updateDebounceTimer !== null) clearTimeout(_updateDebounceTimer)
        _updateDebounceTimer = setTimeout(() => {
          get()._pushHistory()
          _updateDebounceTimer = null
        }, 600)
        set((s) => ({
          edges: s.edges.map((e) => e.id === id ? { ...e, data: { ...(e.data ?? {}), ...data } } : e),
          lastModifiedAt: Date.now(),
        }))
      },
      selectEdge:    (id) => set({ selectedEdgeId: id, isEdgePanelOpen: id !== null, selectedNodeId: null, isPanelOpen: false }),
      closeEdgePanel: ()  => set({ selectedEdgeId: null, isEdgePanelOpen: false }),
      // Fix #32: delete the currently selected edge
      deleteEdge: (id) => {
        get()._pushHistory()
        set((s) => ({
          edges:          s.edges.filter((e) => e.id !== id),
          selectedEdgeId: s.selectedEdgeId === id ? null : s.selectedEdgeId,
          isEdgePanelOpen: s.selectedEdgeId === id ? false : s.isEdgePanelOpen,
          lastModifiedAt: Date.now(),
        }))
      },

      // ── Settings ──────────────────────────────────────────────────────────
      openSettings:   (tab = 'meta') => set({ isSettingsOpen: true,  settingsTab: tab }),
      closeSettings:  ()             => set({ isSettingsOpen: false }),
      setSettingsTab: (tab)          => set({ settingsTab: tab }),
      toggleProblems:  ()            => set((s) => ({ isProblemsOpen: !s.isProblemsOpen })),
      setNodeExecStat: (nodeId, stat) => set((s) => ({ execStats: { ...s.execStats, [nodeId]: stat } })),
      clearExecStats:  ()            => set({ execStats: {} }),
      setActiveJob:    (jobId)       => set({ activeJobId: jobId }),
      setHitlState:    (state)       => set({ hitlState: state }),
      setTraceUrl:     (url)         => set({ traceUrl: url }),
      setCrossRefErrors: (errors)    => set({ crossRefErrors: errors }),

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
        const future = [_snapshot(s), ...s.future].slice(0, MAX_HISTORY)
        return {
          // Fix #28: restore full snapshot
          ...prev,
          past, future, canUndo: past.length > 0, canRedo: true,
          execStats: {}, traceUrl: null, lastModifiedAt: Date.now(),
        }
      }),
      redo: () => set((s) => {
        if (!s.future.length) return {}
        const next   = s.future[0]
        const future = s.future.slice(1)
        const past   = [...s.past, _snapshot(s)].slice(-MAX_HISTORY)
        return {
          // Fix #28: restore full snapshot
          ...next,
          past, future, canUndo: true, canRedo: future.length > 0,
          execStats: {}, lastModifiedAt: Date.now(),
        }
      }),

      // ── Auto-layout ───────────────────────────────────────────────────────
      autoLayout: () => {
        get()._pushHistory()
        set((s) => {
          const annotations = s.nodes.filter((n) => n.type === 'annotation')
          const flowNodes   = s.nodes.filter((n) => n.type !== 'annotation')
          const laidOut     = computeLayout(flowNodes, s.edges)
          return { nodes: [...laidOut, ...annotations], lastModifiedAt: Date.now() }
        })
      },

      // ── Load flow ─────────────────────────────────────────────────────────
      loadFlow: (spec) => {
        // Fix #3: cancel any pending debounced _pushHistory() from a previous
        // editing session so it doesn't write a stale snapshot onto this flow's
        // fresh undo stack 600 ms after the load.
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

        // Map spec edges → ReactFlow edges.
        // ConditionalEdge: create one visual ReactFlow edge per branch + one for the
        // default target (if it differs from all branch targets).  These edges carry
        // minimal routing data; the canonical branch spec is already on the node itself
        // (loaded above via ...rest → data.branches / data.default_target).
        // exportSpec reads ConditionNode.data, not edge data, so no cargo data needed.
        const edges: XYEdge[] = spec.edges.flatMap((e, i) => {
          if (e.type === 'conditional') {
            const branchEdges: XYEdge[] = e.branches.map((branch, bi) => ({
              id:     `${e.id ?? `e-${i}`}-b${bi}`,
              source: e.from,
              target: branch.to,
              type:   'conditional',
              data:   { label: branch.label ?? '' },
            }))
            // Add a visual edge to default_target if not already a branch target.
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

        // Fix #26: derive a safe counter from loaded node IDs to avoid collisions.
        const maxCounter = nodes.reduce((max, n) => {
          const m = n.id.match(/\d+$/)
          return m ? Math.max(max, parseInt(m[0], 10)) : max
        }, 0)

        set({
          nodes, edges,
          flowMeta: { id: spec.id, name: spec.name ?? spec.id, description: spec.description ?? '', runtimeHints: { preferred_adapter: spec.runtime_hints?.preferred_adapter, compatible: spec.runtime_hints?.compatible } },
          stateSchema: spec.state_schema ?? null, agents: spec.agents ?? [],
          memoryStores: spec.memory_stores ?? {}, tools: spec.tools ?? {},
          modelDefaults: spec.model_defaults ?? {}, flowConfig: spec.flow_config ?? {},
          selectedNodeId: null, isPanelOpen: false, selectedEdgeId: null, isEdgePanelOpen: false,
          zodErrors: null, crossRefErrors: [], past: [], future: [], canUndo: false, canRedo: false,
          _nodeCounter: maxCounter,   // Fix #26
          lastModifiedAt: Date.now(),
        })
      },

      // ── Export spec ───────────────────────────────────────────────────────
      exportSpec: () => {
        const s = get()

        // ── Fix #1: ConditionalEdge reconstruction ────────────────────────
        // ReactFlow 'conditional' edges are visual routing only; they carry no
        // canonical branch data for newly-authored flows (onConnect sets only
        // { label:'', context_from:[] }).  The authoritative branch spec lives
        // on the ConditionNode itself (data.branches / data.default_target),
        // edited via ConfigPanel — exactly the same pattern as ParallelForkNode
        // which writes targets directly into node data.
        //
        // Strategy: for each condition node, build ONE ConditionalEdge from
        // node.data.  ReactFlow edges that depart from the same source are
        // purely presentational and are not separately serialised.
        const conditionNodeIds = new Set(
          s.nodes.filter((n) => n.type === 'condition').map((n) => n.id)
        )

        const serialisedEdges = [
          // One ConditionalEdge per condition node, sourced from node data.
          ...s.nodes
            .filter((n) => n.type === 'condition')
            .map((n) => {
              const d = n.data as Record<string, unknown>
              type RawBranch = { condition: Record<string,unknown>; target: string; label?: string }
              const nodeBranches = (d.branches as RawBranch[] | undefined) ?? []
              return {
                type:           'conditional' as const,
                // Derive a stable edge ID from the node ID.
                id:             `ce-${n.id}`,
                from:           n.id,
                branches:       nodeBranches.map((b) => ({
                                  condition: b.condition,
                                  to:        b.target,   // node schema uses 'target', edge schema uses 'to'
                                  label:     b.label,
                                })),
                default_target: (d.default_target as string) ?? '',
              }
            }),

          // All non-conditional edges (condition-source edges are visual only).
          // Fix #5: non-direct edge types (parallel, hitl) are serialised as type='direct'
          // with the real type stored in data.visual_type.  This is intentional:
          //   • The canonical FlowSpec schema has no parallel/hitl edge type — parallel
          //     fan-out is expressed via ParallelForkNode.targets, HITL via the node itself.
          //   • loadFlow reads data.visual_type back via `(edgeData?.visual_type) ?? 'direct'`
          //     so the canvas visual style is preserved across save/load.
          //   • The adapter ignores data.visual_type entirely — semantics come from nodes.
          // Any new visual-only edge type must follow the same pattern.
          ...s.edges
            .filter((e) => !conditionNodeIds.has(e.source))
            .map((e) => {
              const d = (e.data ?? {}) as Record<string, unknown>
              return {
                type:         'direct' as const,
                id:           e.id,
                from:         e.source,
                to:           e.target,
                label:        d.label as string | undefined || undefined,
                context_from: (d.context_from as string[] | undefined)?.length
                                ? d.context_from : undefined,
                data:         e.type !== 'direct'
                                ? { ...d, visual_type: e.type } : undefined,
              }
            }),
        ]

        const raw = {
          spec_version: '0.2.0', id: s.flowMeta.id,
          name:          s.flowMeta.name || undefined,
          description:   s.flowMeta.description || undefined,
          runtime_hints: Object.keys(s.flowMeta.runtimeHints).length
                           ? s.flowMeta.runtimeHints : undefined,
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

      // ── Validate ──────────────────────────────────────────────────────────
      validate: () => {
        const spec = get().exportSpec()
        if (!spec) {
          set({ crossRefErrors: [] })
          return false
        }
        const errors = validateCrossRefs(spec)
        set({ crossRefErrors: errors, zodErrors: null })
        return errors.filter((e) => !e.severity || e.severity === 'error').length === 0
      },

      // ── New flow ──────────────────────────────────────────────────────────
      newFlow: () => {
        // Fix #3: cancel pending debounced snapshot so it doesn't corrupt the
        // new flow's undo stack with state from the previous flow.
        if (_updateDebounceTimer !== null) {
          clearTimeout(_updateDebounceTimer)
          _updateDebounceTimer = null
        }
        set({
          nodes: [], edges: [], flowMeta: defaultMeta(), stateSchema: null,
          agents: [], memoryStores: {}, tools: {}, modelDefaults: {}, flowConfig: {},
          selectedNodeId: null, isPanelOpen: false, selectedEdgeId: null, isEdgePanelOpen: false,
          zodErrors: null, crossRefErrors: [], past: [], future: [], canUndo: false, canRedo: false,
          _nodeCounter: 0,   // Fix #26
          lastModifiedAt: Date.now(),
        })
      },
    }),

    // ── Persist config ────────────────────────────────────────────────────────
    {
      name:    STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: STORAGE_VERSION,

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
        _nodeCounter:   state._nodeCounter,   // Fix #26
        lastModifiedAt: state.lastModifiedAt,
      }),

      migrate: (persisted, version) => {
        if (version === 0) {
          return {
            ...(persisted as object),
            lastModifiedAt: Date.now(),
            _nodeCounter:   0,
            // Explicit defaults for all v0.4 fields — don't rely on Zustand merge behaviour
            stateSchema:   null,
            agents:        [],
            memoryStores:  {},
            tools:         {},
            modelDefaults: {},
            flowConfig:    {},
          }
        }
        if (version === 1) {
          // v1 → v2: add _nodeCounter + ensure v0.4 fields exist
          return {
            ...(persisted as object),
            _nodeCounter:  0,
            stateSchema:   (persisted as PersistedState).stateSchema   ?? null,
            agents:        (persisted as PersistedState).agents         ?? [],
            memoryStores:  (persisted as PersistedState).memoryStores   ?? {},
            tools:         (persisted as PersistedState).tools          ?? {},
            modelDefaults: (persisted as PersistedState).modelDefaults  ?? {},
            flowConfig:    (persisted as PersistedState).flowConfig     ?? {},
          }
        }
        if (version === 2) {
          // Current version — no migration needed.
          return persisted
        }
        // version > STORAGE_VERSION: this browser has data from a future app version
        // (e.g. user ran a newer build then rolled back). The persisted state may have
        // fields that no longer exist or renamed fields that will cause runtime errors.
        // Safest option: reset to empty rather than silently corrupt state.
        console.warn(
          `[itsharness] stored state version ${version} is newer than app version ${STORAGE_VERSION}. ` +
          'Resetting canvas to avoid incompatible state.'
        )
        return {}
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
