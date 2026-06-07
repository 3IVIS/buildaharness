import { describe, it, expect } from 'vitest'
import { parseFlowSpec, assertFlowSpec } from '../spec/schema'
import { validateCrossRefs } from '../spec/validation'
import { EXAMPLE_FLOWS } from '../spec/examples'

// ─── Shared fixtures ─────────────────────────────────────────────────────────
// Minimal valid spec used as a base for many tests.
const BASE = {
  spec_version: '0.2.0' as const,
  id: 'base-flow',
  nodes: [
    { id: 'start', type: 'input'  as const },
    { id: 'done',  type: 'output' as const },
  ],
  edges: [{ type: 'direct' as const, from: 'start', to: 'done' }],
}

function base(overrides: Record<string, unknown> = {}) {
  return { ...BASE, ...overrides }
}

// ─── Zod validation ───────────────────────────────────────────────────────────

describe('FlowSpec — Zod validation', () => {

  // ── All example flows ───────────────────────────────────────────────────────
  EXAMPLE_FLOWS.forEach(({ label, spec }) => {
    it(`validates: ${label}`, () => {
      const result = parseFlowSpec(spec)
      if (!result.success) console.error(result.error.issues)
      expect(result.success).toBe(true)
    })
  })

  // ── spec_version ────────────────────────────────────────────────────────────
  it('rejects wrong spec_version', () => {
    expect(parseFlowSpec(base({ spec_version: '0.1.0' })).success).toBe(false)
  })

  it('rejects missing spec_version', () => {
    const { spec_version: _, ...noVersion } = BASE
    expect(parseFlowSpec(noVersion).success).toBe(false)
  })

  // ── FlowId ──────────────────────────────────────────────────────────────────
  it('rejects a flow ID with uppercase letters', () => {
    expect(parseFlowSpec(base({ id: 'MyFlow' })).success).toBe(false)
  })

  it('rejects a flow ID with spaces', () => {
    expect(parseFlowSpec(base({ id: 'my flow' })).success).toBe(false)
  })

  it('rejects a flow ID with special characters', () => {
    expect(parseFlowSpec(base({ id: 'my_flow!' })).success).toBe(false)
  })

  it('rejects a single-character flow ID', () => {
    // FlowId regex: ^[a-z0-9][a-z0-9-]*[a-z0-9]$ — requires min 2 chars
    expect(parseFlowSpec(base({ id: 'x' })).success).toBe(false)
  })

  it('accepts a valid kebab-case flow ID', () => {
    expect(parseFlowSpec(base({ id: 'my-valid-flow-01' })).success).toBe(true)
  })

  // ── Empty nodes ─────────────────────────────────────────────────────────────
  it('rejects a spec with no nodes', () => {
    expect(parseFlowSpec(base({ nodes: [] })).success).toBe(false)
  })

  // ── LlmCallNode ─────────────────────────────────────────────────────────────
  it('rejects llm_call with missing prompt_template', () => {
    // prompt_template/prompt_ref is enforced by validateCrossRefs, not Zod schema
    // (it must allow prompt_ref as alternative, which can't be expressed in a discriminated union member)
    const spec = assertFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'call',  type: 'llm_call' },   // neither prompt_template nor prompt_ref
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'call' },
        { type: 'direct', from: 'call',  to: 'done' },
      ],
    })
    expect(validateCrossRefs(spec).some((e) => e.field === 'prompt_template')).toBe(true)
  })

  it('accepts llm_call with only prompt_template', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'call',  type: 'llm_call', prompt_template: 'Hello' },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'call' },
        { type: 'direct', from: 'call',  to: 'done' },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects llm_call with temperature above 2', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'call',  type: 'llm_call', prompt_template: 'Hi',
          model_params: { temperature: 3.5 } },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'call' },
        { type: 'direct', from: 'call',  to: 'done' },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('rejects llm_call with top_p above 1', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'call',  type: 'llm_call', prompt_template: 'Hi',
          model_params: { top_p: 1.5 } },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'call' },
        { type: 'direct', from: 'call',  to: 'done' },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('accepts llm_call with output_validator', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'call',  type: 'llm_call', prompt_template: 'Hi',
          output_validator: { fn_ref: './validators/quality.ts', on_fail: 'retry', max_retries: 3 } },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'call' },
        { type: 'direct', from: 'call',  to: 'done' },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects output_validator with max_retries above 5', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'call',  type: 'llm_call', prompt_template: 'Hi',
          output_validator: { fn_ref: './v.ts', on_fail: 'retry', max_retries: 10 } },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'call' },
        { type: 'direct', from: 'call',  to: 'done' },
      ],
    })
    expect(result.success).toBe(false)
  })

  // ── ToolInvokeNode ───────────────────────────────────────────────────────────
  it('rejects tool_invoke with missing tool_id', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'tool',  type: 'tool_invoke' },  // tool_id required
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'tool' },
        { type: 'direct', from: 'tool',  to: 'done' },
      ],
    })
    expect(result.success).toBe(false)
  })

  // ── ConditionNode ────────────────────────────────────────────────────────────
  it('rejects condition node with empty branches array', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'cond',  type: 'condition', branches: [], default_target: 'done' },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'cond' },
        { type: 'direct', from: 'cond',  to: 'done' },
      ],
    })
    expect(result.success).toBe(false)
  })

  // ── ParallelForkNode ─────────────────────────────────────────────────────────
  it('rejects parallel_fork with fewer than 2 targets', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'fork',  type: 'parallel_fork', targets: ['done'] }, // min 2
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'fork' },
        { type: 'direct', from: 'fork',  to: 'done' },
      ],
    })
    expect(result.success).toBe(false)
  })

  // ── AgentDebateNode ──────────────────────────────────────────────────────────
  it('rejects agent_debate with fewer than 2 agents', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start',  type: 'input' },
        { id: 'debate', type: 'agent_debate', config: { agents: ['solo-agent'] } },
        { id: 'done',   type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start',  to: 'debate' },
        { type: 'direct', from: 'debate', to: 'done'   },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('accepts agent_debate with exactly 2 agents', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start',  type: 'input' },
        { id: 'debate', type: 'agent_debate', config: { agents: ['agent-a', 'agent-b'] } },
        { id: 'done',   type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start',  to: 'debate' },
        { type: 'direct', from: 'debate', to: 'done'   },
      ],
    })
    expect(result.success).toBe(true)
  })

  // ── MemoryWriteNode ──────────────────────────────────────────────────────────
  it('rejects memory_write with invalid tier value', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'write', type: 'memory_write',
          store_id: 'cache', key_expr: '$.state.k', value_expr: '$.state.v',
          tier: 'medium' },  // not in enum
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'write' },
        { type: 'direct', from: 'write', to: 'done'  },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('accepts all valid memory_write tier values', () => {
    for (const tier of ['short', 'long', 'entity', 'user'] as const) {
      const result = parseFlowSpec({
        ...BASE,
        nodes: [
          { id: 'start', type: 'input' },
          { id: 'write', type: 'memory_write',
            store_id: 'cache', key_expr: '$.state.k', value_expr: '$.state.v', tier },
          { id: 'done',  type: 'output' },
        ],
        edges: [
          { type: 'direct', from: 'start', to: 'write' },
          { type: 'direct', from: 'write', to: 'done'  },
        ],
      })
      expect(result.success, `tier '${tier}' should be valid`).toBe(true)
    }
  })

  // ── MemoryStoreDef ───────────────────────────────────────────────────────────
  it('rejects a memory store with an invalid type', () => {
    expect(parseFlowSpec(base({ memory_stores: { s: { type: 'graph' } } })).success).toBe(false)
  })

  it('accepts all valid memory store types', () => {
    for (const type of ['key_value', 'vector', 'hybrid'] as const) {
      expect(parseFlowSpec(base({ memory_stores: { s: { type } } })).success, `type '${type}'`).toBe(true)
    }
  })

  // ── ToolDef ──────────────────────────────────────────────────────────────────
  it('rejects a tool with an invalid mcp_server_url', () => {
    expect(parseFlowSpec(base({
      tools: { t: { tool_ref: '@s/t', source: 'mcp', mcp_server_url: 'not-a-url' } },
    })).success).toBe(false)
  })

  it('accepts a tool with a valid mcp_server_url', () => {
    expect(parseFlowSpec(base({
      tools: { t: { tool_ref: '@s/t', source: 'mcp', mcp_server_url: 'https://mcp.example.com/sse' } },
    })).success).toBe(true)
  })

  // ── RetryConfig ──────────────────────────────────────────────────────────────
  it('rejects fail_branch with max_attempts below minimum (1)', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'call',  type: 'llm_call', prompt_template: 'Hi',
          fail_branch: { target: 'done', retry: { max_attempts: 0 } } },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'call' },
        { type: 'direct', from: 'call',  to: 'done' },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('rejects fail_branch with max_attempts above maximum (10)', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'call',  type: 'llm_call', prompt_template: 'Hi',
          fail_branch: { target: 'error-handler', retry: { max_attempts: 99 } } },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'call' },
        { type: 'direct', from: 'call',  to: 'done' },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('rejects fail_branch with invalid backoff value', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'call',  type: 'llm_call', prompt_template: 'Hi',
          fail_branch: { target: 'done', retry: { backoff: 'linear' } } },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'call' },
        { type: 'direct', from: 'call',  to: 'done' },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('accepts fail_branch with all retry config fields', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'call',  type: 'llm_call', prompt_template: 'Hello',
          fail_branch: { target: 'handler', retry: { max_attempts: 3, backoff: 'exponential', delay_ms: 1000 } } },
        { id: 'handler', type: 'transform', mode: 'mapping', mapping: [] },
        { id: 'done',    type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start',   to: 'call'    },
        { type: 'direct', from: 'call',    to: 'done'    },
        { type: 'direct', from: 'call',    to: 'handler' },
        { type: 'direct', from: 'handler', to: 'done'    },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects fail_branch target with invalid NodeId format', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'call',  type: 'llm_call', prompt_template: 'Hi',
          fail_branch: { target: 'My Error Handler!' } },  // invalid NodeId
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'call' },
        { type: 'direct', from: 'call',  to: 'done' },
      ],
    })
    expect(result.success).toBe(false)
  })

  // ── ConditionalEdge ──────────────────────────────────────────────────────────
  it('validates a ConditionalEdge with branches and default_target', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start',    type: 'input' },
        { id: 'branch-a', type: 'transform', mode: 'mapping', mapping: [] },
        { id: 'done',     type: 'output' },
      ],
      edges: [
        { type: 'conditional', from: 'start',
          branches: [{ condition: { type: 'expr', expr: '$.state.x > 0' }, to: 'branch-a' }],
          default_target: 'done' },
        { type: 'direct', from: 'branch-a', to: 'done' },
      ],
    })
    expect(result.success).toBe(true)
  })

  // ── DirectEdge passthrough ───────────────────────────────────────────────────
  it('preserves unknown fields on DirectEdge via passthrough() (round-trip guard)', () => {
    // visual_type is how the canvas round-trips parallel/hitl/fail edge renderers
    // through parseFlowSpec without adding it to the canonical schema.
    const result = parseFlowSpec({
      ...BASE,
      edges: [{ type: 'direct', from: 'start', to: 'done', data: { visual_type: 'parallel' } }],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      const edge = result.data.edges[0] as Record<string, unknown>
      expect((edge.data as Record<string, unknown>)?.visual_type).toBe('parallel')
    }
  })
})

