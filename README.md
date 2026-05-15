# Its Harness Flow Spec

**Runtime-agnostic AI agent workflow specification for LangGraph, CrewAI, Mastra, and Microsoft Agent Framework.**

Every AI agent framework models the same concepts — state, agents, tools, branching, human-in-the-loop, multi-agent loops — differently enough that visual tooling today picks a runtime and locks you in. Its Harness Flow Spec is a neutral JSON format: you describe a workflow once, and adapters translate it to runnable code for whichever framework you're targeting. The spec is the source of truth. Code generation is a separate, swappable layer.

```
flow.json  →  [ langgraph adapter ]               →  Python / LangGraph
           →  [ crewai adapter ]                  →  Python / CrewAI
           →  [ mastra adapter ]                  →  TypeScript / Mastra
           →  [ microsoft_agent_framework adapter] →  C# / MS Agent Framework
```

> **Status:** Phase 0 — spec design complete. Canvas build and adapters begin Phase 1.  
> **RFC:** [GitHub Discussion →](#) ← _replace with Discussion URL after posting_  
> **Spec version:** 0.2.0

---

## The spec

Two canonical files — Zod TypeScript definition and derived JSON Schema:

| File | Description |
|---|---|
| [`spec/schema.ts`](./spec/schema.ts) | Zod schema — canonical source of truth |
| [`spec/schema.json`](./spec/schema.json) | JSON Schema — derived from Zod, use for validation in any language |

The schema is the spec. Every field has a `describe()` string explaining its semantics and adapter behaviour. Read `schema.ts` before opening an issue or PR.

---

## The 14 node types

| Node type | What it does | Runtime support |
|---|---|---|
| `input` | Flow entry point; declares output schema | All |
| `output` | Flow exit point; optional exit code | All |
| `llm_call` | Single LLM invocation — structured output, output validator, streaming | All |
| `tool_invoke` | Calls a named tool from the flow's `tools` registry | All |
| `condition` | Branching node — JSONPath expression or `fn_ref` | All |
| `parallel_fork` | Fan-out to N concurrent branches | All |
| `parallel_join` | Fan-in — configurable reducer: `merge`, `append`, `fn_ref` | All |
| `hitl_breakpoint` | Suspend execution; wait for a typed human resume payload | All (adapter variation) |
| `memory_read` | Read from a named store — key-value or semantic (vector) | All |
| `memory_write` | Write to a named store — upsert or overwrite | All |
| `subgraph` | Embed another flow as a node | All |
| `transform` | State transformation — `mapping` (no-code) or `fn_ref` | All |
| `agent_role` | Execute an agent persona from the top-level `agents[]` registry | All (CR: native; LG/MA/MS: synthesised) |
| `agent_debate` | Multi-agent conversation loop with termination condition | MS: native GroupChat; others: synthesised |

Runtime compatibility is declared per-node via `runtime_support` overrides (`full \| partial \| missing`). The canvas surfaces a warning when a flow uses features unsupported by the target adapter.

---

## A minimal flow

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
    {
      "id": "start",
      "type": "input",
      "output_schema": { "type": "object", "properties": { "question": { "type": "string" } } }
    },
    {
      "id": "answer",
      "type": "llm_call",
      "prompt_template": "Answer this question: {{$.state.question}}",
      "output_key": "answer"
    },
    {
      "id": "done",
      "type": "output"
    }
  ],
  "edges": [
    { "type": "direct", "from": "start",  "to": "answer" },
    { "type": "direct", "from": "answer", "to": "done"   }
  ]
}
```

---

## Example flows

Five reference flows — each valid against `spec/schema.json`, each targeting a different adapter, collectively exercising all 14 node types:

| Flow | Preferred adapter | Exercises |
|---|---|---|
| [01 — RAG Agent](./flows/01-rag-agent-flow.json) | LangGraph | `memory_read` semantic, `transform` fn_ref, vector + kv stores, streaming |
| [02 — Content Moderation + HITL](./flows/02-content-moderation-hitl-flow.json) | Mastra | `llm_call` structured output, `condition` node, `hitl_breakpoint` with resume schema + timeout |
| [03 — Parallel Risk Assessment](./flows/03-parallel-risk-assessment-flow.json) | CrewAI | `parallel_fork/join`, `agent_role` ×3 with `memory_access: "isolated"` |
| [04 — Research Crew](./flows/04-research-crew-flow.json) | CrewAI | `context_from` on edges, `memory_access: "shared"`, `tool_approval: "human"` |
| [05 — Debate Agent + A2A](./flows/05-debate-agent-a2a-flow.json) | MS Agent Framework | `agent_debate`, `runtime_support` overrides, full `a2a_config` |

---

## Validating a flow

Using the JSON Schema directly:

```bash
# ajv-cli
npx ajv-cli validate -s spec/schema.json -d flows/01-rag-agent-flow.json

