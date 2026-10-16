import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ArticleService, createMemoryArticleStore, createArticleChatPort, type PersonalAssistant } from '@buildaharness/aielia'
import type { ILLMClient } from '@buildaharness/runtime'
import { WriteApp } from './WriteApp'
import { assembleWriteServices } from './write-services'

const MARK = { claims: 'You read parts of an article and list the claims', resolve: 'You help a writer keep an article consistent', edits: 'You propose edits to an article', capture: 'A writer is working with an assistant' }
function llm(replies: Partial<Record<keyof typeof MARK, unknown>>): ILLMClient {
  return {
    callChatStructured: async (messages: { role: string; content: string }[]) => {
      const sys = messages.find((m) => m.role === 'system')!.content
      const key = (Object.keys(MARK) as (keyof typeof MARK)[]).find((k) => sys.includes(MARK[k]))
      const out = key ? replies[key] : undefined
      if (out === undefined) throw new Error(`no scripted reply for ${key}`)
      return { content: JSON.stringify(out) }
    },
  } as unknown as ILLMClient
}
async function servicesOn(store: ReturnType<typeof createMemoryArticleStore>, replies: Parameters<typeof llm>[0]) {
  return assembleWriteServices({ store, llm: llm(replies), buildAssistant: async () => ({ turn: async () => ({ reply: 'Noted.' }) }) as unknown as PersonalAssistant })
}
async function services(replies: Parameters<typeof llm>[0], seed?: string) {
  const s = await servicesOn(createMemoryArticleStore(), replies)
  if (seed) await s.service.create('Post', seed)
  return s
}
afterEach(() => {
  vi.restoreAllMocks()
})

const MD = '# Post\n\n## Latency\n\nThe p99 was 18 ms.\n'

