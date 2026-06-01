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
import type { EvalScore } from '../services/api'

export interface A2ADeployment {
  flow_id:      string
  endpoint_url: string
  agent_card:   Record<string, unknown>
  deployed_at:  string
}

export interface UnifiedDeployment {
  flow_id:       string
  rest_url:      string
  mcp_url:       string
  a2a_url:       string | null
  shareable_url: string
  mcp_manifest:  Record<string, unknown>
  deployed_at:   string
}

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

export interface FlowMeta {
  id: string; name: string; description: string
  runtimeHints: { preferred_adapter?: AdapterName; compatible?: AdapterName[] }
}

export type SettingsTab = 'meta' | 'state' | 'memory' | 'tools' | 'agents' | 'config' | 'appearance'

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
  /**
   * Stable UUID used as the Yjs room identifier for real-time collaboration.
   * Unlike flowMeta.id (which the user can rename), this never changes once
   * a flow is created — so renaming a flow doesn't disconnect collaborators.
   * Set to a new UUID by newFlow() and loadFlow(). Persisted to localStorage.
   */
  _collabRoomKey: string
}

// ─── Full store shape (persisted + transient) ─────────────────────────────────

export interface NodeExecStat {
  status:        'pending' | 'running' | 'paused' | 'done' | 'error'
  tokens?:       number
  ms?:           number
  /** Present only when status="error". The raw exception message from the adapter. */
  errorMessage?: string
  /**
   * LLM-as-judge quality score in [0, 1] fetched from Langfuse after a run
   * completes.  Renders as a coloured arc on the ExecBadge:
   *   > 0.8  → green   (good)
   *   0.5–0.8 → amber  (warn)
   *   < 0.5  → red     (poor)
   * Absent when Langfuse is not configured or the score is not yet available.
   */
  score?:  number
}

export interface HitlState {
  jobId:        string
  nodeId:       string
  prompt:       string
  resumeFields: string[]
}

export interface CanvasStore extends PersistedState {
  // Transient UI state — not persisted
  selectedNodeId:  string | null
  isPanelOpen:     boolean
  selectedEdgeId:  string | null
  isEdgePanelOpen: boolean
  isSettingsOpen:  boolean
  settingsTab:     SettingsTab
  // §10 — Light/dark theme
  theme:           'dark' | 'light'
  // §11 — Library full-screen page
  isLibraryOpen:   boolean
  isProblemsOpen:  boolean
  // §6 Run drawer — replaces toolbar Export-JSON-as-primary affordance
  isRunDrawerOpen: boolean
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
  /** Error string from the most recent failed job. Cleared when a new run starts. */
  jobError:        string | null

  // ── Online eval / feedback state ─────────────────────────────────────────
  /** job_id of the most recently completed (done or error) job. Used by
   *  FeedbackBar to submit user thumbs signals.  Cleared when a new run starts. */
  lastCompletedJobId: string | null
  /** True once the user has submitted a thumbs signal for lastCompletedJobId. */
  feedbackSubmitted:  boolean
  /** Scores returned by GET /eval/scores for the last completed run.
   *  Keyed by the Langfuse observationId so ExecBadge can look up a score
   *  once the node_id → observationId mapping is wired (Phase 3 follow-up). */
  evalScores:         EvalScore[]

  // ── A2A deployment state ─────────────────────────────────────────────────
  /** Populated by the Deploy button after POST /deploy/a2a/{flow_id} succeeds.
   *  Cleared when the active flow changes (newFlow / loadFlow). */
  a2aDeployment:      A2ADeployment | null
  /** True while POST /deploy/a2a is in flight — disables the deploy button. */
  a2aDeploying:       boolean

