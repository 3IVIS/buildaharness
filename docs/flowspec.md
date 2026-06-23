# FlowSpec reference

FlowSpec (JSON, `v1.0.0`) is the neutral intermediate representation that buildaharness uses to describe agent workflows. The canvas authors it; adapters compile it to LangGraph, CrewAI, Mastra, or MS Agent Framework code; the adapter API executes it.

The canonical Zod schema lives in `spec/schema.ts`. Canvas and package copies are in `src/spec/schema.ts` and `packages/canvas/src/spec/schema.ts` — see `CLAUDE.md` for sync rules.

---

## Top-level structure

```json
{
  "spec_version": "1.0.0",
  "id": "my-flow",
  "name": "My Flow",
  "description": "...",
  "runtime_hints": { ... },
  "state_schema": { ... },
  "agents": [ ... ],
  "nodes": [ ... ],
  "edges": [ ... ],
  "tools": { ... },
  "memory_stores": { ... },
  "model_defaults": { ... },
  "flow_config": { ... },
  "harness_meta": { ... }
}
```

| Field | Required | Description |
|---|---|---|
| `spec_version` | Yes | `"0.2.0"` or `"1.0.0"`. Existing v0.2.0 flows validate without changes. |
| `id` | Yes | Kebab-case flow identifier, e.g. `"rag-agent-flow"`. |
| `name` | No | Human-readable display name. |
| `description` | No | Free-text description shown in the canvas and marketplace. |
| `runtime_hints` | No | Non-binding hints about the target runtime. |
| `state_schema` | No | JSON Schema describing the flow's shared state object. |
| `agents` | No | Named agent personas referenced by `agent_role` and `agent_debate` nodes. |
| `nodes` | Yes | Array of node objects (minimum 2). |
| `edges` | Yes | Array of edge objects. |
| `tools` | No | Named tool definitions referenced by `tool_invoke` nodes. |
| `memory_stores` | No | Named memory/vector store definitions. |
| `model_defaults` | No | Default model and params applied to all `llm_call` nodes that don't override them. |
| `flow_config` | No | Checkpoint, streaming, telemetry, and deployment config. |
| `harness_meta` | No | Enables the harness layer. See [architecture.md](./architecture.md). |

---

## `runtime_hints`

Non-binding. Adapters ignore unknown fields.

```json
"runtime_hints": {
  "preferred_adapter": "langgraph",
  "compatible": ["langgraph", "crewai", "mastra", "microsoft_agent_framework"],
  "python_version": "3.12",
  "langgraph_version": "0.2"
}
```

| Field | Type | Description |
|---|---|---|
| `preferred_adapter` | `langgraph \| crewai \| mastra \| microsoft_agent_framework` | Default runtime for `/compile` and `/run` when not overridden. |
| `compatible` | array | Runtimes this flow is tested/supported on. |
| `python_version` | string | Minimum Python version hint for LangGraph/CrewAI adapters. |
| `node_version` | string | Minimum Node.js version hint for Mastra. |
| `langgraph_version` | string | LangGraph version hint. |
| `crewai_version` | string | CrewAI version hint. |
| `mastra_version` | string | Mastra version hint. |
| `ms_agent_framework_version` | string | MS Agent Framework version hint. |

---

## `state_schema`

Describes the shared state dictionary passed between nodes. Optional but strongly recommended — the canvas uses it for autocomplete and validation.

```json
"state_schema": {
  "type": "object",
  "properties": {
    "question": { "type": "string", "description": "User question" },
    "answer":   { "type": "string", "reducer": "replace" },
    "chunks":   { "type": "array",  "reducer": "append" }
  },
  "required": ["question"]
}
```

### Reducer strategies

Controls how a field is updated when multiple nodes write to it (relevant for parallel branches).

| Strategy | Behaviour |
|---|---|
| `replace` (default) | Last write wins. |
| `append` | Concatenates arrays. |
| `merge` | Deep object merge. |
| `last_wins` | Explicit last-write-wins (same as `replace`, semantically distinct). |
| `custom` | Requires `reducer_fn_ref` pointing to a custom merge function. |

