/**
 * Its Harness flow spec v0.2.0 — canvas implementation
 *
 * This file is the canvas app's working copy of the spec schema.
 * Canonical source of truth for publishing: spec/schema.ts (root).
 *
 * Why a separate copy rather than re-exporting from spec/schema.ts?
 * The canonical schema uses .refine() directly on node types to add
 * cross-field validation, which wraps them in ZodEffects. Zod's
 * z.discriminatedUnion() requires bare ZodObject members — ZodEffects
 * breaks it. The canvas copy performs the same structural validations
 * via the cross-ref layer (src/spec/validation.ts) instead.
 *
 * Sync rule: when spec/schema.ts changes, update this file and run
 *   npm test
 * to verify all 5 example flows still validate.
 *
 * @version 1.0.0
 * @see spec/schema.ts — canonical Zod schema (source of truth for npm package)
 * @see spec/schema.json — derived JSON Schema (use for non-TS validation)
 * @see spec/CHANGELOG.md — version history
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

// Fix #37: spec_version is a hard literal. When bumping:
//   1. Change this literal to the new version string.
//   2. Update src/spec/schema.ts to match.
//   3. Add a migration in store/index.ts migrate() and in parseFlowSpecLenient below.
//   4. Update STORAGE_VERSION constant in store/index.ts.
//   5. Regenerate spec/schema.json via: cd spec && npm run gen:json-schema
//   6. Update spec/CHANGELOG.md.
export const SpecVersion = z.union([z.literal('0.2.0'), z.literal('1.0.0')])

/** The spec version string as a plain constant (avoids repeated string references). */
export const CURRENT_SPEC_VERSION = '1.0.0' as const

export const FlowId = z
  .string()
  // Fix #36: FlowId uses hyphens only (no underscores) — deliberate, flows are
  // URL path segments. NodeId allows underscores because node type names like
  // parallel_fork use them. Keep this asymmetry intentional and documented.
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Flow ID must be kebab-case (min 2 chars, hyphens only)')

export const NodeId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-_]*$/, 'Node ID must be lowercase alphanumeric with hyphens/underscores')

export const NpmOrLocalRef = z.string()

export const Position = z.object({ x: z.number(), y: z.number() })
export type Position = z.infer<typeof Position>

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

// Fix #56: microsoft_agent_framework is in the spec enum for forward-compatibility
// but has NO adapter implementation yet (no codegen, no runtime runner).
// It is intentionally excluded from SUPPORTED_RUNTIMES in the adapter and
// the node support matrix reflects 'missing' for all node types until implemented.
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
  .enum(['replace', 'append', 'merge', 'custom'])
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

/** Reference to a Langfuse-managed prompt.  When set, prompt_resolver.py
 *  fetches and injects the text into prompt_template before codegen runs.
 *  Stored in the spec JSONB — no Alembic migration needed. */
export const PromptRef = z.object({
  /** Langfuse prompt name (e.g. "rag-system-prompt") */
  name:    z.string().min(1),
  /** Pin to a specific version number.  Omit for latest. */
  version: z.number().int().positive().optional(),
  /** Langfuse label to resolve against (e.g. "production").  Defaults to "production". */
  label:   z.string().optional(),
})
export type PromptRef = z.infer<typeof PromptRef>

