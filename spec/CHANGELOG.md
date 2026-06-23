# Changelog

All notable changes to the Build A Harness Flow Spec schema are documented here.

Format: [Semantic Versioning](https://semver.org). Schema changes in minor versions are always additive (new optional fields). Breaking changes require a major version bump and a migration note.

---

## [1.0.0] — 2026-06-03

### Added — Harness architecture support (Phase 0 foundation)

**`harness_meta` block (optional)** — New optional top-level field that marks a flow as harness-capable. Fields: `harness_version: string`, `phase: string`, `enabled: boolean` (default `false`). When `enabled` is `false`, the adapter rejects any harness node type with a clear error. Flows without this block are treated as `enabled: false`.

**12 harness node type stubs** — New node types accepted by the schema (all require `harness_meta.enabled: true`): `world_model`, `hypothesis_set`, `gather_evidence`, `apply_tool_reliability`, `update_world_model`, `control_state`, `task_graph_node`, `verification_gate`, `recovery_node`, `evidence_store_node`, `experience_store_node`, `reviewer_pass`. Each accepts an opaque `harness_config: object` at this stage; field shapes are added per-phase.

**`SpecVersion` accepts both `"0.2.0"` and `"1.0.0"`** — The `spec_version` field now accepts either string. Migration tool `scripts/migrate-v0.2-to-v1.0.mjs` converts existing flows.

### Migration

Use `node spec/scripts/migrate-v0.2-to-v1.0.mjs <input.json> [output.json]` to convert a v0.2.0 flow to v1.0.0. The migration adds `"spec_version": "1.0.0"` and an empty `harness_meta` block with `enabled: false`. All existing node types and fields are preserved unchanged.

## [Unreleased]

No unreleased spec changes at this time.

## [0.2.0] — 2025-05-14 (updated 2026-05-16)

### Adapter contracts (ADR-001 — no schema version bump)

Codegen semantics formalised for four fields that were previously open RFC questions.
All items implemented as of project v0.8.0.
See [`docs/adr/001-codegen-field-semantics.md`](../docs/adr/001-codegen-field-semantics.md) for full rationale.

- **`output_key`** — Direct state-dict write: node function returns `{output_key: result}`. If absent on `llm_call` or `hitl_breakpoint`, returns `{}`. Canvas warns when `llm_call` has neither `output_key` nor `structured_output`.
- **`query_expr` / `key_expr` / `value_expr`** — Bare JSONPath selectors (`$.state.key`), not mustache templates. Adapters implement a shared `resolve_expr(expr, state)` helper.
- **`context_from`** — CrewAI: maps to `Task.context=[...]` (RFC-1 resolved). LangGraph: dependency declaration only — generates a comment block since LG already shares full state. Mastra: step input mapping.
- **`memory_write.tier`** — CrewAI Crew-level construction hint: adapter scans all `memory_write` nodes for distinct tiers and adds the corresponding `XXXMemory()` instances to the `Crew()` constructor (RFC-2 resolved). Task-level tier targeting is not supported by the CrewAI API. Other adapters treat `tier` as a comment-only hint.

### Added

- `FailBranch` and `RetryConfig` schema types for error-handling branches on `llm_call` and `tool_invoke` nodes
- `fail_branch` optional field on `LlmCallNode` and `ToolInvokeNode`
- Canvas renders `fail_branch` as a red dashed `FailEdge` with "on fail" label
- CrewAI and Mastra adapters emit retry logic when `fail_branch` is configured

### Added (original release)

**`agents[]` registry** — Top-level array of named agent personas (`AgentDef`). Each entry declares `id`, `role`, `backstory`, `goal`, `tools`, `memory_config`, `max_iter`, `allow_delegation`. Referenced by `agent_role` and `agent_debate` nodes.

**`agent_role` node** — Executes an agent persona as a typed task. Key fields: `agent_ref`, `task_description`, `expected_output`, `output_field`.
- `memory_access: 'isolated' | 'shared'` (default `isolated`) — controls whether the agent shares a named memory store with the parent flow. Harness validation error: `parallel_fork` branches with `memory_access: 'shared'` are disallowed.
- `memory_store_id: string` — required when `memory_access` is `'shared'`; must reference a key in `memory_stores`.
- `tool_approval: 'auto' | 'human'` (default `auto`) — when `'human'`, the adapter synthesises an approval gate before each tool call, reusing the shared HITL checkpoint/resume mechanism.

**`agent_debate` node** — Multi-agent conversation loop. Fields: `agents[]`, `max_rounds`, `termination_condition`, `speaker_selection` (`auto | round_robin | custom`), `speaker_selection_fn_ref`, `allow_repeat_speaker`, `output_field`. Native in MS Agent Framework `GroupChat`/`AgentGroupChat`; synthesised in LangGraph, CrewAI, Mastra.

**`context_from` on `DirectEdge`** — Optional `context_from: string[]` field on direct edges. Node IDs whose outputs are injected as context into the target task. Maps to CrewAI `Task.context=`; other adapters inject as additional state fields or system prompt sections.

**`flow_config.process_type`** — `'sequential' | 'hierarchical' | 'consensual'`. Maps to CrewAI `Crew(process=...)`. Other adapters ignore.

**`flow_config.manager_agent_ref`** — Required when `process_type` is `'hierarchical'`. References an entry in `agents[]`.

**`flow_config.a2a_config`** — Declares the flow as an A2A-compatible agent. Fields: `enabled`, `agent_name`, `agent_description`, `version`, `capabilities`, `authentication`, `input_schema_ref`, `output_schema_ref`, `skills[]`. Adapter generates `/.well-known/agent.json` and `/tasks/send` endpoint.

**`RuntimeHints.compatible`** — New `compatible: AdapterName[]` array alongside existing `preferred_adapter`.

**`MemoryStoreDef.namespace`** — Optional partition key for vector stores (Q33). Must reference an environment variable if it contains sensitive routing information.

**`MemoryWriteNode.tier`** — Optional `'short' | 'long' | 'entity' | 'user'` tier hint for CrewAI's 4-tier memory model. Other adapters map to nearest equivalent.

**`RuntimeSupportOverride`** — Updated adapter enum: `semantic_kernel` renamed to `microsoft_agent_framework`; `crewai` added.

### Changed

**`ToolDef.mcp_server_url`** — Description updated: must always reference an environment variable, never a hardcoded URL (Q12).

### Adapters

Four runtimes targeted: `langgraph`, `crewai`, `mastra`, `microsoft_agent_framework`.

---

## [0.1.0] — Initial design

First version of the spec schema. Established:
- 12 node types: `input`, `output`, `llm_call`, `tool_invoke`, `condition`, `parallel_fork`, `parallel_join`, `hitl_breakpoint`, `memory_read`, `memory_write`, `subgraph`, `transform`
- `DirectEdge` and `ConditionalEdge`
- `StateSchema` with `reducer` annotations per field
- `MemoryStoreDef`, `ToolDef`, `ModelDefaults`
- `FlowConfig`: `checkpoint`, `streaming`, `telemetry`
- `RuntimeHints` with `preferred_adapter`
- `RuntimeSupportOverride` per node
- `position: {x, y}` on all nodes (canvas-only; adapters must ignore)
- Adapters: `langgraph`, `mastra`, `microsoft_agent_framework` (then called `semantic_kernel`)
