# Contributing to itsharness

## Where things stand

Phases 0–3 are complete (v0.7.0). The Phase 0 RFC is closed — all 37 questions were resolved across the build process, with the four core codegen field semantics formally recorded in ADR-001. All three adapter runtimes (LangGraph, CrewAI, Mastra) are fully operational including execution. The component marketplace, one-click deploy (REST + MCP + A2A), Team RBAC, multi-tenant namespacing, online/offline eval, and Langfuse self-host are all shipped.

Phase 4 is the next frontier: real-time collaborative canvas (Yjs), MS Agent Framework adapter, SSO via Keycloak, visual CI/CD pipeline, on-prem Helm chart, and an embeddable `@itsharness/canvas` npm package.

The most impactful contributions right now are adapter runtime feedback, Phase 4 groundwork (especially the MAF adapter and Yjs prototype), and community component publishing.

---

## Architecture Decision Records (ADRs)

Significant design decisions are recorded in `docs/adr/`. Each ADR has a status, what it closes, and a per-adapter implementation contract.

| ADR | Title | Status |
|---|---|---|
| [ADR-001](docs/adr/001-codegen-field-semantics.md) | Codegen semantics: `output_key`, `*_expr`, `context_from`, `memory_write.tier` | Accepted |

**ADR-001 scope** — covers the four spec fields whose adapter semantics were left open during the Phase 0 RFC: how `output_key` maps to state writes, that `*_expr` fields are bare JSONPath (not mustache), how `context_from` behaves per runtime, and how `memory_write.tier` maps to CrewAI's Crew-level memory construction. It does not cover all 37 RFC questions — the broader question set was resolved through implementation across Phases 1–3 and is tracked in the open questions tracker.

Before opening an issue about how a spec field maps to generated code, check whether an ADR already covers it. To challenge an accepted ADR, open a new issue with `[adr]` prefix and new evidence — don't re-litigate in the original thread.

---

## What we need right now

**Runtime feedback** — if you use LangGraph, CrewAI, or Mastra seriously, tell us where the adapter generates wrong or unidiomatic code. Open an `[adapter]` issue with the spec JSON, generated output, and the correct output.

**MS Agent Framework adapter** — MAF v1.0 GA'd Apr 2026 (merger of Semantic Kernel + AutoGen). This is the highest-value Phase 4 contribution. The contract is the same as existing adapters: `compile_maf(spec: dict) -> tuple[str, list[str]]`. See `adapter/langgraph_adapter.py` for the pattern and ADR-001 for field semantics. Key mappings: `agent_debate → GroupChatManager`, `agent_role → AssistantAgent`, `tool_invoke → FunctionTool`. OTel traces should flow to Langfuse via OTLP.

**Yjs real-time collab prototype** — multi-user canvas using Yjs CRDT + y-websocket + XYFlow. The main design question is conflict-free merge strategy for the flow spec graph (nodes and edges are CRDT-friendly; IDs need care). A prototype in a feature branch would be very welcome.

**Community components** — publish your own tool wrappers to the marketplace via `POST /marketplace`. Especially needed: database connectors, cloud API wrappers, and data transformation tools. See the marketplace API reference in the README.

**Eval integration feedback** — the eval harness (DeepEval + Ragas) and online eval (Langfuse LLM-as-judge) are shipped. Tell us what's missing: in-flow quality gates? Specific metric implementations? CI regression thresholds?

**Missing node types** — what flow pattern can't you express in the 14 node types? Open a `[node-type]` issue with a concrete use case, proposed schema shape, and per-adapter mapping.

---

## Issue labels

| Label | Use for |
|---|---|
| `[spec]` | Schema changes — new fields, changed types, new constraints |
| `[node-type]` | New node type proposals or changes to existing types |
| `[adapter]` | Questions, bugs, or improvements specific to one runtime |
| `[adr]` | Proposing a new Architecture Decision Record |
| `[breaking]` | Anything that would invalidate currently valid flows |
| `[docs]` | README, CHANGELOG, ADR, or in-schema `describe()` improvements |
| `[marketplace]` | Community component publishing, install behaviour, seeder |
| `[deploy]` | REST/MCP/A2A deploy pipeline, shareable URLs, invoke endpoint |
| `[eval]` | Eval harness, LLM-as-judge, Langfuse scoring integration |
| `[observability]` | Tracing, token counts, Langfuse wiring |
| `[phase4]` | Yjs collab, MAF adapter, SSO, Helm chart, embeddable canvas |

---

## Making schema changes

The Zod schema (`spec/schema.ts`) is the canonical source of truth. The JSON Schema (`spec/schema.json`) is derived from it. **Never edit `schema.json` directly.**

Every schema PR must include:

1. **`spec/schema.ts`** — the change, with a `describe()` string explaining field semantics and per-adapter behaviour
2. **`src/spec/schema.ts`** — kept in sync (omit `.refine()` calls on discriminated union members)
3. **`spec/schema.json`** — regenerated from the Zod schema
4. **`spec/CHANGELOG.md`** — one entry under the appropriate version header
5. **At least one example flow** in `flows/` demonstrating the change, validated against the new schema

Spec version follows semver. In minor versions all changes must be additive (new optional fields only). Removing or renaming fields requires a major version bump and a migration note in `CHANGELOG.md`.

---

## Writing an adapter

An adapter is a Python module with a single public function:

