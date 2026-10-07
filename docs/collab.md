# Real-time collaboration

Real-time collaboration is **opt-in**. It activates only when `VITE_COLLAB_SERVER_URL` is set. Without it the canvas works exactly as before — no performance impact, no extra dependencies loaded.

## Quick start

```bash
# Start the full stack plus the y-websocket server
docker compose -f docker-compose.yml -f docker-compose.collab.yml up
```

Then set `VITE_COLLAB_SERVER_URL=ws://localhost:1234` in `.env.local` and restart the canvas dev server (or rebuild the canvas container). The y-websocket port is published on `127.0.0.1` only.

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

The y-websocket server relays CRDT ops between peers. The bundled overlay also enables LevelDB persistence (`PERSISTENCE=leveldb`, volume `collab_data`) so room documents survive server restarts; the flow itself is still saved through the adapter, not the collab server. If the server restarts, peers reconnect and resync from their IndexedDB cache.

## Document structure

Each flow gets its own Yjs document (room `flow:<_collabRoomKey>`), scoped by a stable `_collabRoomKey` UUID kept in the canvas store and assigned once at flow creation (so renaming the Flow ID never disconnects collaborators). The document structure (`src/collab/doc.ts`):

```
Y.Doc
  ├── Y.Map "nodes"      node.id → Y.Map { id, type, position, data }
  ├── Y.Map "edges"      edge.id → Y.Map { id, source, target, type, data }
  └── Y.Map "flowMeta"   mirrors FlowMeta fields (id, name, description, runtimeHints)
```

Using `Y.Map` (keyed by ID) rather than `Y.Array` means concurrent node moves, updates, and deletions converge correctly without index conflicts, and a field update does not retransmit the whole node.

## File structure

```
src/collab/
├── index.ts           Public exports from the collab module
├── doc.ts             createCollabDoc() — creates the Y.Doc, its shared maps
│                      and the awareness instance (the WebsocketProvider and
│                      IndexeddbPersistence are created in App.tsx)
├── syncToYjs.ts       Zustand → Y.Doc (syncStoreToYjs, seedYjsFromStore)
├── syncFromYjs.ts     Y.Doc → Zustand (bindYjsToStore, hydrateStoreFromYjs)
├── undoManager.ts     Per-user Y.UndoManager over nodes/edges/flowMeta; while
│                      collab is active it replaces the Zustand snapshot undo stack
├── useAwareness.ts    React hook — per-peer cursor position + user metadata
├── CollabStatus.tsx   Connection indicator rendered in Canvas.tsx
└── CollabCursors.tsx  Live peer cursor overlays (absolute over ReactFlow)
```

## Wiring in App.tsx

The `useCollab()` hook in `src/App.tsx` does nothing unless `VITE_COLLAB_SERVER_URL` is set. When it is, an effect (keyed on the room key) lazily imports `y-websocket` and `y-indexeddb`, then:

1. creates the `CollabDoc` and sets the local awareness user (email, or a stable anonymous colour);
2. loads the IndexedDB copy of the doc (`buildaharness:flow:<roomKey>`), falling back to online-only if IndexedDB is unavailable (for example private browsing);
3. seeds the Y.Doc from the Zustand store if it is empty (`seedYjsFromStore`), otherwise hydrates the store from it (`hydrateStoreFromYjs`);
4. connects a `WebsocketProvider`, binds Y.Doc changes to the store (`bindYjsToStore`) and store changes to the Y.Doc (`syncStoreToYjs`), and attaches the undo manager.

## Offline persistence

The Yjs document is always persisted to IndexedDB via `y-indexeddb` (there is no environment switch for this). This means:

- The canvas loads instantly from the local cache even before the WebSocket connects
- Edits made offline are queued and synced when the connection is restored
- Reloading the page does not cause flicker or loss of the current state

If IndexedDB is unavailable the canvas logs a warning and continues without offline persistence.

## Presence and cursors

Each peer's viewport pointer position is broadcast via the Yjs awareness protocol (not via the CRDT document — awareness is ephemeral and not persisted). Each peer gets a stable colour (derived from their email when signed in, otherwise a per-browser anonymous colour).

`CollabStatus` shows a compact indicator with connected peer count and connection state (connecting / connected / disconnected). `CollabCursors` renders a coloured cursor SVG + name label at each peer's current canvas position.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `VITE_COLLAB_SERVER_URL` | _(unset — collab disabled)_ | WebSocket URL of the y-websocket server, for example `ws://localhost:1234` or `wss://collab.your-domain.com`. |

## Self-hosting the y-websocket server

The `docker-compose.collab.yml` overlay starts a y-websocket server (`node:20-alpine`, `npm install --global y-websocket@2`, then `y-websocket`) on port 1234 with LevelDB persistence in the `collab_data` volume. It is published on `127.0.0.1:1234` only and has **no authentication** — the overlay's header comments list the options (JWT in the query string with a custom server, an authenticating reverse proxy, or network isolation).

For production, run it behind your TLS terminator and set `VITE_COLLAB_SERVER_URL=wss://collab.your-domain.com`. y-websocket has no distributed mode, so all peers editing the same room must reach the same server instance; do not spread one room across several instances behind a load balancer.

The Helm chart does not include a collab deployment — add it as a separate `Deployment` and `Service` in your cluster, or use a managed WebSocket service.

## Conflict resolution

Yjs CRDT semantics guarantee **last-write-wins per field** within a `Y.Map`. This means:

- Two peers moving the same node simultaneously → the last position update wins (visually, the node snaps to one position for both peers)
- Two peers editing different fields of the same node simultaneously → both edits are preserved
- Concurrent deletion and edit of the same node → deletion wins (the node is removed; the edit is discarded)

These semantics are appropriate for a visual flow editor where real conflicts are rare.
