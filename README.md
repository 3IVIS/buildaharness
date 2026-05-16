# itsharness

**A complete harness for building, running, and observing AI agent workflows.**

Design flows on a visual canvas → export a runtime-agnostic spec → compile to your framework → run, trace, and debug — all from one tool.

```
flow.json  →  [ langgraph adapter ]                →  Python / LangGraph
           →  [ crewai adapter ]                   →  Python / CrewAI
           →  [ mastra adapter ]                   →  TypeScript / Mastra
           →  [ microsoft_agent_framework adapter ] →  C# + Python / MS Agent Framework
           →  [ A2A protocol ]                     →  any A2A-compatible runtime
```

---

## What it is

Most agent tooling is either high-level (too much magic, hard to debug) or low-level (too much boilerplate, slow to iterate). itsharness sits in the middle:

- **Draw** — 14 node types on a visual canvas. Every spec field is directly editable.
- **Own the spec** — the canvas emits a versioned, runtime-agnostic JSON spec you control and can version alongside your code.
- **Compile** — one API call transforms the spec into runnable code for whichever framework you use.
- **Run and observe** — execution overlays, token streaming, Langfuse telemetry, HITL pause/resume.
- **Compose** — deployed flows expose themselves as REST, MCP tools, and A2A agents simultaneously. External A2A agents (Google ADK, OpenAI Agents SDK, Claude Agent SDK) are invocable as canvas nodes without writing new adapters.

**The spec is the contract. The canvas is the editor. The adapters are the compilers.**

---

## Repository structure

```
itsharness/
│
├── spec/                        ← @itsharness/flow-spec — published npm package
│   ├── schema.ts                  Canonical Zod schema (source of truth)
│   ├── schema.json                Derived JSON Schema (use for non-TS validation)
│   ├── CHANGELOG.md               Version history
│   └── package.json               {"name": "@itsharness/flow-spec", "version": "0.2.0"}
│
├── flows/                       ← Reference example flows (JSON)
│   ├── 01-rag-agent-flow.json
│   ├── 02-content-moderation-hitl-flow.json
│   ├── 03-parallel-risk-assessment-flow.json
│   ├── 04-research-crew-flow.json
│   └── 05-debate-agent-a2a-flow.json
│
├── src/                         ← Canvas app (React + TypeScript + XYFlow)
│   ├── spec/
│   │   ├── schema.ts              Canvas copy — kept in sync with spec/schema.ts
│   │   ├── validation.ts          Cross-ref rules (edge targets, store IDs, agent refs)
│   │   ├── examples.ts            5 example flows as TS constants (for sidebar)
│   │   └── schema.test.ts         Vitest suite — validates all 5 flows
│   ├── store/
│   │   ├── index.ts               Zustand canvas store (persisted)
│   │   └── library.ts             Flow library store (persisted)
│   ├── canvas/
│   │   ├── Canvas.tsx             ReactFlow wrapper
│   │   ├── nodes/                 14 node visual components + registry
│   │   └── edges/                 DirectEdge, ConditionalEdge
│   └── components/
│       ├── Toolbar.tsx            Top bar — undo/redo, auto-layout, validate, export
│       ├── Sidebar.tsx            Node palette + registry shortcuts + My Flows
│       ├── ConfigPanel.tsx        Per-node config panels (all 14 types)
│       ├── EdgeConfigPanel.tsx    Edge label + context_from editor
│       ├── FlowSettingsModal.tsx  6-tab flow-level settings
│       ├── FlowLibraryPanel.tsx   Library management
│       ├── ImportDialog.tsx       File import with inline validation errors
│       └── ProblemsPanel.tsx      Validation error list
│
├── adapter/                     ← LangGraph Python sidecar (FastAPI)
│   ├── main.py                    /health + /compile stub (codegen after RFC)
│   └── requirements.txt
│
├── docker-compose.yml           ← One command: canvas + adapter
├── CONTRIBUTING.md              ← Contribution process
└── LICENSE                      ← Apache 2.0
```

