import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ArticleService, createMemoryArticleStore, type PersonalAssistant } from '@buildaharness/aielia'
import type { ILLMClient } from '@buildaharness/runtime'
import { WriteApp } from './WriteApp'
import { answerDialog, declineDialog } from './dialog-test-utils'
import { assembleWriteServices } from './write-services'

const MARK = {
  claims: 'You read parts of an article and list the claims',
  resolve: 'You help a writer keep an article consistent',
  edits: 'You propose edits to an article',
  outline: 'You rework the outline of an article',
  draft: 'You write the first draft of an article',
  capture: 'A writer is working with an assistant',
  intent: 'You read a writer\'s newest message to their writing assistant',
  ideas: 'You help a writer collect ideas',
  sourceLinks: 'A writer added a source to an article',
  support: 'You check whether a claim from an article',
  links: 'You map how the sections',
  style: 'You read an article and describe it so a co-writer',
}
function llm(replies: Partial<Record<keyof typeof MARK, unknown>>): ILLMClient {
  const structured = async (messages: { role: string; content: string }[], _tools?: unknown, options?: { onUsage?: (u: { inputTokens: number; outputTokens: number; costUsd: number }) => void }): Promise<{ content: string }> => {
    options?.onUsage?.({ inputTokens: 100, outputTokens: 20, costUsd: 0.01 })
    const sys = messages.find((m) => m.role === 'system')!.content
    const key = (Object.keys(MARK) as (keyof typeof MARK)[]).find((k) => sys.includes(MARK[k]))
    const out = key ? replies[key] : undefined
    if (out === undefined) throw new Error(`no scripted reply for ${key}`)
    return { content: JSON.stringify(out) }
  }
  return {
    // A streamed call (the first draft) gets the same scripted reply, a few characters at a time.
    callChat: async function* (messages: { role: string; content: string }[], options?: { onUsage?: (u: { inputTokens: number; outputTokens: number; costUsd: number }) => void }) {
      const { content } = await structured(messages, undefined, options)
      for (let i = 0; i < content.length; i += 9) yield content.slice(i, i + 9)
    },
    callChatStructured: async (messages: { role: string; content: string }[], _tools?: unknown, options?: { onUsage?: (u: { inputTokens: number; outputTokens: number; costUsd: number }) => void }) => {
      options?.onUsage?.({ inputTokens: 100, outputTokens: 20, costUsd: 0.01 })
      const sys = messages.find((m) => m.role === 'system')!.content
      const key = (Object.keys(MARK) as (keyof typeof MARK)[]).find((k) => sys.includes(MARK[k]))
      const out = key ? replies[key] : undefined
      if (out === undefined) throw new Error(`no scripted reply for ${key}`)
      return { content: JSON.stringify(out) }
    },
  } as unknown as ILLMClient
}
async function servicesOn(store: ReturnType<typeof createMemoryArticleStore>, replies: Parameters<typeof llm>[0], fetchWeb?: (url: string) => Promise<string>, searchWeb?: (q: string) => Promise<{ title: string; url: string; snippet: string }[]>) {
  return assembleWriteServices({ store, llm: llm(replies), fetchWeb, searchWeb, buildAssistant: async () => ({ turn: async () => ({ reply: 'Noted.' }), setModel: () => undefined }) as unknown as PersonalAssistant })
}
async function services(replies: Parameters<typeof llm>[0], seed?: string, fetchWeb?: (url: string) => Promise<string>, searchWeb?: (q: string) => Promise<{ title: string; url: string; snippet: string }[]>) {
  const s = await servicesOn(createMemoryArticleStore(), replies, fetchWeb, searchWeb)
  if (seed) await s.service.create('Post', seed)
  return s
}
afterEach(() => {
  vi.restoreAllMocks()
  localStorage.removeItem('aielia-write:chat-mode')
})

describe('the chat mode: Auto reads the message', () => {
  const chatBox = () => screen.getByLabelText('Message')
  it('starts on Auto, and a message the model reads as a request for changes gets suggestions without the writer picking anything', async () => {
    const s = await services({ intent: { intent: 'suggest' }, capture: { articleId: null, ops: [] }, edits: { suggestions: [{ quote: 'It is quick.', replacement: 'It is, well, quick.', reason: 'warmer' }] } }, MD2)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    expect(screen.getByLabelText('When I ask for a change')).toHaveValue('auto')
    await userEvent.type(chatBox(), 'make the second line warmer{Enter}')
    expect(await screen.findByText(/Added 1 suggestion/)).toBeInTheDocument()
  })
  it('answers in the chat when the model reads the message as a question, and leaves the mode on Auto', async () => {
    const s = await services({ intent: { intent: 'answer' }, capture: { articleId: null, ops: [] } }, MD2)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.type(chatBox(), 'is this clear?{Enter}')
    expect(await screen.findByText('Noted.')).toBeInTheDocument()
    expect(screen.queryByText(/suggested change/)).toBeNull()
    expect(screen.getByLabelText('When I ask for a change')).toHaveValue('auto')
  })
  it('rewrites the whole article when the model reads the message as a wish to reshape all of it', async () => {
    const s = await services({ intent: { intent: 'rewrite' }, capture: { articleId: null, ops: [] }, draft: { name: 'Story', markdown: '# Post\n## Once upon a time\nIt was quick.' } }, MD2)
    render(<WriteApp services={s} />)
    const box = await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.type(chatBox(), 'make the whole thing read like a story{Enter}')
    expect(await screen.findByText(/Rewrote the article/)).toBeInTheDocument()
    await waitFor(() => expect(box.value).toContain('Once upon a time'))
  })
  it('reads a page the message points to before rewriting, and says so when it cannot', async () => {
    const reply = { intent: 'rewrite', links: ['https://example.test/story'] }
    const fetched: string[] = []
    const ok = await services({ intent: reply, capture: { articleId: null, ops: [] }, draft: { name: 'Story', markdown: '# Post\n## Once\nIt was quick.' } }, MD2, async (u) => { fetched.push(u); return 'A story-shaped post.' })
    const first = render(<WriteApp services={ok} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.type(chatBox(), 'make it like https://example.test/story{Enter}')
    expect(await screen.findByText(/Rewrote the article/)).toBeInTheDocument()
    expect(fetched).toEqual(['https://example.test/story'])
    expect(screen.queryByText(/I could not read/)).toBeNull()
    first.unmount()
    const bad = await services({ intent: reply, capture: { articleId: null, ops: [] }, draft: { name: 'Story', markdown: '# Post\n## Once\nIt was quick.' } }, MD2, async () => { throw new Error('blocked') })
    render(<WriteApp services={bad} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.type(chatBox(), 'make it like https://example.test/story{Enter}')
    expect(await screen.findByText(/I could not read https:\/\/example\.test\/story \(blocked\), so the change does not follow it/)).toBeInTheDocument()
  })
  it('keeps a mode the writer picked, also after the page is opened again', async () => {
    const s = await services({ capture: { articleId: null, ops: [] } }, MD2)
    const first = render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.selectOptions(screen.getByLabelText('When I ask for a change'), 'answer')
    first.unmount()
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    expect(screen.getByLabelText('When I ask for a change')).toHaveValue('answer')
  })
})

describe('the chat turn: words as they come, and stopping', () => {
  it('hands the turn the signal and a token callback, and says stopped when the turn was cancelled', async () => {
    const seen: { signal?: AbortSignal; tokens: string[] } = { tokens: [] }
    let cancel = false
    const s = await assembleWriteServices({
      store: createMemoryArticleStore(),
      llm: llm({}),
      buildAssistant: async () => ({
        turn: async (_m: string, o: { signal?: AbortSignal; onToken?: (t: string) => void }) => {
          seen.signal = o.signal
          o.onToken?.('Hel'); o.onToken?.('lo')
          return cancel ? { status: 'cancelled', reply: null, reason: 'Stopped by user' } : { status: 'ok', reply: 'Hello' }
        },
        setModel: () => undefined,
      }) as unknown as PersonalAssistant,
    })
    const ctl = new AbortController()
    const ok = await s.chat('hi', undefined, { signal: ctl.signal, onToken: (t) => seen.tokens.push(t) })
    expect(ok).toMatchObject({ reply: 'Hello' })
    expect(ok.stopped).toBeUndefined()
    expect(seen.signal).toBe(ctl.signal)
    expect(seen.tokens.join('')).toBe('Hello')
    cancel = true
    expect(await s.chat('hi', undefined, { signal: ctl.signal })).toMatchObject({ reply: 'Stopped.', stopped: true })
  })
  it('tells a logged-out Claude session to sign in, not to check a key', async () => {
    const s = await assembleWriteServices({
      backend: 'claude-cli',
      store: createMemoryArticleStore(),
      llm: llm({}),
      buildAssistant: async () => ({ turn: async () => ({ status: 'escalated', reply: null, reason: 'Not logged in · Please run /login' }), setModel: () => undefined }) as unknown as PersonalAssistant,
    })
    const r = await s.chat('hi', undefined)
    expect(r.reply).toContain('Not logged in · Please run /login')
    expect(r.reply).toContain('Sign in to Claude')
    expect(r.reply).not.toContain('Check your key')
  })
})

const MD = '# Post\n\n## Latency\n\nThe p99 was 18 ms.\n'
const MD2 = '# Post\n\n## Latency\n\nThe p99 was 18 ms. It is quick.\n\n## Conclusion\n\nSo p99 stays under 20 ms.\n'
const openMenu = (): Promise<void> => userEvent.click(screen.getByRole('button', { name: 'Article' }))
const rail = (name: string): HTMLElement => within(screen.getByRole('navigation', { name: 'Panels' })).getByRole('button', { name })
const panel = (name: string): HTMLElement => (name === 'Links' ? screen.getByRole('tabpanel', { name }) : screen.getByRole('region', { name }))
const dockTab = (name: RegExp | string): Promise<void> => userEvent.click(screen.getByRole('tab', { name }))
/** Opens one kind of issue under its button at the top of the Issues pane. */
const expand = (title: string): Promise<void> => userEvent.click(within(panel('Issues')).getByRole('button', { name: new RegExp(`^${title}`) }))
const waitForText = async (): Promise<HTMLTextAreaElement> => (await screen.findByLabelText('Article text')) as HTMLTextAreaElement
const putCursor = (needle: string): void => {
  const box = screen.getByLabelText('Article text') as HTMLTextAreaElement
  const at = box.value.indexOf(needle)
  box.setSelectionRange(at, at)
  fireEvent.select(box)
}
const wide = <T,>(fn: () => Promise<T>, minWidth = 960): Promise<T> => {
  const original = window.matchMedia
  // a screen at least `minWidth` wide: 960 is a desktop, 640 a tablet
  window.matchMedia = ((q: string) => ({ matches: Number(/min-width: (\d+)px/.exec(q)?.[1] ?? Infinity) <= minWidth, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  return fn().finally(() => { window.matchMedia = original })
}

describe('header and article menu', () => {
  it('has no Publish button for now, shows the alpha pill and the website menu', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Open site menu' }))
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', 'https://myaielia.com/privacy.html')
  })
  it('has only Publish in the header; New, Rename, Export and Import are in the article menu', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} showPublish />)
    await waitForText()
    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument()
    for (const gone of ['New', 'Export', 'Import', 'Check article']) expect(screen.queryByRole('button', { name: gone })).toBeNull()
    await openMenu()
    const menu = screen.getByRole('listbox', { name: 'Articles' })
    for (const item of [/New article/, /Rename this article/, /Export this article/, /Open or import a file/]) expect(within(menu).getByRole('button', { name: item })).toBeInTheDocument()
  })

  it('starts empty, creates an article from the menu, and shows its sections in the outline', async () => {
    render(<WriteApp services={await services({})} />)
    expect(screen.getByText(/Create an article, or import one/)).toBeInTheDocument()
    await openMenu()
    await userEvent.click(screen.getByRole('button', { name: /New article/ }))
    await answerDialog('My post')
    const box = await waitForText()
    expect(box.value).toContain('# My post')
    await userEvent.click(screen.getByRole('button', { name: 'Outline view' }))
    expect((screen.getByRole('textbox', { name: 'Outline' }) as HTMLTextAreaElement).value).toContain('My post')
  })

  it('shows a short name, cut off when long, separate from the title in the text, and lets the writer rename it', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    const head = screen.getByRole('button', { name: 'Article' })
    expect(head).toHaveTextContent('Post')
    expect(head).toHaveAttribute('title', 'Post')
    fireEvent.change(screen.getByLabelText('Article text'), { target: { value: MD.replace('# Post', '# A much longer heading that is the title of the text') } })
    await new Promise((r) => setTimeout(r, 1000))
    expect(screen.getByRole('button', { name: 'Article' })).toHaveTextContent('Post')
    await openMenu()
    await userEvent.click(screen.getByRole('button', { name: /Rename this article/ }))
    await answerDialog('Q3 write-up')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Article' })).toHaveTextContent('Q3 write-up'))
  })

  it('exports through the host\'s own save action when it has one, instead of a download link', async () => {
    const saved: { name: string; text: string }[] = []
    const base = await services({}, MD)
    render(<WriteApp services={{ ...base, saveFile: async (name, text) => { saved.push({ name, text }) } }} />)
    await waitForText()
    await openMenu()
    await userEvent.click(screen.getByRole('button', { name: /Export this article/ }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].name).toMatch(/\.aielia-article\.json$/)
    expect(JSON.parse(saved[0].text)).toBeTypeOf('object')
  })

  it('switches between articles from the menu', async () => {
    const s = await services({}, MD)
    await s.service.create('Second article', '# Second\n\ntext\n')
    render(<WriteApp services={s} />)
    await waitForText()
    await openMenu()
    await userEvent.click(within(screen.getByRole('listbox', { name: 'Articles' })).getByRole('button', { name: 'Second article' }))
    await waitFor(() => expect((screen.getByLabelText('Article text') as HTMLTextAreaElement).value).toContain('# Second'))
  })

  it('publishes even with open items, and says what was still open', async () => {
    const store = createMemoryArticleStore()
    const svc = new ArticleService({ store, llm: llm({}), newId: () => 'a1' })
    const id = await svc.create('Post', MD)
    const b = await svc.get(id)
    await store.save(id, { ...b, meta: { ...b.meta, comments: [{ id: 'wc1', articleId: id, text: 't', state: 'open', conflictsWith: [], origin: 'reviewer', capturedAt: 'now' }] } })
    render(<WriteApp services={await servicesOn(store, {})} showPublish />)
    await waitForText()
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }))
    await answerDialog('v1')
    expect((await screen.findAllByText(/1 item was still open/)).length).toBeGreaterThan(0)
    expect((await svc.get(id)).snapshots).toHaveLength(1)
  })

  it('rereads web sources before publishing and says which changed, unless the setting is off; publishing goes ahead either way', async () => {
    let page = 'p99 is 18 ms.'
    const store = createMemoryArticleStore()
    const s = await servicesOn(store, { resolve: { impacts: [] } }, async () => page)
    const id = await s.service.create('Post', MD)
    const src = await s.service.addSource(id, { kind: 'web', address: 'https://example.com/bench' })
    await s.service.readSource(id, src)
    page = 'p99 is now 30 ms.'
    render(<WriteApp services={s} showPublish />)
    await waitForText()
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }))
    await answerDialog('v1')
    expect((await screen.findAllByText(/1 web source has changed since you read it/)).length).toBeGreaterThan(0)
    expect((await s.service.get(id)).snapshots).toHaveLength(1)
    await userEvent.click(rail('Settings'))
    await userEvent.click(screen.getByLabelText(/Reread web sources before publishing/))
    await waitFor(async () => expect((await s.permissions.get()).recheckBeforePublish).toBe(false))
  })

  it('shows an error from the service instead of failing silently', async () => {
    const s = await services({}, MD)
    render(<WriteApp showPublish services={{ ...s, service: Object.assign(s.service, { updateText: async () => { throw new Error('storage is full') } }) }} />)
    await waitForText()
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }))
    await answerDialog('v1')
    expect((await screen.findAllByText(/Publishing did not finish: storage is full/)).length).toBeGreaterThan(0)
  })
})

