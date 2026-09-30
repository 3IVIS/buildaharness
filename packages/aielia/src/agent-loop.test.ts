import { describe, it, expect } from 'vitest'
import { ControlState } from '@buildaharness/harness'
import { InMemoryAdapter, InMemoryReminderStore } from '@buildaharness/runtime'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition, FsBackend } from '@buildaharness/runtime'
import { AgentLoop } from './agent-loop.js'
import { createTurnControlPlaneState, controlStateToolPolicyEnabled, type TurnControlPlaneState } from './tool-control-plane.js'
import type { FileToolsContext } from './file-tools.js'

/**
 * Phase D0 (harness_consolidation_and_control_plane_plan.html): unit-tests the wiring added to
 * runToolIterations's callChatStructured call — onToolProposal must reuse the exact same
 * checkToolPolicy gate the manual dispatch loop already runs for the proxy backend's calls (see
 * agent-loop.ts:505-533), so a backend whose own internal loop resolves read-only tool calls
 * invisibly (ClaudeCliLLMClient — see claude-cli-llm-client.test.ts for the transport-level half
 * of this round trip) is now gated the same way. This fake ILLMClient stands in for that backend:
 * instead of actually spawning a subprocess, it calls options.onToolProposal itself, exactly the
 * shape ClaudeCliLLMClient's gate server invokes it, and folds the decision into its reply.
 */
class ProposingFakeLLMClient implements ILLMClient {
  public lastDecision: { decision: string; reason?: string } | undefined

  async *callChat(): AsyncIterable<string> {
    yield ''
  }

  async callChatSync(): Promise<string> {
    return ''
  }

  async callChatStructured(_messages: ChatMessage[], _tools?: ToolDefinition[], options: ChatOptions = {}): Promise<LLMStructuredResponse> {
    const decision = await options.onToolProposal?.('read_file', { path: 'notes.txt' })
    this.lastDecision = decision
    if (decision?.decision === 'deny') {
      return { content: `denied: ${decision.reason}` }
    }
    return { content: 'read the file for you' }
  }
}

/** Stands in for the proxy backend: one call returns a real `toolCalls` array (not `onToolProposal`), exercising the manual dispatch loop's own `checkToolPolicy` gate (agent-loop.ts's `runToolIterationStep`, DENY branch) rather than the claude-cli-shaped propose→gate seam `ProposingFakeLLMClient` above exercises. */
class DispatchingFakeLLMClient implements ILLMClient {
  private calls = 0

  async *callChat(): AsyncIterable<string> {
    yield ''
  }

  async callChatSync(): Promise<string> {
    return ''
  }

  async callChatStructured(): Promise<LLMStructuredResponse> {
    this.calls += 1
    if (this.calls === 1) {
      return { content: '', toolCalls: [{ id: 'toolu_1', name: 'read_file', input: { path: 'notes.txt' } }] }
    }
    return { content: 'done' }
  }
}

const fakeFileTools: FileToolsContext = { backend: {} as FsBackend, workspaceRoot: '/workspace' }

function buildAgentLoop(llmClient: ILLMClient): AgentLoop {
  const memory = new InMemoryAdapter()
  const reminderStore = new InMemoryReminderStore(memory)
  return new AgentLoop(memory, llmClient, () => undefined, fakeFileTools, undefined, undefined, undefined, reminderStore, 5, undefined, undefined)
}

/** A claude-cli-shaped backend: it reports `failures` failed read_file results through onToolResult (as the MCP server now does), then proposes one more read. */
class FailingThenProposingFakeLLMClient implements ILLMClient {
  public lastDecision: { decision: string; reason?: string } | undefined
  constructor(private readonly failures: number, private readonly notFound = false, private readonly sameCall = false) {}
  async *callChat(): AsyncIterable<string> { yield '' }
  async callChatSync(): Promise<string> { return '' }
  async callChatStructured(_m: ChatMessage[], _t?: ToolDefinition[], options: ChatOptions = {}): Promise<LLMStructuredResponse> {
    for (let i = 0; i < this.failures; i++) {
      const path = this.sameCall ? 'missing.txt' : `missing-${i}.txt`
      await options.onToolResult?.('read_file', { path }, `File not found: ${path}`, false, this.notFound)
    }
    this.lastDecision = await options.onToolProposal?.('read_file', { path: 'next.txt' })
    return { content: this.lastDecision?.decision === 'deny' ? `denied: ${this.lastDecision.reason}` : 'kept going' }
  }
}

