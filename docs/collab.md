# Real-time collaboration

Real-time collaboration is **opt-in**. It activates only when `VITE_COLLAB_SERVER_URL` is set. Without it the canvas works exactly as before — no performance impact, no extra dependencies loaded.

## Quick start

```bash
# Start the full stack plus the y-websocket server
docker compose -f docker-compose.yml -f docker-compose.collab.yml up
```

Then set `VITE_COLLAB_SERVER_URL=ws://localhost:1234` in `.env.local` and restart the canvas dev server (or rebuild the canvas container).

## How it works

The collab layer is built on [Yjs](https://yjs.dev/) — a CRDT library that guarantees convergence regardless of edit order or network conditions.

```
User A edits a node                 User B edits a different node
       │                                      │
       ▼                                      ▼
  Zustand store update              Zustand store update
       │                                      │
       ▼                                      ▼
  syncToYjs() — write to Y.Doc      syncToYjs() — write to Y.Doc
       │                                      │
       ▼                                      ▼
  Y.Doc emits update                Y.Doc emits update
       │                                      │
       └──────────► y-websocket ◄─────────────┘
                    server
                    (stateless relay)
       │                                      │
       ▼                                      ▼
  syncFromYjs() — read from Y.Doc   syncFromYjs() — read from Y.Doc
       │                                      │
       ▼                                      ▼
  Zustand store updated             Zustand store updated
  (converged)                       (converged)
```

The y-websocket server is a **stateless relay** — it only broadcasts CRDT ops between peers. It holds no flow state. If it restarts, peers reconnect and resync from their IndexedDB cache.

## Document structure

Each flow gets its own Yjs document, scoped by a stable `_collabRoomKey` UUID (stored in the flow's Zustand state and persisted alongside the spec). The document structure:

```
Y.Doc
  ├── Y.Map "nodes"       key: node.id → JSON-serialised FlowNode
  ├── Y.Map "edges"       key: edge.id → JSON-serialised FlowEdge
  └── Y.Map "meta"        key: "flowId" → flow ID (for integrity checks)
```

Using `Y.Map` (keyed by ID) rather than `Y.Array` means concurrent node moves, updates, and deletions converge correctly without index conflicts.

## File structure

```
src/collab/
├── index.ts           Public exports from the collab module
├── doc.ts             createCollabDoc() — creates Y.Doc, WebsocketProvider,
│                      IndexeddbPersistence, and the awareness protocol
├── syncToYjs.ts       Zustand → Y.Doc (called on every store mutation)
├── syncFromYjs.ts     Y.Doc → Zustand (called on every Y.Doc update)
├── undoManager.ts     Y.UndoManager wrapping the nodes/edges maps
│                      (integrates with the existing 50-step Zustand history)
├── useAwareness.ts    React hook — per-peer cursor position + user metadata
├── CollabStatus.tsx   Connection indicator rendered in Canvas.tsx
└── CollabCursors.tsx  Live peer cursor overlays (absolute over ReactFlow)
```

## Wiring in App.tsx

```tsx
// Collab initialisation (runs once per flow load when VITE_COLLAB_SERVER_URL is set)
const collabRef = useRef<CollabHandle | null>(null)

useEffect(() => {
  if (!import.meta.env.VITE_COLLAB_SERVER_URL) return
  const { doc, provider, awareness } = createCollabDoc(flowId, roomKey)
  hydrateStoreFromYjs(doc, getStore())    // initial sync: Y.Doc → Zustand
  bindYjsToStore(doc, getStore())         // ongoing: Zustand mutations → Y.Doc
  syncStoreToYjs(doc, getStore())         // initial seed: Zustand → Y.Doc
  collabRef.current = { doc, provider, awareness }
  return () => provider.destroy()
}, [flowId, roomKey])
```

## Offline persistence

By default (`VITE_COLLAB_OFFLINE_PERSISTENCE=true`) the Yjs document is persisted to IndexedDB via `y-indexeddb`. This means:

- The canvas loads instantly from the local cache even before the WebSocket connects
- Edits made offline are queued and synced when the connection is restored
- Reloading the page does not cause flicker or loss of the current state

Set `VITE_COLLAB_OFFLINE_PERSISTENCE=false` to disable (useful in testing or when storage quota is a concern).

## Presence and cursors

Each peer's viewport pointer position is broadcast via the Yjs awareness protocol (not via the CRDT document — awareness is ephemeral and not persisted). Each peer gets a stable colour derived from their user ID.

`CollabStatus` shows a compact indicator with connected peer count and connection state (connecting / connected / disconnected). `CollabCursors` renders a coloured cursor SVG + name label at each peer's current canvas position.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `VITE_COLLAB_SERVER_URL` | _(unset — collab disabled)_ | WebSocket URL of the y-websocket server. Must start with `ws://` or `wss://`. |
| `VITE_COLLAB_OFFLINE_PERSISTENCE` | `true` | Persist Yjs document to IndexedDB for offline-first editing. |

## Self-hosting the y-websocket server

The `docker-compose.collab.yml` overlay starts a y-websocket server on port 1234 using the official `y-websocket` npm package:

```yaml
services:
  collab:
    image: node:20-alpine
    command: npx y-websocket
    ports:
      - "1234:1234"
    environment:
      - PORT=1234
```

For production, run it behind your TLS terminator and set `VITE_COLLAB_SERVER_URL=wss://collab.your-domain.com`. The server is stateless — you can run multiple instances behind a load balancer as long as all instances in the same "room" are on the same machine (y-websocket does not have a distributed mode out of the box).

The Helm chart does not include a collab deployment — add it as a separate `Deployment` and `Service` in your cluster, or use a managed WebSocket service.

## Conflict resolution

Yjs CRDT semantics guarantee **last-write-wins per field** within a `Y.Map`. This means:

- Two peers moving the same node simultaneously → the last position update wins (visually, the node snaps to one position for both peers)
- Two peers editing different fields of the same node simultaneously → both edits are preserved
- Concurrent deletion and edit of the same node → deletion wins (the node is removed; the edit is discarded)

These semantics are appropriate for a visual flow editor where real conflicts are rare.