describe('only actions that call the model are told in the chat; the rest report in the banner', () => {
  const chatText = (): string => (document.querySelector('.write__chat') as HTMLElement).textContent ?? ''
  it('keeps an action that made no model call out of the chat and says it is done in the banner', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('History'))
    await userEvent.click(await within(panel('History')).findByRole('button', { name: /Save version/i }))
    await answerDialog('mine')
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Saving the version: done\. The article is updated\./))
    expect(chatText()).not.toMatch(/Saving the version/)
  })
  it('clears the banner by itself after ten seconds', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('History'))
    await userEvent.click(await within(panel('History')).findByRole('button', { name: /Save version/i }))
    await answerDialog('mine')
    await waitFor(() => expect(document.querySelector('.write__notice')?.textContent).toMatch(/Saving the version: done/))
    await waitFor(() => expect(document.querySelector('.write__notice')).toBeNull(), { timeout: 11_500 })
  }, 15_000)
  it('tells a failure of such an action in the banner, with the action that failed and the reason', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={{ ...s, service: Object.assign(s.service, { rename: async () => { throw new Error('disk gone') } }) }} />)
    await waitForText()
    await userEvent.click(screen.getByRole('button', { name: 'Article' }))
    await userEvent.click(screen.getByRole('button', { name: /Rename this article/ }))
    await answerDialog('New name')
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Renaming did not finish: disk gone/))
    expect(chatText()).not.toMatch(/Renaming/)
  })
})

describe('spending is shown in the header, and each request says what it used', () => {
  it('counts every model call in the header as it happens, and puts tokens, time and cost under the last message of the turn', async () => {
    const claims = { claims: [{ quote: 'The p99 was 18 ms.', kind: 'factual', matchesId: null, sure: true }] }
    const s = await services({ claims, resolve: { affected: [] } }, MD, async () => 'x', async () => [])
    const id = (await s.service.list())[0].id
    await s.service.analyze(id)
    const before = s.spentUsd()
    render(<WriteApp services={s} />)
    await waitForText()
    expect(screen.getByLabelText(/Spent so far in this browser/)).toBeInTheDocument()
    expect(screen.queryByText(/Spent so far in this browser: \$/, { selector: 'p' })).toBeNull() // no longer in Settings
    await userEvent.selectOptions(screen.getByLabelText('Adjust', { selector: 'select' }), 'action:check')
    const chat = (): HTMLElement => document.querySelector('.write__chat') as HTMLElement
    expect(await within(chat()).findByText(/I found 1 factual claim/)).toBeInTheDocument()
    const usage = await within(chat()).findByTitle('Tokens, time and cost of this request')
    expect(usage.textContent).toMatch(/~?\d+ tokens \(~?\d+ in, \d+ out\) · \d+ calls? · .+ · \$/)
    expect(s.spentUsd()).toBeGreaterThan(before)
    expect(screen.getByLabelText(/Spent so far in this browser/).getAttribute('aria-label')).toContain(s.spentUsd().toFixed(2))
  })
  it('leaves nothing in the chat for a request that made no model call', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(screen.getByRole('button', { name: 'Article' }))
    await userEvent.click(screen.getByRole('button', { name: /Rename this article/ }))
    await answerDialog('Other')
    const chat = document.querySelector('.write__chat') as HTMLElement
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Renaming: done/))
    expect(within(chat).queryByTitle('Tokens, time and cost of this request')).toBeNull()
  })
})

describe('the chat is stored as shown', () => {
  it('keeps the action, the result and the notices, and tells about an action cut short by closing the page', async () => {
    const s = await services({}, MD)
    await s.store.setSetting('chat-pending', 'Publishing')
    render(<WriteApp services={s} />)
    await waitForText()
    expect((await screen.findAllByText(/“Publishing” was still running when this page was closed/)).length).toBeGreaterThan(0)
    await userEvent.click(rail('History'))
    await userEvent.click(await within(panel('History')).findByRole('button', { name: /Save version/i }))
    await answerDialog('mine')
    await waitFor(async () => expect(await s.store.getSetting('chat-pending')).toBe(''))
    expect((((await s.store.getSetting('chat-lines')) as { text: string }[] | undefined) ?? []).map((l) => l.text)).not.toContain('Saving the version')
    expect(await s.store.getSetting('chat-pending')).toBe('')
  })
})

