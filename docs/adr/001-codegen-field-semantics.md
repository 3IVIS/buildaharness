# ADR-001 — Codegen field semantics: `output_key`, `query_expr`, `context_from`, `memory_write.tier`

**Status:** Accepted  
**Date:** 2026-05-16  
**Closes:** RFC-1 (`context_from`), RFC-2 (`memory_write.tier`) in `crewai_adapter.py`  
**Unblocks:** LangGraph adapter real codegen · CrewAI adapter → 100% · HITL pause/resume UI · v0.1 release

---

## Context

Three spec fields have been present in the schema since v0.1.0 / v0.2.0 but their exact runtime semantics were left open pending community RFC feedback. These open questions are the sole remaining blocker for:

- Real LangGraph adapter codegen (~500–800 LOC)
- Uncommenting two `RFC_PENDING` stubs in `crewai_adapter.py`
- Unlocking HITL pause/resume UI (depends on LG adapter)
- v0.1 public release

All four decisions below are derivable from evidence already in the repository. No spec schema changes are required. This ADR records the decisions so adapter authors have a stable contract to code against.

---

## Decision 1 — `output_key`: direct state-dict write

### Fields affected

`output_key` appears on: `llm_call` (optional), `hitl_breakpoint` (optional), `parallel_join` (optional), `memory_read` (required).

### Decision

`output_key` is the state dict key the node writes its primary result to. A node function returns exactly `{output_key: result}` and the runtime's state merge handles the rest.

| Node type | `output_key` | Behaviour when absent |
|---|---|---|
| `llm_call` | optional | Returns `{}` — no state write. Canvas emits a warning: _"llm_call has no output_key and no structured_output — result will be lost."_ |
| `hitl_breakpoint` | optional | Returns `{}` when absent. Defaults to node ID in generated code comments. |
| `parallel_join` | optional | Returns `{}` — aggregated result is discarded. Canvas warns. |
| `memory_read` | **required** (enforced by Zod) | N/A |

### Adapter implementation

```python
# LangGraph — every node function follows this pattern
def node_generate(state: FlowState) -> dict:
    result = llm.invoke(resolve_prompt(node["prompt_template"], state))
    out_key = node.get("output_key")
    return {out_key: result} if out_key else {}
```

```typescript
// Mastra — already implemented correctly
return { [out_key]: result }
```

```python
# CrewAI — output_key is used in Task(expected_output=...) and the
# output_field binding on agent_role nodes; no change needed
```

### Rationale

The reference flow (`flows/01-rag-agent-flow.json`) already relies on this interpretation unambiguously — `"output_key": "answer"` on the `generate` node, `"output_key": "retrieved_chunks"` on the `retrieve` node. Mastra implements it this way. Making it explicit removes the only remaining ambiguity.

---

## Decision 2 — `query_expr` / `key_expr` / `value_expr`: bare JSONPath selectors

### Fields affected

- `memory_read.query_expr` — query string for semantic retrieval
- `memory_read.key_expr` — key lookup for key-value retrieval
- `memory_write.key_expr` — key to write to
- `memory_write.value_expr` — value to write

### Decision

All `*_expr` fields are **bare JSONPath expressions** evaluated against the current flow state. They are _not_ mustache templates.

```
$.state.question          ✓  bare JSONPath — resolves to state["question"]
{{$.state.question}}      ✗  mustache syntax — only valid in prompt_template
```

This distinction is already established by the reference flows:

```json
// flows/01-rag-agent-flow.json
"query_expr": "$.state.question",
"key_expr":   "$.state.question",
"value_expr": "$.state.answer"
```

Compare with `prompt_template`, which uses mustache:

```
"Context:\n{{$.state.formatted_context}}\n\nQuestion: {{$.state.question}}"
```

`*_expr` fields **resolve a value**. `prompt_template` **renders a string**. These are different operations and must use different syntax.

### Adapter implementation

All adapters should implement a shared `resolve_expr(expr, state)` helper:

