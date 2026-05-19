/**
 * Its Harness flow spec v0.2.0 — Zod schema
 *
 * Runtime-agnostic workflow specification for LangGraph, CrewAI, Mastra,
 * and Microsoft Agent Framework adapters.
 *
 * v0.2.0 changes vs v0.1.0:
 *   - 4 runtimes: adds CrewAI, renames SemanticKernel → MicrosoftAgentFramework
 *   - New top-level: agents[] (AgentDef registry)
 *   - New node types: AgentRoleNode, AgentDebateNode (discriminated union updated)
 *   - DirectEdge: new optional context_from field (CrewAI Task.context)
 *   - MemoryWriteNode: new optional tier field (CrewAI 4-tier memory)
 *   - FlowConfig: new process_type, manager_agent_ref, a2a_config fields
 *   - RuntimeHints: updated adapter enum + new compatible[] array
 *   - RuntimeSupportOverride: semantic_kernel → microsoft_agent_framework + crewai
 *
 * Phase 0 Q&A decisions applied (no version bump — design phase):
 *   - AgentRoleNodeConfig: memory_access ('isolated'|'shared'), memory_store_id, tool_approval ('auto'|'human') [Q28, Q29]
 *   - AgentRoleNodeConfig: refine — memory_store_id required when memory_access='shared' [Q28]
 *   - MemoryStoreDef: namespace field for vector store partitioning [Q33]
 *   - ToolDef.mcp_server_url: description updated — must reference env var, never hardcoded [Q12]
 *
 * @version 0.2.0
 * @see https://spec.itsharness.com/v0.2/flow
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const SpecVersion = z.literal('0.2.0')

export const FlowId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Flow ID must be kebab-case')

export const NodeId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-_]*$/, 'Node ID must be lowercase alphanumeric with hyphens/underscores')

export const NpmOrLocalRef = z.string().describe(
  "npm package ref '@scope/pkg/fn' or local path './path/to/fn.ts'"
)

// ---------------------------------------------------------------------------
// Position (canvas only — adapters must ignore)
// ---------------------------------------------------------------------------

export const Position = z.object({
  x: z.number(),
  y: z.number(),
}).describe('Canvas layout coordinates. Non-semantic — adapters MUST ignore this field.')

export type Position = z.infer<typeof Position>

// ---------------------------------------------------------------------------
// RuntimeHints
// ---------------------------------------------------------------------------

export const AdapterName = z.enum(['langgraph', 'crewai', 'mastra', 'microsoft_agent_framework'])
export type AdapterName = z.infer<typeof AdapterName>

export const RuntimeHints = z.object({
  preferred_adapter:          AdapterName.optional(),
  compatible:                 z.array(AdapterName).optional(),
  python_version:             z.string().optional(),
  node_version:               z.string().optional(),
  langgraph_version:          z.string().optional(),
  crewai_version:             z.string().optional(),
  mastra_version:             z.string().optional(),
  ms_agent_framework_version: z.string().optional(),
}).describe('Non-binding hints about target runtime. Adapters ignore unknown fields.')

export type RuntimeHints = z.infer<typeof RuntimeHints>

// ---------------------------------------------------------------------------
// State schema with reducer hints
// ---------------------------------------------------------------------------

export const ReducerStrategy = z
  .enum(['replace', 'append', 'merge', 'custom'])
  .default('replace')
  .describe(
    'replace: last-write-wins (default). append: concat arrays. merge: deep object merge. custom: fn_ref required.'
  )

export const StateField = z
  .object({
    type: z.union([
      z.enum(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']),
      z.array(z.enum(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'])),
    ]),
    description:      z.string().optional(),
    items:            z.unknown().optional(),
    properties:       z.record(z.unknown()).optional(),
    default:          z.unknown().optional(),
    reducer:          ReducerStrategy.optional(),
    reducer_fn_ref:   NpmOrLocalRef.optional(),
  })
  .refine(
    (f) => f.reducer !== 'custom' || !!f.reducer_fn_ref,
    { message: 'reducer_fn_ref is required when reducer is "custom"', path: ['reducer_fn_ref'] }
  )

export type StateField = z.infer<typeof StateField>

export const StateSchema = z.object({
  type:       z.literal('object'),
  properties: z.record(StateField),
  required:   z.array(z.string()).optional(),
})

export type StateSchema = z.infer<typeof StateSchema>

// ---------------------------------------------------------------------------
// Shared node config fragments
// ---------------------------------------------------------------------------

export const RuntimeSupportOverride = z.object({
  langgraph:                 z.enum(['full', 'partial', 'missing']).optional(),
  crewai:                    z.enum(['full', 'partial', 'missing']).optional(),
  mastra:                    z.enum(['full', 'partial', 'missing']).optional(),
  microsoft_agent_framework: z.enum(['full', 'partial', 'missing']).optional(),
})

export type RuntimeSupportOverride = z.infer<typeof RuntimeSupportOverride>

export const OutputValidator = z
  .object({
    fn_ref:       NpmOrLocalRef,
    on_fail:      z.enum(['raise', 'retry', 'skip']).default('raise'),
    max_retries:  z.number().int().min(1).max(5).default(1).optional(),
    retry_prompt: z.string().optional(),
  })
  .describe('Post-execution output validation. Runs after node completes, before state is updated.')

export type OutputValidator = z.infer<typeof OutputValidator>


// Error handling branch — routes a node's failure to a designated target node
// with optional retry config. Canvas renders this as a red dashed edge.
export const RetryConfig = z.object({
  max_attempts: z.number().int().min(1).max(10).default(3),
  backoff:      z.enum(['fixed', 'exponential']).default('exponential'),
  delay_ms:     z.number().int().min(0).default(1000),
})
export type RetryConfig = z.infer<typeof RetryConfig>

export const FailBranch = z.object({
  target: NodeId,       // node id to route to on error (validated as kebab-case)
  retry:  RetryConfig.optional(),
})
export type FailBranch = z.infer<typeof FailBranch>

export const StructuredOutput = z
  .object({ schema: z.record(z.unknown()) })
  .describe('Force typed JSON response from LLM. LG: .with_structured_output(). MA: structuredOutput option. SK: typed return.')

export type StructuredOutput = z.infer<typeof StructuredOutput>

export const Condition = z
  .object({
    type:    z.enum(['expr', 'fn_ref']),
    expr:    z.string().optional(),
    fn_ref:  NpmOrLocalRef.optional(),
  })
  .refine(
    (c) => (c.type === 'expr' ? !!c.expr : !!c.fn_ref),
    { message: 'expr required for type "expr"; fn_ref required for type "fn_ref"' }
  )
  .describe('Branch condition. expr: JSONPath (no-code). fn_ref: code panel.')

export type Condition = z.infer<typeof Condition>

export const InputMapping = z
  .record(z.string())
  .describe('Maps state keys to node input params. Values are JSONPath expressions.')

export const OutputMapping = z
  .record(z.string())
  .describe('Maps node output fields to state keys.')

export const ModelParams = z.object({
  temperature:         z.number().min(0).max(2).optional(),
  max_tokens:          z.number().int().min(1).optional(),
  top_p:               z.number().min(0).max(1).optional(),
  frequency_penalty:   z.number().min(-2).max(2).optional(),
  presence_penalty:    z.number().min(-2).max(2).optional(),
  stop:                z.array(z.string()).optional(),
})

export type ModelParams = z.infer<typeof ModelParams>

// ---------------------------------------------------------------------------
// Node base (shared by all node types)
// ---------------------------------------------------------------------------

const NodeBase = z.object({
  id:              NodeId,
  label:           z.string().optional(),
  description:     z.string().optional(),
  position:        Position.optional(),
  runtime_support: RuntimeSupportOverride.optional(),
})

// ---------------------------------------------------------------------------
// v1 Node types
// ---------------------------------------------------------------------------

export const InputNode = NodeBase.extend({
  type:          z.literal('input'),
  output_schema: z.record(z.unknown()),
})

export type InputNode = z.infer<typeof InputNode>

export const OutputNode = NodeBase.extend({
  type:         z.literal('output'),
  exit_code:    z.string().default('success').optional(),
  input_schema: z.record(z.unknown()).optional(),
})

export type OutputNode = z.infer<typeof OutputNode>

export const PromptRef = z.object({
  name:    z.string().min(1),
  version: z.number().int().positive().optional(),
  label:   z.string().optional(),
})
export type PromptRef = z.infer<typeof PromptRef>

export const LlmCallNode = NodeBase.extend({
  type:             z.literal('llm_call'),
  model:            z.string().optional(),
  system_prompt:    z.string().optional(),
  prompt_template:  z.string().optional(),
  prompt_ref:       PromptRef.optional(),
  model_params:     ModelParams.optional(),
  structured_output: StructuredOutput.optional(),
  output_key:       z.string().optional(),
  output_validator: OutputValidator.optional(),
  fail_branch:      FailBranch.optional(),
})

export type LlmCallNode = z.infer<typeof LlmCallNode>

export const ToolInvokeNode = NodeBase.extend({
  type:             z.literal('tool_invoke'),
  tool_id:          z.string(),
  input_map:        InputMapping.optional(),
  output_map:       OutputMapping.optional(),
  output_validator: OutputValidator.optional(),
})

export type ToolInvokeNode = z.infer<typeof ToolInvokeNode>

const ConditionBranch = z.object({
  condition: Condition,
  target:    z.string(),
})

export const ConditionNode = NodeBase.extend({
  type:           z.literal('condition'),
  branches:       z.array(ConditionBranch).min(1),
  default_target: z.string(),
})

export type ConditionNode = z.infer<typeof ConditionNode>

export const ParallelForkNode = NodeBase.extend({
  type:      z.literal('parallel_fork'),
  targets:   z.array(z.string()).min(2),
  input_map: z.record(InputMapping).optional(),
})

export type ParallelForkNode = z.infer<typeof ParallelForkNode>

export const ParallelJoinNode = NodeBase.extend({
  type:         z.literal('parallel_join'),
  wait_for:     z.union([z.enum(['all', 'any']), z.number().int().min(1)]).default('all').optional(),
  join_reducer: z.enum(['merge', 'append', 'fn_ref']).default('merge').optional(),
  join_fn_ref:  NpmOrLocalRef.optional(),
  output_key:   z.string().optional(),
})
  .refine(
    (n) => n.join_reducer !== 'fn_ref' || !!n.join_fn_ref,
    { message: 'join_fn_ref is required when join_reducer is "fn_ref"', path: ['join_fn_ref'] }
  )

export type ParallelJoinNode = z.infer<typeof ParallelJoinNode>

export const HitlBreakpointNode = NodeBase.extend({
  type:            z.literal('hitl_breakpoint'),
  prompt:          z.string().optional(),
  resume_schema:   z.record(z.unknown()).optional(),
  output_key:      z.string().optional(),
  timeout_seconds: z.number().int().nullable().optional(),
  on_timeout:      z.enum(['raise', 'skip']).default('raise').optional(),
})

export type HitlBreakpointNode = z.infer<typeof HitlBreakpointNode>

export const MemoryReadNode = NodeBase.extend({
  type:           z.literal('memory_read'),
  store_id:       z.string(),
  retrieval_mode: z.enum(['key_value', 'semantic']).default('key_value').optional(),
  key_expr:       z.string().optional(),
  query_expr:     z.string().optional(),
  top_k:          z.number().int().min(1).default(5).optional(),
  min_score:      z.number().min(0).max(1).optional(),
  output_key:     z.string(),
})
  .refine(
    (n) => n.retrieval_mode !== 'key_value' || !!n.key_expr,
    { message: 'key_expr required when retrieval_mode is "key_value"', path: ['key_expr'] }
  )
  .refine(
    (n) => n.retrieval_mode !== 'semantic' || !!n.query_expr,
    { message: 'query_expr required when retrieval_mode is "semantic"', path: ['query_expr'] }
  )

export type MemoryReadNode = z.infer<typeof MemoryReadNode>

export const MemoryWriteNode = NodeBase.extend({
  type:       z.literal('memory_write'),
  store_id:   z.string(),
  key_expr:   z.string(),
  value_expr: z.string(),
  write_mode: z.enum(['upsert', 'overwrite']).default('upsert').optional(),
  tier:       z.enum(['short', 'long', 'entity', 'user']).default('short').optional()
    .describe('CrewAI memory tier. short=ChromaDB, long=SQLite, entity=facts, user=prefs. Other adapters map to nearest equivalent.'),
})

export type MemoryWriteNode = z.infer<typeof MemoryWriteNode>

export const SubgraphNode = NodeBase.extend({
  type:       z.literal('subgraph'),
  flow_ref:   z.string(),
  input_map:  InputMapping.optional(),
  output_map: OutputMapping.optional(),
})

export type SubgraphNode = z.infer<typeof SubgraphNode>

export const TransformNode = NodeBase.extend({
  type: z.literal('transform'),
  mode: z.enum(['mapping', 'fn_ref']),
  mapping: z
    .array(z.object({ from: z.string(), to: z.string() }))
    .optional(),
  fn_ref: NpmOrLocalRef.optional(),
})
  .refine(
    (n) => n.mode !== 'mapping' || (!!n.mapping && n.mapping.length > 0),
    { message: 'mapping array is required and non-empty when mode is "mapping"', path: ['mapping'] }
  )
  .refine(
    (n) => n.mode !== 'fn_ref' || !!n.fn_ref,
    { message: 'fn_ref is required when mode is "fn_ref"', path: ['fn_ref'] }
  )

export type TransformNode = z.infer<typeof TransformNode>

// ---------------------------------------------------------------------------
// AgentDef — top-level agents[] registry entry
// ---------------------------------------------------------------------------

export const MemoryConfig = z.object({
  short_term: z.boolean().default(false),
  long_term:  z.boolean().default(false),
  entity:     z.boolean().default(false),
  user:       z.boolean().default(false),
})
export type MemoryConfig = z.infer<typeof MemoryConfig>

export const AgentDef = z.object({
  id:                z.string(),
  name:              z.string().optional(),
  role:              z.string().optional(),
  backstory:         z.string().optional(),
  goal:              z.string().optional(),
  model:             z.string().optional(),
  tools:             z.array(z.string()).optional(),
  memory_config:     MemoryConfig.optional(),
  max_iter:          z.number().int().default(10).optional(),
  allow_delegation:  z.boolean().default(false).optional(),
}).describe('Named agent persona. Referenced by agent_role nodes. CrewAI: Agent(). LG: synthesised sub-graph. MA: new Agent(). MS: ChatCompletionAgent.')
export type AgentDef = z.infer<typeof AgentDef>

// ---------------------------------------------------------------------------
// New v0.2 node types: AgentRoleNode, AgentDebateNode
// ---------------------------------------------------------------------------

export const AgentRoleNodeConfig = z.object({
  agent_ref:         z.string(),
  task_description:  z.string(),
  expected_output:   z.string().optional(),
  async_execution:   z.boolean().default(false).optional(),
  output_field:      z.string().optional(),
  structured_output: StructuredOutput.optional(),
  // Q28: agent memory isolation
  memory_access: z
    .enum(['isolated', 'shared'])
    .default('isolated')
    .optional()
    .describe(
      'isolated (default): agent memory is private; only the structured result written to output_field crosses into parent flow state. ' +
      'shared: agent reads/writes a named store also accessible to the parent flow, declared via memory_store_id. ' +
      'Harness validation error: async_execution + shared is disallowed — parallel agents must be isolated.'
    ),
  memory_store_id: z
    .string()
    .optional()
    .describe('Required when memory_access is "shared". Must reference a key in the flow\'s top-level memory_stores object.'),
  // Q29: per-tool human approval gate inside agent loop
  tool_approval: z
    .enum(['auto', 'human'])
    .default('auto')
    .optional()
    .describe(
      'auto (default): agent executes all tool calls without pausing. ' +
      'human: adapter synthesises an approval gate before each tool call, reusing the shared HITL checkpoint/resume mechanism (same as hitl_breakpoint). ' +
      'Manual wiring of the approval gate is not possible for runtime-determined tool calls — this is a justified exception to the composability-over-flags principle.'
    ),
})
  .refine(
    (c) => c.memory_access !== 'shared' || !!c.memory_store_id,
    { message: 'memory_store_id is required when memory_access is "shared"', path: ['memory_store_id'] }
  )

export const AgentRoleNode = NodeBase.extend({
  type:   z.literal('agent_role'),
  config: AgentRoleNodeConfig,
}).describe('Executes an agent persona from agents[]. CR: native Task+Agent. LG: synthesised ReAct sub-graph. MA: createStep(agent). MS: ChatCompletionAgent.')
export type AgentRoleNode = z.infer<typeof AgentRoleNode>

export const AgentDebateNodeConfig = z.object({
  agents:                    z.array(z.string()).min(2),
  max_rounds:                z.number().int().default(10).optional(),
  termination_condition:     Condition.optional(),
  speaker_selection:         z.enum(['auto', 'round_robin', 'custom']).default('auto').optional(),
  speaker_selection_fn_ref:  NpmOrLocalRef.optional(),
  allow_repeat_speaker:      z.boolean().default(true).optional(),
  output_field:              z.string().optional(),
}).refine(
  (c) => c.speaker_selection !== 'custom' || !!c.speaker_selection_fn_ref,
  { message: 'speaker_selection_fn_ref required when speaker_selection is "custom"', path: ['speaker_selection_fn_ref'] }
)

export const AgentDebateNode = NodeBase.extend({
  type:   z.literal('agent_debate'),
  config: AgentDebateNodeConfig,
}).describe('Multi-agent conversation loop. MS: native GroupChat/AgentGroupChat. LG/CR/MA: synthesised by adapter. Canvas shows warning for non-MS adapters.')
export type AgentDebateNode = z.infer<typeof AgentDebateNode>

// ---------------------------------------------------------------------------
// v0.2 Node discriminated union (14 types)
// ---------------------------------------------------------------------------

export const Node = z.discriminatedUnion('type', [
  InputNode,
  OutputNode,
  LlmCallNode,
  ToolInvokeNode,
  ConditionNode,
  ParallelForkNode,
  ParallelJoinNode,
  HitlBreakpointNode,
  MemoryReadNode,
  MemoryWriteNode,
  SubgraphNode,
  TransformNode,
  AgentRoleNode,
  AgentDebateNode,
])

export type Node = z.infer<typeof Node>

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

export const DirectEdge = z.object({
  type:         z.literal('direct'),
  id:           z.string().optional(),
  from:         z.string(),
  to:           z.string(),
  label:        z.string().optional(),
  context_from: z.array(z.string()).optional()
    .describe('Node IDs whose outputs are injected as context. CR: Task.context. LG: state.context. MA: step input.'),
}).describe('Fixed transition. SK/MS adapter: emitEvent/onEvent pair using edge id as event name.')

export type DirectEdge = z.infer<typeof DirectEdge>

export const ConditionalEdge = z.object({
  type: z.literal('conditional'),
  id:   z.string().optional(),
  from: z.string(),
  branches: z.array(z.object({
    condition: Condition,
    to:        z.string(),
    label:     z.string().optional(),
  })),
  default_target: z.string(),
})

export type ConditionalEdge = z.infer<typeof ConditionalEdge>

export const Edge = z.discriminatedUnion('type', [DirectEdge, ConditionalEdge])
export type Edge = z.infer<typeof Edge>

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const ToolDef = z
  .object({
    tool_ref:     NpmOrLocalRef,
    source:       z.enum(['npm', 'local', 'mcp']).default('npm').optional(),
    mcp_server_url: z.string().url().optional()
      .describe('Required when source is "mcp". Must always reference an environment variable — never hardcoded in the spec. MA: native. LG: langchain-mcp-adapters. MS: custom KernelFunction wrapper. CR: BaseTool bridge adapter (RFC open).'),
    description:  z.string().optional(),
    input_schema: z.record(z.unknown()).optional(),
    output_schema: z.record(z.unknown()).optional(),
  })
  .refine(
    (t) => t.source !== 'mcp' || !!t.mcp_server_url,
    { message: 'mcp_server_url is required when source is "mcp"', path: ['mcp_server_url'] }
  )

export type ToolDef = z.infer<typeof ToolDef>

// ---------------------------------------------------------------------------
// Memory stores
// ---------------------------------------------------------------------------

export const MemoryStoreDef = z.object({
  type: z.enum(['key_value', 'vector', 'hybrid']),
  description:     z.string().optional(),
  backend: z
    .enum(['in_memory', 'postgres', 'sqlite', 'redis', 'upstash', 'qdrant', 'pinecone', 'azure_ai_search'])
    .default('in_memory')
    .optional(),
  connection_env:  z.string().optional(),
  embedding_model: z.string().optional(),
  dimensions:      z.number().int().optional(),
  scope: z
    .enum(['thread', 'resource', 'global'])
    .default('thread')
    .optional(),
  // Q33: optional namespace for vector store partitioning
  namespace: z
    .string()
    .optional()
    .describe(
      'Optional partition key for vector stores. One store entry per namespace. ' +
      'If the namespace value contains sensitive routing information (e.g. a tenant ID), ' +
      'store it in an environment variable and reference the variable name here — never hardcode the value.'
    ),
})

export type MemoryStoreDef = z.infer<typeof MemoryStoreDef>

// ---------------------------------------------------------------------------
// Model defaults
// ---------------------------------------------------------------------------

export const ModelDefaults = z.object({
  model:           z.string().optional(),
  embedding_model: z.string().optional(),
  model_params:    ModelParams.optional(),
})

export type ModelDefaults = z.infer<typeof ModelDefaults>

// ---------------------------------------------------------------------------
// Flow config: checkpoint, streaming, telemetry
// ---------------------------------------------------------------------------

export const CheckpointConfig = z.object({
  enabled: z.boolean().default(false),
  backend: z
    .enum(['in_memory', 'sqlite', 'postgres', 'redis', 'dapr', 'orleans'])
    .default('in_memory')
    .optional(),
  connection_env: z.string().optional(),
  namespace:      z.string().optional(),
})

export type CheckpointConfig = z.infer<typeof CheckpointConfig>

export const StreamingConfig = z.object({
  enabled: z.boolean().default(false),
  mode: z
    .enum(['updates', 'tokens', 'debug'])
    .default('updates')
    .optional()
    .describe('updates: all runtimes. tokens: all runtimes. debug: LG only.'),
})

export type StreamingConfig = z.infer<typeof StreamingConfig>

export const TelemetryConfig = z.object({
  enabled: z.boolean().default(false),
  provider: z
    .enum(['langsmith', 'langfuse', 'otel', 'azure_monitor'])
    .optional(),
  project:        z.string().optional(),
  endpoint_env:   z.string().optional(),
  trace_all_nodes: z.boolean().default(true).optional(),
})

export type TelemetryConfig = z.infer<typeof TelemetryConfig>

// ---------------------------------------------------------------------------
// A2A config
// ---------------------------------------------------------------------------

export const A2ASkill = z.object({
  id:          z.string(),
  name:        z.string(),
  description: z.string().optional(),
})

export const A2AConfig = z.object({
  enabled:             z.boolean().default(false),
  agent_name:          z.string().optional(),
  agent_description:   z.string().optional(),
  version:             z.string().default('1.0.0').optional(),
  capabilities:        z.array(z.enum(['streaming', 'pushNotifications', 'stateTransitionHistory'])).optional(),
  authentication:      z.enum(['api_key', 'oauth2', 'none']).default('api_key').optional(),
  input_schema_ref:    z.string().optional(),
  output_schema_ref:   z.string().optional(),
  skills:              z.array(A2ASkill).optional(),
}).describe('A2A deployment config. Adapter generates AgentCard at /.well-known/agent.json and /tasks/send endpoint. hitl_breakpoint maps to A2A "input-required" state.')
export type A2AConfig = z.infer<typeof A2AConfig>

// ---------------------------------------------------------------------------
// Flow config (updated v0.2)
// ---------------------------------------------------------------------------

export const FlowConfig = z.object({
  checkpoint:          CheckpointConfig.optional(),
  streaming:           StreamingConfig.optional(),
  telemetry:           TelemetryConfig.optional(),
  process_type:        z.enum(['sequential', 'hierarchical', 'consensual']).default('sequential').optional()
    .describe('CrewAI: Crew(process=). Other adapters ignore. hierarchical requires manager_agent_ref.'),
  manager_agent_ref:   z.string().optional()
    .describe('agents[] entry ID for hierarchical process manager. CrewAI only; required when process_type is hierarchical.'),
  a2a_config:          A2AConfig.optional(),
})

export type FlowConfig = z.infer<typeof FlowConfig>

// ---------------------------------------------------------------------------
// Root FlowSpec
// ---------------------------------------------------------------------------

export const FlowSpec = z
  .object({
    spec_version:   SpecVersion,
    id:             FlowId,
    name:           z.string().optional(),
    description:    z.string().optional(),
    runtime_hints:  RuntimeHints.optional(),
    state_schema:   StateSchema.optional(),
    agents:         z.array(AgentDef).optional(),
    nodes:          z.array(Node).min(2),
    edges:          z.array(Edge),
    tools:          z.record(ToolDef).optional(),
    memory_stores:  z.record(MemoryStoreDef).optional(),
    model_defaults: ModelDefaults.optional(),
    flow_config:    FlowConfig.optional(),
  })
  .describe('Its Harness flow spec v0.2.0 — runtime-agnostic workflow spec for LangGraph, CrewAI, Mastra, and MS Agent Framework adapters.')

export type FlowSpec = z.infer<typeof FlowSpec>

// ---------------------------------------------------------------------------
// Parse helper
// ---------------------------------------------------------------------------

/**
 * Parse and validate a raw JSON object against the FlowSpec v0.2.0 schema.
 */