describe('rail and panels', () => {
  it('has a rail of buttons; on desktop the panel opens from the rail and closes when the same button is clicked again', () =>
    wide(async () => {
      const s = await services({}, MD)
      const { container } = render(<WriteApp services={s} />)
      await waitForText()
      const main = container.querySelector('.write__main') as HTMLElement
      expect(within(screen.getByRole('navigation', { name: 'Panels' })).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Text', 'Style', 'Ideas', 'Issues', 'Sources', 'History', 'Chat', 'Settings'])
      expect(main.dataset.open).toBe('true')
      await userEvent.click(rail('Style'))
      expect(main.dataset.open).toBe('false')
      await userEvent.click(rail('History'))
      expect(main.dataset.open).toBe('true')
      expect(panel('History').className).toContain('is-shown')
      expect(panel('Style').className).not.toContain('is-shown')
    }))

  it('on a tablet the panel starts closed (it would float over the text) and opens from the rail', () =>
    wide(async () => {
      const s = await services({}, MD)
      const { container } = render(<WriteApp services={s} />)
      await waitForText()
      const main = container.querySelector('.write__main') as HTMLElement
      expect(main.dataset.open).toBe('false')
      await userEvent.click(rail('History'))
      expect(main.dataset.open).toBe('true')
    }, 820))

  it('counts what needs attention on the Issues button, and the box under the text lists only the issues of the selected text', async () => {
    const s = await services({}, MD2)
    const id = (await s.service.list())[0].id
    await s.service.addComment(id, { start: MD2.indexOf('So p99'), end: MD2.indexOf('So p99') }, 'x')
    render(<WriteApp services={s} />)
    await waitForText()
    expect(within(rail('Issues')).getByLabelText(/1 issue/)).toBeInTheDocument()
    await dockTab(/Issues/)
    const pane = screen.getByRole('tabpanel', { name: 'Issues' })
    expect(within(pane).getByText(/Click in the text/)).toBeInTheDocument()
    putCursor('The p99 was')
    expect(await within(pane).findByText(/Nothing needs your attention/)).toBeInTheDocument()
    putCursor('So p99 stays')
    expect(await within(pane).findByRole('button', { name: /^Reviewer comments/ })).toBeInTheDocument()
  })
})

describe('outline: a view of the text, edited as text together with it', () => {
  const outline = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Outline' }) as HTMLTextAreaElement
  const showOutline = (): Promise<void> => userEvent.click(screen.getByRole('button', { name: 'Outline view' }))

  it('is a toggle above the text and shows the headings as plain text, one per line', async () => {
    const md = '# Post\n\n## One\n\ntext\n\n### One point one\n\ntext\n\n## Two\n\ntext\n'
    const s = await services({}, md)
    render(<WriteApp services={s} />)
    await waitForText()
    expect(screen.queryByRole('button', { name: 'Outline' })).toBeNull() // not in the rail
    await showOutline()
    expect(outline().value).toBe('# Post\n## One\n### One point one\n## Two')
  })

  it('the mark at the end of a heading line opens the text at that section, and the outline gives way to the text', async () => {
    const md = '# Post\n\n## One\n\ntext\n\n## Two\n\ntext\n'
    const s = await services({}, md)
    render(<WriteApp services={s} />)
    const box = await waitForText()
    await showOutline()
    expect(screen.getByRole('button', { name: 'Outline view' })).toHaveAttribute('aria-pressed', 'true')
        await userEvent.click(screen.getByRole('button', { name: 'Go to the section: Two' }))
    expect(screen.queryByRole('textbox', { name: 'Outline' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Article view' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(box.selectionStart).toBe(md.indexOf('## Two')))
  })

  it('rewording a line rewords the heading in the text and nothing else changes', async () => {
    const s = await services({}, MD2)
    render(<WriteApp services={s} />)
    const box = await waitForText()
    await showOutline()
    fireEvent.change(outline(), { target: { value: outline().value.replace('Latency', 'Response time') } })
    fireEvent.blur(outline())
    await waitFor(() => expect(box.value).toContain('## Response time\n'))
    expect(box.value).toContain('The p99 was 18 ms. It is quick.')
  })

  it('a new line is a new section and more hashes make a subsection', async () => {
    const md = '# Post\n\n## One\n\ntext\n'
    const s = await services({}, md)
    render(<WriteApp services={s} />)
    const box = await waitForText()
    await showOutline()
    fireEvent.change(outline(), { target: { value: '# Post\n## One\n### Detail\n## Two' } })
    fireEvent.blur(outline())
    await waitFor(() => expect(box.value).toContain('### Detail'))
    expect(box.value).toContain('## Two')
    expect(box.value).toContain('text')
  })

  it('clicking a heading line selects it, so the box under the text shows it as if it were clicked in the article', async () => {
    const md = '# Post\n\n## One\n\ntext\n\n## Two\n\ntext\n'
    const s = await services({}, md)
    render(<WriteApp services={s} />)
    await waitForText()
    await showOutline()
    outline().setSelectionRange(outline().value.indexOf('## Two') + 3, outline().value.indexOf('## Two') + 3)
    await userEvent.click(outline())
    const dock = screen.getByLabelText('Comments and sources for this text')
    expect(await within(dock).findByText(/## Two/)).toBeInTheDocument()
    expect(screen.getByLabelText('Comments on this text')).toBeEnabled()
  })

  it('follows what is typed in the text', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    const box = await waitForText()
    fireEvent.change(box, { target: { value: `${MD}\n## Added\n\nmore\n` } })
    await showOutline()
    expect(outline().value).toContain('## Added')
  })
})

describe('a failing model call is said in the chat', () => {
  it('says why in the chat, with what to try, and not in an empty message or only in the top bar', async () => {
    const s = await services({}, MD)
    s.chat = async () => { throw new Error('401 invalid x-api-key') }
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.type(screen.getByLabelText('Message'), 'Tighten the intro')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText(/The model call failed: 401 invalid x-api-key\. Check your key and the model in Settings/)).toBeInTheDocument()
  })
})

describe('autosave and the box under the text', () => {
  it('saves a version by itself when a sentence is finished, and shows it in History', async () => {
    const s = await services({}, MD)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    const box = await waitForText()
    fireEvent.change(box, { target: { value: `${MD}\nA new thought` } })
    expect((await s.service.history(id)).filter((h) => h.label === 'Autosaved')).toHaveLength(0)
    fireEvent.change(box, { target: { value: `${MD}\nA new thought.` } })
    await waitFor(async () => expect((await s.service.history(id)).filter((h) => h.label === 'Autosaved')).toHaveLength(1))
    await waitFor(async () => expect((await s.service.get(id)).markdown).toContain('A new thought.'))
  })

  it('the box under the text can be hidden and shown again', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    expect(screen.getByLabelText('Comments and sources for this text')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Hide the box under the text' }))
    expect(screen.queryByLabelText('Comments and sources for this text')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Show the box under the text' }))
    expect(screen.getByLabelText('Comments and sources for this text')).toBeInTheDocument()
  })
})

describe('chat: model, check and adjust', () => {
  it('the model picker has a dropdown on its right and takes free text; the model shows on every answer', async () => {
    const s = await services({ capture: { articleId: null, ops: [] } }, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.click(screen.getByRole('button', { name: /Model for the chat: choose from the list/ }))
    const list = screen.getByRole('listbox', { name: /Model for the chat: models/ })
    expect(within(list).getAllByRole('option').length).toBeGreaterThan(1)
    await userEvent.click(within(list).getAllByRole('button').at(-1)!)
    await waitFor(() => expect(s.models.chat()).toBe(s.models.suggestions.at(-1)))
    const picker = screen.getByLabelText('Model for the chat')
    await userEvent.clear(picker)
    await userEvent.type(picker, 'my-own-model')
    fireEvent.blur(picker)
    await waitFor(() => expect(s.models.chat()).toBe('my-own-model'))
    await userEvent.type(screen.getByLabelText('Message'), 'hello{Enter}')
    expect(await screen.findByText('Noted.')).toBeInTheDocument()
    expect(screen.getAllByTitle('The model that wrote this')[0]).toHaveTextContent('my-own-model')
  })

  it('an edit keeps what the writer said in the record without running the whole chat turn, and says when it could not', async () => {
    let turns = 0
    const store = createMemoryArticleStore()
    const id = await new ArticleService({ store, llm: llm({}) }).create('Post', MD2)
    const s = await assembleWriteServices({
      store,
      llm: llm({ capture: { articleId: id, ops: [{ op: 'add_correction', note: 'The p99 is 41 ms.' }] }, edits: { suggestions: [{ quote: 'It is quick.', replacement: 'It is very quick.', reason: 'stronger' }] } }),
      buildAssistant: async () => ({ turn: async () => { turns++; return { reply: 'Noted.' } }, setModel: () => undefined }) as unknown as PersonalAssistant,
    })
    // The record is made (the correction in the message is kept in the article) and the assistant's own turn is not run.
    const ok = await s.record('The p99 is 41 ms. Make it stronger.', id)
    expect(ok.recorded).toBe(true)
    expect(turns).toBe(0)
    expect((await s.service.get(id)).meta.corrections.map((c) => c.note)).toContain('The p99 is 41 ms.')
    // Through the page: no turn either, and no "not added" note when the record was made.
    render(<WriteApp services={s} />)
    const box = await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.selectOptions(screen.getByLabelText('When I ask for a change'), 'edit')
    await userEvent.type(screen.getByLabelText('Message'), 'Make it stronger{Enter}')
    expect(await screen.findByText(/Made 1 change/)).toBeInTheDocument()
    await waitFor(() => expect(box.value).toContain('It is very quick.'))
    expect(turns).toBe(0)
    expect(screen.queryByText(/were not added to the article/)).toBeNull()
  })
  it('says so when what the writer said could not be recorded, and still makes the edit', async () => {
    // No scripted reply for the record call: it fails, and the edit goes ahead with a note.
    const s = await services({ edits: { suggestions: [{ quote: 'It is quick.', replacement: 'It is very quick.', reason: 'stronger' }] } }, MD2)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.selectOptions(screen.getByLabelText('When I ask for a change'), 'edit')
    await userEvent.type(screen.getByLabelText('Message'), 'Make it stronger{Enter}')
    expect(await screen.findByText(/were not added to the article's notes/)).toBeInTheDocument()
    expect(await screen.findByText(/Made 1 change/)).toBeInTheDocument()
  })

  it('"Edit the article" saves a version first, then edits, and the page shows the edited text', async () => {
    const s = await services({ capture: { articleId: null, ops: [] }, edits: { suggestions: [{ quote: 'It is quick.', replacement: 'It is very quick.', reason: 'stronger' }] } }, MD2)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    const box = await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.selectOptions(screen.getByLabelText('When I ask for a change'), 'edit')
    await userEvent.type(screen.getByLabelText('Message'), 'Make it stronger{Enter}')
    expect(await screen.findByText(/Made 1 change/)).toBeInTheDocument()
    const line = await screen.findByText((_, el) => !!el?.classList.contains('write__ln') && /Reworded: Latency/.test(el.textContent ?? ''))
    expect(line.querySelector('.write__name')?.textContent).toBe('Latency') // which section, in a colour of its own, not only how many
    await waitFor(() => expect(box.value).toContain('It is very quick.')) // the edited text is on screen
    // The reply carries what the request used; there is no separate "done" line when the reply already said it.
    expect(screen.queryByText(/Editing: done/)).toBeNull()
    const reply = screen.getByText(/Made 1 change/).closest('li') as HTMLElement
    expect(within(reply).getByTitle('Tokens, time and cost of this request')).toBeInTheDocument()
    const b = await s.service.get(id)
    expect(b.markdown).toContain('It is very quick.')
    expect(b.snapshots.find((x) => x.label === 'Before a chat edit: Make it stronger')?.markdown).toBe(MD2) // the text as it was
    expect(b.meta.suggestions.filter((x) => x.state === 'pending')).toHaveLength(0) // nothing is left waiting to accept
  })
  it('"Edit the article" on an empty article writes the draft into the article, not into the chat', async () => {
    const s = await services({ capture: { articleId: null, ops: [] }, draft: { name: 'Quick post', markdown: '# Post\n## Intro\nIt is quick.' } }, MD2)
    render(<WriteApp services={s} />)
    const box = await waitForText()
    fireEvent.change(box, { target: { value: '' } })
    await userEvent.click(rail('Chat'))
    await userEvent.selectOptions(screen.getByLabelText('When I ask for a change'), 'edit')
    await userEvent.type(screen.getByLabelText('Message'), 'Write the article{Enter}')
    expect(await screen.findByText(/Wrote the first draft/)).toBeInTheDocument()
    await waitFor(() => expect(box.value).toContain('It is quick.'))
  })
  it('with no article at all, the chat makes one, writes it and names it, with the mode left on Auto', async () => {
    const s = await services({ intent: { intent: 'edit' }, capture: { articleId: null, ops: [] }, draft: { name: 'Quick post', markdown: '# Post\n## Intro\nIt is quick.' } })
    render(<WriteApp services={s} />)
    await userEvent.click(rail('Chat'))
    expect((screen.getByLabelText('When I ask for a change') as HTMLSelectElement).value).toBe('auto')
    await userEvent.type(screen.getByLabelText('Message'), 'Write an article about speed{Enter}')
    expect(await screen.findByText(/named the article “Quick post”/)).toBeInTheDocument()
    const box = await waitForText()
    await waitFor(() => expect(box.value).toContain('It is quick.'))
    const list = await s.service.list()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('Quick post')
  })
  it('with the Outline showing, the edit is of the outline, also after a saved version', async () => {
    const s = await services({ capture: { articleId: null, ops: [] }, outline: { outline: '# Post\n## Conclusion\n## Latency' } }, MD2)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(screen.getByRole('button', { name: 'Outline view' }))
    await userEvent.click(rail('Chat'))
    await userEvent.selectOptions(screen.getByLabelText('When I ask for a change'), 'edit')
    expect(screen.getByRole('option', { name: 'Edit the outline' })).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Message'), 'Conclusion first{Enter}')
    expect(await screen.findByText(/Reworked the outline/)).toBeInTheDocument()
    const b = await s.service.get(id)
    expect(b.markdown.indexOf('## Conclusion')).toBeLessThan(b.markdown.indexOf('## Latency'))
    expect(b.snapshots.some((x) => x.label === 'Before a chat edit of the outline: Conclusion first' && x.markdown === MD2)).toBe(true)
    expect((screen.getByLabelText('Outline', { exact: true }) as HTMLTextAreaElement).value).toBe('# Post\n## Conclusion\n## Latency')
  })

  it('in Auto, a request for wording is a text edit even with the Outline showing, and one for headings alone is an outline edit', async () => {
    const wording = await services({ intent: { intent: 'edit', links: [], scope: 'text' }, capture: { articleId: null, ops: [] }, edits: { suggestions: [{ quote: 'It is quick.', replacement: 'It is quick, and here is why.', reason: 'more' }] }, outline: { outline: '# Post\n## Conclusion\n## Latency' } }, MD2)
    const first = render(<WriteApp services={wording} />)
    await waitForText()
    await userEvent.click(screen.getByRole('button', { name: 'Outline view' }))
    await userEvent.click(rail('Chat'))
    await userEvent.type(screen.getByLabelText('Message'), 'say more about why it is quick{Enter}')
    expect(await screen.findByText(/Made 1 change/)).toBeInTheDocument()
    expect(screen.queryByText(/Reworked the outline/)).toBeNull()
    first.unmount()
    const headings = await services({ intent: { intent: 'edit', links: [], scope: 'outline' }, capture: { articleId: null, ops: [] }, outline: { outline: '# Post\n## Conclusion\n## Latency' } }, MD2)
    render(<WriteApp services={headings} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.type(screen.getByLabelText('Message'), 'conclusion first{Enter}')
    expect(await screen.findByText(/Reworked the outline/)).toBeInTheDocument()
  })
  it('in Auto, a request for both a new section and what it says changes the outline and then the text, and the reply says so', async () => {
    const s = await services({ intent: { intent: 'edit', links: [], scope: 'both' }, capture: { articleId: null, ops: [] }, outline: { outline: '# Post\n## Latency\n## Why not others\n## Conclusion' }, edits: { suggestions: [{ quote: '## Why not others', replacement: '## Why not others\n\nOther tools fall short.', reason: 'content' }] } }, MD2)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.type(screen.getByLabelText('Message'), 'add a section on why others fall short, and write it{Enter}')
    expect(await screen.findByText(/Reworked the outline and made 1 text change/)).toBeInTheDocument()
    const b = await s.service.get(id)
    expect(b.markdown).toContain('## Why not others\n\nOther tools fall short.')
    expect(await screen.findByText(/with text/)).toBeInTheDocument()
  })

  it('sends the last message again: it and its reply leave the chat and the assistant forgets the exchange', async () => {
    const s = await services({ capture: { articleId: null, ops: [] } }, MD2)
    let undone = 0
    const real = s.undoLastTurn.bind(s)
    s.undoLastTurn = async () => { undone++; await real() }
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.type(screen.getByLabelText('Message'), 'is this clear?{Enter}')
    expect(await screen.findByText('Noted.')).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: /Send again/ }))
    await waitFor(() => expect(undone).toBe(1))
    expect(await screen.findByText('Noted.')).toBeInTheDocument()
    expect(screen.getAllByText('is this clear?')).toHaveLength(1)
    expect(screen.getAllByText('Noted.')).toHaveLength(1)
  })

  it('sends an edit again after putting the article back as it was before the reply', async () => {
    const s = await services({ intent: { intent: 'edit', links: [], scope: 'text' }, capture: { articleId: null, ops: [] }, edits: { suggestions: [{ quote: 'It is quick.', replacement: 'It is quick, and here is why.', reason: 'more' }] } }, MD2)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.type(screen.getByLabelText('Message'), 'say why it is quick{Enter}')
    expect(await screen.findByText(/Made 1 change/)).toBeInTheDocument()
    expect((await s.service.get(id)).markdown).toContain('It is quick, and here is why.')
    await userEvent.click(await screen.findByRole('button', { name: /Send again/ }))
    expect(await screen.findAllByText(/Made 1 change/)).toHaveLength(1)
    // The edit was applied to the original text again, not on top of the first edit.
    const md = (await s.service.get(id)).markdown
    expect(md.split('and here is why.').length - 1).toBe(1)
    expect((await s.service.history(id)).some((v) => v.label === 'Before restoring an earlier version')).toBe(true)
  })

  it('the conversation is still there after the page is opened again', async () => {
    const s = await services({}, MD)
    const first = render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.type(screen.getByLabelText('Message'), 'hello{Enter}')
    expect(await screen.findByText('Noted.')).toBeInTheDocument()
    await waitFor(async () => expect(await s.store.getSetting('chat-lines')).toHaveLength(2))
    first.unmount()
    render(<WriteApp services={s} />)
    await waitForText()
    expect(await screen.findByText('hello')).toBeInTheDocument()
    expect(screen.getByText('Noted.')).toBeInTheDocument()
    // a new message continues after the old ones
    await userEvent.click(rail('Chat'))
    await userEvent.type(screen.getByLabelText('Message'), 'again{Enter}')
    await waitFor(async () => expect(await s.store.getSetting('chat-lines')).toHaveLength(4))
  })

  it('"Find the factual claims and check them" is an action in the Adjust list, without a model name in its label, runs as soon as it is picked, and says which model checked', async () => {
    const s = await services({ capture: { articleId: null, ops: [] }, claims: { claims: [{ quote: 'The p99 was 18 ms.', kind: 'factual', matchesId: null, sure: true }] }, resolve: { affected: [] } }, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.selectOptions(screen.getByLabelText('Adjust', { selector: 'select' }), 'action:check')
    expect(await screen.findByText(/I found 1 factual claim/)).toBeInTheDocument()
    expect(screen.getAllByTitle('The model that wrote this').at(-1)).toHaveTextContent(s.models.chat())
  })

  it('"Fill in the style and links" is said in the chat, with its result, and not in the top bar', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.selectOptions(screen.getByLabelText('Adjust', { selector: 'select' }), 'action:prepare')
    await waitFor(() => expect(document.querySelector('.write__line--you')?.textContent).toBe('Fill in the style and links from the article'))
    expect(await screen.findByText(/Check your key and the model in Settings/)).toBeInTheDocument() // nothing is set up to answer in this test, so it says why
    expect(screen.queryByRole('status')?.textContent ?? '').not.toMatch(/Check your key/)
  })

  it('tints the sentences of the claims it found, says what the colours mean, and the marks can be switched off', async () => {
    const s = await services({ capture: { articleId: null, ops: [] }, claims: { claims: [{ quote: 'The p99 was 18 ms.', kind: 'factual', matchesId: null, sure: true }] }, resolve: { affected: [] } }, MD)
    const { container } = render(<WriteApp services={s} />)
    await waitForText()
    expect(container.querySelector('mark')).toBeNull()
    await userEvent.click(rail('Chat'))
    await userEvent.selectOptions(screen.getByLabelText('Adjust', { selector: 'select' }), 'action:check')
    await screen.findByText(/I found 1 factual claim/)
    await waitFor(() => expect(container.querySelector('mark')?.textContent).toBe('The p99 was 18 ms.'))
    expect(container.querySelector('mark')).toHaveClass('write__mark--look')
    expect(screen.getByText('needs checking')).toBeInTheDocument()
    expect(container.querySelector('.write__backdrop')).toHaveAttribute('aria-hidden', 'true')
    putCursor('18 ms')
    expect(screen.queryByText(/Here:/)).toBeNull() // the box under the text says it
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show marks in the text' }))
    expect(container.querySelector('mark')).toBeNull()
    expect(screen.queryByText(/Here:/)).toBeNull()
    localStorage.removeItem('aielia-write.tint')
  })

  it('an adjustment is sent with Enter as an ordinary chat message, and the edits come back as suggestions', async () => {
    const s = await services({ capture: { articleId: null, ops: [] }, edits: { suggestions: [{ quote: 'It is quick.', replacement: 'It is, well, quick.', reason: 'more conversational' }] } }, MD2)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.selectOptions(screen.getByLabelText('Adjust', { selector: 'select' }), 'tone')
    expect(screen.queryByRole('button', { name: /Send adjustment/ })).toBeNull() // no extra button: Enter sends
    await userEvent.type(screen.getByLabelText('How'), 'Tone of voice: Conversational{Enter}')
    expect(await screen.findByText(/tone of voice is: Conversational/)).toBeInTheDocument()
    expect(await screen.findByText(/Added 1 suggestion/)).toBeInTheDocument()
  })

  it('lets the writer adjust something that is not listed', async () => {
    const s = await services({ capture: { articleId: null, ops: [] }, edits: { suggestions: [] } }, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.selectOptions(screen.getByLabelText('Adjust', { selector: 'select' }), 'other')
    await userEvent.type(screen.getByLabelText('How'), 'pacing: slower in the middle{Enter}')
    expect(await screen.findByText(/Adjust the article: pacing: slower in the middle/)).toBeInTheDocument()
  })

  it('Delete all my data asks first, then removes the articles, the chat and the settings', async () => {
    const s = await services({}, MD)
    const onDeleted = vi.fn()
    render(<WriteApp services={s} onDeleted={onDeleted} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.type(screen.getByLabelText('Message'), 'hello{Enter}')
    expect(await screen.findByText('Noted.')).toBeInTheDocument()
    await userEvent.click(rail('Settings'))
    const button = await within(panel('Settings')).findByRole('button', { name: 'Delete all my data' })
    expect(button.className).toContain('write__dangerbtn') // red, at the bottom of Settings
    await userEvent.click(button)
    await declineDialog() // keeping the data is the way out
    expect(await s.service.list()).toHaveLength(1)
    expect(onDeleted).not.toHaveBeenCalled()
    await userEvent.click(button)
    await answerDialog()
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(await s.service.list()).toEqual([])
    await waitFor(async () => expect(((await s.store.getSetting('chat-lines')) as { text: string }[]).map((l) => l.text)).toEqual(['All your data was deleted.'])) // only the line saying so, nothing from before
    expect(screen.queryByText('Noted.')).toBeNull()
    expect(screen.getByText('Create an article, or import one, to begin.')).toBeInTheDocument()
  })

  it('the lines between the panes can be moved (arrow keys here, the mouse in a browser), are remembered, and double-click puts them back', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400)
    try {
      const s = await services({}, MD)
      const first = render(<WriteApp services={s} />)
      await waitForText()
      const main = document.querySelector('.write__main') as HTMLElement
      const chatLine = screen.getByRole('separator', { name: 'Chat width' })
      fireEvent.keyDown(chatLine, { key: 'ArrowLeft' }) // toward the text: the chat gets wider
      expect(main.style.getPropertyValue('--chat-size')).toBe('336px')
      const dockLine = screen.getByRole('separator', { name: 'Height of the box under the text' })
      fireEvent.keyDown(dockLine, { key: 'ArrowUp' })
      expect(JSON.parse(localStorage.getItem('aielia-write.layout') ?? '{}')).toMatchObject({ chat: 336 })
      first.unmount()
      render(<WriteApp services={s} />) // opened again: the size is where it was left
      await waitForText()
      expect((document.querySelector('.write__main') as HTMLElement).style.getPropertyValue('--chat-size')).toBe('336px')
      fireEvent.doubleClick(screen.getByRole('separator', { name: 'Chat width' }))
      expect((document.querySelector('.write__main') as HTMLElement).style.getPropertyValue('--chat-size')).toBe('')
    } finally {
      width.mockRestore()
      localStorage.removeItem('aielia-write.layout')
    }
  })

  it('warns in Settings when the automatic checks use the same model as the chat', async () => {
    const s = await services({}, MD)
    await s.models.setAuto(s.models.chat())
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Settings'))
    expect(await screen.findByText(/Same model as the chat/)).toBeInTheDocument()
  })

  it('shows the defaults in Settings, saves a change, and applies the spending cap', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Settings'))
    const auto = await screen.findByLabelText(/Check by itself when I stop typing/)
    expect(auto).not.toBeChecked()
    await userEvent.click(auto)
    await waitFor(async () => expect((await s.permissions.get()).autoCheck).toBe(true))
    await userEvent.type(screen.getByLabelText('Spending cap'), '2')
    fireEvent.blur(screen.getByLabelText('Spending cap'))
    await waitFor(async () => expect((await s.permissions.get()).spendCapUsd).toBe(2))
  })
})

describe('issues in batches', () => {
  const seed = async (replies: Parameters<typeof llm>[0], edit: (m: import('@buildaharness/aielia').ArticleMeta, id: string) => import('@buildaharness/aielia').ArticleMeta) => {
    const store = createMemoryArticleStore()
    const s = await servicesOn(store, replies)
    const id = await s.service.create('Post', MD2)
    const b = await s.service.get(id)
    await store.save(id, { ...b, meta: edit(b.meta, id) })
    return { s, id, store }
  }
  const sg = (id: string, quote: string, replacement: string) => ({ id, span: { start: MD2.indexOf(quote), end: MD2.indexOf(quote) + quote.length, quote }, replacement, reason: 'r', proposedBy: 'assistant' as const, state: 'pending' as const, createdAt: 'now' })
  const open = async (s: Awaited<ReturnType<typeof services>>): Promise<HTMLTextAreaElement> => {
    render(<WriteApp services={s} />)
    const box = await waitForText()
    await userEvent.click(rail('Issues'))
    return box
  }

  it('groups issues by kind, with one button per group and a count', async () => {
    const { s } = await seed({}, (m, id) => ({
      ...m,
      suggestions: [sg('sg1', '18 ms', '41 ms'), sg('sg2', 'under 20 ms', 'under 41 ms')],
      comments: [
        { id: 'wc1', articleId: id, label: 'C1', text: 'Say which percentile', state: 'open', conflictsWith: [], origin: 'reviewer', capturedAt: 'now' },
        { id: 'wc2', articleId: id, label: 'C4', text: 'Cost first', state: 'open', conflictsWith: ['wc3'], origin: 'reviewer', capturedAt: 'now' },
        { id: 'wc3', articleId: id, label: 'C5', text: 'Cost last', state: 'open', conflictsWith: ['wc2'], origin: 'reviewer', capturedAt: 'now' },
      ],
      claims: [{ id: 'k1', sectionId: m.sections[1].id, quote: 'The p99 was 18 ms.', position: MD2.indexOf('The p99'), kind: 'factual', author: 'model', authorAt: 'now', confirmed: false, sourceStatus: 'none' }],
    }))
    await open(s)
    const issues = panel('Issues')
    for (const title of ['Suggested changes', 'Reviewer comments', 'Claims without support']) await expand(title)
    const group = (title: string): HTMLElement => within(issues).getByRole('region', { name: title })
    expect(within(group('Suggested changes')).getByRole('button', { name: 'Accept all' })).toBeInTheDocument()
    expect(within(group('Reviewer comments')).getByRole('button', { name: 'Suggest fixes' })).toBeInTheDocument()
    expect(within(group('Claims without support')).getByRole('button', { name: 'Suggest fixes' })).toBeInTheDocument()
    expect(within(issues).getByText(/Conflicts with C5/)).toBeInTheDocument() // listed apart, no batch action for it
    expect(within(issues).getByRole('button', { name: 'Resolve all' })).toBeInTheDocument()
  })

  it('shows only a button per kind with its count until one is clicked, and lists claims with the same reason once under it', async () => {
    const { s } = await seed({}, (m) => ({
      ...m,
      claims: [
        { id: 'k1', sectionId: m.sections[1].id, quote: 'The p99 was 18 ms.', position: MD2.indexOf('The p99'), kind: 'factual', author: 'model', authorAt: 'now', confirmed: false, sourceStatus: 'none' },
        { id: 'k2', sectionId: m.sections[2].id, quote: 'So p99 stays under 20 ms.', position: MD2.indexOf('So p99'), kind: 'factual', author: 'model', authorAt: 'now', confirmed: false, sourceStatus: 'none' },
      ],
    }))
    await open(s)
    const issues = panel('Issues')
    expect(within(issues).getByRole('button', { name: /^Claims without support/ })).toHaveAttribute('aria-expanded', 'false')
    expect(within(issues).queryByText('The p99 was 18 ms.')).toBeNull()
    await expand('Claims without support')
    expect(within(issues).getAllByText(/^No source$/)).toHaveLength(1)
    expect(within(issues).getByText('The p99 was 18 ms.')).toBeInTheDocument()
    expect(within(issues).getByText('So p99 stays under 20 ms.')).toBeInTheDocument()
    await expand('Claims without support')
    expect(within(issues).queryByText('The p99 was 18 ms.')).toBeNull()
  })

  it('"Accept all" applies every waiting suggestion at once and says what it did', async () => {
    const { s } = await seed({}, (m) => ({ ...m, suggestions: [sg('sg1', '18 ms', '41 ms'), sg('sg2', 'under 20 ms', 'under 41 ms')] }))
    const box = await open(s)
    await expand('Suggested changes')
    await userEvent.click(within(panel('Issues')).getByRole('button', { name: 'Accept all' }))
    await waitFor(() => expect(box.value).toContain('41 ms.'))
    expect(box.value).toContain('under 41 ms')
    expect(await within(panel('Issues')).findByText(/2 accepted/)).toBeInTheDocument()
  })

  it('a suggestion\'s replacement text is edited where it stands, and the edited text is what is accepted', async () => {
    const { s } = await seed({}, (m) => ({ ...m, suggestions: [sg('sg1', '18 ms', '41 ms')] }))
    const box = await open(s)
    await expand('Suggested changes')
    await userEvent.click(within(panel('Issues')).getByRole('button', { name: /Replacement text for 18 ms/ }))
    const input = screen.getByLabelText(/Replacement text for 18 ms/)
    await userEvent.clear(input)
    await userEvent.type(input, '41 milliseconds{Enter}')
    await userEvent.click(await within(panel('Issues')).findByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(box.value).toContain('41 milliseconds'))
  })

  it('"Suggest fixes" for comments asks for edits and the comment closes when the suggestion is accepted', async () => {
    const reply = { suggestions: [{ quote: 'The p99 was 18 ms.', replacement: 'The p99 was 18 ms (p99).', reason: 'C1', commentIds: ['wc1'] }] }
    const { s, id } = await seed({ edits: reply }, (m) => ({ ...m, comments: [{ id: 'wc1', articleId: m.id, label: 'C1', text: 'Say which percentile', state: 'open', conflictsWith: [], origin: 'reviewer', capturedAt: 'now' }] }))
    await open(s)
    await expand('Reviewer comments')
    await userEvent.click(within(within(panel('Issues')).getByRole('region', { name: 'Reviewer comments' })).getByRole('button', { name: 'Suggest fixes' }))
    expect(await within(panel('Issues')).findByText(/1 suggested change/)).toBeInTheDocument()
    await expand('Suggested changes')
    await userEvent.click(await within(panel('Issues')).findByRole('button', { name: 'Accept all' }))
    await waitFor(async () => expect((await s.service.get(id)).meta.comments[0].state).toBe('addressed'))
  })

  it('"Resolve all" runs every group and reports each, without applying text changes', async () => {
    const reply = { suggestions: [{ quote: 'So p99 stays under 20 ms.', replacement: 'So p99 stays under 41 ms.', reason: 'r', sectionIds: ['s3'] }] }
    const { s } = await seed({ edits: reply }, (m) => ({ ...m, sections: m.sections.map((x) => (x.id === 's3' ? { ...x, review: { state: 'needs_review' as const, reason: 'figure changed' } } : x)) }))
    const box = await open(s)
    await userEvent.click(within(panel('Issues')).getByRole('button', { name: 'Resolve all' }))
    expect(await within(panel('Issues')).findByText(/1 suggested change added/)).toBeInTheDocument()
    expect(box.value).not.toContain('under 41 ms')
  })

  it('comments are edited where they stand, and can be marked as dealt with with one icon', async () => {
    const { s, id } = await seed({}, (m) => ({ ...m, comments: [{ id: 'wc1', articleId: m.id, label: 'C1', text: 'Say which percentile', state: 'open', conflictsWith: [], origin: 'reviewer', capturedAt: 'now' }] }))
    await open(s)
    await expand('Reviewer comments')
    await userEvent.click(within(panel('Issues')).getByRole('button', { name: 'Comment C1' }))
    const input = screen.getByLabelText('Comment C1')
    await userEvent.clear(input)
    await userEvent.type(input, 'Say which percentile, and why{Enter}')
    await waitFor(async () => expect((await s.service.get(id)).meta.comments[0].text).toBe('Say which percentile, and why'))
    await userEvent.click(within(panel('Issues')).getByRole('button', { name: 'Mark as dealt with' }))
    await waitFor(async () => expect((await s.service.get(id)).meta.comments[0].state).toBe('addressed'))
  })

  it('shows nothing to do for a clean article', async () => {
    const s = await services({}, MD)
    await open(s)
    expect(within(panel('Issues')).getByText(/Nothing needs your attention/)).toBeInTheDocument()
    expect(within(panel('Issues')).queryByRole('button', { name: 'Resolve all' })).toBeNull()
  })
})

describe('double-click selects bigger and bigger pieces', () => {
  it('the sentence, then the paragraph, then each section up to just below the whole article, then the sentence again', async () => {
    const s = await services({}, MD2)
    render(<WriteApp services={s} />)
    const box = await waitForText()
    const doubleClick = (needle: string): void => {
      const at = box.value.indexOf(needle) + 2
      fireEvent.mouseDown(box, { detail: 1 })
      box.setSelectionRange(at, at)
      fireEvent.mouseDown(box, { detail: 2 })
      fireEvent.doubleClick(box)
    }
    const picked = (): string => box.value.slice(box.selectionStart, box.selectionEnd)
    doubleClick('The p99')
    expect(picked()).toBe('The p99 was 18 ms.')
    doubleClick('The p99')
    expect(picked()).toBe('The p99 was 18 ms. It is quick.') // the paragraph
    doubleClick('The p99')
    expect(picked()).toBe('## Latency\n\nThe p99 was 18 ms. It is quick.') // its section
    // `# Post` is the whole article here, so the section above was the largest one: the next double-click starts over
    doubleClick('The p99')
    expect(picked()).toBe('The p99 was 18 ms.')
  })
})

describe('a picked piece of text stays marked', () => {
  it('stays drawn when the writer clicks in the box under the text, and goes when the text is clicked again', async () => {
    const s = await services({}, MD2)
    const { container } = render(<WriteApp services={s} />)
    const box = await waitForText()
    const at = box.value.indexOf('The p99')
    await waitFor(() => {
      box.focus()
      box.setSelectionRange(at + 4, at + 17)
      fireEvent.click(box) // the page reads the selection on a click (React drops a repeated select event for a range it has already seen)
      expect(container.querySelector('mark.write__sel')).toBeNull() // while the box is in use the browser draws it
      act(() => box.blur()) // a real blur, as when the writer clicks elsewhere
      expect(container.querySelector('mark.write__sel')?.textContent).toBe('p99 was 18 ms')
    })
    await dockTab('Sources')
    expect(container.querySelector('mark.write__sel')?.textContent).toBe('p99 was 18 ms')
    act(() => box.focus())
    expect(container.querySelector('mark.write__sel')).toBeNull()
  })
})

describe('comments and sources under the text', () => {
  it('asks you to click in the text first, and shows what is under the cursor', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    const dock = screen.getByLabelText('Comments and sources for this text')
    expect(within(dock).getByText(/to see the comments on it and to add one/)).toBeInTheDocument() // like Issues, Links and History: nothing to show or add until some text is picked
    expect(screen.queryByLabelText('Comments on this text')).toBeNull()
    await dockTab('Sources')
    expect(within(dock).getByText(/to see the sources for it and to add one/)).toBeInTheDocument()
    expect(within(dock).queryByLabelText('Add to this text')).toBeNull()
    await dockTab('Comments')
    putCursor('18 ms')
    expect(screen.getByLabelText('Comments on this text')).toBeEnabled()
    expect(within(screen.getByLabelText('Comments and sources for this text')).getByText(/The p99 was 18 ms\./)).toBeInTheDocument()
  })

  it('the comments are free text: write one, reword it in place, add another after a blank line, and clear it to delete', async () => {
    const s = await services({}, MD)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    putCursor('18 ms')
    const box = screen.getByLabelText('Comments on this text') as HTMLTextAreaElement
    await userEvent.type(box, 'Is this the median?')
    fireEvent.blur(box)
    await waitFor(async () => expect((await s.service.get(id)).meta.comments[0]?.text).toBe('Is this the median?'))
    expect((await s.service.get(id)).meta.comments[0].span?.quote).toBe('The p99 was 18 ms.')
    await waitFor(() => expect((screen.getByLabelText('Comments on this text') as HTMLTextAreaElement).value).toBe('Is this the median?'))
    fireEvent.change(screen.getByLabelText('Comments on this text'), { target: { value: 'Is this p99 or the median?\n\nAdd the date.' } })
    fireEvent.blur(screen.getByLabelText('Comments on this text'))
    await waitFor(async () => expect((await s.service.get(id)).meta.comments.map((c) => c.text)).toEqual(['Is this p99 or the median?', 'Add the date.']))
    await waitFor(() => expect((screen.getByLabelText('Comments on this text') as HTMLTextAreaElement).value).toBe('Is this p99 or the median?\n\nAdd the date.'))
    fireEvent.change(screen.getByLabelText('Comments on this text'), { target: { value: '' } })
    fireEvent.blur(screen.getByLabelText('Comments on this text'))
    await waitFor(async () => expect((await s.service.get(id)).meta.comments).toEqual([]))
  })

  it('a comment on a highlighted paragraph is anchored to exactly that text', async () => {
    const s = await services({}, MD2)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    const box = await waitForText()
    const start = MD2.indexOf('The p99')
    const end = MD2.indexOf('It is quick.') + 'It is quick.'.length
    box.setSelectionRange(start, end)
    fireEvent.select(box)
    const comments = screen.getByLabelText('Comments on this text')
    await userEvent.type(comments, 'Tighten this paragraph')
    fireEvent.blur(comments)
    await waitFor(async () => expect((await s.service.get(id)).meta.comments[0].span?.quote).toBe(MD2.slice(start, end)))
  })

  it('a pasted passage or a link becomes a source for the text; in the Sources tab; one icon removes it', async () => {
    const s = await services({}, MD)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    putCursor('18 ms')
    await dockTab('Sources')
    const dock = screen.getByLabelText('Comments and sources for this text')
    await userEvent.type(within(dock).getByLabelText('Add to this text', { selector: 'input' }), 'p99 latency: 18 ms{Enter}')
    expect(await within(dock).findByText(/p99 latency: 18 ms/)).toBeInTheDocument()
    await userEvent.type(within(dock).getByLabelText('Add to this text', { selector: 'input' }), 'https://example.com/bench{Enter}')
    await waitFor(async () => expect((await s.service.get(id)).meta.sources.map((x) => x.kind).sort()).toEqual(['upload', 'web']))
    await userEvent.click(within(dock).getAllByRole('button', { name: 'Remove this source from the text' })[0])
    await waitFor(async () => expect((await s.service.get(id)).meta.links.filter((l) => l.kind === 'supported_by')).toHaveLength(1))
  })

  it('attaches a dropped text file to the text under the cursor, and says so for a file it cannot read', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    putCursor('18 ms')
    await dockTab('Sources')
    const dock = screen.getByLabelText('Comments and sources for this text')
    fireEvent.drop(dock, { dataTransfer: { files: [new File(['p99: 18 ms measured on 8 cores'], 'bench.txt', { type: 'text/plain' }), new File(['x'], 'photo.png', { type: 'image/png' })] } })
    expect(await within(dock).findByText('bench.txt')).toBeInTheDocument()
    expect((await screen.findAllByText(/photo\.png: only text, code, PDF and Word \(\.docx\) files can be read/)).length).toBeGreaterThan(0)
  })

  it('a file dropped anywhere in the window, not only on a pane, is added to the sources', async () => {
    const s = await services({ sourceLinks: { claims: [] } }, MD)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    const page = document.querySelector('.write') as HTMLElement
    fireEvent.dragOver(page, { dataTransfer: { types: ['Files'], files: [] } })
    expect(page.className).toContain('is-dropping')
    fireEvent.drop(page, { dataTransfer: { types: ['Files'], files: [new File(['p99: 18 ms measured on 8 cores'], 'bench.txt', { type: 'text/plain' })] } })
    await waitFor(async () => expect((await s.service.get(id)).meta.sources.map((x) => x.address)).toEqual(['bench.txt']))
    expect(page.className).not.toContain('is-dropping')
  })

  it('a file dropped with no article open creates an article named after it and is added as its source', async () => {
    const s = await services({ sourceLinks: { claims: [] } })
    render(<WriteApp services={s} />)
    const page = document.querySelector('.write') as HTMLElement
    fireEvent.drop(page, { dataTransfer: { types: ['Files'], files: [new File(['p99: 18 ms measured on 8 cores'], 'bench notes.txt', { type: 'text/plain' })] } })
    await waitFor(async () => {
      const list = await s.service.list()
      expect(list).toHaveLength(1)
      expect((await s.service.get(list[0].id)).meta.sources.map((x) => x.address)).toEqual(['bench notes.txt'])
    })
    expect((await s.service.list())[0].name).toBe('bench notes')
  })

  it('stores a dropped code file as a code source', async () => {
    const s = await services({ sourceLinks: { claims: [] } }, MD)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    putCursor('18 ms')
    fireEvent.drop(screen.getByLabelText('Comments and sources for this text'), { dataTransfer: { files: [new File(['export const limit = 20'], 'limits.ts', { type: '' })] } })
    expect(await screen.findByText(/limits\.ts: added as code/)).toBeInTheDocument()
    expect((await s.service.get(id)).meta.sources[0]).toMatchObject({ kind: 'code', address: 'limits.ts', passage: 'export const limit = 20' })
  })

  it('the Sources button at the side lists every source of the article, with the claims each one backs, without picking any text', async () => {
    const s = await services({ claims: { claims: [{ quote: 'The p99 was 18 ms.', kind: 'factual', matchesId: null, sure: true }] }, resolve: { affected: [] } }, MD)
    const id = (await s.service.list())[0].id
    await s.service.analyze(id)
    const at = MD.indexOf('18 ms')
    const backed = await s.service.addSource(id, { kind: 'upload', address: 'bench.txt', passage: 'p99 18 ms' })
    await s.service.attachSourceToText(id, { start: at, end: at }, backed)
    await s.service.addSource(id, { kind: 'upload', address: 'spare.txt', passage: 'unused' })
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Sources'))
    const side = panel('Sources')
    const list = await within(side).findByRole('list', { name: 'All sources of the article' })
    expect(within(list).getByText('bench.txt')).toBeInTheDocument()
    expect(within(list).getByText('spare.txt')).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: 'no claims yet' })).toBeInTheDocument()
    expect(within(list).queryByText(/The p99 was 18 ms\./)).toBeNull()
    await userEvent.click(within(list).getByRole('button', { name: '1 claim' }))
    expect(within(within(list).getByRole('list', { name: 'Lines of this file and the claims they back' })).getByText(/The p99 was 18 ms\./)).toBeInTheDocument()
  })

  it('a file dropped into the chat is stored and Aielia proposes where it belongs, to confirm under the text with one icon', async () => {
    const s = await services({ sourceLinks: { claims: [{ claimId: 'k1', relation: 'supports', reason: 'same figure', confidence: 0.9 }] } }, MD)
    const id = (await s.service.list())[0].id
    const at = MD.indexOf('18 ms')
    const first = await s.service.addSource(id, { kind: 'upload', passage: 'first' })
    await s.service.attachSourceToText(id, { start: at, end: at }, first)
    await s.service.detachSource(id, 'k1', first)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    fireEvent.drop(panel('Chat'), { dataTransfer: { files: [new File(['p99 is 18 ms'], 'notes.txt', { type: 'text/plain' })] } })
    expect(await screen.findByText(/notes\.txt: added/)).toBeInTheDocument()
    putCursor('18 ms')
    await dockTab('Sources')
    const dock = screen.getByLabelText('Comments and sources for this text')
    expect(await within(dock).findByText('notes.txt')).toBeInTheDocument()
    expect(within(dock).getByText(/suggested 90%/)).toBeInTheDocument()
    await userEvent.click(within(dock).getByRole('button', { name: 'Use this source' }))
    await waitFor(() => expect(within(dock).queryByText(/suggested 90%/)).toBeNull())
  })
})