---

## `agents`

Named agent personas. Referenced by `agent_role` and `agent_debate` nodes via `agent_ref`.

```json
"agents": [
  {
    "id": "researcher",
    "name": "Research Specialist",
    "role": "Senior Researcher",
    "backstory": "Expert in finding accurate, up-to-date information.",
    "goal": "Research the given topic thoroughly.",
    "model": "gpt-4o",
    "tools": ["web-search"],
    "memory_config": { "short_term": true, "long_term": true },
    "max_iter": 10,
    "allow_delegation": false
  }
]
```

| Field | Required | Description |
|---|---|---|
| `id` | Yes | Unique identifier, referenced by `agent_ref`. |
| `name` | No | Display name. |
| `role` | No | Agent's role (used as CrewAI `Agent(role=)`). |
| `backstory` | No | Agent persona backstory (CrewAI `Agent(backstory=)`). |
| `goal` | No | Agent's goal statement. |
| `model` | No | Overrides `model_defaults.model` for this agent. |
| `tools` | No | Tool IDs from the flow's `tools` registry. |
| `memory_config` | No | Which CrewAI memory tiers to enable (`short_term`, `long_term`, `entity`, `user`). |
| `max_iter` | No | Maximum ReAct iterations (default 10). |
| `allow_delegation` | No | Whether the agent can delegate tasks (CrewAI only). |

---

## `model_defaults`

Applied to all `llm_call` nodes that do not set their own `model` or `model_params`.

```json
"model_defaults": {
  "model": "gpt-4o-mini",
  "embedding_model": "nomic-embed-text",
  "model_params": {
    "temperature": 0.7,
    "max_tokens": 1024
  }
}
```

---

## `flow_config`

### `checkpoint`

```json
"flow_config": {
  "checkpoint": {
    "enabled": true,
    "backend": "postgres",
    "connection_env": "DATABASE_URL",
    "namespace": "my-flow"
  }
}
```

| Backend | Notes |
|---|---|
| `in_memory` | Default. State lost on process restart. |
| `sqlite` | Persistent local file. |
| `postgres` | Production-grade. Uses `DATABASE_URL`. |
| `redis` | Uses `REDIS_URL`. |

### `streaming`

```json
"streaming": { "enabled": true, "mode": "tokens" }
```

`mode`: `updates` (all runtimes) · `tokens` (all runtimes) · `debug` (LangGraph only).

### `telemetry`

```json
"telemetry": {
  "enabled": true,
  "provider": "langfuse",
  "trace_all_nodes": true
}
```

### `process_type` (CrewAI only)

`sequential` (default) · `hierarchical` (requires `manager_agent_ref`) · `consensual`.

### `a2a_config`

```json
"a2a_config": {
  "enabled": true,
  "agent_name": "Research Assistant",
  "agent_description": "Researches topics on demand.",
  "version": "1.0.0",
  "capabilities": ["streaming"],
  "authentication": "api_key",
  "input_schema_ref": "start",
  "output_schema_ref": "done",
  "skills": [{ "id": "research", "name": "Research a topic" }]
}
```

When `enabled: true`, deploying the flow creates an AgentCard at `/.well-known/agent/{id}.json` and a task endpoint at `/a2a/{id}/tasks/send`. `hitl_breakpoint` nodes map to the A2A `input-required` state.

---

## `memory_stores`

Named vector or key-value stores referenced by `memory_read` and `memory_write` nodes.

```json
"memory_stores": {
  "kb": {
    "type": "vector",
    "backend": "qdrant",
    "connection_env": "QDRANT_URL",
    "embedding_model": "nomic-embed-text",
    "dimensions": 768,
    "scope": "global"
  },
  "session": {
    "type": "key_value",
    "backend": "redis",
    "connection_env": "REDIS_URL",
    "scope": "thread"
  }
}
```