```python
# Python adapters (LangGraph, CrewAI)
import re

def resolve_expr(expr: str, state: dict) -> Any:
    """Resolve a $.state.key JSONPath expression against current state.
    
    Supports simple dot-paths only ($.state.key, $.state.nested.key).
    For full JSONPath compliance, swap in jsonpath-ng.
    """
    expr = expr.strip()
    # Strip leading $.state. or $.
    path = re.sub(r"^\$\.state\.", "", expr)
    path = re.sub(r"^\$\.", "", path)
    # Traverse dot-separated keys
    val = state
    for segment in path.split("."):
        if isinstance(val, dict):
            val = val.get(segment)
        else:
            return None
    return val
```

```typescript
// TypeScript adapters (Mastra) — already implemented via ts_str()
// Formalise as:
function resolveExpr(expr: string, state: Record<string, unknown>): unknown {
  const path = expr.replace(/^\$\.state\./, '').replace(/^\$\./, '')
  return path.split('.').reduce<unknown>((obj, key) =>
    obj != null && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined,
    state
  )
}
```

### Rationale

The reference flows unambiguously use bare JSONPath for all `*_expr` fields. The canvas `EdgeConfigPanel` already uses this syntax for `context_from` references. Using mustache in these fields would be a category error — they select data, they don't render strings.

---

## Decision 3 — `context_from`: per-adapter semantics

### Field affected

`DirectEdge.context_from: string[]` — list of node IDs whose outputs are explicitly declared as context for the target node.

### Decision by adapter

**CrewAI** — native support. Maps directly to `Task.context=[task_a, task_b]`.  
**Action:** Uncomment the `RFC_PENDING[RFC-1]` lines in `crewai_adapter.py`. This closes RFC-1.

```python
# Before (in crewai_adapter.py emit_task):
# RFC_PENDING[RFC-1]: context=[task_research, task_analyse]
# Uncomment once context_from semantics are decided.

# After:
context=[task_research, task_analyse],
```

**LangGraph** — LG nodes receive the full shared state, so all prior `output_key` values are already accessible. `context_from` is a **dependency declaration**, not a data routing instruction. The adapter generates a comment block in the node function:

```python
def node_write_report(state: FlowState) -> dict:
    # context_from: ["research", "analyse"]
    # → state["research_output"] and state["analyse_output"] available via shared state
    ...
```

Additionally: if any node ID in `context_from` references a source node with no `output_key` set, the LG adapter emits a codegen warning to stderr.

**Mastra** — inject referenced step outputs as additional input fields in the step's input schema. Already implemented; no change.

**Microsoft Agent Framework** — inject as additional step input fields, consistent with Mastra. Document in adapter README.

### Canvas validation (no schema change)

The cross-ref validator (`src/spec/validation.ts`) already catches `context_from` references to non-existent nodes. No schema change needed. Add one additional canvas warning:

> _"`context_from` references node `{id}` which has no `output_key` — LangGraph adapter will emit a warning; CrewAI Task.context will be empty for this source."_

### Rationale

The CHANGELOG for v0.2.0 already documents the intended semantics: _"Maps to CrewAI `Task.context=`; other adapters inject as additional state fields or system prompt sections."_ Flow 04 (`04-research-crew-flow.json`) exercises this with two edges carrying `context_from`. The CrewAI adapter already generates the correct code commented out. This decision just authorises uncommenting it.

---

## Decision 4 — `memory_write.tier`: Crew-level construction hint for CrewAI

### Field affected

`MemoryWriteNode.tier: 'short' | 'long' | 'entity' | 'user'` (optional, default `'short'`).

### Decision

CrewAI's memory API does not support imperative per-task tier targeting. Memory is configured at `Crew()` construction time; the framework routes writes automatically based on which memory backends are present.

The adapter handles `tier` in two places:

**1. Crew constructor** — scan all `memory_write` nodes in the flow, collect distinct tiers, and add the corresponding `XXXMemory()` instances:

```python
# crewai_adapter.py — gen_crew() section
from crewai.memory import ShortTermMemory, LongTermMemory, EntityMemory, UserMemory

TIER_MAP = {
    "short":  "ShortTermMemory()",
    "long":   "LongTermMemory()",
    "entity": "EntityMemory()",
    "user":   "UserMemory()",
}

used_tiers = {
    n.get("tier", "short")
    for n in spec["nodes"]
    if n["type"] == "memory_write"
}

memory_kwargs = ", ".join(
    f"{tier}_term_memory={TIER_MAP[tier]}"
    for tier in used_tiers
    if tier in TIER_MAP
)
# → e.g. long_term_memory=LongTermMemory(), entity_memory=EntityMemory()
```