describe('the box under the text', () => {
  it('adds a comment or a source only, each in its own tab; My word and Revise are gone and the buttons stay inside the box', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    putCursor('18 ms')
    const dock = screen.getByLabelText('Comments and sources for this text')
    expect(within(dock).queryByRole('group', { name: 'What to add' })).toBeNull() // Comments and Sources are tabs, not a switch
    expect(within(dock).queryByRole('button', { name: 'Add a file as a source' })).toBeNull() // files belong to the Sources tab
    await dockTab('Sources')
    expect(within(dock).getByRole('button', { name: 'Add a file as a source' })).toBeInTheDocument()
    expect(within(dock).queryByRole('button', { name: 'Revise' })).toBeNull()
    expect(within(dock).queryByRole('button', { name: 'My word' })).toBeNull()
  })

  it('has Comments, Sources, Issues, Links and History as tabs', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    expect(within(screen.getByRole('tablist')).getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual(['Comments', 'Sources', 'Issues', 'Links', 'History'])
  })
})

describe('finding sources', () => {
  it('searches for pages that may back a claim, shows them, and a picked page becomes a source tied to the claim', async () => {
    const s = await services({ claims: { claims: [{ quote: 'The p99 was 18 ms.', kind: 'factual', matchesId: null, sure: true }] }, resolve: { affected: [] } }, MD, async () => 'p99 was 18 ms in the benchmark.', async () => [{ title: 'Benchmark report', url: 'https://example.com/report', snippet: 'p99 latency 18 ms' }])
    const id = (await s.service.list())[0].id
    await s.service.analyze(id)
    render(<WriteApp services={s} />)
    await waitForText()
    putCursor('18 ms')
    await dockTab('Sources')
    const dock = screen.getByLabelText('Comments and sources for this text')
    await userEvent.click(await within(dock).findByRole('button', { name: 'Find sources for this claim' }))
    const found = await within(dock).findByRole('group', { name: 'Pages that may back this claim' })
    expect(within(found).getByText('Benchmark report')).toBeInTheDocument()
    await userEvent.click(within(found).getByRole('button', { name: /Use Benchmark report as a source/ }))
    await waitFor(async () => expect((await s.service.get(id)).meta.sources[0]).toMatchObject({ address: 'https://example.com/report', passage: 'p99 was 18 ms in the benchmark.' }))
    expect(screen.queryByRole('group', { name: 'Pages that may back this claim' })).toBeNull()
  })
  it('looks for a source, reads it and checks the claim from one click; with nothing found it says so', async () => {
    const claims = { claims: [{ quote: 'The p99 was 18 ms.', kind: 'factual', matchesId: null, sure: true }] }
    const s = await services({ claims, resolve: { affected: [] }, support: { verdict: 'supported', reason: 'the report says 18 ms' } }, MD, async () => 'p99 was 18 ms in the benchmark.', async () => [{ title: 'Benchmark report', url: 'https://example.com/report', snippet: '' }])
    const id = (await s.service.list())[0].id
    await s.service.analyze(id)
    render(<WriteApp services={s} />)
    await waitForText()
    putCursor('18 ms')
    await dockTab('Sources')
    const dock = screen.getByLabelText('Comments and sources for this text')
    await userEvent.click(await within(dock).findByRole('button', { name: 'Look for a source and check this claim' }))
    await waitFor(async () => expect((await s.service.get(id)).meta.claims[0]).toMatchObject({ sourceStatus: 'supported' }))
    expect((await s.service.get(id)).meta.sources[0]).toMatchObject({ address: 'https://example.com/report' })
    expect((await s.service.get(id)).meta.links[0]).toMatchObject({ origin: 'proposed' })
  })
  it('says no source was found when the search comes back empty, and verifies every claim from the chat menu', async () => {
    const claims = { claims: [{ quote: 'The p99 was 18 ms.', kind: 'factual', matchesId: null, sure: true }] }
    const s = await services({ claims, resolve: { affected: [] } }, MD, async () => 'x', async () => [])
    const id = (await s.service.list())[0].id
    await s.service.analyze(id)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.selectOptions(screen.getByLabelText('Adjust', { selector: 'select' }), 'action:verify')
    expect(await screen.findByText(/Looked at 1 claim, none backed: 1 with no source found/)).toBeInTheDocument()
    expect((await s.service.get(id)).meta.claims[0].lookup).toMatchObject({ outcome: 'no_results' })
    putCursor('18 ms')
    await dockTab('Sources')
    expect(await within(screen.getByLabelText('Comments and sources for this text')).findByText(/No source found: searched the web/)).toBeInTheDocument()
  })
  it('shows a progress line in the chat while a command runs, and replaces it with the result', async () => {
    const claims = { claims: [{ quote: 'The p99 was 18 ms.', kind: 'factual', matchesId: null, sure: true }] }
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    const s = await services({ claims, resolve: { affected: [] } }, MD, async () => 'x', async () => { await gate; return [] })
    const id = (await s.service.list())[0].id
    await s.service.analyze(id)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.selectOptions(screen.getByLabelText('Adjust', { selector: 'select' }), 'action:verify')
    const chatList = (): HTMLElement => document.querySelector('.write__chat') as HTMLElement
    expect(await within(chatList()).findByText(/^Verifying with /)).toBeInTheDocument()
    release()
    expect(await screen.findByText(/Looked at 1 claim/)).toBeInTheDocument()
    await waitFor(() => expect(within(chatList()).queryByText(/^Verifying with /)).toBeNull())
  })
  it('counts the claims done, and Stop ends a check between claims, keeping the ones already checked', async () => {
    const claims = { claims: [{ quote: 'The p99 was 18 ms.', kind: 'factual', matchesId: null, sure: true }, { quote: 'So p99 stays under 20 ms.', kind: 'factual', matchesId: null, sure: true }] }
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    let searches = 0
    const s = await services({ claims, resolve: { affected: [] } }, MD2, async () => 'x', async () => { searches++; await gate; return [] })
    const id = (await s.service.list())[0].id
    await s.service.analyze(id)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.selectOptions(screen.getByLabelText('Adjust', { selector: 'select' }), 'action:verify')
    const stop = await screen.findByRole('button', { name: 'Stop' })
    await waitFor(() => expect(searches).toBe(1))
    await userEvent.click(stop)
    expect(await screen.findByText('Stopping after this step…')).toBeInTheDocument()
    release()
    expect(await screen.findByText(/Stopped early: 1 claim was checked and 1 is left/)).toBeInTheDocument()
    expect(searches).toBe(1)
    expect(screen.queryByText(/each run takes/)).toBeNull()
  })
  it('says so when Stop came while the last step was already running and the work finished', async () => {
    const claims = { claims: [{ quote: 'The p99 was 18 ms.', kind: 'factual', matchesId: null, sure: true }] }
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    let searches = 0
    const s = await services({ claims, resolve: { affected: [] } }, MD, async () => 'x', async () => { searches++; await gate; return [] })
    const id = (await s.service.list())[0].id
    await s.service.analyze(id)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.selectOptions(screen.getByLabelText('Adjust', { selector: 'select' }), 'action:verify')
    const stop = await screen.findByRole('button', { name: 'Stop' })
    await waitFor(() => expect(searches).toBe(1))
    await userEvent.click(stop) // the only claim is already being searched: nothing is left to skip
    release()
    expect(await screen.findByText(/Looked at 1 claim/)).toBeInTheDocument()
    expect(await screen.findByText(/Stop came while the last step was already running, so it finished/)).toBeInTheDocument()
  })
  it('offers no search button when no search is set up', async () => {
    const s = await services({ claims: { claims: [{ quote: 'The p99 was 18 ms.', kind: 'factual', matchesId: null, sure: true }] }, resolve: { affected: [] } }, MD)
    await s.service.analyze((await s.service.list())[0].id)
    render(<WriteApp services={s} />)
    await waitForText()
    putCursor('18 ms')
    await dockTab('Sources')
    await within(screen.getByLabelText('Comments and sources for this text')).findByRole('button', { name: /Check this claim/ })
    expect(screen.queryByRole('button', { name: 'Find sources for this claim' })).toBeNull()
  })
})