| Field | Values | Description |
|---|---|---|
| `type` | `key_value \| vector \| hybrid` | Store type. |
| `backend` | `in_memory \| postgres \| sqlite \| redis \| upstash \| qdrant \| pinecone \| azure_ai_search` | Storage backend. |
| `connection_env` | string | Environment variable name containing the connection URL. |
| `embedding_model` | string | Model used to embed queries and documents (vector stores only). |
| `dimensions` | integer | Vector dimension — must match the embedding model output. |
| `scope` | `thread \| resource \| global` | `thread`: isolated per job. `global`: shared across all runs. |
| `namespace` | string | Optional partition key for multi-tenant vector stores. |

---

## Node types — base (14 types)

Every node shares these base fields:

| Field | Required | Description |
|---|---|---|
| `id` | Yes | Kebab-case node identifier, unique within the flow. |
| `type` | Yes | Node type (see below). |
| `label` | No | Display name in the canvas. |
| `description` | No | Node description shown in tooltips. |
| `position` | No | `{ "x": number, "y": number }` — canvas layout only, adapters ignore. |
| `runtime_support` | No | Per-adapter support override (`full \| partial \| missing`). |

---

### `input`

Entry point of the flow. Defines the shape of data passed to `POST /run`.

```json
{ "id": "start", "type": "input",
  "output_schema": { "question": { "type": "string" } } }
```

| Field | Required | Description |
|---|---|---|
| `output_schema` | Yes | JSON Schema for the input payload. Validated against `state_schema`. |

Every flow must have exactly one `input` node.

---

### `output`

Terminal node. Marks where a flow's result is collected.

```json
{ "id": "done", "type": "output", "exit_code": "success" }
```

| Field | Required | Description |
|---|---|---|
| `exit_code` | No | Semantic label for this exit (default `"success"`). Use distinct codes for multiple exit paths. |
| `input_schema` | No | Expected shape of state when this node is reached. |

---

### `llm_call`

Calls an LLM and writes the response to the flow state.

```json
{
  "id": "generate",
  "type": "llm_call",
  "model": "gpt-4o-mini",
  "system_prompt": "You are a helpful assistant.",
  "prompt_template": "Answer: {{state.question}}\n\nContext:\n{{state.formatted_context}}",
  "output_key": "answer",
  "model_params": { "temperature": 0.3, "max_tokens": 512 }
}
```

| Field | Required | Description |
|---|---|---|
| `model` | No | Overrides `model_defaults.model`. |
| `system_prompt` | No | System prompt text (static). |
| `prompt_template` | No | User prompt — use `{{state.key}}` mustache syntax to interpolate state. |
| `prompt_ref` | No | Langfuse-managed prompt reference `{ "name": "...", "version": 1 }`. Takes precedence over `prompt_template`. |
| `model_params` | No | `temperature`, `max_tokens`, `top_p`, `frequency_penalty`, `presence_penalty`, `stop`. |
| `structured_output` | No | `{ "schema": { ... } }` — forces typed JSON output. |
| `output_key` | No | State key to write the result to. Canvas warns if absent and `structured_output` is also absent (result will be lost). |
| `output_validator` | No | Post-execution validation: `{ "fn_ref": "...", "on_fail": "raise\|retry\|skip", "max_retries": 1 }`. |
| `fail_branch` | No | `{ "target": "node-id", "retry": { "max_attempts": 3, "backoff": "exponential" } }` — routes failures to a designated node. |

---

### `tool_invoke`

Calls a registered tool from the flow's `tools` registry.

```json
{
  "id": "search",
  "type": "tool_invoke",
  "tool_id": "web-search",
  "input_map": { "query": "$.state.question" },
  "output_map": { "results": "search_results" }
}
```

| Field | Required | Description |
|---|---|---|
| `tool_id` | Yes | Key in the flow's `tools` map. |
| `input_map` | No | Maps state keys (as JSONPath) to tool input parameters. |
| `output_map` | No | Maps tool output fields to state keys. |
| `output_validator` | No | Same as `llm_call`. |

---

### `condition`

Routes execution to one of several branches based on state values.