# Python: jsonschema
python3 -c "
import json, jsonschema
schema = json.load(open('spec/schema.json'))
flow   = json.load(open('flows/01-rag-agent-flow.json'))
jsonschema.validate(flow, schema)
print('valid')
"
```

Using the Zod schema in TypeScript:

```typescript
import { FlowSpec } from './spec/schema'
import flow from './flows/01-rag-agent-flow.json'

const result = FlowSpec.safeParse(flow)
if (!result.success) console.error(result.error.issues)
```

---

## Design decisions

The major design decisions made in Phase 0 are documented in the [RFC Discussion](#). Key choices:

- **Superset, not intersection** — the spec covers features from all four runtimes. Unsupported features get `runtime_support` flags; canvas warns rather than errors.
- **JSONPath + fn_ref for conditions** — `$.state.field == 'value'` for no-code; `fn_ref` for a code panel. CEL excluded.
- **Reducer-annotated state** — each state field carries `reducer: 'replace' | 'append' | 'merge' | 'custom'`.
- **npm refs for tools** — `pypi` source type is deferred; acknowledged as a gap for the Python community.
- **RAG = composed primitives** — `memory_read` → `transform` → `llm_call`. No `rag_retrieval` node.
- **Eval deferred to v2** — use `llm_call` + `condition` to approximate in-flow evaluation.

---

## Contributing

**The best place to contribute right now is the [RFC Discussion](#).**

This is Phase 0 — the last good moment to influence the schema before adapter build starts. Phase 1 begins in ~3 weeks; after that, schema changes become breaking changes.

For code contributions:

```
[spec]       schema changes — requires a decision rationale comment in schema.ts
[node-type]  taxonomy proposals — new node types or changes to existing ones  
[adapter]    adapter-specific questions or constraints
[breaking]   anything that would invalidate existing valid flows
```

All schema changes must include:
1. Updated `spec/schema.ts` (Zod — primary)
2. Updated `spec/schema.json` (derived — regenerate from Zod)
3. Updated `spec/CHANGELOG.md`
4. At least one updated or new example flow demonstrating the change

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full process.

---

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 — Spec design | Primitive extraction, concept map, node taxonomy, spec schema v0.2, 5 example flows, RFC | ✅ Complete |
| 1 — Canvas + LangGraph adapter | XYFlow canvas, 14 node components, LangGraph adapter (Python), spec validation, export | 🔜 Starting |
| 2 — Observability + HITL + A2A | Langfuse, live execution overlay, HITL UI, A2A protocol layer, deployment | ⏳ Planned |
| 3 — Teams + CrewAI + Mastra | CrewAI adapter, Mastra adapter, team RBAC, eval integration, component marketplace | ⏳ Planned |
| 4 — Enterprise + Collab + MS | MS Agent Framework adapter, real-time collab (Yjs), SSO, on-prem Helm chart | ⏳ Planned |

---

## License

Apache 2.0 — see [LICENSE](./LICENSE).