describe('web links', () => {
  it('reads a pasted link when the browser can, shows when the page changes, and takes the new text only on the writer\'s say', async () => {
    let page = 'p99 latency is 18 ms.'
    const s = await services({ sourceLinks: { claims: [] }, resolve: { impacts: [] } }, MD, async () => page)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    putCursor('18 ms')
    await dockTab('Sources')
    const dock = screen.getByLabelText('Comments and sources for this text')
    await userEvent.type(within(dock).getByLabelText('Add to this text', { selector: 'input' }), 'https://example.com/bench{Enter}')
    await waitFor(async () => expect((await s.service.get(id)).meta.sources[0]).toMatchObject({ kind: 'web', passage: 'p99 latency is 18 ms.' }))
    page = 'p99 latency is now 30 ms.'
    await userEvent.click(await within(dock).findByRole('button', { name: 'Read the page again' }))
    await waitFor(async () => expect((await s.service.get(id)).meta.sources[0].fetchedPassage).toBe('p99 latency is now 30 ms.'))
    expect(await within(dock).findByText(/The page has changed since you read it/)).toBeInTheDocument()
    await userEvent.click(within(dock).getByRole('button', { name: 'Use the new text of this page' }))
    await waitFor(async () => expect((await s.service.get(id)).meta.sources[0]).toMatchObject({ passage: 'p99 latency is now 30 ms.', freshness: 'current' }))
  })
  it('keeps the link and says to paste the passage when pages cannot be read here', async () => {
    const s = await services({ sourceLinks: { claims: [] } }, MD)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    putCursor('18 ms')
    await dockTab('Sources')
    const dock = screen.getByLabelText('Comments and sources for this text')
    await userEvent.type(within(dock).getByLabelText('Add to this text', { selector: 'input' }), 'https://example.com/bench{Enter}')
    expect((await screen.findAllByText(/This browser cannot read web pages/)).length).toBeGreaterThan(0)
    expect((await s.service.get(id)).meta.sources[0]).toMatchObject({ kind: 'web', address: 'https://example.com/bench' })
  })
})