export const LlmCallNode = NodeBase.extend({
  type:              z.literal('llm_call'),
  model:             z.string().optional(),
  system_prompt:     z.string().optional(),
  // prompt_template is optional when prompt_ref is set; required otherwise.
  // Cross-ref validation (validation.ts) enforces: must have one or the other.
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
  type:    z.literal('transform'),
  mode:    z.enum(['mapping', 'fn_ref']),
  mapping: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
  fn_ref:  NpmOrLocalRef.optional(),
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
// Harness node type stubs (Phase 0) — full harness_config shapes added per-phase
// ---------------------------------------------------------------------------

const HarnessNodeBase = NodeBase.extend({
  harness_config: z.record(z.unknown()).optional(),
})

export const WorldModelNode = HarnessNodeBase.extend({ type: z.literal('world_model') })
export const HypothesisSetNode = HarnessNodeBase.extend({ type: z.literal('hypothesis_set') })
export const GatherEvidenceNode = HarnessNodeBase.extend({ type: z.literal('gather_evidence') })
export const ApplyToolReliabilityNode = HarnessNodeBase.extend({ type: z.literal('apply_tool_reliability') })
export const UpdateWorldModelNode = HarnessNodeBase.extend({ type: z.literal('update_world_model') })
export const ControlStateNode = HarnessNodeBase.extend({ type: z.literal('control_state') })
export const TaskGraphNode = HarnessNodeBase.extend({ type: z.literal('task_graph_node') })
export const VerificationGateNode = HarnessNodeBase.extend({ type: z.literal('verification_gate') })
export const RecoveryNode = HarnessNodeBase.extend({ type: z.literal('recovery_node') })
export const EvidenceStoreNode = HarnessNodeBase.extend({ type: z.literal('evidence_store_node') })
export const ExperienceStoreNode = HarnessNodeBase.extend({ type: z.literal('experience_store_node') })
export const ReviewerPassNode = HarnessNodeBase.extend({ type: z.literal('reviewer_pass') })

export type WorldModelNode = z.infer<typeof WorldModelNode>
export type HypothesisSetNode = z.infer<typeof HypothesisSetNode>
export type GatherEvidenceNode = z.infer<typeof GatherEvidenceNode>
export type ApplyToolReliabilityNode = z.infer<typeof ApplyToolReliabilityNode>
export type UpdateWorldModelNode = z.infer<typeof UpdateWorldModelNode>
export type ControlStateNode = z.infer<typeof ControlStateNode>
export type TaskGraphNode = z.infer<typeof TaskGraphNode>
export type VerificationGateNode = z.infer<typeof VerificationGateNode>
export type RecoveryNode = z.infer<typeof RecoveryNode>
export type EvidenceStoreNode = z.infer<typeof EvidenceStoreNode>
export type ExperienceStoreNode = z.infer<typeof ExperienceStoreNode>
export type ReviewerPassNode = z.infer<typeof ReviewerPassNode>

export const HarnessNode = z.discriminatedUnion('type', [
  WorldModelNode,
  HypothesisSetNode,
  GatherEvidenceNode,
  ApplyToolReliabilityNode,
  UpdateWorldModelNode,
  ControlStateNode,
  TaskGraphNode,
  VerificationGateNode,
  RecoveryNode,
  EvidenceStoreNode,
  ExperienceStoreNode,
  ReviewerPassNode,
])
export type HarnessNode = z.infer<typeof HarnessNode>

// Fix #25: AnyNode is imported by validation.ts — includes both v0.2 and harness nodes.
export const AnyNode = z.union([Node, HarnessNode])
export type AnyNode = z.infer<typeof AnyNode>

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
  // Fix #38 — passthrough() rationale and tradeoffs:
  //
  // The canvas must survive an exportSpec → parseFlowSpec → loadFlow round-trip
  // while preserving the visual_type hint (parallel / hitl / fail) that is not
  // part of the canonical DirectEdge schema.  .passthrough() retains unknown keys
  // so visual_type survives Zod parsing without being in the canonical spec.
  //
  // Accepted tradeoff: arbitrary unknown keys in edge.data are not rejected.
  // Mitigation: the data field itself is a plain object (not part of the schema
  // contract), so pollution is bounded to edge.data and cannot corrupt typed fields.
  //
  // The canonical spec/schema.ts does NOT use passthrough() — the npm package
  // rejects unknown top-level edge keys to stay clean for external consumers.
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
// Harness meta block (v1.0.0+, optional)
// ---------------------------------------------------------------------------

export const HarnessMeta = z.object({
  harness_version: z.string().optional(),
  phase:           z.string().optional(),
  enabled:         z.boolean().default(false),
})
export type HarnessMeta = z.infer<typeof HarnessMeta>

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
  nodes:          z.array(AnyNode).min(1),
  edges:          z.array(Edge),
  tools:          z.record(ToolDef).optional(),
  memory_stores:  z.record(MemoryStoreDef).optional(),
  model_defaults: ModelDefaults.optional(),
  flow_config:    FlowConfig.optional(),
  harness_meta:   HarnessMeta.optional(),
})
export type FlowSpec = z.infer<typeof FlowSpec>

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

