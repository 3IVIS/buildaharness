# Contributing to itsharness

## Where things stand

Phases 0, 1, and 2 are complete. The RFC is closed — all 36 questions are decided, deferred, or parked. Three adapters are fully operational (LangGraph, CrewAI, Mastra). Langfuse self-host and HITL pause/resume are shipped.

The most valuable contributions right now are in Phase 3 territory: runtime feedback from real adapter users, eval integration, and tooling for teams.

---

## Architecture Decision Records (ADRs)

Significant adapter-level design decisions are recorded in `docs/adr/`. Each ADR has a status, what it closes, and a concrete implementation checklist.

| ADR | Title | Status |
|---|---|---|
| [ADR-001](docs/adr/001-codegen-field-semantics.md) | Codegen semantics: `output_key`, `*_expr`, `context_from`, `memory_write.tier` | Accepted |

Before opening an issue about how a spec field should map to generated code, check whether an ADR already covers it. If you believe an accepted ADR is wrong, open an issue with `[adapter]` prefix and link the ADR — don't re-litigate in the original thread.

New ADRs follow the same template: status, what it closes/unblocks, per-adapter decision, implementation checklist.

---

## What we need right now (Phase 3)

**Runtime feedback** — if you use LangGraph, CrewAI, or Mastra seriously, tell us where the adapter's generated code is wrong or unidiomatic. Open an `[adapter]` issue with the spec JSON, the generated code, and what the correct output should look like.

**Adapter for a new runtime** — writing an adapter is a well-defined task. See `adapter/crewai_adapter.py` and `adapter/langgraph_adapter.py` for the pattern. The contract is: `compile(spec: dict) -> tuple[str, list[str]]` (code, warnings). ADR-001 defines the field semantics all adapters must respect.

**Missing node types** — what flow pattern can't you express in the 14 node types? Open a `[node-type]` issue with a concrete use case, proposed schema shape, and how you'd want it represented on the canvas.

**Python tool refs** — the `tool_ref` field is npm-only. This is wrong for the Python community (LangGraph, CrewAI). We need a solution that works for both ecosystems without forking the field.

**Eval integration** — `eval_node` was deferred to Phase 3. Tell us what you actually need: in-flow quality gates? Offline batch eval? LLM-as-judge on production traces? CI regression runs?

---

## Issue labels

Use these prefixes in your issue title:

| Label | Use for |
|---|---|
| `[spec]` | Schema changes — new fields, changed types, new constraints |
| `[node-type]` | New node type proposals or changes to existing types |
| `[adapter]` | Questions, bugs, or improvements specific to one runtime adapter |
| `[adr]` | Proposing a new Architecture Decision Record |
| `[breaking]` | Anything that would invalidate currently valid flows |
| `[docs]` | README, CHANGELOG, ADR, or in-schema `describe()` improvements |
| `[flows]` | Changes to or additions of example flows |
| `[observability]` | Langfuse integration, tracing, eval |

---

## Making schema changes

The Zod schema (`spec/schema.ts`) is the canonical source of truth. The JSON Schema (`spec/schema.json`) is derived from it. **Never edit `schema.json` directly.**

Every schema PR must include:

1. **`spec/schema.ts`** — the change itself, with a `describe()` string explaining the field's semantics and adapter behaviour for each affected type
2. **`src/spec/schema.ts`** — kept in sync (omit `.refine()` calls on discriminated union members)
3. **`spec/schema.json`** — regenerate from the Zod schema
4. **`spec/CHANGELOG.md`** — one entry under the appropriate version header
5. **At least one example flow** in `flows/` demonstrating the change, validated against the new schema

### Regenerating schema.json

```bash
cd spec
npx ts-node generate-schema.ts
```

Until the generation script exists, include your `schema.ts` changes and note in the PR that `schema.json` needs regeneration.

### Schema change rules

Spec version follows semver. **In minor versions, all changes must be additive (new optional fields)**. Removing or renaming fields requires a major version bump and a migration note in `CHANGELOG.md`. If you're unsure whether your change is breaking, ask in the issue before writing code.

---

## Writing an adapter

An adapter is a Python module with a single public function:

```python
def compile_<runtime>(spec: dict) -> tuple[str, list[str]]:
    """
    Compile a FlowSpec dict to runnable code.
    Returns (code: str, warnings: list[str]).
    Warnings are shown to the user in the canvas compile panel.
    """
```

The adapter is registered in `adapter/main.py` (`SUPPORTED_RUNTIMES` + the compile dispatch block) and in `adapter/run_api.py` if execution is also supported.

### ADR-001 field contracts (all adapters must respect these)

| Field | Adapter contract |
|---|---|
| `output_key` | Node function returns `{output_key: result}`. If absent on `llm_call`, return `{}` and log a warning. |
| `query_expr` / `key_expr` / `value_expr` | Bare JSONPath (`$.state.field`). Implement a `resolve_expr(expr, state)` helper — see `langgraph_adapter.py`. |
| `context_from` (on edges) | Map to the runtime's native context mechanism. If no native equivalent, generate a comment block. Log a warning if the source node has no `output_key`. |
| `memory_write.tier` | Map to the runtime's memory tier system. If no native tier API, generate a comment. |

### Testing your adapter

All 5 reference flows must produce syntactically valid output. Add a test to `adapter/tests/test_<runtime>_adapter.py`:

```python
import json, pytest
from <runtime>_adapter import compile_<runtime>

FLOWS = [f"../flows/{i:02d}-*.json" for i in range(1, 6)]  # glob in fixture

def test_all_flows_compile(flow_json):
    code, warnings = compile_<runtime>(json.loads(flow_json))
    assert code  # non-empty
    compile(code, "<test>", "exec")  # valid Python (or use tsc for TS)
```

---

## Adding example flows

Example flows live in `flows/`. A valid example flow must:

- Pass validation against `spec/schema.json`
- Include `position` coordinates on all nodes (canvas rendering)
- Have a `description` field at the top level explaining what it demonstrates
- Exercise at least one node type or feature not already covered by the existing five flows
- Follow the naming convention: `NN-descriptive-name.json` (next available number)

---

## Canvas contributions

The canvas is React + TypeScript + XYFlow. Run it with:

```bash
npm install
npm run dev   # → http://localhost:3000
npm test      # Vitest — must stay green
```

The canvas must never break spec export/import. `npm test` validates all 5 reference flows through the full round-trip (import → canvas state → export → Zod parse). Add new test cases in `src/spec/schema.test.ts` for any new cross-ref validation rules.

### Per-node config panels

Each node type has a config panel in `src/components/ConfigPanel.tsx`. Adding a new node type requires:

1. A Zod schema entry in both `spec/schema.ts` and `src/spec/schema.ts`
2. A `NODE_DEFAULTS` entry in `src/store/index.ts`
3. A config panel function in `ConfigPanel.tsx` registered in the `PANELS` map
4. An icon and colour in `src/canvas/nodes/BaseNode.tsx` (`NODE_HEX`, `NODE_ICONS`)
5. A `NODE_SUPPORT_MATRIX` entry in `src/spec/schema.ts` for the 4 runtimes

---

## Code of conduct

Be direct. Disagree on specifics, not people. If a decision was made and documented — in an ADR, a closed issue, or the CHANGELOG — open a new issue with new evidence rather than re-litigating the original thread.
