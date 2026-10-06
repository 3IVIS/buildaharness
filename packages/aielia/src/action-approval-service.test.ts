import { describe, it, expect } from 'vitest'
import { InMemoryAdapter, type FsBackend, type ILLMClient } from '@buildaharness/runtime'
import { ActionApprovalService } from './action-approval-service.js'
import { stagePendingAction } from './file-tools.js'
import { toolLoopPendingKey } from './agent-loop.js'
import type { AssistantSession } from './assistant-session.js'
import type { AgentLoop } from './agent-loop.js'

const ROOT = '/workspace'

function fakeBackend(): FsBackend {
  const files = new Map<string, string>()
  return {
    async readTextFile(p) {
      return files.get(p)
    },
    async writeTextFile(p, c) {
      files.set(p, c)
    },
    async removeFile(p) {
      files.delete(p)
    },
    async mkdir() {},
    async readDir() {
      return []
    },
  }
}

function makeService(sendEmail: () => Promise<{ messageId?: string }>, backend: FsBackend, memory: InMemoryAdapter): ActionApprovalService {
  const session = { appendTranscriptMessage: async () => {} } as unknown as AssistantSession
  return new ActionApprovalService(
    memory,
    {} as ILLMClient,
    () => undefined,
    undefined,
    undefined,
    { backend, workspaceRoot: ROOT, sendEmail } as never,
    session,
    {} as AgentLoop,
    undefined,
    undefined,
  )
}

describe('ActionApprovalService.resolvePendingAction', () => {
  it('applies a staged email once when the same approval arrives twice concurrently', async () => {
    const backend = fakeBackend()
    const memory = new InMemoryAdapter({ scope: 'thread', namespace: 'approval-double' })
    let sent = 0
    const service = makeService(async () => {
      sent++
      await new Promise((r) => setTimeout(r, 20))
      return {}
    }, backend, memory)
    const { id } = await stagePendingAction(backend, ROOT, { kind: 'email', to: 'a@b.c', subject: 's', body: 'b' })
    const results = await Promise.allSettled([
      service.resolvePendingAction('s1', 'tk', id, true, ''),
      service.resolvePendingAction('s1', 'tk', id, true, ''),
    ])
    expect(sent).toBe(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
  })

  it('keeps the paused tool loop when applying the approved action fails, so a retry can resume it', async () => {
    const backend = fakeBackend()
    const memory = new InMemoryAdapter({ scope: 'thread', namespace: 'approval-loop-keep' })
    const service = makeService(async () => {
      throw new Error('smtp down')
    }, backend, memory)
    const { id } = await stagePendingAction(backend, ROOT, { kind: 'email', to: 'a@b.c', subject: 's', body: 'b' })
    await memory.set(toolLoopPendingKey(id), { messages: [], actions: [] })
    await expect(service.resolvePendingAction('s1', 'tk', id, true, '')).rejects.toThrow('smtp down')
    expect(await memory.get(toolLoopPendingKey(id))).toBeDefined()
  })
})
