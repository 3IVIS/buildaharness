# Contributing to buildaharness


## Current state

v0.8.0 — fully implemented. All four adapter runtimes are executable. Full 11-layer harness architecture is in place. No open RFCs.

**What's shipped:**
- FlowSpec schema v1.0.0, 26 canvas node types (14 base + 12 harness), 5 reference flows, ADR-001 closed
- XYFlow canvas, LangGraph + CrewAI + Mastra + MAF adapters, auth, Langfuse, execution, HITL
- Observability stack (ClickHouse + Redis + Langfuse), OTel traces, token counts
- Team RBAC, JWT revocation, offline/online eval, prompt versioning, A2A, deploy, marketplace
- SSO/OIDC + SCIM, Helm chart, Yjs real-time collab, `@buildaharness/canvas` package
- Full harness architecture: 11-layer reasoning and control system, 470 harness tests (P0–P11, P-PC, integration, E2E, invariants)
- npm packages: `@buildaharness/harness`, `@buildaharness/runtime`, `@buildaharness/react`, `@buildaharness/proxy`

---

## Architecture Decision Records

Significant design decisions are in `docs/adr/`. Open a new `[adr]` issue with new evidence to challenge an accepted record — don't re-litigate in the original thread.

| ADR | Title | Status |
|---|---|---|
| [ADR-001](docs/adr/001-codegen-field-semantics.md) | Codegen semantics: `output_key`, `*_expr`, `context_from`, `memory_write.tier` | Accepted |

---

## What we need

**Adapter runtime feedback** — if you use LangGraph, CrewAI, Mastra, or MAF seriously, tell us where the adapter generates wrong or unidiomatic code. Open an `[adapter]` issue with the spec JSON, generated output, and the correct output.

**New node types** — what flow pattern can't you express with the 14 existing types? Open a `[node-type]` issue with a concrete use case, proposed schema shape, and per-adapter mapping for all four runtimes.