  // ── Unified deployment state ─────────────────────────────────────────────
  /** Populated by the Deploy button after POST /deploy/{flow_id} succeeds.
   *  Contains REST, MCP, A2A, and shareable URLs. Cleared on flow change. */
  unifiedDeployment:  UnifiedDeployment | null
  /** True while POST /deploy/{flow_id} is in flight. */
  unifiedDeploying:   boolean

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
  // §10 — theme toggle
  setTheme:       (t: 'dark' | 'light') => void
  // §11 — library page
  openLibrary:    () => void
  closeLibrary:   () => void
  toggleProblems:       () => void
  openRunDrawer:        () => void
  closeRunDrawer:       () => void
  setNodeExecStat:      (nodeId: string, stat: NodeExecStat) => void
  clearExecStats:       () => void
  setActiveJob:         (jobId: string | null) => void
  setHitlState:         (state: HitlState | null) => void
  setTraceUrl:          (url: string | null) => void
  setJobError:          (err: string | null) => void
  /** Called by runPoller when a job reaches 'done' or 'error'.
   *  Stores the jobId for FeedbackBar and resets the per-run feedback state. */
  setLastCompleted:     (jobId: string) => void
  /** Called by FeedbackBar once the thumbs signal has been submitted. */
  setFeedbackSubmitted: () => void
  /** Called by runPoller with scores fetched from GET /eval/scores. */
  setEvalScores:        (scores: EvalScore[]) => void
  setA2ADeployment:     (d: A2ADeployment | null) => void
  setA2ADeploying:      (v: boolean) => void
  setUnifiedDeployment: (d: UnifiedDeployment | null) => void
  setUnifiedDeploying:  (v: boolean) => void

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

