/**
 * @itsharness/canvas — public API
 *
 * Primary export: the <ItsHarnessCanvas> component.
 * CSS: import '@itsharness/canvas/styles.css' in your app entry.
 *
 * Type exports: FlowSpec (the spec shape flowing in/out), NodeExecStat
 * (the run-time badge shape injected via execStats prop), and all node
 * types for building your own toolbars or config panels.
 */

// ── Styles — must be imported so Vite emits dist/styles.css ──────────────────
import './styles/canvas.css'

// ── Component ─────────────────────────────────────────────────────────────────
export { ItsHarnessCanvas } from './ItsHarnessCanvas'
export type { ItsHarnessCanvasProps } from './ItsHarnessCanvas'

// ── Store types (useful for hosts that manage their own sidebar/inspector) ────
export type { NodeExecStat, CanvasStore, NodeData } from './store/create'
export { useCanvasStore } from './store/context'

// ── Spec types ────────────────────────────────────────────────────────────────
export type {
  FlowSpec,
  NodeType,
  AdapterName,
  AgentDef,
  MemoryStoreDef,
  ToolDef,
  ModelDefaults,
  FlowConfig,
  StateSchema,
  RuntimeHints,
} from './spec/schema'
export {
  NODE_SUPPORT_MATRIX,
  ADAPTER_LABELS,
  CURRENT_SPEC_VERSION,
  parseFlowSpec,
} from './spec/schema'

// ── Canvas internals (for building custom toolbars that drag nodes) ───────────
export { NODE_HEX, NODE_ICONS, NODE_TYPE_LABELS } from './canvas/nodes/BaseNode'
export { CANVAS_SEARCH_EVENT } from './components/CanvasToolbar'
