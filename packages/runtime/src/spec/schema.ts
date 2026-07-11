/**
 * Build A Harness flow spec v0.2.0 — runtime package's working copy
 *
 * This is the FOURTH copy of the FlowSpec schema in this repo (after
 * spec/schema.ts, src/spec/schema.ts, packages/canvas/src/spec/schema.ts —
 * see CONTRIBUTING.md's "Making schema changes" checklist, which this file
 * extends to cover a 4th location). When editing any of the other three,
 * check whether this file's Node/FlowSpec shapes need the same change too;
 * scripts/check-schema-sync.mjs enforces export-name parity against this
 * file as well as the other copies.
 *
 * Why a local copy instead of depending on @buildaharness/canvas?
 * Runtime only needs the FlowSpec/Node type shapes and the harness-permissive
 * RuntimeFlowSpec parser — it has no use for canvas's React component, store,
 * or UI-only exports (ADAPTER_LABELS, NODE_SUPPORT_MATRIX, etc). Depending on
 * @buildaharness/canvas for types alone would pull zustand/dagre/lucide-react/
 * react into this package's dependency closure for nothing, and (published)
 * canvas only exports its full index — there's no schema-only subpath.
 *
 * Why a local copy instead of depending on the published, already-standalone
 * @buildaharness/flow-spec package (built from the canonical spec/schema.ts,
 * with no runtime/canvas coupling — see spec/package.json)? That package was
 * evaluated first and rejected for this use, not skipped: its Node types are
 * stricter than what this package's existing behavior (and tests) rely on —
 * e.g. canonical InputNode requires output_schema where this copy (following
 * packages/canvas/src/spec/schema.ts) makes it optional, and canonical
 * HarnessMeta has no .passthrough(), so it would silently drop unrecognized
 * harness_meta keys that existing flows set. It also has no RuntimeFlowSpec/
 * assertRuntimeFlowSpec (harness-permissive parser) at all — that parser
 * originated in packages/canvas/src/spec/schema.ts, not here. Depending on
 * @buildaharness/flow-spec directly would have meant loosening the canonical
 * package's validation for every consumer, or hand-rolling the divergence
 * anyway. Forking a copy scoped to this package's actual needs was judged
 * lower-risk than either. If @buildaharness/flow-spec ever grows a
 * runtime-permissive parser of its own, prefer switching to it over
 * maintaining this copy.
 *
 * @see spec/schema.ts — canonical Zod schema (source of truth for the npm package)
 * @see packages/canvas/src/spec/schema.ts — canvas package's copy (also the
 *      origin of RuntimeFlowSpec/assertRuntimeFlowSpec, copied here verbatim)
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const SpecVersion = z.literal('0.2.0')

export const FlowId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Flow ID must be kebab-case (min 2 chars, hyphens only)')

export const NodeId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-_]*$/, 'Node ID must be lowercase alphanumeric with hyphens/underscores')

export const NpmOrLocalRef = z.string()

export const Position = z.object({ x: z.number(), y: z.number() })
export type Position = z.infer<typeof Position>

// ---------------------------------------------------------------------------
// Runtime hints
// ---------------------------------------------------------------------------

export const AdapterName = z.enum(['langgraph', 'crewai', 'mastra', 'microsoft_agent_framework'])
export type AdapterName = z.infer<typeof AdapterName>

export const RuntimeHints = z.object({
  preferred_adapter:          AdapterName.optional(),
  compatible:                 z.array(AdapterName).optional(),
  langgraph_version:          z.string().optional(),
  crewai_version:             z.string().optional(),
  mastra_version:             z.string().optional(),
  ms_agent_framework_version: z.string().optional(),
})
export type RuntimeHints = z.infer<typeof RuntimeHints>

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

export const ReducerStrategy = z
  .enum(['replace', 'append', 'merge', 'last_wins', 'custom'])
  .default('replace')

export const StateField = z.object({
  type: z.union([
    z.enum(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']),
    z.array(z.enum(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'])),
  ]),
  description:    z.string().optional(),
  items:          z.unknown().optional(),
  properties:     z.record(z.unknown()).optional(),
  default:        z.unknown().optional(),
  reducer:        ReducerStrategy.optional(),
  reducer_fn_ref: NpmOrLocalRef.optional(),
})
export type StateField = z.infer<typeof StateField>

export const StateSchema = z.object({
  type:       z.literal('object'),
  properties: z.record(StateField),
  required:   z.array(z.string()).optional(),
})
export type StateSchema = z.infer<typeof StateSchema>

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

export const RuntimeSupportOverride = z.object({
  langgraph:                 z.enum(['full', 'partial', 'missing']).optional(),
  crewai:                    z.enum(['full', 'partial', 'missing']).optional(),
  mastra:                    z.enum(['full', 'partial', 'missing']).optional(),
  microsoft_agent_framework: z.enum(['full', 'partial', 'missing']).optional(),
})
export type RuntimeSupportOverride = z.infer<typeof RuntimeSupportOverride>
export type SupportLevel = 'full' | 'partial' | 'missing'

export const OutputValidator = z.object({
  fn_ref:       NpmOrLocalRef,
  on_fail:      z.enum(['raise', 'retry', 'skip']).default('raise'),
  max_retries:  z.number().int().min(1).max(5).default(1).optional(),
  retry_prompt: z.string().optional(),
})
export type OutputValidator = z.infer<typeof OutputValidator>

export const RetryConfig = z.object({
  max_attempts: z.number().int().min(1).max(10).default(3),
  backoff:      z.enum(['fixed', 'exponential']).default('exponential'),
  delay_ms:     z.number().int().min(0).default(1000),
})
export type RetryConfig = z.infer<typeof RetryConfig>

export const FailBranch = z.object({
  target: NodeId,
  retry:  RetryConfig.optional(),
})
export type FailBranch = z.infer<typeof FailBranch>

export const StructuredOutput = z.object({ schema: z.record(z.unknown()) })
export type StructuredOutput = z.infer<typeof StructuredOutput>

export const Condition = z.object({
  type:   z.enum(['expr', 'fn_ref']),
  expr:   z.string().optional(),
  fn_ref: NpmOrLocalRef.optional(),
})
export type Condition = z.infer<typeof Condition>

export const InputMapping  = z.record(z.string())
export const OutputMapping = z.record(z.string())

export const ModelParams = z.object({
  temperature:       z.number().min(0).max(2).optional(),
  max_tokens:        z.number().int().min(1).optional(),
  top_p:             z.number().min(0).max(1).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty:  z.number().min(-2).max(2).optional(),
  stop:              z.array(z.string()).optional(),
})
export type ModelParams = z.infer<typeof ModelParams>

// ---------------------------------------------------------------------------
// Node base
// ---------------------------------------------------------------------------

const NodeBase = z.object({
  id:              NodeId,
  label:           z.string().optional(),
  description:     z.string().optional(),
  position:        Position.optional(),
  runtime_support: RuntimeSupportOverride.optional(),
})

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

export const InputNode = NodeBase.extend({
  type:          z.literal('input'),
  output_schema: z.record(z.unknown()).optional(),
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
  type:              z.literal('llm_call'),
  model:             z.string().optional(),
  system_prompt:     z.string().optional(),
  prompt_template:   z.string().optional(),
  prompt_ref:        PromptRef.optional(),
  model_params:      ModelParams.optional(),
  structured_output: StructuredOutput.optional(),
  output_key:        z.string().optional(),
  output_validator:  OutputValidator.optional(),
  fail_branch:       FailBranch.optional(),
})
export type LlmCallNode = z.infer<typeof LlmCallNode>

export const ToolInvokeNode = NodeBase.extend({
  type:             z.literal('tool_invoke'),
  tool_id:          z.string(),
  input_map:        InputMapping.optional(),
  output_map:       OutputMapping.optional(),
  output_validator: OutputValidator.optional(),
  fail_branch:      FailBranch.optional(),
})
export type ToolInvokeNode = z.infer<typeof ToolInvokeNode>

const ConditionBranch = z.object({ condition: Condition, target: z.string() })
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
export type MemoryReadNode = z.infer<typeof MemoryReadNode>

export const MemoryWriteNode = NodeBase.extend({
  type:       z.literal('memory_write'),
  store_id:   z.string(),
  key_expr:   z.string(),
  value_expr: z.string(),
  write_mode: z.enum(['upsert', 'overwrite']).default('upsert').optional(),
  tier:       z.enum(['short', 'long', 'entity', 'user']).default('short').optional(),
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
  type:       z.literal('transform'),
  mode:       z.enum(['mapping', 'fn_ref']),
  mapping:    z.array(z.object({ from: z.string(), to: z.string() })).optional(),
  output_map: OutputMapping.optional(),
  fn_ref:     NpmOrLocalRef.optional(),
})
export type TransformNode = z.infer<typeof TransformNode>

export const MemoryConfig = z.object({
  short_term: z.boolean().default(false),
  long_term:  z.boolean().default(false),
  entity:     z.boolean().default(false),
  user:       z.boolean().default(false),
})
export type MemoryConfig = z.infer<typeof MemoryConfig>

export const AgentDef = z.object({
  id:               z.string(),
  name:             z.string().optional(),
  role:             z.string().optional(),
  backstory:        z.string().optional(),
  goal:             z.string().optional(),
  model:            z.string().optional(),
  tools:            z.array(z.string()).optional(),
  memory_config:    MemoryConfig.optional(),
  max_iter:         z.number().int().default(10).optional(),
  allow_delegation: z.boolean().default(false).optional(),
})
export type AgentDef = z.infer<typeof AgentDef>

export const AgentRoleNodeConfig = z.object({
  agent_ref:         z.string(),
  task_description:  z.string(),
  expected_output:   z.string().optional(),
  async_execution:   z.boolean().default(false).optional(),
  output_field:      z.string().optional(),
  structured_output: StructuredOutput.optional(),
  memory_access:     z.enum(['isolated', 'shared']).default('isolated').optional(),
  memory_store_id:   z.string().optional(),
  tool_approval:     z.enum(['auto', 'human']).default('auto').optional(),
})

export const AgentRoleNode = NodeBase.extend({
  type:   z.literal('agent_role'),
  config: AgentRoleNodeConfig,
})
export type AgentRoleNode = z.infer<typeof AgentRoleNode>

export const AgentDebateNodeConfig = z.object({
  agents:                   z.array(z.string()).min(2),
  max_rounds:               z.number().int().default(10).optional(),
  termination_condition:    Condition.optional(),
  speaker_selection:        z.enum(['auto', 'round_robin', 'custom']).default('auto').optional(),
  speaker_selection_fn_ref: NpmOrLocalRef.optional(),
  allow_repeat_speaker:     z.boolean().default(true).optional(),
  output_field:             z.string().optional(),
})

export const AgentDebateNode = NodeBase.extend({
  type:   z.literal('agent_debate'),
  config: AgentDebateNodeConfig,
})
export type AgentDebateNode = z.infer<typeof AgentDebateNode>

export const Node = z.discriminatedUnion('type', [
  InputNode, OutputNode, LlmCallNode, ToolInvokeNode,
  ConditionNode, ParallelForkNode, ParallelJoinNode,
  HitlBreakpointNode, MemoryReadNode, MemoryWriteNode,
  SubgraphNode, TransformNode, AgentRoleNode, AgentDebateNode,
])
export type Node = z.infer<typeof Node>
export type NodeType = Node['type']

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

export const DirectEdge = z.object({
  type:         z.literal('direct'),
  id:           z.string().optional(),
  from:         z.string(),
  to:           z.string(),
  label:        z.string().optional(),
  context_from: z.array(z.string()).optional(),
}).passthrough()
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
// Tools & Memory
// ---------------------------------------------------------------------------

export const ToolDef = z.object({
  tool_ref:       NpmOrLocalRef,
  source:         z.enum(['npm', 'local', 'mcp']).default('npm').optional(),
  mcp_server_url: z.string().url().optional(),
  description:    z.string().optional(),
  input_schema:   z.record(z.unknown()).optional(),
  output_schema:  z.record(z.unknown()).optional(),
})
export type ToolDef = z.infer<typeof ToolDef>

export const MemoryStoreDef = z.object({
  type:            z.enum(['key_value', 'vector', 'hybrid']),
  description:     z.string().optional(),
  backend:         z.enum(['in_memory', 'postgres', 'sqlite', 'redis', 'upstash', 'qdrant', 'pinecone', 'azure_ai_search']).default('in_memory').optional(),
  connection_env:  z.string().optional(),
  embedding_model: z.string().optional(),
  dimensions:      z.number().int().optional(),
  scope:           z.enum(['thread', 'resource', 'global']).default('thread').optional(),
  namespace:       z.string().optional(),
})
export type MemoryStoreDef = z.infer<typeof MemoryStoreDef>

// ---------------------------------------------------------------------------
// Flow config
// ---------------------------------------------------------------------------

export const ModelDefaults = z.object({
  model:           z.string().optional(),
  embedding_model: z.string().optional(),
  model_params:    ModelParams.optional(),
})
export type ModelDefaults = z.infer<typeof ModelDefaults>

export const CheckpointConfig = z.object({
  enabled:        z.boolean().default(false),
  backend:        z.enum(['in_memory', 'sqlite', 'postgres', 'redis']).default('in_memory').optional(),
  connection_env: z.string().optional(),
  namespace:      z.string().optional(),
})

export const StreamingConfig = z.object({
  enabled: z.boolean().default(false),
  mode:    z.enum(['updates', 'tokens', 'debug']).default('updates').optional(),
})

export const TelemetryConfig = z.object({
  enabled:         z.boolean().default(false),
  provider:        z.enum(['langsmith', 'langfuse', 'otel', 'azure_monitor']).optional(),
  project:         z.string().optional(),
  endpoint_env:    z.string().optional(),
  trace_all_nodes: z.boolean().default(true).optional(),
})

export const A2ASkill = z.object({
  id:          z.string(),
  name:        z.string(),
  description: z.string().optional(),
})

export const A2AConfig = z.object({
  enabled:           z.boolean().default(false),
  agent_name:        z.string().optional(),
  agent_description: z.string().optional(),
  version:           z.string().default('1.0.0').optional(),
  capabilities:      z.array(z.enum(['streaming', 'pushNotifications', 'stateTransitionHistory'])).optional(),
  authentication:    z.enum(['api_key', 'oauth2', 'none']).default('api_key').optional(),
  input_schema_ref:  z.string().optional(),
  output_schema_ref: z.string().optional(),
  skills:            z.array(A2ASkill).optional(),
})
export type A2AConfig = z.infer<typeof A2AConfig>

export const FlowConfig = z.object({
  checkpoint:        CheckpointConfig.optional(),
  streaming:         StreamingConfig.optional(),
  telemetry:         TelemetryConfig.optional(),
  process_type:      z.enum(['sequential', 'hierarchical', 'consensual']).default('sequential').optional(),
  manager_agent_ref: z.string().optional(),
  a2a_config:        A2AConfig.optional(),
})
export type FlowConfig = z.infer<typeof FlowConfig>

// ---------------------------------------------------------------------------
// Root FlowSpec
// ---------------------------------------------------------------------------

export const FlowSpec = z.object({
  spec_version:   SpecVersion,
  id:             FlowId,
  name:           z.string().optional(),
  description:    z.string().optional(),
  runtime_hints:  RuntimeHints.optional(),
  state_schema:   StateSchema.optional(),
  agents:         z.array(AgentDef).optional(),
  nodes:          z.array(Node).min(1),
  edges:          z.array(Edge),
  tools:          z.record(ToolDef).optional(),
  memory_stores:  z.record(MemoryStoreDef).optional(),
  model_defaults: ModelDefaults.optional(),
  flow_config:    FlowConfig.optional(),
})
export type FlowSpec = z.infer<typeof FlowSpec>

export function parseFlowSpec(raw: unknown) {
  return FlowSpec.safeParse(raw)
}

export function assertFlowSpec(raw: unknown): FlowSpec {
  return FlowSpec.parse(raw)
}

// ---------------------------------------------------------------------------
// Runtime-permissive FlowSpec
// Accepts harness-specific node types (gather_evidence, update_world_model,
// etc.) and canvas observability node types (world_model, hypothesis_set,
// etc.) as passthrough stubs, plus the harness_meta field, so harness-enabled
// flows validate here without runtime needing to model every harness node's
// full config shape (it doesn't execute them — see executors/index.ts).
// ---------------------------------------------------------------------------

const RuntimeNodeStub = z.object({ id: NodeId, type: z.string() }).passthrough()
const RuntimeNodeSchema = z.union([Node, RuntimeNodeStub])
export type RuntimeNode = z.infer<typeof RuntimeNodeSchema>

export const RuntimeFlowSpec = FlowSpec.extend({
  nodes:        z.array(RuntimeNodeSchema).min(1),
  harness_meta: z.record(z.unknown()).optional(),
})
export type RuntimeFlowSpec = z.infer<typeof RuntimeFlowSpec>

export function assertRuntimeFlowSpec(raw: unknown): RuntimeFlowSpec {
  return RuntimeFlowSpec.parse(raw)
}
