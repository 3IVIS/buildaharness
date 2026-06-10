import type { FlowSpec } from './schema'

export interface ValidationError {
  nodeId?:   string
  edgeId?:   string
  field:     string
  message:   string
  severity?: 'error' | 'warning'   // omitted = 'error' for backwards compat
}

/**
 * Runs cross-spec validation rules that Zod's per-type schemas can't catch:
 * edge references, store IDs, agent refs, graph reachability, etc.
 *
 * Fixes applied:
 *   #39 — memory_read/memory_write/tool_invoke store/tool refs are now errors
 *          even when the registry is empty (previously silently passed).
 *   #40 — basic graph reachability check: every non-input node must be reachable
 *          from an input node, and the graph must be acyclic for sequential flows.
 */
export function validateCrossRefs(spec: FlowSpec): ValidationError[] {
  const errors: ValidationError[] = []
  const nodeIds  = new Set(spec.nodes.map((n) => n.id))
  const storeIds = new Set(Object.keys(spec.memory_stores ?? {}))
  const toolIds  = new Set(Object.keys(spec.tools ?? {}))
  const agentIds = new Set((spec.agents ?? []).map((a) => a.id))

  // ── Edge from/to cross-refs ───────────────────────────────────────────────

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

  // ── Node-level cross-refs ─────────────────────────────────────────────────

  for (const node of spec.nodes) {
    if (node.type === 'condition') {
      for (const branch of node.branches) {
        if (branch.target && !nodeIds.has(branch.target)) {
          errors.push({ nodeId: node.id, field: 'branches.target', message: `Branch target "${branch.target}" is not a valid node ID` })
        }
      }
      if (node.default_target && !nodeIds.has(node.default_target)) {
        errors.push({ nodeId: node.id, field: 'default_target', message: `Default target "${node.default_target}" is not a valid node ID` })
      }
    }

    if (node.type === 'parallel_fork') {
      for (const t of node.targets) {
        if (t && !nodeIds.has(t)) {
          errors.push({ nodeId: node.id, field: 'targets', message: `Fork target "${t}" is not a valid node ID` })
        }
      }
    }

    if (node.type === 'memory_read') {
      // Only validate when memory_stores is explicitly declared; if the key is absent the spec is still being built.
      if (spec.memory_stores !== undefined && !storeIds.has(node.store_id)) {
        errors.push({
          nodeId: node.id,
          field: 'store_id',
          message: `Store "${node.store_id}" not found in memory_stores${storeIds.size === 0 ? ' (memory_stores is empty)' : ''}`,
        })
      }
    }

    if (node.type === 'memory_write') {
      if (spec.memory_stores !== undefined && !storeIds.has(node.store_id)) {
        errors.push({
          nodeId: node.id,
          field: 'store_id',
          message: `Store "${node.store_id}" not found in memory_stores${storeIds.size === 0 ? ' (memory_stores is empty)' : ''}`,
        })
      }
    }

    if (node.type === 'tool_invoke') {
      // Only validate when tools is explicitly declared.
      if (spec.tools !== undefined && !toolIds.has(node.tool_id)) {
        errors.push({
          nodeId: node.id,
          field: 'tool_id',
          message: `Tool "${node.tool_id}" not found in tools registry${toolIds.size === 0 ? ' (tools is empty)' : ''}`,
        })
      }
    }

    const fb = (node as Record<string, unknown>).fail_branch as { target?: string } | undefined
    if (fb?.target && !nodeIds.has(fb.target)) {
      errors.push({ nodeId: node.id, field: 'fail_branch.target', message: `fail_branch target "${fb.target}" is not a valid node ID` })
    }

    if (node.type === 'agent_role') {
      if (!agentIds.has(node.config.agent_ref)) {
        errors.push({
          nodeId: node.id,
          field: 'config.agent_ref',
          message: `Agent "${node.config.agent_ref}" not found in agents[]${agentIds.size === 0 ? ' (agents is empty)' : ''}`,
        })
      }
      if (node.config.memory_access === 'shared' && !node.config.memory_store_id) {
        errors.push({ nodeId: node.id, field: 'config.memory_store_id', message: 'memory_store_id is required when memory_access is "shared"' })
      }
    }

    if (node.type === 'agent_debate') {
      for (const agentRef of node.config.agents) {
        if (!agentIds.has(agentRef)) {
          errors.push({
            nodeId: node.id,
            field: 'config.agents',
            message: `Agent "${agentRef}" not found in agents[]${agentIds.size === 0 ? ' (agents is empty)' : ''}`,
          })
        }
      }
    }
  }

  // ── Structural: must have input and output ────────────────────────────────

  const inputCount  = spec.nodes.filter((n) => n.type === 'input').length
  const outputCount = spec.nodes.filter((n) => n.type === 'output').length
  if (inputCount === 0)  errors.push({ field: 'nodes', message: 'Flow must have at least one input node' })
  if (outputCount === 0) errors.push({ field: 'nodes', message: 'Flow must have at least one output node' })

  // ── Fix #40: Reachability check ───────────────────────────────────────────
  // Build an adjacency map and BFS from every input node.
  // Any non-input, non-annotation node that is never reached is an orphan.

  const adjacency = new Map<string, Set<string>>()
  for (const node of spec.nodes) {
    adjacency.set(node.id, new Set())
  }
  for (const edge of spec.edges) {
    if (!adjacency.has(edge.from)) continue
    if (edge.type === 'direct') {
      if (nodeIds.has(edge.to)) adjacency.get(edge.from)!.add(edge.to)
    } else if (edge.type === 'conditional') {
      for (const branch of edge.branches) {
        if (nodeIds.has(branch.to)) adjacency.get(edge.from)!.add(branch.to)
      }
      if (nodeIds.has(edge.default_target)) adjacency.get(edge.from)!.add(edge.default_target)
    }
  }

  const reachable = new Set<string>()
  const queue: string[] = spec.nodes
    .filter((n) => n.type === 'input')
    .map((n) => n.id)
  for (const seed of queue) reachable.add(seed)

  while (queue.length > 0) {
    const current = queue.shift()!
    for (const neighbour of adjacency.get(current) ?? []) {
      if (!reachable.has(neighbour)) {
        reachable.add(neighbour)
        queue.push(neighbour)
      }
    }
  }

  for (const node of spec.nodes) {
    if (node.type === 'input' || node.type === ('annotation' as string)) continue
    if (!reachable.has(node.id)) {
      errors.push({
        nodeId:   node.id,
        field:    'nodes',
        message:  `Node "${node.id}" is unreachable from any input node`,
        severity: 'warning',
      })
    }
  }

  // ── Fix #40 / #20: Cycle detection — iterative DFS (no recursion) ─────────
  // Recursive DFS can stack-overflow on large flows (>~10 k nodes on V8).
  // We use an explicit stack with a GRAY/BLACK colouring scheme instead.
  {
    const WHITE = 0, GRAY = 1, BLACK = 2
    const color   = new Map<string, number>()
    for (const node of spec.nodes) color.set(node.id, WHITE)

    let cycleFound = false

    for (const startNode of spec.nodes) {
      if (color.get(startNode.id) !== WHITE) continue

      // Stack entries: [nodeId, iterator-over-neighbours, hasBeenGrayed]
      // We push a node twice: once to colour it GRAY (entering), once to colour BLACK (leaving).
      const stack: Array<{ id: string; neighbours: Iterator<string>; entered: boolean }> = []
      stack.push({
        id:         startNode.id,
        neighbours: (adjacency.get(startNode.id) ?? new Set<string>())[Symbol.iterator](),
        entered:    false,
      })

      while (stack.length > 0 && !cycleFound) {
        const frame = stack[stack.length - 1]

        if (!frame.entered) {
          frame.entered = true
          color.set(frame.id, GRAY)
        }

        const { value: nextId, done } = frame.neighbours.next()

        if (done) {
          color.set(frame.id, BLACK)
          stack.pop()
        } else {
          const c = color.get(nextId)
          if (c === GRAY) {
            cycleFound = true
          } else if (c === WHITE) {
            stack.push({
              id:         nextId,
              neighbours: (adjacency.get(nextId) ?? new Set<string>())[Symbol.iterator](),
              entered:    false,
            })
          }
        }
      }

      if (cycleFound) break
    }

    // LangGraph natively supports cycles (state machine); only warn for sequential adapters.
    const adapter = spec.runtime_hints?.preferred_adapter
    const cyclesAllowed = adapter === 'langgraph'
    if (cycleFound && !cyclesAllowed) {
      errors.push({
        field:    'edges',
        message:  'Graph contains a cycle — sequential flows must be acyclic',
        severity: 'warning',
      })
    }
  }

  // ── ADR-001 output_key warnings ───────────────────────────────────────────

  const outputKeyMap = new Map<string, string | undefined>()
  for (const node of spec.nodes) {
    const n = node as Record<string, unknown>
    if (node.type === 'input')           outputKeyMap.set(node.id, '__input__')
    if (node.type === 'llm_call')        outputKeyMap.set(node.id, n['output_key'] as string | undefined)
    if (node.type === 'memory_read')     outputKeyMap.set(node.id, n['output_key'] as string | undefined)
    if (node.type === 'hitl_breakpoint') outputKeyMap.set(node.id, n['output_key'] as string | undefined)
    if (node.type === 'parallel_join')   outputKeyMap.set(node.id, n['output_key'] as string | undefined)
    if (node.type === 'agent_role')      outputKeyMap.set(node.id, (n['config'] as Record<string, unknown>)?.['output_field'] as string | undefined)
    if (node.type === 'agent_debate')    outputKeyMap.set(node.id, (n['config'] as Record<string, unknown>)?.['output_field'] as string | undefined)
  }

  for (const node of spec.nodes) {
    if (node.type === 'llm_call') {
      const n = node as Record<string, unknown>
      const hasInlinePrompt = Boolean(n['prompt_template'])
      const hasPromptRef    = Boolean((n['prompt_ref'] as Record<string, unknown> | undefined)?.['name'])

      if (hasInlinePrompt && hasPromptRef) {
        errors.push({
          nodeId:   node.id,
          field:    'prompt_ref',
          message:  '[Warning] Both prompt_template and prompt_ref are set — prompt_ref takes precedence at runtime. Remove prompt_template to avoid confusion.',
          severity: 'warning',
        })
      } else if (!hasInlinePrompt && !hasPromptRef) {
        errors.push({
          nodeId:   node.id,
          field:    'prompt_template',
          message:  'llm_call requires either prompt_template (inline) or prompt_ref (Langfuse-managed) — neither is set.',
        })
      }

      if (!n['output_key'] && !n['structured_output']) {
        errors.push({
          nodeId:   node.id,
          field:    'output_key',
          message:  '[Warning] llm_call has no output_key and no structured_output — LLM result will be discarded. Add output_key or structured_output. (ADR-001)',
          severity: 'warning',
        })
      }
    }
  }

  for (const edge of spec.edges) {
    if (edge.type === 'direct') {
      for (const srcId of edge.context_from ?? []) {
        if (nodeIds.has(srcId) && !outputKeyMap.get(srcId)) {
          errors.push({
            edgeId:   edge.id,
            field:    'context_from',
            message:  `[Warning] context_from source "${srcId}" has no output_key — LangGraph adapter will warn; CrewAI Task.context will be empty for this source. (ADR-001)`,
            severity: 'warning',
          })
        }
      }
    }
  }

  return errors
}
