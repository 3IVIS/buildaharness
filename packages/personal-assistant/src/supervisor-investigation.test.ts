import { describe, it, expect } from 'vitest'
import { InMemoryAdapter, InMemoryReminderStore } from '@buildaharness/runtime'
import type { ILLMClient } from '@buildaharness/runtime'
import { AgentLoop } from './agent-loop.js'
import type { WebToolsContext } from './web-tools.js'

/**
 * S5 of plans/harness_trajectory_supervisor_plan.html — the personal-assistant host
 * implementation of HarnessRunOptions.runInvestigation
 * (AgentLoop.runSupervisorInvestigation). Read-only only, own Budget, tool-policy gated,
 * no staging path.
 */

class SilentLLM implements ILLMClient {
  async *callChat(): AsyncIterable<string> {
    yield ''
  }
  async callChatSync(): Promise<string> {
    return ''
  }
  async callChatStructured(): Promise<{ content: string }> {
    return { content: '{}' }
  }
}

function buildLoop(webTools?: WebToolsContext): AgentLoop {
  const memory = new InMemoryAdapter()
  const reminderStore = new InMemoryReminderStore(memory)
  return new AgentLoop(memory, new SilentLLM(), () => undefined, undefined, webTools, undefined, undefined, reminderStore, 5, undefined, undefined)
}

describe('AgentLoop.runSupervisorInvestigation (S5)', () => {
  it('returns [] for an empty question', async () => {
    const loop = buildLoop()
    expect(await loop.runSupervisorInvestigation({ question: '  ', suggested_tools: ['web_search'], budget: 3 })).toEqual([])
  })

  it('never runs write / shell / email tools — none are in the runnable set (INV-23)', async () => {
    let searched = 0
    const loop = buildLoop({ search: async () => { searched++; return [] } })
    const out = await loop.runSupervisorInvestigation({
      question: 'which port?',
      suggested_tools: ['write_file', 'run_shell_command', 'send_email', 'read_file'],
      budget: 9,
    })
    expect(out).toEqual([])
    expect(searched).toBe(0)
  })

  it('returns [] when no allowlisted tool is runnable from a bare question (no webTools configured)', async () => {
    const loop = buildLoop(undefined)
    expect(await loop.runSupervisorInvestigation({ question: 'q', suggested_tools: ['web_search'], budget: 3 })).toEqual([])
  })

  it('honours a tool-policy DENY inside the sub-loop — no call, no finding, no throw', async () => {
    let searched = 0
    const loop = buildLoop({ search: async () => { searched++; return [{ title: 't', url: 'https://x', snippet: 's' }] } })
    const out = await loop.runSupervisorInvestigation(
      { question: 'which port?', suggested_tools: ['web_search'], budget: 3 },
      { riskHint: 'LOW', controlState: { permission: 'DENY', execution_mode: 'CAUTIOUS', escalation: 'NONE' } },
    )
    expect(out).toEqual([])
    expect(searched).toBe(0)
  })

  it('runs web_search when policy allows and returns a MEDIUM-reliability finding', async () => {
    const loop = buildLoop({
      search: async (query: string) => [{ title: `re: ${query}`, url: 'https://adapter.docs', snippet: 'binds :8000' }],
    })
    const out = await loop.runSupervisorInvestigation({ question: 'which port does the adapter bind?', suggested_tools: ['web_search'], budget: 3 })
    expect(out).toHaveLength(1)
    expect(out[0].tool).toBe('web_search')
    expect(out[0].reliability).toBe('MEDIUM')
    expect(out[0].content).toContain('8000')
  })

  it('caps calls at min(budget, runnable tools) — its own Budget (INV-25)', async () => {
    let searched = 0
    const loop = buildLoop({ search: async () => { searched++; return [{ title: 't', url: 'https://x', snippet: 's' }] } })
    // budget 0 → no calls even though web_search is runnable
    await loop.runSupervisorInvestigation({ question: 'q', suggested_tools: ['web_search'], budget: 0 })
    expect(searched).toBe(0)
  })
})