describe('claude-cli tool failures reach the turn ControlState the gate reads', () => {
  const run = async (failures: number, withState = true, kind: { notFound?: boolean; sameCall?: boolean } = {}) => {
    const llm = new FailingThenProposingFakeLLMClient(failures, kind.notFound, kind.sameCall)
    // Built the way agent-loop.ts's own factory does, so the eval-only ablation switch (its one read site) applies.
    const state = withState ? createTurnControlPlaneState(['read_file'], { pinNormal: !controlStateToolPolicyEnabled() }) : undefined
    const result = await buildAgentLoop(llm).runToolLoop('s', [], 'find it', 'system prompt', undefined, undefined, undefined, 'LOW', state)
    return { llm, result, state }
  }

  it('a few failed reads leave the gate open', async () => {
    const { llm } = await run(3)
    expect(llm.lastDecision).toEqual({ decision: 'allow' })
  })

  it('a turn that has piled up failures is denied further read-only calls, and the model sees why', async () => {
    const { llm, result } = await run(13)
    expect(llm.lastDecision?.decision).toBe('deny')
    expect(result).toMatchObject({ kind: 'final' })
  })

  it('13 DIFFERENT missing paths (negative answers) are a search: the gate stays open', async () => {
    const { llm } = await run(13, true, { notFound: true })
    expect(llm.lastDecision).toEqual({ decision: 'allow' })
  })

  it('the same missing path asked for over and over is a retry loop: the gate closes', async () => {
    const { llm } = await run(13, true, { notFound: true, sameCall: true })
    expect(llm.lastDecision?.decision).toBe('deny')
  })

  it('without a turn control plane (nothing to fold outcomes into) the calls are still allowed, as before', async () => {
    const { llm } = await run(13, false)
    expect(llm.lastDecision).toEqual({ decision: 'allow' })
  })

  it('the AUDIT_CONTROL_STATE_TOOL_POLICY=0 switch still pins the gate open', async () => {
    process.env.AUDIT_CONTROL_STATE_TOOL_POLICY = '0'
    try {
      const { llm } = await run(13)
      expect(llm.lastDecision).toEqual({ decision: 'allow' })
    } finally {
      delete process.env.AUDIT_CONTROL_STATE_TOOL_POLICY
    }
  })
})

describe('AgentLoop onToolProposal wiring (Phase D0)', () => {
  it('allows a read-only proposal at the pre-evidence baseline (no controlPlaneState wired)', async () => {
    const llmClient = new ProposingFakeLLMClient()
    const agentLoop = buildAgentLoop(llmClient)

    const result = await agentLoop.runToolLoop('session-1', [], 'read notes.txt', 'system prompt')

    expect(llmClient.lastDecision).toEqual({ decision: 'allow' })
    expect(result).toEqual({ kind: 'final', content: 'read the file for you', sources: [] })
  })

  it('denies a read-only proposal when the live ControlState permission is DENY, and the model sees the denial', async () => {
    const llmClient = new ProposingFakeLLMClient()
    const agentLoop = buildAgentLoop(llmClient)
    const controlPlaneState: TurnControlPlaneState = createTurnControlPlaneState(['read_file'])
    controlPlaneState.controlState = new ControlState({ permission: 'DENY' })

    const result = await agentLoop.runToolLoop(
      'session-1',
      [],
      'read notes.txt',
      'system prompt',
      undefined,
      undefined,
      undefined,
      'LOW',
      controlPlaneState,
    )

    expect(llmClient.lastDecision?.decision).toBe('deny')
    expect(llmClient.lastDecision?.reason).toMatch(/harness control state denies action/)
    expect(result).toEqual({
      kind: 'final',
      content: 'denied: harness control state denies action this turn',
      sources: [],
    })
  })

  it('reports a denied claude-cli-shaped proposal via onToolStep with deniedReason set, so the CLI can print it', async () => {
    const llmClient = new ProposingFakeLLMClient()
    const agentLoop = buildAgentLoop(llmClient)
    const controlPlaneState: TurnControlPlaneState = createTurnControlPlaneState(['read_file'])
    controlPlaneState.controlState = new ControlState({ permission: 'DENY' })

    const steps: { tool: string; deniedReason?: string }[] = []
    await agentLoop.runToolLoop(
      'session-1',
      [],
      'read notes.txt',
      'system prompt',
      undefined,
      (step) => steps.push({ tool: step.tool, deniedReason: step.deniedReason }),
      undefined,
      'LOW',
      controlPlaneState,
    )

    // ProposingFakeLLMClient only calls onToolProposal (the gate), not onToolStep (the separate
    // tool_use-event signal ClaudeCliLLMClient's own stream parsing fires) — so only the denial
    // itself is reported here; claude-cli-llm-client.test.ts covers the tool_use-event half.
    expect(steps).toEqual([{ tool: 'read_file', deniedReason: 'harness control state denies action this turn' }])
  })

  it('reports a denied manual-dispatch-loop tool call via onToolStep with deniedReason set', async () => {
    const llmClient = new DispatchingFakeLLMClient()
    const agentLoop = buildAgentLoop(llmClient)
    const controlPlaneState: TurnControlPlaneState = createTurnControlPlaneState(['read_file'])
    controlPlaneState.controlState = new ControlState({ permission: 'DENY' })

    const steps: { tool: string; deniedReason?: string }[] = []
    const result = await agentLoop.runToolLoop(
      'session-1',
      [],
      'read notes.txt',
      'system prompt',
      undefined,
      (step) => steps.push({ tool: step.tool, deniedReason: step.deniedReason }),
      undefined,
      'LOW',
      controlPlaneState,
    )

    expect(steps).toEqual([
      { tool: 'read_file', deniedReason: undefined },
      { tool: 'read_file', deniedReason: 'harness control state denies action this turn' },
    ])
    expect(result).toEqual({ kind: 'final', content: 'done', sources: [] })
  })

  it('denies (REQUIRE_APPROVAL folded into deny — see D0 plan note) on a fail-safe UNKNOWN risk hint', async () => {
    const llmClient = new ProposingFakeLLMClient()
    const agentLoop = buildAgentLoop(llmClient)

    await agentLoop.runToolLoop('session-1', [], 'read notes.txt', 'system prompt', undefined, undefined, undefined, 'UNKNOWN')

    expect(llmClient.lastDecision?.decision).toBe('deny')
    expect(llmClient.lastDecision?.reason).toMatch(/fail-safe UNKNOWN/)
  })
})