```python
def compile_<runtime>(spec: dict) -> tuple[str, list[str]]:
    """
    Compile a FlowSpec dict to runnable code.
    Returns (code: str, warnings: list[str]).
    Warnings are surfaced to the user in the canvas compile panel.
    """
```

Register it in `adapter/main.py` (`SUPPORTED_RUNTIMES` + the compile dispatch block) and in `adapter/run_api.py` if execution is also supported.

If execution requires a sidecar process (like Mastra's Node.js runner), add it to `docker-compose.yml` and document the protocol in the sidecar's README.

### ADR-001 field contracts (all adapters must respect these)

| Field | Contract |
|---|---|
| `output_key` | Node function returns `{output_key: result}`. If absent on `llm_call`, return `{}` and log a warning. |
| `query_expr` / `key_expr` / `value_expr` | Bare JSONPath (`$.state.field`). Implement a `_resolve(expr, state)` helper — see `langgraph_adapter.py`. |
| `context_from` (on edges) | Map to the runtime's native context mechanism. Generate a descriptive comment block if no native equivalent exists. |
| `memory_write.tier` | Map to the runtime's memory tier API. Generate a comment if no native tier system exists. |

### Testing your adapter

All 5 reference flows must produce syntactically valid output:

```python
import json, pytest
from <runtime>_adapter import compile_<runtime>

@pytest.mark.parametrize("flow_path", [
    "flows/01-rag-agent-flow.json",
    "flows/02-content-moderation-hitl-flow.json",
    # ... all 5
])
def test_all_flows_compile(flow_path):
    spec = json.loads(open(flow_path).read())
    code, warnings = compile_<runtime>(spec)
    assert code
    compile(code, "<test>", "exec")  # valid Python; use tsc for TypeScript adapters
```

---

## Publishing a marketplace component

Components are pre-configured `tool_invoke` nodes published to the itsharness marketplace. Publishing requires authentication:

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

**`node_spec.tool_id`** must equal `slug.replace("-", "_")` — this is what the canvas uses to key the tool in the flow's tools registry after install.

User-published components start as unverified. The `@itsharness` verified badge is reserved for the six seed packages.

---

## Adding example flows

Example flows live in `flows/`. A valid flow must:

- Pass validation against `spec/schema.json`
- Include `position` coordinates on all nodes
- Have a `description` field explaining what it demonstrates
- Exercise at least one feature not already covered by the existing five flows
- Follow the naming convention: `NN-descriptive-name.json`

---

## Canvas contributions

The canvas is React + TypeScript + XYFlow. Run it with:

```bash
npm install
npm run dev   # → http://localhost:3000
npm test      # Vitest — must stay green
```

The canvas must never break spec export/import. `npm test` validates all 5 reference flows through the full round-trip (import → canvas state → export → Zod parse).

### Adding a new node type

Adding a node type touches six places:

1. **`spec/schema.ts`** — Zod schema entry with `describe()` strings
2. **`src/spec/schema.ts`** — canvas copy (omit `.refine()` calls)
3. **`src/store/index.ts`** — `NODE_DEFAULTS` entry
4. **`src/components/ConfigPanel.tsx`** — config panel registered in the `PANELS` map
5. **`src/canvas/nodes/BaseNode.tsx`** — icon (`NODE_ICONS`) and colour (`NODE_HEX`)
6. **`src/spec/schema.ts`** — `NODE_SUPPORT_MATRIX` entry for all 4 runtimes

### Adding a marketplace component UI card field

The `ComponentCard` in `src/components/MarketplacePanel.tsx` renders the fields returned by `GET /marketplace`. If you add a new field to the `CommunityComponent` Pydantic model, add it to both the `MarketplaceComponent` TypeScript interface in `src/services/api.ts` and the card render in `MarketplacePanel.tsx`.

---

## Adapter test suite

The adapter test suite lives in `adapter/tests/`. Tests use an in-memory SQLite database (no Postgres required in CI) via the `client` fixture in `conftest.py`.

```bash
# Run the full suite
pytest adapter/tests/ -v

# Run a specific test file
pytest adapter/tests/test_marketplace.py -v

# Run a specific test
pytest adapter/tests/test_deploy.py::test_unified_deploy_success -v
```

New test files must follow the existing pattern: use the `client` and `auth_headers` fixtures from `conftest.py`, register a fresh user per test with a unique email address (function-scoped DB prevents cross-test state, but duplicate emails within a test module will fail), and mark all async tests with `@pytest.mark.asyncio`.

---

## Database migrations

Schema changes require an Alembic migration. The migration chain is currently `0001 → 0007`. Add new migrations as `000N_descriptive_name.py` in `adapter/migrations/versions/`:

```python
revision: str = "0008"
down_revision: str | None = "0007"

def upgrade() -> None:
    op.create_table("my_table", ...)

def downgrade() -> None:
    op.drop_table("my_table")
```

**Important:** use `postgresql.UUID` and `postgresql.JSONB` in migrations (Postgres-native types). For the SQLAlchemy ORM model in `db.py`, use the `_UUIDType` and `_JSONBType` wrappers — these fall back to `TEXT` on SQLite so the test suite keeps working without Postgres.

After adding the ORM model in `db.py`, add it to `Base.metadata` by ensuring it's imported before `init_db()` runs. The `CommunityComponent`, `UnifiedDeployment`, `A2ADeployment`, and `Job` models are good references.

---

## Code of conduct

Be direct. Disagree on specifics, not people. If a decision is documented in an ADR, a closed issue, or the CHANGELOG — open a new issue with new evidence rather than re-litigating the original thread.