**2. Task generation** — replace the `RFC_PENDING[RFC-2]` comment with a descriptive comment only (no API call):

```python
# Before:
# RFC_PENDING[RFC-2]: tier='long' — CrewAI tier mapping TBD

# After:
# memory tier: 'long' → LongTermMemory configured at Crew level
```

This closes RFC-2 in `crewai_adapter.py`.

### Other adapters

| Adapter | `tier` behaviour |
|---|---|
| LangGraph | Ignored at codegen. Comment generated: `# memory tier hint: '{tier}' — configure your store backend accordingly` |
| Mastra | Ignored. Mastra memory is configured via `MastraMemory` at agent/workflow level, not per-write. |
| MS Agent Framework | Ignored. Document in adapter README. |

The `tier` field remains in the spec as a CrewAI-specific hint. The `describe()` string in `spec/schema.ts` already documents this correctly: _"CrewAI memory tier. short=ChromaDB, long=SQLite, entity=facts, user=prefs. Other adapters map to nearest equivalent."_ No schema change needed.

### Rationale

CrewAI's memory model is Crew-level, not Task-level. Attempting to generate per-task tier writes would require wrapping every `memory_write` node in a custom `BaseTool`, adding significant complexity with no real benefit — the Crew-level configuration achieves the same routing. This approach keeps generated code readable and idiomatic.

---

## Implementation checklist

### `adapter/crewai_adapter.py`

- [ ] **RFC-1** — In `emit_task()`: replace the `RFC_PENDING[RFC-1]` commented lines with live `context=[...]` argument when `ctx` is non-empty
- [ ] **RFC-2** — In `gen_tasks()` for `memory_write`: replace `RFC_PENDING[RFC-2]` comment with `# memory tier: '{tier}' → configured at Crew level`
- [ ] **RFC-2** — In `gen_crew()`: scan `memory_write` nodes for distinct tiers; add `XXXMemory()` kwargs to `Crew()` constructor
- [ ] Update the module docstring: remove `RFC_PENDING` entries from the "isolated" section, move to "resolved"
- [ ] Update `main.py` `SUPPORTED_RUNTIMES["crewai"]["note"]` from `"RFC_PENDING: context_from + memory tier."` → `"Full codegen."`

### `adapter/langgraph_adapter.py` (new file)

- [ ] Implement `resolve_expr(expr, state)` helper
- [ ] `llm_call` → node function returning `{output_key: result}` or `{}` if absent, with canvas warning logged
- [ ] `memory_read` → `resolve_expr(query_expr, state)` for semantic mode; `resolve_expr(key_expr, state)` for key-value mode
- [ ] `memory_write` → `resolve_expr(key_expr, state)` + `resolve_expr(value_expr, state)` + tier comment
- [ ] `context_from` on edges → generate comment block per Decision 3; emit stderr warning if source node has no `output_key`
- [ ] `hitl_breakpoint` → `interrupt()` + `update_state()` pattern; `output_key` receives resume payload
- [ ] `parallel_fork` / `parallel_join` → `Send()` pattern; `parallel_join.output_key` receives aggregated result

### `src/spec/validation.ts`

- [ ] Add canvas warning: `context_from` source node has no `output_key` (non-blocking, warning level)
- [ ] Add canvas warning: `llm_call` has no `output_key` and no `structured_output`

### `spec/CHANGELOG.md`

- [ ] Add entry under `[Unreleased]` → _"ADR-001: Codegen semantics for `output_key`, `*_expr`, `context_from`, `memory_write.tier` — no schema changes, adapter contracts formalised."_

---

## Consequences

- **No spec version bump.** All four decisions are adapter-level contracts. The schema already contains the correct fields and types.
- **No breaking changes.** All existing valid flows remain valid.
- **CrewAI adapter reaches 100%.** Two stubs uncommented, one Crew-level change added.
- **LangGraph adapter can start.** All three blocking questions answered with implementable decisions.
- **Cross-adapter consistency.** `resolve_expr()` helper is shared across all Python adapters; TypeScript equivalent in Mastra.
