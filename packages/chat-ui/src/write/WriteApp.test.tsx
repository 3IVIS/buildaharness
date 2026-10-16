import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ArticleService, createMemoryArticleStore, createArticleChatPort, type PersonalAssistant } from '@buildaharness/aielia'
import type { ILLMClient } from '@buildaharness/runtime'
import { WriteApp } from './WriteApp'
import { assembleWriteServices } from './write-services'

const MARK = { claims: 'You read parts of an article and list the claims', resolve: 'You help a writer keep an article consistent', edits: 'You propose edits to an article', capture: 'A writer is working with an assistant', ideas: 'You help a writer collect ideas', sourceLinks: 'A writer added a source to an article' }
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
      expect(within(rail).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Text', 'Outline', 'Ideas', 'Issues', 'Links', 'History', 'Chat', 'Settings'])
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

  it('shows a short name in the header, cut off when long, separate from the title in the text, and lets the writer rename it', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await screen.findByLabelText('Article text')
    const head = screen.getByRole('button', { name: 'Article' })
    expect(head).toHaveTextContent('Post')
    expect(head).toHaveAttribute('title', 'Post') // the full name, for when the shown one is cut off
    fireEvent.change(screen.getByLabelText('Article text'), { target: { value: MD.replace('# Post', '# A much longer heading that is the title of the text') } })
    await new Promise((r) => setTimeout(r, 1000))
    expect(screen.getByRole('button', { name: 'Article' })).toHaveTextContent('Post') // the name does not follow the heading
    vi.spyOn(window, 'prompt').mockReturnValue('Q3 write-up')
    await userEvent.click(screen.getByRole('button', { name: 'Article' }))
    await userEvent.click(screen.getByRole('button', { name: /Rename this article/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Article' })).toHaveTextContent('Q3 write-up'))
  })

  it('opens a list of articles from the name, to switch between them', async () => {
    const s = await services({}, MD)
    await s.service.create('Second article', '# Second\n\ntext\n')
    render(<WriteApp services={s} />)
    await screen.findByLabelText('Article text')
    await userEvent.click(screen.getByRole('button', { name: 'Article' }))
    const list = screen.getByRole('listbox', { name: 'Articles' })
    expect(within(list).getAllByRole('option')).toHaveLength(2) // the two articles; the rename entry is an action, not an article
    await userEvent.click(within(list).getByRole('button', { name: 'Second article' }))
    await waitFor(() => expect((screen.getByLabelText('Article text') as HTMLTextAreaElement).value).toContain('# Second'))
  })
})

describe('WriteApp history and outline details', () => {
  it('each version says what changed since the one before it, and the icons are explained at the top', async () => {
    const s = await services({}, MD)
    const id = (await s.service.list())[0].id
    await s.service.saveVersion(id, 'First draft')
    await s.service.updateText(id, MD.replace('18 ms', '41 ms') + '\n## Memory\n\nIt uses 40 MB.\n', { analyze: false })
    await s.service.saveVersion(id, 'Added memory')
    render(<WriteApp services={s} />)
    await screen.findByLabelText('Article text')
    await userEvent.click(screen.getByRole('button', { name: 'History' }))
    const legend = screen.getByLabelText('What the icons do')
    expect(within(legend).getByText(/View the text/)).toBeInTheDocument()
    expect(within(legend).getByText(/Compare with now/)).toBeInTheDocument()
    expect(within(legend).getByText(/Restore/)).toBeInTheDocument()
    const region = screen.getByRole('region', { name: 'History' })
    expect(await within(region).findByText('First version')).toBeInTheDocument()
    expect(within(region).getByText(/Latency, Memory/)).toBeInTheDocument()
    expect(within(region).getAllByRole('button', { name: 'Restore' })).toHaveLength(3) // includes the automatic checkpoint before the large change
    expect(within(region).getByText('Before a large change')).toBeInTheDocument()
    expect(within(region).getByText(/No text changes since the last version/)).toBeInTheDocument()
  })

  it('indents only real sub-headings, and shows the title on top without an indent', async () => {
    const md = '# Post\n\n## One\n\ntext\n\n### One point one\n\ntext\n\n## Two\n\ntext\n'
    const s = await services({}, md)
    render(<WriteApp services={s} />)
    await screen.findByLabelText('Article text')
    const outline = screen.getByRole('region', { name: 'Outline' })
    const li = (name: string) => within(outline).getByRole('button', { name }).closest('li') as HTMLElement
    expect(li('Post').style.marginLeft).toBe('0px')
    expect(li('One').style.marginLeft).toBe('0px')
    expect(li('Two').style.marginLeft).toBe('0px')
    expect(li('One point one').style.marginLeft).toBe('16px')
    expect(li('One point one').className).toContain('is-nested')
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
    expect(screen.queryByRole('button', { name: 'Check article' })).toBeNull() // no longer in the header
    await userEvent.click(screen.getByRole('button', { name: 'Chat' }))
    await userEvent.click(screen.getByRole('button', { name: /Check article with/ }))
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
    fireEvent.click(screen.getByRole('button', { name: /Check article with/ }))
    expect(await screen.findByText('storage is full')).toBeInTheDocument()
  })
})


describe('WriteApp chat: adjust, model, check', () => {
  it('sends an adjustment as an ordinary chat message and the edits come back as suggestions, labelled with the model', async () => {
    const s = await services({ capture: { articleId: null, ops: [] }, edits: { suggestions: [{ quote: 'It is quick.', replacement: 'It is, well, quick.', reason: 'more conversational' }] } }, MD + '\nIt is quick.\n')
    render(<WriteApp services={s} />)
    await screen.findByLabelText('Article text')
    await userEvent.click(screen.getByRole('button', { name: 'Chat' }))
    await userEvent.selectOptions(screen.getByLabelText('Adjust', { selector: 'select' }), 'tone-of-voice')
    const how = screen.getByLabelText('How')
    expect(document.querySelector(`datalist[id="${how.getAttribute('list')}"]`)?.querySelectorAll('option').length).toBeGreaterThan(5)
    await userEvent.type(how, 'Conversational')
    await userEvent.click(screen.getByRole('button', { name: 'Send adjustment' }))
    expect(await screen.findByText(/tone of voice is: Conversational/)).toBeInTheDocument() // shown as the writer's own message
    expect(await screen.findByText(/added 1 suggested change/)).toBeInTheDocument()
    expect(screen.getAllByTitle('The model that wrote this').length).toBeGreaterThan(0)
  })

  it('lets the writer adjust something that is not listed', async () => {
    const s = await services({ capture: { articleId: null, ops: [] }, edits: { suggestions: [] } }, MD)
    render(<WriteApp services={s} />)
    await screen.findByLabelText('Article text')
    await userEvent.click(screen.getByRole('button', { name: 'Chat' }))
    await userEvent.selectOptions(screen.getByLabelText('Adjust', { selector: 'select' }), 'other')
    await userEvent.type(screen.getByLabelText('What to adjust'), 'pacing')
    await userEvent.type(screen.getByLabelText('How'), 'slower in the middle')
    await userEvent.click(screen.getByRole('button', { name: 'Send adjustment' }))
    expect(await screen.findByText(/pacing is: slower in the middle/)).toBeInTheDocument()
  })

  it('the model picked next to the chat title is the one used and shown for the answer and for the check', async () => {
    const s = await services({ capture: { articleId: null, ops: [] }, claims: { claims: [{ quote: 'The p99 was 18 ms.', kind: 'factual', matchesId: null, sure: true }] }, resolve: { affected: [] } }, MD)
    render(<WriteApp services={s} />)
    await screen.findByLabelText('Article text')
    await userEvent.click(screen.getByRole('button', { name: 'Chat' }))
    const picker = screen.getByLabelText('Model for the chat')
    await userEvent.clear(picker)
    await userEvent.type(picker, 'my-own-model')
    fireEvent.blur(picker)
    await waitFor(() => expect(s.models.chat()).toBe('my-own-model'))
    await userEvent.type(screen.getByLabelText('Message'), 'hello')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Noted.')).toBeInTheDocument()
    expect(screen.getAllByTitle('The model that wrote this')[0]).toHaveTextContent('my-own-model')
    await userEvent.click(screen.getByRole('button', { name: 'Check article with my-own-model' }))
    expect(await screen.findByText(/I found 1 factual claim/)).toBeInTheDocument()
    expect(screen.getAllByTitle('The model that wrote this').at(-1)).toHaveTextContent('my-own-model')
  })

  it('warns in Settings when the automatic checks use the same model as the chat', async () => {
    const s = await services({}, MD)
    await s.models.setAuto(s.models.chat())
    render(<WriteApp services={s} />)
    await screen.findByLabelText('Article text')
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(await screen.findByText(/same model as the chat/)).toBeInTheDocument()
  })
})

describe('WriteApp sources under the text', () => {
  const putCursor = (needle: string): void => {
    const box = screen.getByLabelText('Article text') as HTMLTextAreaElement
    const at = box.value.indexOf(needle)
    box.setSelectionRange(at, at)
    fireEvent.select(box)
  }

  it('shows the sources for the sentence under the cursor, adds one there, and detaches it', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await screen.findByLabelText('Article text')
    expect(screen.queryByRole('button', { name: 'Sources' })).toBeNull() // no Sources tab any more
    expect(screen.getByText(/Click in the text to see its sources/)).toBeInTheDocument()
    putCursor('18 ms')
    const dock = screen.getByLabelText('Sources for this text')
    expect(within(dock).getByText(/The p99 was 18 ms\./)).toBeInTheDocument()
    await userEvent.type(within(dock).getByLabelText('Source text'), 'p99 latency: 18 ms')
    await userEvent.click(within(dock).getByRole('button', { name: 'Add source' }))
    expect(await within(dock).findByText(/p99 latency: 18 ms/)).toBeInTheDocument()
    expect(within(dock).getByText('attached, not checked')).toBeInTheDocument()
    await userEvent.click(within(dock).getByRole('button', { name: 'Detach' }))
    await waitFor(() => expect(within(dock).getByText('No source attached.')).toBeInTheDocument())
  })

  it('attaches a dropped text file to the text under the cursor, and says so for a file it cannot read', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await screen.findByLabelText('Article text')
    putCursor('18 ms')
    const dock = screen.getByLabelText('Sources for this text')
    const good = new File(['p99: 18 ms measured on 8 cores'], 'bench.txt', { type: 'text/plain' })
    const bad = new File(['%PDF'], 'paper.pdf', { type: 'application/pdf' })
    fireEvent.drop(dock, { dataTransfer: { files: [good, bad] } })
    expect((await within(dock).findAllByText('bench.txt')).length).toBeGreaterThan(0) // on the claim, and in the list of all sources
    expect(await screen.findByText(/paper\.pdf: only text files can be read/)).toBeInTheDocument()
  })

  it('a file dropped into the chat is stored and the assistant proposes where it belongs, to confirm under the text', async () => {
    const s = await services({ sourceLinks: { claims: [{ claimId: 'k1', relation: 'supports', reason: 'same figure', confidence: 0.9 }] } }, MD)
    const id = (await s.service.list())[0].id
    const at = MD.indexOf('18 ms')
    const first = await s.service.addSource(id, { kind: 'upload', passage: 'first' })
    await s.service.attachSourceToText(id, { start: at, end: at }, first) // makes claim k1
    await s.service.detachSource(id, 'k1', first)
    render(<WriteApp services={s} />)
    await screen.findByLabelText('Article text')
    await userEvent.click(screen.getByRole('button', { name: 'Chat' }))
    fireEvent.drop(screen.getByRole('region', { name: 'Chat' }), { dataTransfer: { files: [new File(['p99 is 18 ms'], 'notes.txt', { type: 'text/plain' })] } })
    expect(await screen.findByText(/notes\.txt: added/)).toBeInTheDocument()
    putCursor('18 ms')
    const dock = screen.getByLabelText('Sources for this text')
    expect((await within(dock).findAllByText('notes.txt')).length).toBeGreaterThan(0)
    expect(within(dock).getByText(/suggested 90%/)).toBeInTheDocument()
    await userEvent.click(within(dock).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(within(dock).queryByText(/suggested 90%/)).toBeNull())
  })
})