```json
{
  "id": "route",
  "type": "condition",
  "branches": [
    { "condition": { "type": "expr", "expr": "$.state.severity == 'high'" }, "target": "escalate" },
    { "condition": { "type": "expr", "expr": "$.state.severity == 'medium'" }, "target": "review" }
  ],
  "default_target": "auto-approve"
}
```

| Field | Required | Description |
|---|---|---|
| `branches` | Yes | Ordered list of `{ condition, target }` pairs. First matching branch wins. |
| `default_target` | Yes | Node ID to route to when no branch matches. |

**Condition types:**
- `{ "type": "expr", "expr": "$.state.field == 'value'" }` — JSONPath expression (no-code)
- `{ "type": "fn_ref", "fn_ref": "my_module:decide" }` — custom Python/TS function

---

### `parallel_fork`

Fans out execution to two or more branches simultaneously.

```json
{
  "id": "fork",
  "type": "parallel_fork",
  "targets": ["branch-a", "branch-b", "branch-c"]
}
```

| Field | Required | Description |
|---|---|---|
| `targets` | Yes | At least two node IDs to execute in parallel. |
| `input_map` | No | Per-branch input mappings: `{ "branch-a": { "query": "$.state.q1" }, ... }`. |

---

### `parallel_join`

Waits for parallel branches to complete and merges their results.

```json
{
  "id": "join",
  "type": "parallel_join",
  "wait_for": "all",
  "join_reducer": "merge",
  "output_key": "combined_results"
}
```

| Field | Required | Description |
|---|---|---|
| `wait_for` | No | `"all"` (default), `"any"`, or an integer (wait for N branches). |
| `join_reducer` | No | `merge` (default) · `append` · `fn_ref`. |
| `join_fn_ref` | Conditional | Required when `join_reducer` is `"fn_ref"`. |
| `output_key` | No | State key to write the aggregated result to. Canvas warns if absent. |

---

### `hitl_breakpoint`

Pauses execution and waits for human input before continuing.

```json
{
  "id": "review",
  "type": "hitl_breakpoint",
  "prompt": "Please review the generated content and approve or reject.",
  "resume_schema": {
    "decision": { "type": "string", "enum": ["approved", "rejected"] },
    "notes":    { "type": "string" }
  },
  "output_key": "review_result",
  "timeout_seconds": 3600,
  "on_timeout": "raise"
}
```

| Field | Required | Description |
|---|---|---|
| `prompt` | No | Message shown to the human reviewer. |
| `resume_schema` | No | JSON Schema for the payload expected in `POST /run/{job_id}/resume`. |
| `output_key` | No | State key to write the resume payload to. |
| `timeout_seconds` | No | Seconds before the pause expires. `null` = no timeout. |
| `on_timeout` | No | `raise` (default, fails the job) or `skip` (continues with no input). |

When paused, job status becomes `"paused"` and `hitl_prompt` is included in the status response. Resume via:

```bash
curl -X POST http://localhost:8000/run/{job_id}/resume \
  -H "Authorization: Bearer <token>" \
  -d '{"payload": {"decision": "approved", "notes": "LGTM"}}'
```

---

### `memory_read`

Reads from a registered memory store into the flow state.

```json
{
  "id": "retrieve",
  "type": "memory_read",
  "store_id": "kb",
  "retrieval_mode": "semantic",
  "query_expr": "$.state.question",
  "top_k": 5,
  "min_score": 0.7,
  "output_key": "retrieved_chunks"
}
```

| Field | Required | Description |
|---|---|---|
| `store_id` | Yes | Key in the flow's `memory_stores` map. |
| `retrieval_mode` | No | `"key_value"` (default) or `"semantic"`. |
| `key_expr` | Conditional | JSONPath expression — required when `retrieval_mode` is `"key_value"`. |
| `query_expr` | Conditional | JSONPath expression — required when `retrieval_mode` is `"semantic"`. |
| `top_k` | No | Number of results to return (default 5). Semantic mode only. |
| `min_score` | No | Minimum cosine similarity score (0–1). Semantic mode only. |
| `output_key` | Yes | State key to write the retrieved value or list to. |