export function parseFlowSpec(raw: unknown): z.SafeParseReturnType<unknown, FlowSpec> {
  return FlowSpec.safeParse(raw)
}

/** Assert that a raw JSON object is a valid FlowSpec, throwing on failure. */
export function assertFlowSpec(raw: unknown): FlowSpec {
  return FlowSpec.parse(raw)
}

// ---------------------------------------------------------------------------
// Example: multi-agent research flow using agents[] + agent_role + agent_debate
// ---------------------------------------------------------------------------
//
// {
//   "spec_version": "0.2.0",
//   "id": "research-debate-flow",
//   "name": "Research + editorial review",
//   "agents": [
//     {
//       "id": "researcher",
//       "role": "Senior Researcher",
//       "backstory": "Expert in finding accurate, up-to-date information.",
//       "goal": "Research the given topic thoroughly.",
//       "tools": ["web-search"],
//       "memory_config": { "short_term": true, "long_term": true }
//     },
//     {
//       "id": "critic",
//       "role": "Critical Reviewer",
//       "backstory": "Sharp editor who identifies gaps and inaccuracies.",
//       "goal": "Ensure research quality and completeness."
//     },
//     {
//       "id": "editor",
//       "role": "Senior Editor",
//       "backstory": "Produces clear, well-structured final summaries.",
//       "goal": "Write the final approved summary."
//     }
//   ],
//   "nodes": [
//     { "id": "start", "type": "input",
//       "output_schema": { "type": "object",
//         "properties": { "topic": { "type": "string" } } } },
//     { "id": "research", "type": "agent_role",
//       "config": { "agent_ref": "researcher",
//         "task_description": "Research: {{topic}}",
//         "expected_output": "5 key findings with sources",
//         "output_field": "research_results" } },
//     { "id": "debate", "type": "agent_debate",
//       "config": { "agents": ["researcher", "critic", "editor"],
//         "max_rounds": 8,
//         "termination_condition": { "type": "expr",
//           "expr": "$.last_message contains 'APPROVED'" },
//         "speaker_selection": "round_robin",
//         "output_field": "final_summary" } },
//     { "id": "done", "type": "output" }
//   ],
//   "edges": [
//     { "type": "direct", "from": "start",    "to": "research" },
//     { "type": "direct", "from": "research", "to": "debate",
//       "context_from": ["research"] },
//     { "type": "direct", "from": "debate",   "to": "done" }
//   ],
//   "flow_config": {
//     "process_type": "consensual",
//     "a2a_config": {
//       "enabled": true,
//       "agent_name": "Research Assistant",
//       "capabilities": ["streaming"],
//       "authentication": "api_key",
//       "input_schema_ref": "start",
//       "output_schema_ref": "done"
//     }
//   }
// }
