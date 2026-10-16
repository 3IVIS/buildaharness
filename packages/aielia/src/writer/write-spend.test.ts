import { describe, it, expect } from 'vitest'
import type { ChatMessage, ILLMClient } from '@buildaharness/runtime'
import { ArticleService, createArticleChatPort, createMemoryArticleStore } from './article-service.js'
import { processWriterMessage } from './writer-chat-turn.js'
import { CALL_TYPES, CHAT_CALL, callTypeLabel, classifyCall } from './write-spend.js'
import { createSpendMeter, withSpendCap } from './write-permissions.js'

const NOW = '2026-10-16T10:00:00.000Z'
const MD = '# Post\n\n## Latency\n\nThe p99 was 18 ms.\n\n## Conclusion\n\nSo p99 stays under 20 ms.\n'

/** Answers every step with something each of them can read, and records what kind of call it thought it was. */
function recording(seen: string[]): ILLMClient {
  const reply = { claims: [{ quote: 'The p99 was 19 ms.', kind: 'factual', matchesId: null, sure: true }], affected: [], impacts: [], links: [], suggestions: [], ideas: [], ops: [], articleId: null }
  return {
    callChatStructured: async (messages: ChatMessage[]) => {
      seen.push(classifyCall(messages).id)
      return { content: JSON.stringify(reply) }
    },
  } as unknown as ILLMClient
}

describe('call types', () => {
  it('recognises every model step of the article service, so none is counted as chat by mistake', async () => {
    const seen: string[] = []
    let page = 'p99 is 18 ms.'
    const store = createMemoryArticleStore()
    const svc = new ArticleService({ store, llm: recording(seen), now: () => NOW, fetchWeb: async () => page })
    const id = await svc.create('Post', MD)
    await svc.updateText(id, MD.replace('18 ms', '19 ms'), { analyze: true }) // claims, impact
    const b = await svc.get(id)
    const claimId = b.meta.claims[0].id
    const src = await svc.addSource(id, { kind: 'web', address: 'https://x.test/a' })
    await svc.readSource(id, src)
    await svc.attachSource(id, claimId, src)
    await svc.checkClaim(id, claimId) // support
    page = 'p99 is now 30 ms.'
    await svc.readSource(id, src) // source change
    await svc.proposeLinksForSource(id, src) // source links
    await svc.findDependencies(id) // links
    await svc.suggest(id, 'tighten it') // edits
    await svc.suggestIdeas(id) // ideas
    await processWriterMessage({ port: createArticleChatPort(store), message: 'Dana says check the figure', now: NOW }, recording(seen)) // capture
    expect(new Set(seen)).toEqual(new Set(CALL_TYPES.map((t) => t.id)))
  })
  it('counts an unrecognised system prompt as chat, and names every type', () => {
    expect(classifyCall([{ role: 'system', content: 'You are Aielia.' }, { role: 'user', content: 'hi' }])).toBe(CHAT_CALL)
    expect(classifyCall([{ role: 'user', content: 'hi' }])).toBe(CHAT_CALL)
    expect(callTypeLabel('support')).toBe('Checking claims against sources')
    expect(callTypeLabel('chat')).toBe('Chat')
  })
})

describe('spend by type', () => {
  it('keeps dollars and calls for each kind of call, and keeps them across a reload', async () => {
    const store = createMemoryArticleStore()
    const meter = await createSpendMeter(store, {})
    const usage = { inputTokens: 1_000_000, outputTokens: 0 } as never
    const inner = { callChatStructured: async (_m: ChatMessage[], _t: unknown, o?: { onUsage?: (u: unknown) => void }) => { o?.onUsage?.(usage); return { content: '{}' } } } as unknown as ILLMClient
    const llm = withSpendCap(inner, meter, () => undefined)
    const claimsPrompt = { role: 'system' as const, content: `${CALL_TYPES[0].marker} in them.` }
    await llm.callChatStructured([claimsPrompt])
    await llm.callChatStructured([claimsPrompt])
    await llm.callChatStructured([{ role: 'system', content: 'You are Aielia.' }])
    await Promise.resolve()
    const by = meter.byType()
    expect(by.claims.calls).toBe(2)
    expect(by.chat.calls).toBe(1)
    expect(by.claims.usd + by.chat.usd).toBeCloseTo(meter.spentUsd())
    const again = await createSpendMeter(store, {})
    expect(again.byType()).toEqual(by)
  })
})