**`*_expr` fields use bare JSONPath, not mustache.** `"$.state.question"` resolves to `state["question"]`. Do not use `{{}}` syntax here.

---

### `memory_write`

Writes a value from the flow state to a registered memory store.

```json
{
  "id": "save",
  "type": "memory_write",
  "store_id": "session",
  "key_expr":   "$.state.question",
  "value_expr": "$.state.answer",
  "write_mode": "upsert",
  "tier": "long"
}
```

| Field | Required | Description |
|---|---|---|
| `store_id` | Yes | Key in the flow's `memory_stores` map. |
| `key_expr` | Yes | JSONPath expression — resolves to the storage key. |
| `value_expr` | Yes | JSONPath expression — resolves to the value to store. |
| `write_mode` | No | `"upsert"` (default) or `"overwrite"`. |
| `tier` | No | CrewAI memory tier: `short` (ChromaDB) · `long` (SQLite) · `entity` (facts) · `user` (prefs). Other adapters emit a comment. |

---

### `transform`

Reshapes state data using a declarative mapping or a custom function.

```json
{
  "id": "format",
  "type": "transform",
  "mode": "fn_ref",
  "fn_ref": "rag_utils:format_chunks"
}
```

Or with a declarative mapping:

```json
{
  "id": "rename",
  "type": "transform",
  "mode": "mapping",
  "mapping": [
    { "from": "$.state.raw_output", "to": "final_answer" }
  ]
}
```

| Field | Required | Description |
|---|---|---|
| `mode` | Yes | `"mapping"` (declarative) or `"fn_ref"` (custom code). |
| `mapping` | Conditional | Required when `mode` is `"mapping"`. Array of `{ "from": JSONPath, "to": state key }`. |
| `fn_ref` | Conditional | Required when `mode` is `"fn_ref"`. `"module:function"` — validated against the fn_ref allowlist. |

---

### `subgraph`

Embeds another flow as a sub-graph within the current flow.

```json
{
  "id": "inner",
  "type": "subgraph",
  "flow_ref": "validation-flow",
  "input_map":  { "text": "$.state.draft" },
  "output_map": { "is_valid": "validation_result" }
}
```

| Field | Required | Description |
|---|---|---|
| `flow_ref` | Yes | ID of the flow to embed. Must be a saved flow in the adapter. |
| `input_map` | No | Maps parent state to sub-flow input. |
| `output_map` | No | Maps sub-flow output back to parent state. |

---

### `agent_role`

Runs a named agent persona on a specific task. The agent can use tools and has its own ReAct loop.

```json
{
  "id": "research",
  "type": "agent_role",
  "config": {
    "agent_ref": "researcher",
    "task_description": "Research the topic: {{state.topic}}",
    "expected_output": "5 key findings with sources",
    "output_field": "research_results",
    "memory_access": "isolated",
    "tool_approval": "auto"
  }
}
```

| Config field | Required | Description |
|---|---|---|
| `agent_ref` | Yes | ID in the flow's `agents` array. |
| `task_description` | Yes | Task prompt — supports `{{state.key}}` mustache syntax. |
| `expected_output` | No | Description of what the agent should produce. |
| `async_execution` | No | Run in parallel with sibling tasks (CrewAI native; others: adapter-synthesised). |
| `output_field` | No | State key to write the agent's result to. |
| `structured_output` | No | Force typed JSON output from the agent. |
| `memory_access` | No | `"isolated"` (default): agent memory is private. `"shared"`: agent reads/writes a named store. |
| `memory_store_id` | Conditional | Required when `memory_access` is `"shared"`. Must reference a `memory_stores` key. |
| `tool_approval` | No | `"auto"` (default): agent executes tools without pausing. `"human"`: synthesises an approval gate before each tool call. |

**Adapter mapping:** CrewAI uses native `Task` + `Agent`. LangGraph synthesises a ReAct sub-graph. Mastra uses `createStep(agent)`. MS Agent Framework uses `ChatCompletionAgent`.

