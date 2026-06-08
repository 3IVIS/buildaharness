import type { NodeTypes } from '@xyflow/react'
import {
  InputNode, OutputNode, LlmCallNode, ToolInvokeNode,
  ConditionNode, ParallelForkNode, ParallelJoinNode,
  HitlBreakpointNode, MemoryReadNode, MemoryWriteNode,
  SubgraphNode, TransformNode, AgentRoleNode, AgentDebateNode,
  GatherEvidenceNode, ApplyToolReliabilityNode, UpdateWorldModelNode,
  WorldModelNodeWrapper, HypothesisSetNodeWrapper, ControlStateNodeWrapper,
  TaskGraphNodeWrapper, VerificationGateNodeWrapper, RecoveryNodeWrapper,
  EvidenceStoreNodeWrapper, ExperienceStoreNodeWrapper, ReviewerPassNodeWrapper,
} from './NodeComponents'
import { AnnotationNode } from './AnnotationNode'

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
  world_model:             WorldModelNodeWrapper,
  hypothesis_set:          HypothesisSetNodeWrapper,
  control_state:           ControlStateNodeWrapper,
  task_graph_node:         TaskGraphNodeWrapper,
  verification_gate:       VerificationGateNodeWrapper,
  recovery_node:           RecoveryNodeWrapper,
  evidence_store_node:     EvidenceStoreNodeWrapper,
  experience_store_node:   ExperienceStoreNodeWrapper,
  reviewer_pass:           ReviewerPassNodeWrapper,
}
