import type { NodeTypes } from '@xyflow/react'
import {
  InputNode, OutputNode, LlmCallNode, ToolInvokeNode,
  ConditionNode, ParallelForkNode, ParallelJoinNode,
  HitlBreakpointNode, MemoryReadNode, MemoryWriteNode,
  SubgraphNode, TransformNode, AgentRoleNode, AgentDebateNode,
  GatherEvidenceNode, ApplyToolReliabilityNode, UpdateWorldModelNode,
} from './NodeComponents'
import { AnnotationNode } from './AnnotationNode'
import {
  WorldModelNode, HypothesisSetNode, ControlStateNode,
  TaskGraphNode, VerificationGateNode, RecoveryNode,
  EvidenceStoreNode, ExperienceStoreNode, ReviewerPassNode,
  ProcessConceptNode,
} from './harness'

export const nodeTypes: NodeTypes = {
  // v0.2 node types
  input:            InputNode,
  output:           OutputNode,
  llm_call:         LlmCallNode,
  tool_invoke:      ToolInvokeNode,
  condition:        ConditionNode,
  parallel_fork:    ParallelForkNode,
  parallel_join:    ParallelJoinNode,
  hitl_breakpoint:  HitlBreakpointNode,
  memory_read:      MemoryReadNode,
  memory_write:     MemoryWriteNode,
  subgraph:         SubgraphNode,
  transform:        TransformNode,
  agent_role:       AgentRoleNode,
  agent_debate:     AgentDebateNode,
  annotation:       AnnotationNode,
  // Phase 1 harness nodes
  gather_evidence:         GatherEvidenceNode,
  apply_tool_reliability:  ApplyToolReliabilityNode,
  update_world_model:      UpdateWorldModelNode,
  // Phase 10 harness canvas nodes
  world_model:             WorldModelNode,
  hypothesis_set:          HypothesisSetNode,
  control_state:           ControlStateNode,
  task_graph_node:         TaskGraphNode,
  verification_gate:       VerificationGateNode,
  recovery_node:           RecoveryNode,
  evidence_store_node:     EvidenceStoreNode,
  experience_store_node:   ExperienceStoreNode,
  reviewer_pass:           ReviewerPassNode,
  // Process Concepts (P-PC)
  process_concept:         ProcessConceptNode,
}