describe('WriteApp ideas', () => {
  it('collects ideas, lets the assistant suggest more (marked with the model), writes chosen ones in as suggestions, and marks them used when accepted', async () => {
    const s = await services({
      capture: { articleId: null, ops: [] },
      ideas: { ideas: [{ text: 'Say what 18 ms means for users', sectionId: null }] },
      edits: { suggestions: [{ quote: 'The p99 was 18 ms.', replacement: 'The p99 was 18 ms, which users cannot notice.', reason: 'idea', ideaIds: ['id1'] }] },
    }, MD)
    render(<WriteApp services={s} />)
    await screen.findByLabelText('Article text')
    await userEvent.click(screen.getByRole('button', { name: 'Ideas' }))
    const panel = screen.getByRole('region', { name: 'Ideas' })
    await userEvent.type(within(panel).getByLabelText('New idea'), 'Mention the re-run')
    await userEvent.click(within(panel).getByRole('button', { name: 'Add idea' }))
    expect(await within(panel).findByText('Mention the re-run')).toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: /Suggest ideas with/ }))
    expect(await within(panel).findByText('Say what 18 ms means for users')).toBeInTheDocument()
    expect(within(panel).getByText(/Aielia · /)).toBeInTheDocument()
    await userEvent.click(within(panel).getByLabelText('Choose: Mention the re-run'))
    await userEvent.click(within(panel).getByRole('button', { name: /^Write 1 into the article with/ }))
    expect(await screen.findByText(/added 1 suggested change from your ideas/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Issues' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    await waitFor(async () => {
      const b = await s.service.get((await s.service.list())[0].id)
      expect(b.meta.ideas.find((i) => i.text === 'Mention the re-run')?.state).toBe('used')
    })
  })
})