describe('code sources', () => {
  it('stores a GitHub file link as code with the lines of its fragment, and changes the kept lines from the source row', async () => {
    const fetched: string[] = []
    const s = await services({ sourceLinks: { claims: [] }, resolve: { impacts: [] } }, MD, async (u) => { fetched.push(u); return 'one\ntwo\nthree\nfour' })
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    putCursor('18 ms')
    await dockTab('Sources')
    const dock = screen.getByLabelText('Comments and sources for this text')
    await userEvent.type(within(dock).getByLabelText('Add to this text', { selector: 'input' }), 'https://github.com/o/r/blob/main/a.ts#L2-L3{Enter}')
    await waitFor(async () => expect((await s.service.get(id)).meta.sources[0]).toMatchObject({ kind: 'code', passage: 'two\nthree', lines: { from: 2, to: 3 } }))
    expect(fetched).toEqual(['https://raw.githubusercontent.com/o/r/main/a.ts'])
    expect(await within(dock).findByText(/lines 2–3/)).toBeInTheDocument()
    await userEvent.click(within(dock).getByRole('button', { name: 'Change which lines are kept' }))
    await answerDialog('1-4')
    await waitFor(async () => expect((await s.service.get(id)).meta.sources[0]).toMatchObject({ passage: 'one\ntwo\nthree\nfour', lines: { from: 1, to: 4 } }))
  })
})

