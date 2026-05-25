# `@itsharness/canvas`

Embeddable itsharness flow canvas — spec in, spec changes out.

## Install

```bash
npm install @itsharness/canvas @xyflow/react react react-dom
```

## Usage

```tsx
import { ItsHarnessCanvas } from '@itsharness/canvas'
import '@itsharness/canvas/styles.css'

export function FlowEditor() {
  return (
    <div style={{ width: '100%', height: '600px' }}>
      <ItsHarnessCanvas
        initialSpec={myFlowSpec}
        onSpecChange={(updated) => saveToBackend(updated)}
        onNodeSelect={(id) => setInspectorNode(id)}
      />
    </div>
  )
}
```

## Props

| Prop | Type | Description |
|------|------|-------------|
| `initialSpec` | `FlowSpec` | Flow spec to display. Changes to this reference trigger `loadFlow()`. |
| `onSpecChange` | `(spec: FlowSpec) => void` | Called after every canvas edit (debounced 300 ms on rapid changes like dragging). |
| `onNodeSelect` | `(id: string \| null) => void` | Called when the user clicks a node. Use this to render your own config sidebar. |
| `onEdgeSelect` | `(id: string \| null) => void` | Called when the user clicks an edge. |
| `execStats` | `Record<string, NodeExecStat>` | Run-time status badges. Inject node execution progress; the canvas renders token counts, latency, and quality scores without knowing the execution engine. |
| `theme` | `'dark' \| 'light'` | Visual theme. Defaults to `'dark'`. Scoped to the canvas element — does not affect the host app. |
| `className` | `string` | Extra CSS class on the canvas root div. |
| `style` | `React.CSSProperties` | Inline styles on the canvas root div. |

## Injecting exec stats

```tsx
const [stats, setStats] = useState<Record<string, NodeExecStat>>({})

// On each SSE event from your run API:
eventSource.onmessage = (e) => {
  const { node_id, status, tokens, ms } = JSON.parse(e.data)
  setStats((prev) => ({ ...prev, [node_id]: { status, tokens, ms } }))
}

<ItsHarnessCanvas execStats={stats} />
```

## Building a sidebar

```tsx
const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

<div style={{ display: 'flex', height: '100vh' }}>
  <ItsHarnessCanvas
    initialSpec={spec}
    onSpecChange={setSpec}
    onNodeSelect={setSelectedNodeId}
    style={{ flex: 1 }}
  />
  {selectedNodeId && (
    <MyConfigPanel nodeId={selectedNodeId} spec={spec} onChange={setSpec} />
  )}
</div>
```

## Accessing the store from inside the canvas

For advanced use cases, mount your panel inside the same `CanvasStoreProvider` by using `useCanvasStore`:

```tsx
import { useCanvasStore } from '@itsharness/canvas'

function MyConfigPanel() {
  const selectedId = useCanvasStore((s) => s.selectedNodeId)
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === selectedId))
  const updateNodeData = useCanvasStore((s) => s.updateNodeData)
  // ...
}
```

`useCanvasStore` must be called within a subtree rendered inside `<ItsHarnessCanvas>` (reads from the canvas's React context). This is useful for config panels that need direct store access rather than going through `onSpecChange`.

## Multiple instances

The canvas uses a **per-instance Zustand store** via `createStore()` — not a module-level singleton. It is safe to mount multiple `<ItsHarnessCanvas>` components on the same page. Each instance manages its own state, history, and selection independently.

## CSS

Styles are shipped separately so bundler tree-shaking works:

```ts
import '@itsharness/canvas/styles.css'
```

The stylesheet uses CSS custom properties so you can override the palette by targeting `[data-itsharness-canvas]`:

```css
[data-itsharness-canvas] {
  --bg-canvas: #000;
  --bg-raised: #111;
}
```

## Undo / redo

The canvas maintains a 50-step undo history internally. Users invoke it with Ctrl+Z / Ctrl+Shift+Z. There is no prop to control history depth in v0.1.

## Peer dependencies

| Package | Version |
|---|---|
| `react` | `>=18` |
| `react-dom` | `>=18` |
| `@xyflow/react` | `>=12` |

## Publishing

The publish pipeline is `.github/workflows/publish-canvas.yml` — it triggers on `canvas-v*` tags, runs typecheck + schema sync check + tests + lib build + dist artefact verification, then publishes to npm with provenance.

```bash
git tag canvas-v0.2.0 && git push --tags
```
