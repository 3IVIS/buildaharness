import { describe, it, expect } from 'vitest'
import type { ILLMClient } from '@buildaharness/runtime'
import { createMemoryArticleStore } from './article-service.js'
import { DEFAULT_WRITE_PERMISSIONS, SpendCapReachedError, createSpendMeter, loadPermissions, savePermissions, withSpendCap } from './write-permissions.js'

function client(costUsd: number): ILLMClient {
  return {
    callChatStructured: async (_m: unknown, _t: unknown, o?: { onUsage?: (u: unknown) => void }) => {
      o?.onUsage?.({ inputTokens: 10, outputTokens: 10, costUsd })
      return { content: '{}' }
    },
    callChatSync: async () => 'x',
    callChat: async function* () { yield 'x' },
  } as unknown as ILLMClient
}

describe('permissions', () => {
  it('defaults to capturing chat, no automatic checks, no cap; a damaged value falls back to the defaults', async () => {
    const store = createMemoryArticleStore()
    expect(await loadPermissions(store)).toEqual(DEFAULT_WRITE_PERMISSIONS)
    await store.setSetting('writer:permissions', { captureChat: 'yes' })
    expect(await loadPermissions(store)).toEqual(DEFAULT_WRITE_PERMISSIONS)
    await savePermissions(store, { captureChat: false, autoCheck: true, recheckBeforePublish: false, spendCapUsd: 2 })
    expect(await loadPermissions(store)).toEqual({ captureChat: false, autoCheck: true, recheckBeforePublish: false, spendCapUsd: 2 })
    await expect(savePermissions(store, { captureChat: true, autoCheck: false, recheckBeforePublish: true, spendCapUsd: -1 })).rejects.toThrow()
  })
  it('settings saved before the recheck option existed keep their values and get its default (on)', async () => {
    const store = createMemoryArticleStore()
    await store.setSetting('writer:permissions', { captureChat: false, autoCheck: true, spendCapUsd: 3 })
    expect(await loadPermissions(store)).toEqual({ captureChat: false, autoCheck: true, recheckBeforePublish: true, spendCapUsd: 3 })
  })
})

describe('spend cap', () => {
  it('counts every call, keeps the total across a reload, and stops calls once the cap is reached', async () => {
    const store = createMemoryArticleStore()
    const meter = await createSpendMeter(store, {})
    const llm = withSpendCap(client(0.6), meter, () => 1)
    await llm.callChatStructured([])
    await llm.callChatStructured([])
    await Promise.resolve()
    expect(meter.spentUsd()).toBeCloseTo(1.2)
    await expect(llm.callChatStructured([])).rejects.toBeInstanceOf(SpendCapReachedError)
    await expect(llm.callChatSync([])).rejects.toThrow('Raise it in Settings')
    const again = await createSpendMeter(store, {})
    expect(again.spentUsd()).toBeCloseTo(1.2)
  })

  it('does not stop anything without a cap, and a raised cap lets calls through again', async () => {
    const meter = await createSpendMeter(createMemoryArticleStore(), {})
    let cap: number | undefined
    const llm = withSpendCap(client(5), meter, () => cap)
    await llm.callChatStructured([])
    await llm.callChatStructured([])
    cap = 3
    await expect(llm.callChatStructured([])).rejects.toBeInstanceOf(SpendCapReachedError)
    cap = 100
    await expect(llm.callChatStructured([])).resolves.toBeTruthy()
  })

  it('keeps saying that a client cannot take tool definitions, so the repository search talks to it in text', async () => {
    const meter = await createSpendMeter(createMemoryArticleStore(), { backend: 'claude-cli', model: 'claude-sonnet-5-5' })
    const cli = { ...client(0), nativeToolCalls: false } as unknown as ILLMClient
    expect(withSpendCap(cli, meter, () => undefined).nativeToolCalls).toBe(false)
    expect(withSpendCap(client(0), meter, () => undefined).nativeToolCalls).toBeUndefined()
  })
})