export function parseFlowSpec(raw: unknown) {
  return FlowSpec.safeParse(raw)
}

export function assertFlowSpec(raw: unknown): FlowSpec {
  return FlowSpec.parse(raw)
}

/**
 * Fix #37: lenient parser that migrates specs from older versions before
 * validating them.  Use this in loadFlow / import paths so saved flows
 * from older spec versions don't break on open.
 *
 * Version migration map:
 *   0.1.0 → 0.2.0: spec_version field added; inject it if missing.
 *   0.2.0 → 1.0.0: harness_meta block added; existing flows remain valid (field is optional).
 */
export function parseFlowSpecLenient(raw: unknown): ReturnType<typeof FlowSpec.safeParse> {
  if (raw !== null && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    // Migrate 0.1.0 → 0.2.0: inject missing spec_version
    if (!obj['spec_version']) {
      obj['spec_version'] = CURRENT_SPEC_VERSION
    }
    // Future migrations go here as else-if chains.
  }
  return FlowSpec.safeParse(raw)
}

// ---------------------------------------------------------------------------
// Canvas-only: adapter display labels
// ---------------------------------------------------------------------------

export const ADAPTER_LABELS: Record<AdapterName, string> = {
  langgraph:                 'LG',
  crewai:                    'CR',
  mastra:                    'MA',
  microsoft_agent_framework: 'MS',
}

// ---------------------------------------------------------------------------
// Canvas-only: default runtime support matrix per node type
// Override per-node via the node's runtime_support field.
// ---------------------------------------------------------------------------

// Fix #56: microsoft_agent_framework has no adapter implementation.
// All node types marked 'missing' until the adapter is built.
// The enum value is kept for forward-compatibility with saved specs.
export const NODE_SUPPORT_MATRIX: Record<NodeType, Record<AdapterName, SupportLevel>> = {
  input:            { langgraph: 'full', crewai: 'full', mastra: 'full', microsoft_agent_framework: 'missing' },
  output:           { langgraph: 'full', crewai: 'full', mastra: 'full', microsoft_agent_framework: 'missing' },
  llm_call:         { langgraph: 'full', crewai: 'full', mastra: 'full', microsoft_agent_framework: 'missing' },
  tool_invoke:      { langgraph: 'full', crewai: 'full', mastra: 'full', microsoft_agent_framework: 'missing' },
  condition:        { langgraph: 'full', crewai: 'full', mastra: 'full', microsoft_agent_framework: 'missing' },
  parallel_fork:    { langgraph: 'full', crewai: 'full', mastra: 'full', microsoft_agent_framework: 'missing' },
  parallel_join:    { langgraph: 'full', crewai: 'full', mastra: 'full', microsoft_agent_framework: 'missing' },
  hitl_breakpoint:  { langgraph: 'full', crewai: 'partial', mastra: 'full', microsoft_agent_framework: 'missing' },
  memory_read:      { langgraph: 'full', crewai: 'full', mastra: 'full', microsoft_agent_framework: 'missing' },
  memory_write:     { langgraph: 'full', crewai: 'full', mastra: 'full', microsoft_agent_framework: 'missing' },
  subgraph:         { langgraph: 'full', crewai: 'partial', mastra: 'full', microsoft_agent_framework: 'missing' },
  transform:        { langgraph: 'full', crewai: 'full', mastra: 'full', microsoft_agent_framework: 'missing' },
  agent_role:       { langgraph: 'partial', crewai: 'full', mastra: 'partial', microsoft_agent_framework: 'missing' },
  agent_debate:     { langgraph: 'partial', crewai: 'partial', mastra: 'partial', microsoft_agent_framework: 'missing' },
}