> **`spec/schema.ts` vs `src/spec/schema.ts`**
> `spec/schema.ts` is the canonical schema published as `@itsharness/flow-spec`. The canvas uses its own copy at `src/spec/schema.ts` — functionally identical but without `.refine()` on individual node types (Zod's `z.discriminatedUnion()` requires bare `ZodObject` members). When the spec changes, update both and run `npm test` to confirm all 5 example flows still validate.

---

## The spec — `@itsharness/flow-spec`

The spec is a runtime-agnostic JSON format. You describe a workflow once; adapters translate it to runnable code for whichever framework you target.

**Current version:** `0.2.0` · **RFC:** open — see [CONTRIBUTING.md](./CONTRIBUTING.md)

### The 14 node types

| Node | What it does | Runtime support |
|---|---|---|
| `input` | Flow entry point; declares output schema | All |
| `output` | Flow exit point; optional exit code | All |
| `llm_call` | Single LLM invocation — structured output, validator, streaming | All |
| `tool_invoke` | Calls a named tool from the flow's `tools` registry | All |
| `condition` | Branching — JSONPath expression or `fn_ref` | All |
| `parallel_fork` | Fan-out to N concurrent branches | All |
| `parallel_join` | Fan-in — configurable reducer: `merge`, `append`, `fn_ref` | All |
| `hitl_breakpoint` | Suspend execution; wait for a typed human resume payload | All (adapter variation) |
| `memory_read` | Read from a named store — key-value or semantic (vector) | All |
| `memory_write` | Write to a named store — upsert or overwrite | All |
| `subgraph` | Embed another flow as a node | LG/MA: full · CR/MS: partial |
| `transform` | State transformation — `mapping` (no-code) or `fn_ref` | All |
| `agent_role` | Execute an agent persona from the `agents[]` registry | CR: native · LG/MA/MS: synthesised |
| `agent_debate` | Multi-agent conversation loop with termination condition | MS: native GroupChat · others: synthesised |

### Validating a flow

```bash
# JSON Schema (any language)
npx ajv-cli validate -s spec/schema.json -d flows/01-rag-agent-flow.json

# Python
python3 -c "
import json, jsonschema
schema = json.load(open('spec/schema.json'))
flow   = json.load(open('flows/01-rag-agent-flow.json'))
jsonschema.validate(flow, schema)
print('valid')
"

# TypeScript (Zod)
import { parseFlowSpec } from './spec/schema'
import flow from './flows/01-rag-agent-flow.json'
const result = parseFlowSpec(flow)
if (!result.success) console.error(result.error.issues)
```

### A minimal flow

```json
{
  "spec_version": "0.2.0",
  "id": "hello-flow",
  "runtime_hints": { "preferred_adapter": "langgraph" },
  "state_schema": {
    "type": "object",
    "properties": {
      "question": { "type": "string" },
      "answer":   { "type": "string" }
    }
  },
  "nodes": [
    { "id": "start",  "type": "input",    "output_schema": { "type": "object", "properties": { "question": { "type": "string" } } } },
    { "id": "answer", "type": "llm_call", "prompt_template": "Answer this: {{$.state.question}}", "output_key": "answer" },
    { "id": "done",   "type": "output" }
  ],
  "edges": [
    { "type": "direct", "from": "start",  "to": "answer" },
    { "type": "direct", "from": "answer", "to": "done"   }
  ]
}
```

### Example flows

Five reference flows — each valid against `spec/schema.json`, each targeting a different adapter:

| Flow | Adapter | Exercises |
|---|---|---|
| [01 — RAG Agent](./flows/01-rag-agent-flow.json) | LangGraph | `memory_read` semantic, `transform` fn_ref, vector + kv stores, streaming |
| [02 — Content Moderation + HITL](./flows/02-content-moderation-hitl-flow.json) | Mastra | `llm_call` structured output, `condition`, `hitl_breakpoint` + resume schema |
| [03 — Parallel Risk Assessment](./flows/03-parallel-risk-assessment-flow.json) | CrewAI | `parallel_fork/join`, `agent_role` ×3, `memory_access: "isolated"` |
| [04 — Research Crew](./flows/04-research-crew-flow.json) | CrewAI | `context_from` on edges, `memory_access: "shared"`, `tool_approval: "human"` |
| [05 — Debate Agent + A2A](./flows/05-debate-agent-a2a-flow.json) | MS Agent Framework | `agent_debate`, `runtime_support` overrides, full `a2a_config` |

---

## The canvas — Phase 1

A visual editor for the spec. Draw a flow, configure every field, validate, and export — the canvas emits clean spec JSON at all times.

### Running locally

```bash
npm install
npm run dev        # → http://localhost:3000
npm test           # 17 tests — all 5 example flows + cross-ref error cases
```

With Docker (canvas + Python adapter sidecar together):

```bash
docker compose up
# canvas  → http://localhost:3000
# adapter → http://localhost:8000/health
```

### What's built

**Canvas**
- All 14 node types with per-type config panels — every spec field editable
- Drag-to-add from the node palette; drag-to-connect between handles
- Click any edge to edit `label` and `context_from` (CrewAI Task.context)
- Auto-layout (dagre LR), undo/redo (50 steps), keyboard shortcuts (`Delete`, `Escape`, `Ctrl+Z`)
- Runtime compatibility badges per node (LG / CR / MA / MS)

**Flow settings** (⚙ button)
- 6-tab modal: flow identity, state schema editor, memory stores registry, tools registry, agents registry, flow_config (checkpoint / streaming / telemetry / A2A)

**Spec validation**
- Zod validation on every canvas change — errors shown inline
- Cross-ref validation: edge targets, store IDs, agent refs
- Problems panel listing all errors with clickable links to offending nodes
- Import dialog with per-error display and "load anyway" path for warnings-only

**Persistence**
- Auto-save to `localStorage:itsharness:current` on every change — survives page refresh
- Flow library (`localStorage:itsharness:library`): save, load, rename, delete named snapshots
- Dirty indicator — amber dot when unsaved library changes exist

**Export**
- Export spec JSON (download as `{id}.json`)
- Copy spec to clipboard
- `POST http://localhost:8000/compile` — spec JSON → compiled code (stub in Phase 1)

---

## The adapter — Phase 1 stub

The FastAPI sidecar at `adapter/main.py` accepts a `FlowSpec` JSON and will return compiled Python. In Phase 1 it returns a stub:

```bash
curl -s http://localhost:8000/health
# {"status":"ok","adapter":"langgraph","phase":"1-stub"}

curl -s -X POST http://localhost:8000/compile \
  -H "Content-Type: application/json" \
  -d @flows/01-rag-agent-flow.json | jq .runtime
# "langgraph"
```

Real codegen is gated on the RFC closing. The spec's field names — `output_key`, `query_expr`, `context_from` semantics, `resume_schema` — are the open questions most likely to attract feedback, and they're the ones the adapter hardcodes. Waiting avoids rewriting 300+ lines after feedback.

---

## Adapter order and rationale

| # | Runtime | Phase | Key spec mappings |
|---|---|---|---|
| 1 | LangGraph · Python · MIT | Phase 1 | `node→fn`, `edge→add_edge`, `condition→add_conditional_edges+router`, `hitl→interrupt()+update_state()`, `parallel→Send()`, `agent_role→named subgraph`, `agent_debate→conditional loop` |
| 2 | CrewAI · Python · MIT | Phase 3 | `agents[]→Agent(role,backstory,goal)`, `agent_role node→Task(agent=...)`, `context_from edge→Task.context=[]`, `process_type→Crew(process=)`, `agent_debate→consensual process`, `parallel→async_execution=True` |
| 3 | Mastra · TypeScript · Apache 2 | Phase 3 | `nodes→createStep()`, `edges→.then()/.branch()/.parallel()`, `agent_role→createAgent()`, `hitl→suspend()/resume()`, `state_schema→Zod schema`, `context_from→step input mapping` |
| 4 | Microsoft Agent Framework · C# + Python · MIT | Phase 4 | `agent_debate→GroupChat+GroupChatManager`, `agent_role→AssistantAgent`, `nodes→KernelProcessStep`, `edges→KernelProcessEvent`, `hitl→human_input_mode=ALWAYS`, `context_from→step input injection` |
| ~ | A2A Protocol | Phase 2 | Not codegen — invocation + exposure layer. `a2a_config→AgentCard`, `hitl→task state input-required`, `streaming→TaskArtifactUpdateEvent`. Replaces custom adapters for Google ADK, OpenAI Agents SDK, Claude Agent SDK, and any future A2A-compatible runtime. |

**On A2A scope:** You write custom adapters for 4 runtimes (LangGraph, CrewAI, Mastra, MS Agent Framework) — the ones where users want to *author* flows visually and export runnable code. For every other runtime, A2A gives invocation-level interoperability without a custom adapter. This bounds adapter build work to 4 runtimes, permanently.

---

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| **0 — Spec design** | Primitive extraction · concept map · node taxonomy · spec schema v0.2 · 5 example flows · RFC | ✅ Complete |
| **1 — Canvas + LangGraph adapter** | XYFlow canvas · 14 node components · spec validation · persistence · library · LangGraph adapter (Python sidecar) | 🟡 Canvas complete · adapter awaiting RFC |
| **2 — Observability + HITL + deploy + A2A** | Langfuse integration · live execution overlay · HITL pause/resume UI · LiteLLM gateway · flow versioning · A2A protocol layer · REST + MCP + A2A deployment · basic auth | ⬜ Planned — needs adapter |
| **3 — Teams + CrewAI + Mastra** | CrewAI adapter · `agent_role` + `agent_debate` canvas nodes · Mastra adapter · runtime selector · team RBAC · flow version diff · eval integration · prompt versioning · component marketplace | ⬜ Planned |
| **4 — Enterprise + collab + MS** | Real-time collaborative canvas (Yjs) · Microsoft Agent Framework adapter · SSO / enterprise auth · visual CI/CD pipeline · on-prem Helm chart · embeddable `@itsharness/canvas` npm package · advanced A2A orchestration | ⬜ Planned |

### Phase 2 detail (next after adapter)

Once the LangGraph adapter ships, Phase 2 unlocks simultaneously:

- **Langfuse integration** — every execution auto-traced. Canvas shows live node status (pending → running → done/error) via websocket. Click any completed node to inspect inputs, outputs, token cost, latency.
- **HITL pause/resume UI** — canvas highlights paused node in amber. Side panel shows state at breakpoint; user edits and clicks resume → calls `update_state()` + resume. Full time-travel via LangGraph checkpoints.
- **LiteLLM gateway** — LLM call nodes route through LiteLLM. Model selector covers 100+ providers. Cost-per-call in execution overlay. Virtual keys prevent hardcoded API keys in flows.
- **A2A protocol layer** — auto-generates `AgentCard` from `a2a_config`, exposes flows as A2A endpoints, enables invoking external A2A agents as canvas nodes without custom adapters.
- **One-click deploy** — flow → REST endpoint + MCP tool + A2A agent. Built on LangGraph Server (OSS) + FastAPI.

---

## Key design decisions

**TypeScript on XYFlow, not Python on LangFlow.** LangFlow's canvas wires components; a harness needs to author state machines. Python backend creates a language split at the wrong layer. XYFlow costs ~4–6 extra weeks but delivers the correct canvas model, a single-language stack, runtime-agnostic design, and a future embeddable `@itsharness/canvas` npm package.

**Neutral spec IR as the anchor, not the runtime.** The canvas emits a neutral JSON spec. Adapters translate it. Swapping a runtime means updating one adapter file. Canvas, versioning, RBAC, eval, and collaboration are completely decoupled from any runtime choice.

**Langfuse (MIT, self-hosted) over LangSmith.** LangSmith is proprietary SaaS with LangChain-first trace semantics. Langfuse is MIT, self-hostable, OTel-compatible, and natively understands LangGraph traces. Zero marginal cost at scale. Used as the observability backbone across all four runtimes.

**Microsoft Agent Framework over Semantic Kernel.** Microsoft merged AutoGen + Semantic Kernel into a single SDK that reached v1.0 GA in April 2026. One adapter covers both SK and AutoGen users.

**CrewAI at Adapter #2.** 44,600+ GitHub stars, ~60% Fortune 500 adoption, the largest unaddressed audience. Most users prototype in CrewAI then want better tooling — itsharness is exactly that migration path.

**A2A in Phase 2, before any non-core adapter.** Adding A2A transforms itsharness from "a visual tool for 4 runtimes" to "the orchestrator of orchestrators." Google ADK, OpenAI Agents SDK, Claude Agent SDK all become invocable without custom adapters. ~3 weeks of work, effectively unlimited runtime coverage via protocol.

**Real-time collaboration deferred to Phase 4.** Yjs collaborative canvas is 4–6 weeks alone — the most complex single feature in the roadmap. Deferring it until Phase 4 validates the product with real users before spending that budget.

---

## Contributing

**The best place to contribute right now is the RFC Discussion** (link TBD — will be posted when the GitHub Discussion goes live).

Phase 0 is complete and the spec is locked for Phase 1. The RFC is the last good moment to push back on design decisions before adapter build starts. After Phase 1 begins, schema changes become breaking changes.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full process — issue labels, schema change requirements, example flow conventions, and the regeneration process for `spec/schema.json`.

---

## License

Apache 2.0 — see [LICENSE](./LICENSE).
