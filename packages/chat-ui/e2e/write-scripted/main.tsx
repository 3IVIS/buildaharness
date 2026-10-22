/**
 * The real Write page (WriteApp) with scripted model calls and a scripted streaming assistant, for the browser specs in e2e/. Nothing here reaches a
 * model or the network: each structured call waits DELAY ms and returns the reply for its prompt, so the page's progress, Stop, lit passage and layout
 * can be exercised in a real browser with no key. Served by vite.write-scripted.config.ts.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryArticleStore, type PersonalAssistant } from '@buildaharness/aielia'
import type { ILLMClient } from '@buildaharness/runtime'
import { WriteApp } from '/src/write/WriteApp'
import { assembleWriteServices } from '/src/write/write-services'

const MD = '# Latency report\n\n## Latency\n\nThe p99 was 18 ms. It is quick.\n\n## Conclusion\n\nSo p99 stays under 20 ms. The cache holds 100 items.\n'
/** How long each scripted model call takes; the page takes `?delay=<ms>` so a spec can run fast. */
const DELAY = Number(new URLSearchParams(location.search).get('delay') ?? 1200)
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const MARK: Record<string, string> = {
  claims: 'You read parts of an article and list the claims',
  resolve: 'You help a writer keep an article consistent',
  edits: 'You propose edits to an article',
  draft: 'You write the first draft of an article',
  capture: 'A writer is working with an assistant',
  support: 'You check whether a claim from an article',
  links: 'You map how the sections',
  style: 'You read an article and describe it so a co-writer',
  sourceLinks: 'A writer added a source to an article',
}
const replies: Record<string, unknown> = {
  claims: { claims: ['The p99 was 18 ms.', 'So p99 stays under 20 ms.', 'The cache holds 100 items.'].map((quote) => ({ quote, kind: 'factual', matchesId: null, sure: true })) },
  resolve: { affected: [] },
  edits: { suggestions: [{ quote: 'It is quick.', replacement: 'It is very quick, and it keeps getting quicker.', reason: 'stronger' }] },
  draft: { name: 'Quick post', markdown: '# Quick post\n\n## Intro\n\nIt is quick.\n' },
  capture: { articleId: null, ops: [] },
  support: { verdict: 'supported', reason: 'by the pages' },
  links: { links: [] },
  style: {},
  sourceLinks: { claims: [] },
}
const llm = {
  callChatStructured: async (messages: { role: string; content: string }[], _t?: unknown, options?: { onUsage?: (u: { inputTokens: number; outputTokens: number; costUsd: number }) => void }) => {
    await wait(DELAY)
    options?.onUsage?.({ inputTokens: 900, outputTokens: 140, costUsd: 0.004 })
    const sys = messages.find((m) => m.role === 'system')!.content
    const key = Object.keys(MARK).find((k) => sys.includes(MARK[k]))
    return { content: JSON.stringify(key ? replies[key] ?? {} : {}) }
  },
} as unknown as ILLMClient

const ANSWER = 'The p99 of 18 ms is a good number for a service like this, but a single percentile hides the tail. I would add the p999 and say how many requests the figure is based on, so a reader can judge how much weight it carries.'
const assistant = {
  turn: async (_m: string, o: { signal?: AbortSignal; onToken?: (t: string) => void } = {}) => {
    await wait(1500)
    for (const word of ANSWER.split(' ')) {
      if (o.signal?.aborted) return { status: 'cancelled', reply: null, reason: 'Stopped by user' }
      o.onToken?.(`${word} `)
      await wait(90)
    }
    return { status: 'ok', reply: ANSWER }
  },
  setModel: () => undefined,
} as unknown as PersonalAssistant

async function boot(): Promise<void> {
  const store = createMemoryArticleStore()
  const services = await assembleWriteServices({
    store, llm, buildAssistant: async () => assistant,
    searchWeb: async () => { await wait(DELAY); return [] },
    fetchWeb: async () => 'page',
  })
  const id = await services.service.create('Latency report', MD)
  await services.service.analyze(id)
  createRoot(document.getElementById('root')!).render(<StrictMode><WriteApp services={services} /></StrictMode>)
}
void boot()
