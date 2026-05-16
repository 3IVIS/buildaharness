import type { FlowSpec } from './schema'

export interface ValidationError {
  nodeId?: string
  edgeId?: string
  field:   string
  message: string
}

/**
 * Runs cross-spec validation rules that Zod's per-type schemas can't catch:
 * edge references, store IDs, agent refs, etc.
 */
export function validateCrossRefs(spec: FlowSpec): ValidationError[] {
  const errors: ValidationError[] = []
  const nodeIds = new Set(spec.nodes.map((n) => n.id))
  const storeIds = new Set(Object.keys(spec.memory_stores ?? {}))
  const toolIds  = new Set(Object.keys(spec.tools ?? {}))
  const agentIds = new Set((spec.agents ?? []).map((a) => a.id))

  // Edge from/to must reference valid node IDs
  for (const edge of spec.edges) {
    if (!nodeIds.has(edge.from)) {
      errors.push({ edgeId: edge.id, field: 'from', message: `Edge source "${edge.from}" is not a valid node ID` })
    }
    if (edge.type === 'direct') {
      if (!nodeIds.has(edge.to)) {
        errors.push({ edgeId: edge.id, field: 'to', message: `Edge target "${edge.to}" is not a valid node ID` })
      }
      for (const ctx of edge.context_from ?? []) {
        if (!nodeIds.has(ctx)) {
          errors.push({ edgeId: edge.id, field: 'context_from', message: `context_from references unknown node "${ctx}"` })
        }
      }
    }
    if (edge.type === 'conditional') {
      for (const branch of edge.branches) {
        if (!nodeIds.has(branch.to)) {
          errors.push({ edgeId: edge.id, field: 'branches.to', message: `Branch target "${branch.to}" is not a valid node ID` })
        }
      }
      if (!nodeIds.has(edge.default_target)) {
        errors.push({ edgeId: edge.id, field: 'default_target', message: `Default target "${edge.default_target}" is not a valid node ID` })
      }
    }
  }

  // Node-level cross-ref checks
  for (const node of spec.nodes) {
    if (node.type === 'condition') {
      for (const branch of node.branches) {
        // Skip empty-string targets — user is still filling in the form
        if (branch.target && !nodeIds.has(branch.target)) {
          errors.push({ nodeId: node.id, field: 'branches.target', message: `Branch target "${branch.target}" is not a valid node ID` })
        }
      }
      // Only validate non-empty default_target (empty = user hasn't set it yet)
      if (node.default_target && !nodeIds.has(node.default_target)) {
        errors.push({ nodeId: node.id, field: 'default_target', message: `Default target "${node.default_target}" is not a valid node ID` })
      }
    }

    if (node.type === 'parallel_fork') {
      for (const t of node.targets) {
        // Skip empty-string targets — user is still filling in the form
        if (t && !nodeIds.has(t)) {
          errors.push({ nodeId: node.id, field: 'targets', message: `Fork target "${t}" is not a valid node ID` })
        }
      }
    }

    if (node.type === 'memory_read') {
      if (storeIds.size > 0 && !storeIds.has(node.store_id)) {
        errors.push({ nodeId: node.id, field: 'store_id', message: `Store "${node.store_id}" not found in memory_stores` })
      }
    }

    if (node.type === 'memory_write') {
      if (storeIds.size > 0 && !storeIds.has(node.store_id)) {
        errors.push({ nodeId: node.id, field: 'store_id', message: `Store "${node.store_id}" not found in memory_stores` })
      }
    }

    if (node.type === 'tool_invoke') {
      if (toolIds.size > 0 && !toolIds.has(node.tool_id)) {
        errors.push({ nodeId: node.id, field: 'tool_id', message: `Tool "${node.tool_id}" not found in tools registry` })
      }
    }

    // Validate fail_branch.target references a real node (applies to llm_call, tool_invoke)
    const fb = (node as Record<string, unknown>).fail_branch as { target?: string } | undefined
    if (fb?.target && !nodeIds.has(fb.target)) {
      errors.push({ nodeId: node.id, field: 'fail_branch.target', message: `fail_branch target "${fb.target}" is not a valid node ID` })
    }

    if (node.type === 'agent_role') {
      if (agentIds.size > 0 && !agentIds.has(node.config.agent_ref)) {
        errors.push({ nodeId: node.id, field: 'config.agent_ref', message: `Agent "${node.config.agent_ref}" not found in agents[]` })
      }
      if (node.config.memory_access === 'shared' && !node.config.memory_store_id) {
        errors.push({ nodeId: node.id, field: 'config.memory_store_id', message: 'memory_store_id is required when memory_access is "shared"' })
      }
    }

    if (node.type === 'agent_debate') {
      for (const agentRef of node.config.agents) {
        if (agentIds.size > 0 && !agentIds.has(agentRef)) {
          errors.push({ nodeId: node.id, field: 'config.agents', message: `Agent "${agentRef}" not found in agents[]` })
        }
      }
    }
  }

  // Must have exactly one input and one output
  const inputCount  = spec.nodes.filter((n) => n.type === 'input').length
  const outputCount = spec.nodes.filter((n) => n.type === 'output').length
  if (inputCount === 0)  errors.push({ field: 'nodes', message: 'Flow must have at least one input node' })
  if (outputCount === 0) errors.push({ field: 'nodes', message: 'Flow must have at least one output node' })

  return errors
}