// ─── Cross-ref validation ─────────────────────────────────────────────────────

describe('Cross-ref validation', () => {

  // ── All example flows ───────────────────────────────────────────────────────
  EXAMPLE_FLOWS.forEach(({ label, spec }) => {
    it(`no cross-ref errors: ${label}`, () => {
      const errors = validateCrossRefs(spec)
      if (errors.length > 0) console.error(errors)
      expect(errors).toHaveLength(0)
    })
  })

  // ── I/O node requirements ───────────────────────────────────────────────────
  it('flags a flow with no input node', () => {
    const spec = assertFlowSpec({ ...BASE, nodes: [{ id: 'done', type: 'output' }], edges: [] })
    expect(validateCrossRefs(spec).some((e) => e.message.includes('input node'))).toBe(true)
  })

  it('flags a flow with no output node', () => {
    const spec = assertFlowSpec({ ...BASE, nodes: [{ id: 'start', type: 'input' }], edges: [] })
    expect(validateCrossRefs(spec).some((e) => e.message.includes('output node'))).toBe(true)
  })

  it('passes with exactly one input and one output', () => {
    expect(validateCrossRefs(assertFlowSpec(BASE))).toHaveLength(0)
  })

  // ── Edge from/to ────────────────────────────────────────────────────────────
  it('catches edge with unknown source node (from)', () => {
    const spec = assertFlowSpec({
      ...BASE,
      edges: [{ type: 'direct', from: 'ghost', to: 'done' }],
    })
    expect(validateCrossRefs(spec).some((e) => e.field === 'from' && e.message.includes('ghost'))).toBe(true)
  })

  it('catches edge with unknown target node (to)', () => {
    const spec = assertFlowSpec({
      ...BASE,
      edges: [
        { type: 'direct', from: 'start', to: 'does-not-exist' },
        { type: 'direct', from: 'start', to: 'done' },
      ],
    })
    expect(validateCrossRefs(spec).some((e) => e.message.includes('does-not-exist'))).toBe(true)
  })

  it('catches context_from referencing an unknown node', () => {
    const spec = assertFlowSpec({
      ...BASE,
      edges: [{ type: 'direct', from: 'start', to: 'done', context_from: ['phantom-node'] }],
    })
    expect(validateCrossRefs(spec).some((e) => e.field === 'context_from' && e.message.includes('phantom-node'))).toBe(true)
  })

  it('passes with valid context_from references', () => {
    const spec = assertFlowSpec({
      ...BASE,
      edges: [{ type: 'direct', from: 'start', to: 'done', context_from: ['start'] }],
    })
    expect(validateCrossRefs(spec)).toHaveLength(0)
  })

  // ── ConditionalEdge ──────────────────────────────────────────────────────────
  it('catches ConditionalEdge branch.to referencing an unknown node', () => {
    const spec = assertFlowSpec({
      ...BASE,
      edges: [{
        type: 'conditional', from: 'start',
        branches: [{ condition: { type: 'expr', expr: 'true' }, to: 'nowhere' }],
        default_target: 'done',
      }],
    })
    expect(validateCrossRefs(spec).some((e) => e.message.includes('nowhere'))).toBe(true)
  })

  it('catches ConditionalEdge default_target referencing an unknown node', () => {
    const spec = assertFlowSpec({
      ...BASE,
      edges: [{
        type: 'conditional', from: 'start',
        branches: [{ condition: { type: 'expr', expr: 'true' }, to: 'done' }],
        default_target: 'phantom',
      }],
    })
    expect(validateCrossRefs(spec).some((e) => e.field === 'default_target' && e.message.includes('phantom'))).toBe(true)
  })

  // ── Memory stores ────────────────────────────────────────────────────────────
  it('catches memory_read with unknown store_id', () => {
    const spec = assertFlowSpec({
      ...BASE,
      memory_stores: { known: { type: 'key_value' } },
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'read',  type: 'memory_read', store_id: 'unknown',
          retrieval_mode: 'key_value', key_expr: '$.state.x', output_key: 'result' },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'read' },
        { type: 'direct', from: 'read',  to: 'done' },
      ],
    })
    expect(validateCrossRefs(spec).some((e) => e.message.includes('unknown'))).toBe(true)
  })

  it('catches memory_write with unknown store_id', () => {
    const spec = assertFlowSpec({
      ...BASE,
      memory_stores: { known: { type: 'key_value' } },
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'write', type: 'memory_write', store_id: 'missing',
          key_expr: '$.state.k', value_expr: '$.state.v' },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'write' },
        { type: 'direct', from: 'write', to: 'done'  },
      ],
    })
    expect(validateCrossRefs(spec).some((e) => e.message.includes('missing'))).toBe(true)
  })

  it('skips store_id check when no memory_stores are declared', () => {
    const spec = assertFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'read',  type: 'memory_read', store_id: 'any-store',
          retrieval_mode: 'key_value', key_expr: '$.x', output_key: 'result' },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'read' },
        { type: 'direct', from: 'read',  to: 'done' },
      ],
    })
    expect(validateCrossRefs(spec)).toHaveLength(0)
  })

  // ── Tools ────────────────────────────────────────────────────────────────────
  it('catches tool_invoke referencing an unregistered tool', () => {
    const spec = assertFlowSpec({
      ...BASE,
      tools: { registered: { tool_ref: '@scope/tool' } },
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'tool',  type: 'tool_invoke', tool_id: 'unregistered' },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'tool' },
        { type: 'direct', from: 'tool',  to: 'done' },
      ],
    })
    expect(validateCrossRefs(spec).some((e) => e.message.includes('unregistered'))).toBe(true)
  })

  it('skips tool_id check when no tools are declared', () => {
    const spec = assertFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'tool',  type: 'tool_invoke', tool_id: 'any-tool' },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'tool' },
        { type: 'direct', from: 'tool',  to: 'done' },
      ],
    })
    expect(validateCrossRefs(spec)).toHaveLength(0)
  })

  // ── Agents ───────────────────────────────────────────────────────────────────
  it('catches agent_role with unknown agent_ref', () => {
    const spec = assertFlowSpec({
      ...BASE,
      agents: [{ id: 'real-agent', role: 'Researcher' }],
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'role',  type: 'agent_role',
          config: { agent_ref: 'ghost-agent', task_description: 'Do stuff.' } },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'role' },
        { type: 'direct', from: 'role',  to: 'done' },
      ],
    })
    expect(validateCrossRefs(spec).some((e) => e.message.includes('ghost-agent'))).toBe(true)
  })

  it('catches agent_debate with an unknown agent ref', () => {
    const spec = assertFlowSpec({
      ...BASE,
      agents: [{ id: 'agent-a', role: 'Advocate' }, { id: 'agent-b', role: 'Skeptic' }],
      nodes: [
        { id: 'start',  type: 'input' },
        { id: 'debate', type: 'agent_debate', config: { agents: ['agent-a', 'ghost-agent'] } },
        { id: 'done',   type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start',  to: 'debate' },
        { type: 'direct', from: 'debate', to: 'done'   },
      ],
    })
    expect(validateCrossRefs(spec).some((e) => e.message.includes('ghost-agent'))).toBe(true)
  })

  it('catches agent_role with memory_access=shared but no memory_store_id', () => {
    const spec = assertFlowSpec({
      ...BASE,
      agents: [{ id: 'my-agent', role: 'Worker' }],
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'role',  type: 'agent_role',
          config: { agent_ref: 'my-agent', task_description: 'Work.', memory_access: 'shared' } },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'role' },
        { type: 'direct', from: 'role',  to: 'done' },
      ],
    })
    expect(validateCrossRefs(spec).some((e) => e.field === 'config.memory_store_id')).toBe(true)
  })

  // ── fail_branch cross-ref ────────────────────────────────────────────────────
  it('catches fail_branch.target referencing a non-existent node', () => {
    const spec = assertFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'call',  type: 'llm_call', prompt_template: 'Hi',
          fail_branch: { target: 'no-such-handler' } },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'call' },
        { type: 'direct', from: 'call',  to: 'done' },
      ],
    })
    const errors = validateCrossRefs(spec)
    expect(errors.some((e) => e.field === 'fail_branch.target' && e.message.includes('no-such-handler'))).toBe(true)
  })

  it('passes when fail_branch.target is a valid existing node', () => {
    const spec = assertFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start',   type: 'input' },
        { id: 'call',    type: 'llm_call', prompt_template: 'Hi', fail_branch: { target: 'handler' } },
        { id: 'handler', type: 'transform', mode: 'mapping', mapping: [] },
        { id: 'done',    type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start',   to: 'call'    },
        { type: 'direct', from: 'call',    to: 'done'    },
        { type: 'direct', from: 'handler', to: 'done'    },
      ],
    })
    expect(validateCrossRefs(spec).filter((e) => e.field === 'fail_branch.target')).toHaveLength(0)
  })

  // ── parallel_fork ────────────────────────────────────────────────────────────
  it('catches parallel_fork with an unknown target node', () => {
    const spec = assertFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start',    type: 'input' },
        { id: 'fork',     type: 'parallel_fork', targets: ['branch-a', 'phantom'] },
        { id: 'branch-a', type: 'transform', mode: 'mapping', mapping: [] },
        { id: 'done',     type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start',    to: 'fork'     },
        { type: 'direct', from: 'fork',     to: 'branch-a' },
        { type: 'direct', from: 'branch-a', to: 'done'     },
      ],
    })
    expect(validateCrossRefs(spec).some((e) => e.field === 'targets' && e.message.includes('phantom'))).toBe(true)
  })

  // ── condition node branch targets ────────────────────────────────────────────
  it('catches condition node branch.target referencing an unknown node', () => {
    const spec = assertFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'cond',  type: 'condition',
          branches: [{ condition: { type: 'expr', expr: 'true' }, target: 'nowhere' }],
          default_target: 'done' },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'cond' },
        { type: 'direct', from: 'cond',  to: 'done' },
      ],
    })
    expect(validateCrossRefs(spec).some((e) => e.field === 'branches.target' && e.message.includes('nowhere'))).toBe(true)
  })

  // ── ProcessConceptNode ───────────────────────────────────────────────────────
  it('accepts process_concept node with a valid concept_id', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start',   type: 'input' },
        { id: 'concept', type: 'process_concept', harness_config: { concept_id: 'debug_test_failure' } },
        { id: 'done',    type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start',   to: 'concept' },
        { type: 'direct', from: 'concept', to: 'done'    },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects process_concept node with empty concept_id', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start',   type: 'input' },
        { id: 'concept', type: 'process_concept', harness_config: { concept_id: '' } },
        { id: 'done',    type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start',   to: 'concept' },
        { type: 'direct', from: 'concept', to: 'done'    },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('rejects process_concept node with missing harness_config', () => {
    const result = parseFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start',   type: 'input' },
        { id: 'concept', type: 'process_concept' },
        { id: 'done',    type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start',   to: 'concept' },
        { type: 'direct', from: 'concept', to: 'done'    },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('does not flag empty-string branch targets (in-progress condition node)', () => {
    // Empty string = user hasn't filled in the form yet — should not produce an error
    const spec = assertFlowSpec({
      ...BASE,
      nodes: [
        { id: 'start', type: 'input' },
        { id: 'cond',  type: 'condition',
          branches: [{ condition: { type: 'expr', expr: '' }, target: '' }],
          default_target: '' },
        { id: 'done',  type: 'output' },
      ],
      edges: [
        { type: 'direct', from: 'start', to: 'cond' },
        { type: 'direct', from: 'cond',  to: 'done' },
      ],
    })
    expect(validateCrossRefs(spec).filter((e) => e.nodeId === 'cond' && e.field === 'branches.target')).toHaveLength(0)
  })
})