describe('bringing a page or file in to edit', () => {
  it('reads a web page into a new article, says it is a copy, and offers it only where pages can be read', async () => {
    const base = await services({}, MD, async () => '<html><body><h1>Caching</h1><p>The cache holds 100 items.</p></body></html>')
    render(<WriteApp services={base} />)
    await waitForText()
    await openMenu()
    await userEvent.click(screen.getByRole('button', { name: /Open a web page to edit/ }))
    await answerDialog('https://example.com/post')
    expect((await screen.findAllByText(/This is a copy of the page/)).length).toBeGreaterThan(0)
    await waitFor(async () => expect((await base.service.list()).length).toBe(2))
    const made = (await base.service.list()).find((a) => a.name === 'Caching' || a.title === 'Caching')
    if (!made) throw new Error('no imported article')
    expect((await base.service.get(made.id)).markdown).toBe('# Caching\n\nThe cache holds 100 items.\n')
    cleanup()
    const none = await services({}, MD)
    render(<WriteApp services={none} />)
    await waitForText()
    await openMenu()
    expect(screen.queryByRole('button', { name: /Open a web page to edit/ })).toBeNull()
  })
  it('opens an HTML or MDX file as a copy to edit', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    const file = new File(['<html><body><h1>From a file</h1><p>Body.</p></body></html>'], 'page.html', { type: 'text/html' })
    await userEvent.upload(screen.getByLabelText('Choose an exported article'), file)
    expect((await screen.findAllByText(/This is a copy of the file/)).length).toBeGreaterThan(0)
    await waitFor(async () => expect((await s.service.list()).length).toBe(2))
  })
})

describe('selecting by sentence, paragraph and section', () => {
  const TEXT = '# Post\n\nFirst one. The p99 was 18 ms. Last one.\n\n## Latency\n\nIt is quick.\n'
  const selected = (): string => { const t = screen.getByLabelText('Article text') as HTMLTextAreaElement; return t.value.slice(t.selectionStart, t.selectionEnd) }
  it('grows from the cursor to the sentence, paragraph and section from the keyboard, and shrinks back; there are no select buttons under the text', async () => {
    const s = await services({}, TEXT)
    render(<WriteApp services={s} />)
    await waitForText()
    putCursor('18 ms')
    expect(screen.queryByRole('group', { name: 'Select text' })).toBeNull()
    const box = screen.getByLabelText('Article text')
    const more = (): void => { fireEvent.keyDown(box, { key: 'ArrowUp', altKey: true, shiftKey: true }) }
    const less = (): void => { fireEvent.keyDown(box, { key: 'ArrowDown', altKey: true, shiftKey: true }) }
    more()
    expect(selected()).toBe('The p99 was 18 ms.')
    const dock = (): HTMLElement => screen.getByLabelText('Comments and sources for this text')
    expect(within(dock()).getByText('Sentence')).toBeInTheDocument()
    await dockTab('Links')
    expect(within(dock()).getByText('Sentence')).toBeInTheDocument() // the title names the selection, not the tab
    more()
    expect(selected()).toBe('First one. The p99 was 18 ms. Last one.')
    expect(within(dock()).getByText('Paragraph')).toBeInTheDocument()
    more()
    expect(selected()).toBe(TEXT.trim())
    expect(within(dock()).getByText('Section')).toBeInTheDocument()
    less()
    expect(selected()).toBe('First one. The p99 was 18 ms. Last one.')
  })
})

