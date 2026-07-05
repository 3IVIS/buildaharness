# @buildaharness/runtime

Framework-agnostic client-side executor for FlowSpec-authored flows, plus the
concrete storage and LLM-client implementations `@buildaharness/harness` and
`@buildaharness/personal-assistant` are built on. Runs in the browser or Node.

## FlowSpec execution

`FlowRuntime` walks a `FlowGraph` (nodes + edges from a canvas-authored
`FlowSpec`) node by node, dispatching each to the executor registered for its
`type` (`input`, `llm_call`, `transform`, `condition`, `memory_read`,
`memory_write`, `tool_invoke`, `hitl_breakpoint`, `agent_role`, `agent_debate`,
`parallel_fork`/`parallel_join`, `subgraph`, `output`, ...).

```ts
import { FlowRuntime, createExecutionContext, LLMClient } from '@buildaharness/runtime'

const runtime = new FlowRuntime()
const context = createExecutionContext({
  llmClient: new LLMClient({ proxyUrl, authToken }),
})

const finalState = await runtime.execute(flowSpec, { userInput: 'hello' }, context)
```

`createExecutionContext` wires up sensible defaults (a `ToolRegistry` seeded
with `BUILT_IN_TOOLS`, an `EventBus`, an `AbortController`) and accepts
overrides — `memoryAdapters`, `functions`, `retryConfig`, `agents`, etc. — for
anything a flow needs. Subscribe to `context.eventBus` for `node:start`,
`node:complete`, `node:error`, and token-stream events to drive a live UI.

`@buildaharness/react`'s `useHarness()` hook wraps this class for React apps;
use `FlowRuntime` directly for anything else (a CLI, a worker, a test harness).

## Memory adapters

Every `memory_read`/`memory_write` node in a flow resolves to a `MemoryAdapter`
(`get`/`set`/`search`/`delete`) registered under a `store_id`. `FlowRuntime`
auto-creates an `InMemoryAdapter` for any `in_memory`-backed store declared in
`spec.memory_stores` that the caller hasn't already registered.

| Adapter | Backing store | Use when |
|---|---|---|
| `InMemoryAdapter` | A `Map`, scoped by `global`/`thread`/`resource` | Node, tests, or anything that doesn't need to survive a reload |
| `IndexedDBAdapter` | IndexedDB via Dexie | Browser data that should survive a page reload. Falls back to an in-memory `Map` outside a browser (Node/tests) — it self-detects `typeof indexedDB` and logs a warning when it falls back. |

```ts
import { IndexedDBAdapter } from '@buildaharness/runtime'

const memory = new IndexedDBAdapter({ namespace: 'my-app' })
await memory.set('preferences', { theme: 'dark' })
await memory.get('preferences') // { theme: 'dark' }
```

`search(query, topK, minScore)` on both adapters is a linear scan doing
`JSON.stringify(value).includes(query)` — a keyword match, not semantic
search. Fine for small stores; if you need real semantic recall over a large
memory store, that's not implemented here yet.

## LLM client

`LLMClient` implements `ILLMClient` (`callChat` streaming, `callChatSync`,
`callChatStructured` with tool calls) against `@buildaharness/proxy`'s
`/llm/chat` endpoint, so API keys never reach the browser.

```ts
import { LLMClient } from '@buildaharness/runtime'

const llm = new LLMClient({ proxyUrl: 'https://proxy.example.com', authToken })
const reply = await llm.callChatSync([{ role: 'user', content: 'hi' }])
```

## Cross-run learning (DexieExperienceStore)

`@buildaharness/harness`'s `ExperienceStore` interface is fully synchronous
(it's called mid-loop by `HarnessRuntime`), but IndexedDB has no synchronous
API. `DexieExperienceStore` bridges the two: it wraps an
`InMemoryExperienceStore` as the synchronous source of truth and persists a
snapshot to Dexie in the background after every mutation, so learning survives
a page reload instead of resetting every session. A storage failure is
swallowed rather than breaking a run, matching the harness's own
"unavailable store degrades to a silent no-op" contract.

```ts
import { DexieExperienceStore } from '@buildaharness/runtime'
import { HarnessRuntime } from '@buildaharness/harness'

const experienceStore = await DexieExperienceStore.create({ namespace: 'my-app' })
const outcome = await new HarnessRuntime().run(objective, successCriteria, { experienceStore, /* ... */ })
```

## Package structure

| Path | Contents |
|---|---|
| `src/runtime.ts` | `FlowRuntime` — the FlowSpec node-graph executor |
| `src/graph.ts`, `state.ts` | `FlowGraph` (topology) and `FlowState` (schema-validated run state) |
| `src/context.ts` | `createExecutionContext`, `ToolRegistry`, `ExecutionContext` type |
| `src/executors/` | One executor per FlowSpec node type |
| `src/memory/` | `InMemoryAdapter`, `IndexedDBAdapter` |
| `src/experience-store/` | `DexieExperienceStore` |
| `src/llm-client.ts` | `LLMClient` / `ILLMClient` |
| `src/events.ts` | `EventBus` + runtime event types |
| `src/tools/` | `BUILT_IN_TOOLS`, tool registry |

## Commands

```bash
npm run build --workspace=packages/runtime
npm test --workspace=packages/runtime
npm run typecheck --workspace=packages/runtime
```