  // ── Real-time collaboration (Yjs) ─────────────────────────────────────────
  /** When true, _pushHistory is a no-op — Y.UndoManager owns the undo stack. */
  _collabActive:   boolean
  /** Yjs clientID for collision-free node IDs in concurrent adds. Null in solo mode. */
  _collabClientId: number | null
  /** Live WebsocketProvider — set once collab setup completes, null in solo mode.
   *  Stored here so Canvas components (CollabStatus, CollabCursors) can read it
   *  without prop-threading through Canvas → every panel. */
  _collabWsProvider: any | null
  /** Live Awareness instance — set alongside _collabWsProvider. */
  _collabAwareness: any | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function defaultMeta(): FlowMeta {
  return {
    id: 'my-flow', name: 'My Flow', description: '',
    runtimeHints: { preferred_adapter: 'langgraph', compatible: ['langgraph'] },
  }
}

// Fix #26: ID generation now reads/writes the persisted _nodeCounter from the store.

/**
 * Collab-safe node ID generator.
 * In solo mode: "llm-call-3". In collab mode: "llm-call-3-2847391042"
 * The Yjs clientID suffix prevents two clients from producing the same ID.
 */
function newNodeIdCollab(
  type:     NodeType | 'annotation',
  counter:  number,
  clientId: number | null,
): string {
  const base = `${(type as string).replace(/_/g, '-')}-${counter}`
  return clientId !== null ? `${base}-${clientId}` : base
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
let _updateDebounceTimer: ReturnType<typeof setTimeout> | null = null
const MAX_HISTORY     = 50
const STORAGE_KEY    = 'itsharness:current'
const STORAGE_VERSION = 3

// ─── Store ───────────────────────────────────────────────────────────────────

export const useCanvasStore = create<CanvasStore>()(
  persist(
    (set, get) => ({
      // ── Persisted initial values ──────────────────────────────────────────
      nodes: [], edges: [],
      flowMeta: defaultMeta(), stateSchema: null,
      agents: [], memoryStores: {}, tools: {}, modelDefaults: {}, flowConfig: {},
      _nodeCounter:   0,
      lastModifiedAt: Date.now(),
      _collabRoomKey: crypto.randomUUID(),

      // ── Transient initial values ──────────────────────────────────────────
      selectedNodeId: null, isPanelOpen: false,
      selectedEdgeId: null, isEdgePanelOpen: false,
      isSettingsOpen: false, settingsTab: 'meta' as SettingsTab,
      // §10 — theme (read from localStorage; applied to <html> in main.tsx on boot)
      theme: (localStorage.getItem('itsharness:theme') as 'dark' | 'light') ?? 'dark',
      // §11 — library page
      isLibraryOpen: false,
      isProblemsOpen: false,
      isRunDrawerOpen: false,
      execStats: {},
      activeJobId: null, hitlState: null, traceUrl: null, jobError: null, zodErrors: null, crossRefErrors: [],
      past: [], future: [], canUndo: false, canRedo: false,
      // Online eval / feedback
      lastCompletedJobId: null,
      feedbackSubmitted:  false,
      evalScores:         [],
      // A2A deployment
      a2aDeployment: null,
      a2aDeploying:  false,

      // Unified deployment
      unifiedDeployment: null,
      unifiedDeploying:  false,

      // ── Collab ────────────────────────────────────────────────────────────
      _collabActive:    false,
      _collabClientId:  null,
      _collabWsProvider: null,
      _collabAwareness:  null,

      // ── Internal helpers ──────────────────────────────────────────────────
      _touch: () => set({ lastModifiedAt: Date.now() }),
      _pushHistory: () => {
        // No-op when collab is active — Y.UndoManager owns the undo stack.
        if (get()._collabActive) return
        set((s) => ({
          past: [...s.past, _snapshot(s)].slice(-MAX_HISTORY),
          future: [], canUndo: true, canRedo: false,
          lastModifiedAt: Date.now(),
        }))
      },

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
          const id      = newNodeIdCollab(type, counter, s._collabClientId)
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
          const id      = newNodeIdCollab('annotation', counter, s._collabClientId)
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
          const nodeId  = newNodeIdCollab(type, counter, s._collabClientId)
          const src = s.nodes.find((n) => n.id === edge.source)
          const tgt = s.nodes.find((n) => n.id === edge.target)
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

      // §10 — theme
      setTheme: (t) => {
        localStorage.setItem('itsharness:theme', t)
        document.documentElement.setAttribute('data-theme', t)
        set({ theme: t })
      },

      // §11 — library page
      openLibrary:  () => set({ isLibraryOpen: true }),
      closeLibrary: () => set({ isLibraryOpen: false }),
      toggleProblems:  ()            => set((s) => ({ isProblemsOpen: !s.isProblemsOpen })),
      openRunDrawer:   ()            => set({ isRunDrawerOpen: true }),
      closeRunDrawer:  ()            => set({ isRunDrawerOpen: false }),
      setNodeExecStat: (nodeId, stat) => set((s) => ({ execStats: { ...s.execStats, [nodeId]: stat } })),
      clearExecStats:  ()            => set({
        execStats: {},
        // Reset per-run eval/feedback state when a new run starts.
        lastCompletedJobId: null,
        feedbackSubmitted:  false,
        evalScores:         [],
      }),
      setActiveJob:    (jobId)       => set({ activeJobId: jobId }),
      setHitlState:    (state)       => set({ hitlState: state }),
      setTraceUrl:     (url)         => set({ traceUrl: url }),
      setJobError:     (err)         => set({ jobError: err }),
      setCrossRefErrors: (errors)    => set({ crossRefErrors: errors }),
      setLastCompleted:     (jobId)  => set({ lastCompletedJobId: jobId, feedbackSubmitted: false }),
      setFeedbackSubmitted: ()       => set({ feedbackSubmitted: true }),
      setEvalScores:        (scores) => set({ evalScores: scores }),
      setA2ADeployment:     (d)      => set({ a2aDeployment: d }),
      setA2ADeploying:      (v)      => set({ a2aDeploying: v }),
      setUnifiedDeployment: (d)      => set({ unifiedDeployment: d }),
      setUnifiedDeploying:  (v)      => set({ unifiedDeploying: v }),

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
          ...prev,
          past, future, canUndo: past.length > 0, canRedo: true,
          execStats: {}, traceUrl: null, jobError: null, lastModifiedAt: Date.now(),
        }
      }),
      redo: () => set((s) => {
        if (!s.future.length) return {}
        const next   = s.future[0]
        const future = s.future.slice(1)
        const past   = [...s.past, _snapshot(s)].slice(-MAX_HISTORY)
        return {
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
          flowMeta: { id: spec.id, name: spec.name ?? spec.id, description: spec.description ?? '', runtimeHints: { preferred_adapter: spec.runtime_hints?.preferred_adapter, compatible: spec.runtime_hints?.compatible } },
          stateSchema: spec.state_schema ?? null, agents: spec.agents ?? [],
          memoryStores: spec.memory_stores ?? {}, tools: spec.tools ?? {},
          modelDefaults: spec.model_defaults ?? {}, flowConfig: spec.flow_config ?? {},
          selectedNodeId: null, isPanelOpen: false, selectedEdgeId: null, isEdgePanelOpen: false,
          zodErrors: null, crossRefErrors: [], past: [], future: [], canUndo: false, canRedo: false,
          _nodeCounter: maxCounter,
          lastModifiedAt: Date.now(),
          _collabRoomKey: crypto.randomUUID(),
          a2aDeployment: null, a2aDeploying: false, unifiedDeployment: null, unifiedDeploying: false,
        })
      },

      // ── Export spec ───────────────────────────────────────────────────────
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
              type RawBranch = { condition: Record<string,unknown>; target: string; label?: string }
              const nodeBranches = (d.branches as RawBranch[] | undefined) ?? []
              return {
                type:           'conditional' as const,
                id:             `ce-${n.id}`,
                from:           n.id,
                branches:       nodeBranches.map((b) => ({
                                  condition: b.condition,
                                  to:        b.target,
                                  label:     b.label,
                                })),
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
        if (_updateDebounceTimer !== null) {
          clearTimeout(_updateDebounceTimer)
          _updateDebounceTimer = null
        }
        // §8 — pre-place a single input node labeled "Start"
        const startNode: CanvasNode = {
          id:       'input-1',
          type:     'input',
          position: { x: 140, y: 200 },
          data:     { label: 'Start', output_schema: {} },
        }
        set({
          nodes: [startNode], edges: [], flowMeta: defaultMeta(), stateSchema: null,
          agents: [], memoryStores: {}, tools: {}, modelDefaults: {}, flowConfig: {},
          selectedNodeId: null, isPanelOpen: false, selectedEdgeId: null, isEdgePanelOpen: false,
          zodErrors: null, crossRefErrors: [], past: [], future: [], canUndo: false, canRedo: false,
          _nodeCounter: 1,
          lastModifiedAt: Date.now(),
          _collabRoomKey: crypto.randomUUID(),
          a2aDeployment: null, a2aDeploying: false, unifiedDeployment: null, unifiedDeploying: false,
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
        _nodeCounter:   state._nodeCounter,
        lastModifiedAt: state.lastModifiedAt,
        _collabRoomKey: state._collabRoomKey,
      }),

      migrate: (persisted, version) => {
        if (version === 0) {
          return {
            ...(persisted as object),
            lastModifiedAt: Date.now(),
            _nodeCounter:   0,
            stateSchema:   null,
            agents:        [],
            memoryStores:  {},
            tools:         {},
            modelDefaults: {},
            flowConfig:    {},
          }
        }
        if (version === 1) {
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
          // v3 adds _collabRoomKey — generate one from the flow id so existing flows
          // get a stable room key based on their id.
          const p = persisted as PersistedState & { flowMeta?: { id?: string } }
          return {
            ...p,
            _collabRoomKey: p._collabRoomKey ?? crypto.randomUUID(),
          }
        }
        if (version === 3) {
          return persisted
        }
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