---

### `agent_debate`

Multi-agent conversation loop where multiple agents discuss until a termination condition is met.

```json
{
  "id": "debate",
  "type": "agent_debate",
  "config": {
    "agents": ["researcher", "critic", "editor"],
    "max_rounds": 10,
    "termination_condition": {
      "type": "expr",
      "expr": "$.last_message contains 'VERDICT'"
    },
    "speaker_selection": "round_robin",
    "output_field": "final_decision"
  }
}
```

| Config field | Required | Description |
|---|---|---|
| `agents` | Yes | At least 2 agent IDs from the `agents` array. |
| `max_rounds` | No | Maximum conversation turns (default 10). |
| `termination_condition` | No | Condition that ends the debate. |
| `speaker_selection` | No | `"auto"` · `"round_robin"` · `"custom"`. |
| `speaker_selection_fn_ref` | Conditional | Required when `speaker_selection` is `"custom"`. |
| `allow_repeat_speaker` | No | Whether the same speaker can go twice in a row (default `true`). |
| `output_field` | No | State key to write the conversation transcript or last message to. |

**Adapter mapping:** MS Agent Framework uses native `GroupChat`/`AgentGroupChat`. LangGraph, CrewAI, and Mastra synthesise the debate loop.

---

## Edges

### `direct`

Fixed transition from one node to another.

```json
{ "type": "direct", "from": "retrieve", "to": "generate", "context_from": ["retrieve"] }
```

| Field | Required | Description |
|---|---|---|
| `from` | Yes | Source node ID. |
| `to` | Yes | Target node ID. |
| `label` | No | Edge label shown in the canvas. |
| `context_from` | No | Node IDs whose `output_key` values are explicitly injected as context for the target. CrewAI: `Task.context`. LangGraph: advisory comment + state already shared. |

### `conditional`

Routes to different nodes based on runtime state.

```json
{
  "type": "conditional",
  "from": "router",
  "branches": [
    { "condition": { "type": "expr", "expr": "$.state.score > 0.8" }, "to": "accept", "label": "High" },
    { "condition": { "type": "expr", "expr": "$.state.score > 0.5" }, "to": "review", "label": "Medium" }
  ],
  "default_target": "reject"
}
```

| Field | Required | Description |
|---|---|---|
| `from` | Yes | Source node ID. |
| `branches` | Yes | Ordered list of `{ condition, to, label? }`. First match wins. |
| `default_target` | Yes | Target when no branch matches. |

---

## `tools` registry

```json
"tools": {
  "web-search": {
    "tool_ref": "@buildaharness/tools/web-search",
    "source": "npm",
    "description": "Search the web for current information.",
    "input_schema":  { "query": { "type": "string" } },
    "output_schema": { "results": { "type": "array" } }
  },
  "my-scraper": {
    "tool_ref": "my_tools:scrape_page",
    "source": "local"
  },
  "code-runner": {
    "tool_ref": "code_runner_server",
    "source": "mcp",
    "mcp_server_url": "http://localhost:8888"
  }
}
```

| Field | Required | Description |
|---|---|---|
| `tool_ref` | Yes | `"@scope/pkg/fn"` (npm) or `"module:function"` (local). Validated against the fn_ref allowlist at `/compile`, `/flows`, and `/run`. |
| `source` | No | `npm` · `local` · `mcp`. |
| `mcp_server_url` | Conditional | Required when `source` is `"mcp"`. Must reference an environment variable — never hardcode. |
| `description` | No | Human-readable description for marketplace listing. |
| `input_schema` | No | JSON Schema for tool inputs. |
| `output_schema` | No | JSON Schema for tool outputs. |

---

## `harness_meta`

Enables the 11-layer reasoning and control harness. See [architecture.md](./architecture.md) for the full harness description.

```json
"harness_meta": {
  "enabled": true,
  "process_concept_id": "implement_feature",
  "max_steps": 50
}
```