**Community components** — publish tool wrappers to the marketplace via `POST /marketplace`. Especially needed: database connectors, cloud API wrappers, data transformation tools. See [Publishing a marketplace component](#publishing-a-marketplace-component).

**Eval integration feedback** — the eval harness (DeepEval + Ragas) and Langfuse LLM-as-judge are shipped. Tell us what's missing: in-flow quality gates, specific metric implementations, CI regression thresholds.

**`@buildaharness/canvas` consumers** — if you embed the canvas package in your own tool, open a `[canvas-pkg]` issue for anything that doesn't fit the current props API.

---

## Issue labels

| Label | Use for |
|---|---|
| `[spec]` | Schema changes — new fields, changed types, new constraints |
| `[node-type]` | New node type proposals or changes to existing types |
| `[adapter]` | Questions, bugs, or improvements specific to one runtime |
| `[adr]` | Proposing a new Architecture Decision Record |
| `[breaking]` | Anything that invalidates currently valid flows |
| `[docs]` | README, CHANGELOG, ADR, or in-schema `describe()` improvements |
| `[marketplace]` | Component publishing, install behaviour, seeder |
| `[deploy]` | REST/MCP/A2A deploy pipeline, shareable URLs, invoke endpoint |
| `[eval]` | Eval harness, LLM-as-judge, Langfuse scoring |
| `[observability]` | Tracing, token counts, Langfuse wiring |
| `[collab]` | Yjs real-time collaboration, presence, offline persistence |
| `[canvas-pkg]` | `@buildaharness/canvas` npm package — props API, embedding, theming |

---

## Making schema changes

`spec/schema.ts` is the canonical source of truth. `spec/schema.json` is derived — never edit it directly.

Every schema PR must include:

1. **`spec/schema.ts`** — the change with a `describe()` string explaining field semantics
2. **`src/spec/schema.ts`** — kept in sync (omit `.refine()` calls on discriminated union members)
3. **`packages/canvas/src/spec/schema.ts`** — same sync, same rule
4. **`packages/runtime/src/spec/schema.ts`** — same sync, same rule (runtime's own copy — see that file's header comment for why it doesn't just depend on `@buildaharness/canvas` or `@buildaharness/flow-spec`)
5. **`spec/schema.json`** — regenerated
6. **`spec/CHANGELOG.md`** — one entry under the appropriate version header
7. **At least one example flow** in `flows/` demonstrating the change

Run `node scripts/check-schema-sync.mjs` to verify all copies are aligned.

Spec version follows semver. Minor versions are additive only (new optional fields). Removing or renaming fields requires a major bump and a migration note in `CHANGELOG.md`.

---

## Writing an adapter

An adapter is a Python module with one public function:

```python
def compile_<runtime>(spec: dict) -> tuple[str, list[str]]:
    """
    Returns (code: str, warnings: list[str]).
    Warnings are shown in the canvas compile panel.
    """
```

Register it in `adapter/main.py` (`SUPPORTED_RUNTIMES` + compile dispatch) and in `adapter/run_api.py` if execution is also supported.

If execution requires a sidecar (like Mastra's Node.js runner), add it to `docker-compose.yml` and document the protocol.

### ADR-001 field contracts — all adapters must respect these

| Field | Contract |
|---|---|
| `output_key` | Node returns `{output_key: result}`. If absent on `llm_call`, return `{}` and log a warning. |
| `query_expr` / `key_expr` / `value_expr` | Bare JSONPath (`$.state.field`). Implement `_resolve(expr, state)` — see `langgraph_adapter.py`. |
| `context_from` on edges | Map to the runtime's native context mechanism. Generate a descriptive comment block if no native equivalent exists. |
| `memory_write.tier` | Map to the runtime's memory tier API. Generate a comment if no native tier system exists. |

### NODE_SUPPORT_MATRIX — mark compat for all four runtimes

Every node type in `spec/schema.ts` carries runtime compatibility flags: `[LG]` LangGraph, `[CR]` CrewAI, `[MA]` Mastra, `[MS]` MS Agent Framework. Mark full / partial / missing for each. The canvas shows a warning badge when the selected runtime has partial support.

### Testing your adapter

All 5 reference flows must produce syntactically valid output:

```python
import json, pytest
from <runtime>_adapter import compile_<runtime>

@pytest.mark.parametrize("flow_path", [
    "flows/01-rag-agent-flow.json",
    "flows/02-content-moderation-hitl-flow.json",
    "flows/03-parallel-risk-assessment-flow.json",
    "flows/04-research-crew-flow.json",
    "flows/05-debate-agent-a2a-flow.json",
])
def test_all_flows_compile(flow_path):
    spec = json.loads(open(flow_path).read())
    code, warnings = compile_<runtime>(spec)
    assert code
    compile(code, "<test>", "exec")  # Python; use tsc for TypeScript adapters
```

---

## Adding a node type

Touches nine places:

1. **`spec/schema.ts`** — Zod schema entry with `describe()` strings
2. **`src/spec/schema.ts`** — canvas copy (omit `.refine()` calls)
3. **`packages/canvas/src/spec/schema.ts`** — canvas package copy (same rule)
4. **`packages/runtime/src/spec/schema.ts`** — runtime's own copy (same rule); also add/skip an executor in `packages/runtime/src/executors/` depending on whether runtime should execute the new type or treat it as a passthrough stub
5. **`src/store/index.ts`** — `NODE_DEFAULTS` entry
6. **`src/canvas/nodes/NodeComponents.tsx`** — the React component, exported by name
7. **`src/canvas/nodes/index.ts`** — add to the `nodeTypes` export map
8. **`src/components/ConfigPanel.tsx`** — panel function + entry in `PANEL_MAP`
9. **`src/canvas/nodes/BaseNode.tsx`** — icon (`NODE_ICONS`) and colour (`NODE_HEX`)

### Adding a harness node type

Harness nodes (those inside `src/canvas/nodes/harness/`) need two additional steps:

9. **`adapter/harness/node_compilers.py`** — add a `compile_<type>_node(node)` function and register it in `HARNESS_NODE_COMPILERS`
10. **`adapter/harness/__init__.py`** — export the new compile function and update `HARNESS_NODE_COMPILERS`

The harness node is then available to all four adapters automatically via `gen_harness_preamble()`.

---

## Canvas contributions

```bash
npm install
npm run dev      # → http://localhost:3000
npm test         # Vitest — must stay green

# Canvas package (packages/canvas/)
npm run build:canvas     # lib build → packages/canvas/dist/
npm run test:canvas      # canvas-package tests
npm run typecheck:canvas # TypeScript check
```

The canvas must never break spec round-trip. `npm test` validates all 5 reference flows through import → canvas state → export → Zod parse.

### `@buildaharness/canvas` package contributions

The canvas package in `packages/canvas/` uses a **per-instance Zustand store** via `createStore()` — not a module-level singleton. This is intentional so the component is safe to mount multiple times on a page. Any contribution that introduces module-level mutable state will be rejected.

Props changes require updating `packages/canvas/src/BuildAHarnessCanvas.tsx`, `packages/canvas/README.md`, and this file's props table if it changes the public API.

### Collab contributions

Real-time collab lives in `src/collab/`. The Yjs document structure (`doc.ts`) and the bidirectional sync with Zustand (`syncToYjs.ts` / `syncFromYjs.ts`) are the core of the layer. Any change that causes the Yjs doc and the Zustand store to diverge will cause split-brain for collaborators — test this carefully.

The y-websocket server is stateless with respect to the flow spec (it only relays CRDT ops). Do not add server-side state to the collab infrastructure.

---

## Publishing a marketplace component

```bash
curl -s -X POST http://localhost:8000/marketplace \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "slug":        "my-tool",
    "name":        "My Tool",
    "description": "Does something useful",
    "category":    "tool",
    "icon_emoji":  "🔧",
    "npm_ref":     "@my-scope/my-tool",
    "source":      "npm",
    "node_spec":   {"type": "tool_invoke", "tool_id": "my_tool", "data": {"label": "My Tool"}},
    "tool_def":    {
      "tool_ref": "@my-scope/my-tool",
      "source": "npm",
      "description": "Does something useful",
      "input_schema": {"type": "object", "properties": {"input": {"type": "string"}}, "required": ["input"]}
    },
    "tags": ["category", "keyword"]
  }'
```

**Slug rules** — kebab-case, `[a-z0-9][a-z0-9-]*[a-z0-9]`, max 80 chars, globally unique.  
`node_spec.tool_id` must equal `slug.replace("-", "_")`.  
User-published components start unverified. The `@buildaharness` verified badge is reserved for the six seed packages.

---

## Adding example flows

Example flows live in `flows/`. A valid flow must:

- Pass validation against `spec/schema.json`
- Include `position` coordinates on all nodes
- Have a `description` field
- Exercise at least one feature not covered by the existing five flows
- Follow naming: `NN-descriptive-name.json`

---

## Adapter test suite

```bash
# Main suite (SQLite in-memory, no stack required)
pytest adapter/tests/ -v
pytest adapter/tests/test_maf_adapter.py -v    # MAF suite
pytest adapter/tests/test_sso.py -v            # SSO/OIDC + SCIM suite

# Harness suite (all infrastructure-free, uses --noconftest)
PYTHONPATH=adapter python3.12 -m pytest adapter/tests/test_harness_p*.py adapter/tests/test_harness_process_concepts.py adapter/tests/test_harness_primitives.py -v --noconftest

# Harness integration + E2E + invariants
PYTHONPATH=adapter python3.12 -m pytest adapter/tests/test_harness_integration_*.py adapter/tests/test_harness_e2e.py adapter/tests/test_harness_invariants.py -v --noconftest
```

Tests use an in-memory SQLite database via the `client` fixture in `conftest.py`. New test files must:

- Use `client` and `auth_headers` fixtures from `conftest.py`
- Register a fresh user per test with a unique email address
- Mark all async tests with `@pytest.mark.asyncio`

---

## Database migrations

The current migration chain is `0001 → 0011`. Add new migrations as `000N_descriptive_name.py` in `adapter/migrations/versions/`:

```python
revision: str = "0012"
down_revision: str | None = "0011"

def upgrade() -> None:
    op.create_table("my_table", ...)

def downgrade() -> None:
    op.drop_table("my_table")
```

Use `postgresql.UUID` and `postgresql.JSONB` in migrations. In `db.py` ORM models, use the `_UUIDType` and `_JSONBType` wrappers — these fall back to `TEXT` on SQLite so the CI test suite works without Postgres.

---

## Code of conduct

Be direct. Disagree on specifics, not people. If a decision is documented in an ADR, a closed issue, or the CHANGELOG — open a new issue with new evidence rather than re-litigating the original thread.
