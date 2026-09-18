import { describe, it, expect } from 'vitest'
import { InMemoryAdapter, InMemoryReminderStore } from '@buildaharness/runtime'
import type { ILLMClient, FsBackend } from '@buildaharness/runtime'
import { AgentLoop } from './agent-loop.js'
import type { WebToolsContext } from './web-tools.js'
import type { FileToolsContext } from './file-tools.js'

const WS_ROOT = '/ws'

/** Minimal in-memory FsBackend over a flat path→content map. Any path that is a strict
 *  prefix of another is treated as a directory. */
function fsFrom(files: Record<string, string>): FsBackend {
  const map = new Map(Object.entries(files).map(([k, v]) => [`${WS_ROOT}/${k}`, v]))
  return {
    async readTextFile(path: string) {
      return map.get(path)
    },
    async readDir(dir: string) {
      const prefix = dir === WS_ROOT ? `${WS_ROOT}/` : `${dir}/`
      const names = new Set<string>()
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0])
      }
      return [...names]
    },
    async writeTextFile() {},
    async removeFile() {},
    async mkdir() {},
  } as unknown as FsBackend
}

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

function buildLoop(webTools?: WebToolsContext, fileTools?: FileToolsContext): AgentLoop {
  const memory = new InMemoryAdapter()
  const reminderStore = new InMemoryReminderStore(memory)
  return new AgentLoop(memory, new SilentLLM(), () => undefined, fileTools, webTools, undefined, undefined, reminderStore, 5, undefined, undefined)
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

  it('walks the workspace when read_file is allowed and fileTools is configured (S8 lever 1)', async () => {
    const fileTools: FileToolsContext = { backend: fsFrom({
      'config.base.env': 'LOG_LEVEL=info\n',
      'config.local.env': 'LOG_LEVEL=debug\n',
    }), workspaceRoot: WS_ROOT }
    const loop = buildLoop(undefined, fileTools)
    const out = await loop.runSupervisorInvestigation({
      question: 'what is the effective LOG_LEVEL?',
      suggested_tools: ['read_file', 'list_directory'],
      budget: 10,
    })
    const joined = out.map(f => f.content).join('\n')
    expect(joined).toContain('config.local.env')
    expect(joined).toContain('LOG_LEVEL=debug')
    expect(out.every(f => f.tool === 'read_file' && f.reliability === 'MEDIUM')).toBe(true)
  })

  it('descends into subdirectories, bounded by the call budget', async () => {
    const fileTools: FileToolsContext = { backend: fsFrom({
      'a.txt': 'alpha',
      'sub/b.txt': 'bravo',
      'sub/deep/c.txt': 'charlie',
    }), workspaceRoot: WS_ROOT }
    const loop = buildLoop(undefined, fileTools)
    const out = await loop.runSupervisorInvestigation({
      question: 'find the value',
      suggested_tools: ['read_file', 'list_directory'],
      budget: 20,
    })
    const joined = out.map(f => f.content).join('\n')
    expect(joined).toContain('bravo')
    expect(joined).toContain('charlie')
  })

  it('walk is inert without fileTools even when read_file is suggested', async () => {
    const loop = buildLoop(undefined, undefined)
    expect(await loop.runSupervisorInvestigation({ question: 'q', suggested_tools: ['read_file'], budget: 5 })).toEqual([])
  })

  it('caps calls at min(budget, runnable tools) — its own Budget (INV-25)', async () => {
    let searched = 0
    const loop = buildLoop({ search: async () => { searched++; return [{ title: 't', url: 'https://x', snippet: 's' }] } })
    // budget 0 → no calls even though web_search is runnable
    await loop.runSupervisorInvestigation({ question: 'q', suggested_tools: ['web_search'], budget: 0 })
    expect(searched).toBe(0)
  })
})