| Field | Required | Description |
|---|---|---|
| `enabled` | Yes | Must be `true` to use harness node types. Default `false`. |
| `process_concept_id` | No | Seeds the task graph from a named process concept (`GET /run/concepts`). |
| `harness_version` | No | Informational — records which harness version authored this flow. |
| `phase` | No | Informational — records which harness phase this flow was built for. |

---

## Harness node types (12 types)

These nodes are only valid when `harness_meta.enabled: true`. They are rendered in the canvas by the `DiagnosticsPanel` and compiled by the harness node compiler dispatch table.

All harness nodes share the base fields (`id`, `type`, `label`, `description`, `position`) and accept an optional `harness_config` object.

| Node type | Purpose | Key `harness_config` fields |
|---|---|---|
| `world_model` | Displays world model beliefs, observations, and contradictions | `display_mode`, `show_observations`, `show_contradictions`, `max_beliefs_shown` |
| `hypothesis_set` | Displays ranked hypotheses | `show_eliminated`, `max_hypotheses_shown` |
| `gather_evidence` | Collects evidence from a tool into the evidence store | `source_tool` (required), `evidence_type` (`OBSERVATION\|INFERENCE\|SYSTEM_ERROR`), `reliability_override` |
| `apply_tool_reliability` | Caps conclusion reliability based on tool type | `apply_to` (`inferences_only\|all`) |
| `update_world_model` | Integrates evidence into beliefs | `integration_mode` (`observations_only\|infer_beliefs`), `reliability_threshold` |
| `control_state` | Displays 5-tier control state resolution | `show_block_mask`, `show_notes` |
| `task_graph_node` | Displays the 6-state task graph | `show_write_domains`, `show_abstraction_level`, `max_tasks_shown` |
| `verification_gate` | Runs 9-layer verification | `enabled_layers` (array of layer names), `require_adversarial_on_high_risk` |
| `recovery_node` | Executes named recovery strategies | `strategy_order_override` (array of strategy names), `show_pattern_confidence` |
| `evidence_store_node` | Displays evidence store with reliability envelopes | `show_envelopes`, `show_manifest`, `max_evidence_shown` |
| `experience_store_node` | Displays cross-run learning weights | `show_weights_heatmap`, `show_run_count` |
| `reviewer_pass` | Runs 3-lens review (consistency, adversarial, abstraction fit) | `show_adversarial_prior`, `show_findings_detail`, `show_reopened_tasks` |

**Verification layer names** (for `verification_gate.enabled_layers`):
`syntax` · `unit` · `integration` · `consistency` · `requirements` · `assumptions` · `goal_correctness` · `evidence_sufficiency` · `output_contract_partial`

**Recovery strategy names** (for `recovery_node.strategy_order_override`):
`DIRECT_EDIT` · `TRACE_EXEC` · `BROADER_SEARCH` · `REIMPLEMENT` · `MINIMAL_FIX` · `ESCALATE` · `REGROUND_TO_AGREEMENT` · `REFRAME_QUESTION` · `HOLD_SPACE` · `COMPRESS_STAGE`

---

## Minimal valid flow

```json
{
  "spec_version": "1.0.0",
  "id": "hello-world",
  "nodes": [
    { "id": "start", "type": "input",
      "output_schema": { "name": { "type": "string" } } },
    { "id": "greet", "type": "llm_call",
      "prompt_template": "Greet {{state.name}} warmly in one sentence.",
      "output_key": "greeting" },
    { "id": "done", "type": "output" }
  ],
  "edges": [
    { "type": "direct", "from": "start", "to": "greet" },
    { "type": "direct", "from": "greet", "to": "done" }
  ]
}
```

---

## Schema validation

```bash
# Canvas (Vitest)
npm test                          # runs schema.test.ts

# Eval gate — validates all reference flows compile on all 4 adapters
pytest adapter/eval/test_spec_validation.py -v

# Manual parse
node -e "const {assertFlowSpec}=require('./spec/dist/schema.js'); assertFlowSpec(require('./flows/01-rag-agent-flow.json'))"
```