describe('files from a folder on the computer', () => {
  it('lists a chosen folder, adds a picked file as code for the text, and shows when it changes', async () => {
    const files: Record<string, string> = { 'src/cache.ts': 'const LIMIT = 100', 'README.md': 'hello' }
    const reader = { name: 'repo', files: async () => Object.keys(files), read: async (p: string) => files[p] }
    const base = await services({ sourceLinks: { claims: [] }, resolve: { impacts: [] } }, MD)
    const s = { ...base, pickFolder: async () => reader }
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    putCursor('18 ms')
    await dockTab('Sources')
    const dock = screen.getByLabelText('Comments and sources for this text')
    await userEvent.click(within(dock).getByRole('button', { name: 'Use files from a folder on this computer' }))
    const group = await within(dock).findByRole('group', { name: 'Files in the folder' })
    await userEvent.type(within(group).getByLabelText('Find a file in the folder'), 'cache')
    expect(within(group).queryByRole('button', { name: 'README.md' })).toBeNull()
    await userEvent.click(within(group).getByRole('button', { name: 'src/cache.ts' }))
    await waitFor(async () => expect((await s.service.get(id)).meta.sources[0]).toMatchObject({ kind: 'code', address: 'repo/src/cache.ts', passage: 'const LIMIT = 100' }))
    files['src/cache.ts'] = 'const LIMIT = 50'
    await userEvent.click(within(group).getByRole('button', { name: 'src/cache.ts' }))
    await waitFor(async () => expect((await s.service.get(id)).meta.sources[0].fetchedPassage).toBe('const LIMIT = 50'))
  })
  it('offers no folder button where the browser cannot pick a folder', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    putCursor('18 ms')
    expect(screen.queryByRole('button', { name: 'Use files from a folder on this computer' })).toBeNull()
  })
})

describe('ideas', () => {
  it('is a scratchpad: click, write, and it is kept with the article; nothing else to fill in', async () => {
    const s = await services({}, MD)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Ideas'))
    const ideas = panel('Ideas')
    expect(within(ideas).getAllByRole('textbox')).toHaveLength(1)
    await userEvent.type(within(ideas).getByLabelText('Scratchpad'), 'Mention the re-run')
    await waitFor(async () => expect((await s.service.get(id)).meta.scratchpad).toBe('Mention the re-run'))
  })

  it('starts from the ideas an older article kept in a list', async () => {
    const s = await services({}, MD)
    const id = (await s.service.list())[0].id
    await s.service.addIdea(id, { text: 'An old idea' })
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Ideas'))
    expect(within(panel('Ideas')).getByLabelText('Scratchpad')).toHaveValue('An old idea')
  })
})

describe('phone layout', () => {
  it('opens the chat as a sheet with the text still shown behind it, and closes it again', async () => {
    const s = await services({}, MD)
    const { container } = render(<WriteApp services={s} />)
    await waitForText()
    const text = screen.getByRole('region', { name: 'Text' })
    expect(rail('Chat')).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(rail('Chat'))
    expect(container.querySelector('.write__main')).toHaveAttribute('data-tab', 'chat')
    expect(panel('Chat')).toHaveClass('is-shown')
    expect(text).toHaveClass('is-shown')
    await userEvent.click(screen.getByRole('button', { name: 'Close the chat' }))
    expect(panel('Chat')).not.toHaveClass('is-shown')
    expect(text).toHaveClass('is-shown')
  })
})

describe('style', () => {
  it('has the brief only: no writing profile; a line is filled by clicking it', async () => {
    const s = await services({}, MD)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Style'))
    const style = panel('Style')
    expect(within(style).queryByText(/profile/i)).toBeNull()
    await userEvent.click(within(style).getByRole('button', { name: 'Audience' }))
    await userEvent.type(screen.getByLabelText('Audience'), 'SREs on call{Enter}')
    await waitFor(async () => expect((await s.service.get(id)).meta.brief).toEqual({ audience: 'SREs on call' }))
  })

  it('fills itself in once the article is about a page long', async () => {
    const page = `# Guide\n\n${Array.from({ length: 320 }, (_, i) => `word${i}`).join(' ')}\n`
    const s = await services({ style: { audience: 'Operators', purpose: 'Teach', tone: 'plain', length: 'about 320 words', notes: '', voice: 'direct', terms: [] } }, page)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Style'))
    expect(await within(panel('Style')).findByText('Operators')).toBeInTheDocument()
    expect((await s.service.get(id)).meta.brief).toMatchObject({ audience: 'Operators', tone: 'plain' })
  })

  it('says so in the Style panel when the text could not be read, instead of reading for ever', async () => {
    const page = `# Guide\n\n${Array.from({ length: 320 }, (_, i) => `word${i}`).join(' ')}\n`
    const s = await services({ style: 'this is not json' }, page)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Style'))
    expect(await within(panel('Style')).findByText(/Could not read the text to fill this in/)).toBeInTheDocument()
    expect(within(panel('Style')).queryByText(/Reading the text to fill this in…/)).toBeNull()
  })

  it('waits when there is less than a page of text', async () => {
    const s = await services({ style: { audience: 'Operators', purpose: '', tone: '', length: '', notes: '', voice: '', terms: [] } }, MD)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    await new Promise((r) => setTimeout(r, 100))
    expect((await s.service.get(id)).meta.brief).toBeUndefined()
  })
})

describe('links, history', () => {
  it('Links: shown in the box under the text for the section the selection is in; confirm, and adding one by hand is tucked away', async () => {
    const reply = { links: [{ from: 's3', to: 's2', kind: 'repeats', reason: 'repeats the bound', confidence: 0.8 }] }
    const s = await services({ links: reply }, MD2)
    render(<WriteApp services={s} />)
    await waitForText()
    expect(screen.queryByRole('button', { name: 'Links' })).toBeNull() // not in the rail
    await dockTab('Links')
    const links = panel('Links')
    expect(within(links).getByText(/Click in the text/)).toBeInTheDocument()
    expect(within(links).queryByRole('button', { name: /Look for links between sections/ })).toBeNull() // found from the chat menu, not here
    await userEvent.click(rail('Chat'))
    await userEvent.selectOptions(screen.getByLabelText('Adjust', { selector: 'select' }), 'action:prepare')
    await screen.findByText(/found 1 possible link/)
    expect(s.models.chat()).not.toBe(s.models.auto())
    expect(screen.getAllByTitle('The model that wrote this').at(-1)).toHaveTextContent(s.models.chat()) // started from the chat, so it ran on the chat's model, not the small automatic one
    await userEvent.click(rail('Text'))
    await dockTab('Comments')
    putCursor('So p99 stays')
    await dockTab('Links')
    expect(await within(panel('Links')).findByText(/suggested 80%/)).toBeInTheDocument()
    await userEvent.click(within(panel('Links')).getByRole('button', { name: 'Confirm this link' }))
    expect(await within(panel('Links')).findByText('confirmed')).toBeInTheDocument()
    const details = within(panel('Links')).getByText('Add one yourself').closest('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    putCursor('The p99 was')
    expect(await within(panel('Links')).findByText(/this section/)).toBeInTheDocument() // the other end of the same link
  })

  it('History of the text: how the selected sentence read in earlier versions', async () => {
    const s = await services({}, MD)
    const id = (await s.service.list())[0].id
    await s.service.saveVersion(id, 'First draft')
    await s.service.updateText(id, MD.replace('The p99 was 18 ms.', 'The p99 was 41 ms.'), { analyze: false })
    render(<WriteApp services={s} />)
    await waitForText()
    putCursor('41 ms')
    await dockTab('History')
    const pane = screen.getByRole('tabpanel', { name: 'History of this text' })
    expect(await within(pane).findByText('The p99 was 18 ms.')).toBeInTheDocument()
    expect(within(pane).getByText('First draft')).toBeInTheDocument()
  })

  it('History: each version says what changed, icons are explained at the top, a saved version can be renamed in place, compared and restored', async () => {
    const s = await services({}, MD)
    const id = (await s.service.list())[0].id
    await s.service.saveVersion(id, 'First draft')
    await s.service.updateText(id, MD.replace('18 ms', '41 ms') + '\n## Memory\n\nIt uses 40 MB.\n', { analyze: false })
    await s.service.saveVersion(id, 'Added memory')
    render(<WriteApp services={s} />)
    const box = await waitForText()
    await userEvent.click(rail('History'))
    const history = panel('History')
    const legend = within(history).getByLabelText('What the icons do')
    for (const word of [/View the text/, /Compare with now/, /Restore/]) expect(within(legend).getByText(word)).toBeInTheDocument()
    expect(await within(history).findByText('First version')).toBeInTheDocument()
    expect(within(history).getByText(/^\+\d+ −\d+ lines$/)).toBeInTheDocument() // the level of change, not which sections it touched
    expect(within(history).queryByText(/Latency, Memory/)).toBeNull()
    await userEvent.click(within(history).getAllByRole('button', { name: 'Version name' })[0])
    const input = screen.getByRole('textbox', { name: 'Version name' })
    await userEvent.clear(input)
    await userEvent.type(input, 'Memory added{Enter}')
    expect(await within(history).findByText('Memory added')).toBeInTheDocument()
    await userEvent.click(within(history).getAllByRole('button', { name: 'Compare with now' })[1]) // the oldest: 18 ms became 41 ms
    const detail = await screen.findByLabelText('Version detail')
    expect(detail.querySelector('ins')?.textContent).toBe('41') // the changed word is marked inside its line, not the whole line twice
    expect(detail.querySelector('del')?.textContent).toBe('18')
    expect(within(history).queryByLabelText('Version detail')).toBeNull() // shown in the main text window, not in the side panel
    // the Article / Outline toggle stays at the top and works on the version too
    const show = screen.getByRole('group', { name: 'Show' })
    const which = screen.getByRole('group', { name: 'Which text' })
    expect(which.parentElement).toBe(show.parentElement) // Current / History sit in the same row as Article / Outline...
    expect(which.compareDocumentPosition(show) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy() // ...to the left of it
    expect(screen.getByLabelText('Version detail').compareDocumentPosition(show) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy() // above the version, not under it
    await userEvent.click(within(show).getByRole('button', { name: 'Outline view' }))
    expect(screen.queryByLabelText('Version detail')).toBeNull()
    expect(within(screen.getByLabelText('Version outline')).getByText(/# Post/)).toBeInTheDocument()
    await userEvent.click(within(show).getByRole('button', { name: 'Article view' }))
    expect(await screen.findByLabelText('Version detail')).toBeInTheDocument()
    await userEvent.click(within(screen.getByRole('group', { name: 'Which text' })).getByRole('button', { name: 'Current' }))
    expect(screen.queryByLabelText('Version detail')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Which text' })).toBeNull() // back to the article, nothing left to toggle
    const restore = within(history).getAllByRole('button', { name: 'Restore' }).at(-1)!
    await userEvent.click(restore)
    await answerDialog()
    await waitFor(() => expect(box.value).toContain('18 ms'))
    expect(await within(history).findByText('Before restoring an earlier version')).toBeInTheDocument()
  })
})

describe('repositories on a host with its own network call', () => {
  it('lists a GitHub repository through the host\'s fetch, not the page\'s own', async () => {
    const calls: string[] = []
    const hostFetch = (async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ tree: [{ path: 'src/a.ts', type: 'blob', size: 10 }] }))
    }) as unknown as typeof fetch
    const pageFetch = vi.fn(async () => { throw new Error('the page must not call GitHub itself') })
    vi.stubGlobal('fetch', pageFetch)
    const base = await services({}, MD)
    render(<WriteApp services={{ ...base, githubFetch: hostFetch }} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.selectOptions(screen.getByLabelText('Adjust', { selector: 'select' }), 'action:verify_repo')
    await userEvent.type(screen.getByLabelText('Repository address'), 'github.com/o/r{Enter}')
    await waitFor(() => expect(calls.some((u) => u.includes('/git/trees/'))).toBe(true))
    expect((pageFetch.mock.calls as unknown[][]).filter((c) => c[0] !== '/__mirror')).toEqual([])
    vi.unstubAllGlobals()
  })
})