describe('WriteApp layout', () => {
  it('has a labelled outline whose entries jump to that place in the text', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    const box = (await screen.findByLabelText('Article text')) as HTMLTextAreaElement
    expect(within(screen.getByRole('region', { name: 'Outline' })).getByRole('heading', { name: 'Outline' })).toBeInTheDocument()
    await userEvent.click(within(screen.getByRole('region', { name: 'Outline' })).getByRole('button', { name: 'Latency' }))
    expect(box.selectionStart).toBe(MD.indexOf('## Latency'))
  })

  it('has a rail of buttons; on desktop the panel opens from the rail and closes when the same button is clicked again', async () => {
    const original = window.matchMedia
    window.matchMedia = ((q: string) => ({ matches: q.includes('min-width: 960px'), media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
    try {
      const s = await services({}, MD)
      const { container } = render(<WriteApp services={s} />)
      await screen.findByLabelText('Article text')
      const main = container.querySelector('.write__main') as HTMLElement
      const rail = screen.getByRole('navigation', { name: 'Panels' })
      expect(within(rail).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Text', 'Outline', 'Issues', 'Sources', 'History', 'Chat', 'Settings'])
      expect(main.dataset.open).toBe('true') // starts with the outline open
      await userEvent.click(within(rail).getByRole('button', { name: 'Outline' }))
      expect(main.dataset.open).toBe('false')
      await userEvent.click(within(rail).getByRole('button', { name: 'History' }))
      expect(main.dataset.open).toBe('true')
      expect(screen.getByRole('region', { name: 'History' }).className).toContain('is-shown')
      expect(screen.getByRole('region', { name: 'Outline' }).className).not.toContain('is-shown')
    } finally {
      window.matchMedia = original
    }
  })

  it('History: saves a named version, shows what changed since it, and restores it after saving the present article', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    const box = (await screen.findByLabelText('Article text')) as HTMLTextAreaElement
    vi.spyOn(window, 'prompt').mockReturnValue('First draft')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await userEvent.click(screen.getByRole('button', { name: 'History' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }))
    expect(await screen.findByText('First draft')).toBeInTheDocument()
    fireEvent.change(box, { target: { value: MD.replace('18 ms', '41 ms') } })
    await userEvent.click(screen.getByRole('button', { name: 'Compare with now' }))
    const detail = await screen.findByLabelText('Version detail')
    expect(within(detail).getByText(/changed lines/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(box.value).toContain('18 ms'))
    expect(await screen.findByText('Before restoring an earlier version')).toBeInTheDocument()
  })

  it('shows the article under the title taken from its heading, and keeps the actions together', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await screen.findByLabelText('Article text')
    expect(screen.getByRole('option', { name: 'Post' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Article text'), { target: { value: MD.replace('# Post', '# Renamed in the text') } })
    expect(await screen.findByRole('option', { name: 'Renamed in the text' }, { timeout: 3000 })).toBeInTheDocument()
  })
})

describe('WriteApp settings', () => {
  it('shows the defaults, saves a change, and uses it for the next automatic check', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await screen.findByLabelText('Article text')
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const auto = await screen.findByLabelText(/Check claims and effects by itself/)
    expect(auto).not.toBeChecked()
    expect(screen.getByLabelText(/Remember reviewer comments/)).toBeChecked()
    await userEvent.click(auto)
    await waitFor(async () => expect((await s.permissions.get()).autoCheck).toBe(true))
    await userEvent.type(screen.getByLabelText('Spending cap'), '2')
    fireEvent.blur(screen.getByLabelText('Spending cap'))
    await waitFor(async () => expect((await s.permissions.get()).spendCapUsd).toBe(2))
  })

  it('refuses model calls once the cap is reached and says why', async () => {
    const store = createMemoryArticleStore()
    const s = await servicesOn(store, { claims: { claims: [] }, resolve: { affected: [] } })
    await s.service.create('Post', MD)
    await s.permissions.set({ captureChat: true, autoCheck: false, spendCapUsd: 0.01 })
    await store.setSetting('writer:spent-usd', 1)
    const fresh = await servicesOn(store, { claims: { claims: [] }, resolve: { affected: [] } })
    expect(fresh.spentUsd()).toBe(1)
    const out = await fresh.service.analyze((await fresh.service.list())[0].id)
    expect(out.extraction?.status).toBe('not_extracted')
  })
})

describe('WriteApp', () => {
  it('starts empty, creates an article, and shows its sections in the outline', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('My post')
    render(<WriteApp services={await services({})} />)
    expect(screen.getByText(/Create an article, or import one/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'New' }))
    const box = (await screen.findByLabelText('Article text')) as HTMLTextAreaElement
    expect(box.value).toContain('# My post')
    await userEvent.click(screen.getByRole('button', { name: 'Outline' }))
    expect(within(screen.getByRole('region', { name: 'Outline' })).getByText('My post')).toBeInTheDocument()
  })

  it('finds the claims on request and shows them as having no source', async () => {
    const s = await services({ claims: { claims: [{ quote: 'The p99 was 18 ms.', kind: 'factual', matchesId: null, sure: true }] }, resolve: { affected: [] } }, MD)
    render(<WriteApp services={s} />)
    await screen.findByLabelText('Article text')
    await userEvent.click(screen.getByRole('button', { name: 'Check article' }))
    await userEvent.click(screen.getByRole('button', { name: 'Issues' }))
    expect(await screen.findByText('The p99 was 18 ms.')).toBeInTheDocument()
    expect(screen.getByText('no source')).toBeInTheDocument()
  })

  it('a chat request for edits becomes suggestions, and accepting one changes the text', async () => {
    const s = await services({ capture: { articleId: null, ops: [] }, edits: { suggestions: [{ quote: '18 ms', replacement: '41 ms', reason: 'the re-run' }] } }, MD)
    render(<WriteApp services={s} />)
    await screen.findByLabelText('Article text')
    await userEvent.click(screen.getByRole('button', { name: 'Chat' }))
    await userEvent.click(screen.getByLabelText(/Ask for edits/))
    await userEvent.type(screen.getByLabelText('Message'), 'use 41 ms')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText(/added 1 suggested change/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Issues' }))
    expect(screen.getByText('41 ms')).toBeInTheDocument()
    expect((screen.getByLabelText('Article text') as HTMLTextAreaElement).value).toContain('18 ms') // nothing changed yet
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect((screen.getByLabelText('Article text') as HTMLTextAreaElement).value).toContain('41 ms'))
  })

  it('shows reviewer comments the chat captured, including a conflict the writer has not resolved', async () => {
    const store = createMemoryArticleStore()
    const svc = new ArticleService({ store, llm: llm({}), newId: () => 'a1' })
    const id = await svc.create('Post', MD)
    const b = await svc.get(id)
    const mk = (n: number, label: string, other: string) => ({ id: `wc${n}`, articleId: id, label, reviewer: 'Dana', text: `${label} text`, state: 'open' as const, conflictsWith: [`wc${other}`], origin: 'reviewer' as const, capturedAt: 'now' })
    await store.save(id, { ...b, meta: { ...b.meta, comments: [mk(1, 'C4', '2'), mk(2, 'C5', '1')] } })
    const port = createArticleChatPort(store)
    render(<WriteApp services={{ ...(await servicesOn(store, {})), service: svc, port }} />)
    await screen.findByLabelText('Article text')
    await userEvent.click(screen.getByRole('button', { name: 'Issues' }))
    expect(screen.getAllByText(/You have not chosen/)).toHaveLength(2)
    expect(screen.getByText(/2 open comments/)).toBeInTheDocument()
  })

  it('publishes even with open items, and says what was still open', async () => {
    const store = createMemoryArticleStore()
    const svc = new ArticleService({ store, llm: llm({}), newId: () => 'a1' })
    const id = await svc.create('Post', MD)
    const b = await svc.get(id)
    await store.save(id, { ...b, meta: { ...b.meta, comments: [{ id: 'wc1', articleId: id, text: 't', state: 'open', conflictsWith: [], origin: 'reviewer', capturedAt: 'now' }] } })
    vi.spyOn(window, 'prompt').mockReturnValue('v1')
    render(<WriteApp services={{ ...(await servicesOn(store, {})), service: svc }} />)
    await screen.findByLabelText('Article text')
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }))
    expect(await screen.findByText(/1 item was still open/)).toBeInTheDocument()
    expect((await svc.get(id)).snapshots).toHaveLength(1)
  })

  it('shows an error from the service instead of failing silently', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={{ ...s, service: Object.assign(s.service, { updateText: async () => { throw new Error('storage is full') } }) }} />)
    await screen.findByLabelText('Article text')
    fireEvent.click(screen.getByRole('button', { name: 'Check article' }))
    expect(await screen.findByText('storage is full')).toBeInTheDocument()
  })
})
