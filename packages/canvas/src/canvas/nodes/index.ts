import type { NodeTypes } from '@xyflow/react'
import {
  InputNode, OutputNode, LlmCallNode, ToolInvokeNode,
  ConditionNode, ParallelForkNode, ParallelJoinNode,
  HitlBreakpointNode, MemoryReadNode, MemoryWriteNode,
  SubgraphNode, TransformNode, AgentRoleNode, AgentDebateNode,
} from './NodeComponents'
import { AnnotationNode } from './AnnotationNode'

export const nodeTypes: NodeTypes = {
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
}
