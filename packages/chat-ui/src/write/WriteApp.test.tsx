import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ArticleService, createMemoryArticleStore, type PersonalAssistant } from '@buildaharness/aielia'
import type { ILLMClient } from '@buildaharness/runtime'
import { WriteApp } from './WriteApp'
import { assembleWriteServices } from './write-services'

const MARK = {
  claims: 'You read parts of an article and list the claims',
  resolve: 'You help a writer keep an article consistent',
  edits: 'You propose edits to an article',
  capture: 'A writer is working with an assistant',
  ideas: 'You help a writer collect ideas',
  sourceLinks: 'A writer added a source to an article',
  support: 'You check whether a claim from an article',
  links: 'You map how the sections',
}
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
async function servicesOn(store: ReturnType<typeof createMemoryArticleStore>, replies: Parameters<typeof llm>[0], fetchWeb?: (url: string) => Promise<string>) {
  return assembleWriteServices({ store, llm: llm(replies), fetchWeb, buildAssistant: async () => ({ turn: async () => ({ reply: 'Noted.' }), setModel: () => undefined }) as unknown as PersonalAssistant })
}
async function services(replies: Parameters<typeof llm>[0], seed?: string, fetchWeb?: (url: string) => Promise<string>) {
  const s = await servicesOn(createMemoryArticleStore(), replies, fetchWeb)
  if (seed) await s.service.create('Post', seed)
  return s
}
afterEach(() => {
  vi.restoreAllMocks()
})

const MD = '# Post\n\n## Latency\n\nThe p99 was 18 ms.\n'
const MD2 = '# Post\n\n## Latency\n\nThe p99 was 18 ms. It is quick.\n\n## Conclusion\n\nSo p99 stays under 20 ms.\n'
const openMenu = (): Promise<void> => userEvent.click(screen.getByRole('button', { name: 'Article' }))
const rail = (name: string): HTMLElement => within(screen.getByRole('navigation', { name: 'Panels' })).getByRole('button', { name })
const panel = (name: string): HTMLElement => screen.getByRole('region', { name })
const waitForText = async (): Promise<HTMLTextAreaElement> => (await screen.findByLabelText('Article text')) as HTMLTextAreaElement
const putCursor = (needle: string): void => {
  const box = screen.getByLabelText('Article text') as HTMLTextAreaElement
  const at = box.value.indexOf(needle)
  box.setSelectionRange(at, at)
  fireEvent.select(box)
}
const wide = <T,>(fn: () => Promise<T>): Promise<T> => {
  const original = window.matchMedia
  window.matchMedia = ((q: string) => ({ matches: q.includes('min-width: 640px'), media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  return fn().finally(() => { window.matchMedia = original })
}

describe('header and article menu', () => {
  it('has only Publish in the header; New, Rename, Export and Import are in the article menu', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument()
    for (const gone of ['New', 'Export', 'Import', 'Check article']) expect(screen.queryByRole('button', { name: gone })).toBeNull()
    await openMenu()
    const menu = screen.getByRole('listbox', { name: 'Articles' })
    for (const item of [/New article/, /Rename this article/, /Export this article/, /Import an article/]) expect(within(menu).getByRole('button', { name: item })).toBeInTheDocument()
  })

  it('starts empty, creates an article from the menu, and shows its sections in the outline', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('My post')
    render(<WriteApp services={await services({})} />)
    expect(screen.getByText(/Create an article, or import one/)).toBeInTheDocument()
    await openMenu()
    await userEvent.click(screen.getByRole('button', { name: /New article/ }))
    const box = await waitForText()
    expect(box.value).toContain('# My post')
    await userEvent.click(rail('Outline'))
    expect(within(panel('Outline')).getByText('My post')).toBeInTheDocument()
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
    vi.spyOn(window, 'prompt').mockReturnValue('Q3 write-up')
    await openMenu()
    await userEvent.click(screen.getByRole('button', { name: /Rename this article/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Article' })).toHaveTextContent('Q3 write-up'))
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
    vi.spyOn(window, 'prompt').mockReturnValue('v1')
    render(<WriteApp services={await servicesOn(store, {})} />)
    await waitForText()
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }))
    expect(await screen.findByText(/1 item was still open/)).toBeInTheDocument()
    expect((await svc.get(id)).snapshots).toHaveLength(1)
  })

  it('shows an error from the service instead of failing silently', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={{ ...s, service: Object.assign(s.service, { updateText: async () => { throw new Error('storage is full') } }) }} />)
    await waitForText()
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }))
    expect(await screen.findByText('storage is full')).toBeInTheDocument()
  })
})

describe('rail and panels', () => {
  it('has a rail of buttons; on desktop the panel opens from the rail and closes when the same button is clicked again', () =>
    wide(async () => {
      const s = await services({}, MD)
      const { container } = render(<WriteApp services={s} />)
      await waitForText()
      const main = container.querySelector('.write__main') as HTMLElement
      expect(within(screen.getByRole('navigation', { name: 'Panels' })).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Text', 'Outline', 'Style', 'Ideas', 'Issues', 'Links', 'History', 'Chat', 'Settings'])
      expect(main.dataset.open).toBe('true')
      await userEvent.click(rail('Outline'))
      expect(main.dataset.open).toBe('false')
      await userEvent.click(rail('History'))
      expect(main.dataset.open).toBe('true')
      expect(panel('History').className).toContain('is-shown')
      expect(panel('Outline').className).not.toContain('is-shown')
    }))

  it('counts what needs attention on the Issues button', async () => {
    const s = await services({}, MD)
    const id = (await s.service.list())[0].id
    await s.service.addComment(id, { start: 0, end: 0 }, 'x') // no text under a click at 0? the heading line is a unit
    render(<WriteApp services={s} />)
    await waitForText()
    expect(within(rail('Issues')).getByLabelText(/1 issue/)).toBeInTheDocument()
  })
})

describe('outline: edited in place', () => {
  it('shows the title on top, indents only sub-headings, and jumps to a heading on a click', async () => {
    const md = '# Post\n\n## One\n\ntext\n\n### One point one\n\ntext\n\n## Two\n\ntext\n'
    const s = await services({}, md)
    render(<WriteApp services={s} />)
    const box = await waitForText()
    await userEvent.click(rail('Outline'))
    const li = (name: string) => within(panel('Outline')).getByRole('button', { name: `Heading: ${name}` }).closest('li') as HTMLElement
    expect(li('Post').style.marginLeft).toBe('0px')
    expect(li('One').style.marginLeft).toBe('0px')
    expect(li('One point one').style.marginLeft).toBe('16px')
    await userEvent.click(within(panel('Outline')).getByRole('button', { name: 'Heading: Two' }))
    expect(box.selectionStart).toBe(md.indexOf('## Two'))
  })

  it('renames a heading by double-clicking it: the heading in the text changes and nothing else does', async () => {
    const s = await services({}, MD2)
    render(<WriteApp services={s} />)
    const box = await waitForText()
    await userEvent.click(rail('Outline'))
    await userEvent.dblClick(within(panel('Outline')).getByRole('button', { name: 'Heading: Latency' }))
    const input = screen.getByLabelText('Heading: Latency')
    await userEvent.clear(input)
    await userEvent.type(input, 'Response time{Enter}')
    await waitFor(() => expect(box.value).toContain('## Response time\n'))
    expect(box.value).toContain('The p99 was 18 ms. It is quick.')
    expect(within(panel('Outline')).getByRole('button', { name: 'Heading: Response time' })).toBeInTheDocument()
  })

  it('lets the writer say what a section is for by clicking the line under it, and Escape puts it back', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Outline'))
    await userEvent.click(within(panel('Outline')).getByRole('button', { name: 'Purpose of Latency' }))
    await userEvent.type(screen.getByLabelText('Purpose of Latency'), 'Show the p99{Enter}')
    expect(await within(panel('Outline')).findByText('Show the p99')).toBeInTheDocument()
    await userEvent.click(within(panel('Outline')).getByRole('button', { name: 'Purpose of Latency' }))
    await userEvent.type(screen.getByLabelText('Purpose of Latency'), ' extra{Escape}')
    expect(within(panel('Outline')).getByText('Show the p99')).toBeInTheDocument()
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

  it('"Check the article" is an action in the Adjust list, runs as soon as it is picked, and says which model checked', async () => {
    const s = await services({ capture: { articleId: null, ops: [] }, claims: { claims: [{ quote: 'The p99 was 18 ms.', kind: 'factual', matchesId: null, sure: true }] }, resolve: { affected: [] } }, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.selectOptions(screen.getByLabelText('Adjust', { selector: 'select' }), 'action:check')
    expect(await screen.findByText(/I found 1 factual claim/)).toBeInTheDocument()
    expect(screen.getAllByTitle('The model that wrote this').at(-1)).toHaveTextContent(s.models.chat())
  })

  it('underlines the claims it found in the text, and says what the tones mean', async () => {
    const s = await services({ capture: { articleId: null, ops: [] }, claims: { claims: [{ quote: 'The p99 was 18 ms.', kind: 'factual', matchesId: null, sure: true }] }, resolve: { affected: [] } }, MD)
    const { container } = render(<WriteApp services={s} />)
    await waitForText()
    expect(container.querySelector('mark')).toBeNull()
    await userEvent.click(rail('Chat'))
    await userEvent.selectOptions(screen.getByLabelText('Adjust', { selector: 'select' }), 'action:check')
    await screen.findByText(/I found 1 factual claim/)
    await waitFor(() => expect(container.querySelector('mark')?.textContent).toBe('The p99 was 18 ms.'))
    expect(container.querySelector('mark')).toHaveClass('write__mark--look')
    expect(screen.getByText(/Underlined claims:/)).toHaveTextContent('needs a look')
    expect(container.querySelector('.write__backdrop')).toHaveAttribute('aria-hidden', 'true')
  })

  it('an adjustment is sent with Enter as an ordinary chat message, and the edits come back as suggestions', async () => {
    const s = await services({ capture: { articleId: null, ops: [] }, edits: { suggestions: [{ quote: 'It is quick.', replacement: 'It is, well, quick.', reason: 'more conversational' }] } }, MD2)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.selectOptions(screen.getByLabelText('Adjust', { selector: 'select' }), 'tone-of-voice')
    expect(screen.queryByRole('button', { name: /Send adjustment/ })).toBeNull() // no extra button: Enter sends
    await userEvent.type(screen.getByLabelText('How'), 'Conversational{Enter}')
    expect(await screen.findByText(/tone of voice is: Conversational/)).toBeInTheDocument()
    expect(await screen.findByText(/added 1 suggested change/)).toBeInTheDocument()
  })

  it('lets the writer adjust something that is not listed', async () => {
    const s = await services({ capture: { articleId: null, ops: [] }, edits: { suggestions: [] } }, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Chat'))
    await userEvent.selectOptions(screen.getByLabelText('Adjust', { selector: 'select' }), 'other')
    await userEvent.type(screen.getByLabelText('What to adjust'), 'pacing')
    await userEvent.type(screen.getByLabelText('How'), 'slower in the middle{Enter}')
    expect(await screen.findByText(/pacing is: slower in the middle/)).toBeInTheDocument()
  })

  it('warns in Settings when the automatic checks use the same model as the chat', async () => {
    const s = await services({}, MD)
    await s.models.setAuto(s.models.chat())
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Settings'))
    expect(await screen.findByText(/same model as the chat/)).toBeInTheDocument()
  })

  it('shows the defaults in Settings, saves a change, and applies the spending cap', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Settings'))
    const auto = await screen.findByLabelText(/Check claims and effects by itself/)
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
    const group = (title: string): HTMLElement => within(issues).getByText(title).closest('details') as HTMLElement
    expect(within(group('Suggested changes')).getByRole('button', { name: 'Accept all' })).toBeInTheDocument()
    expect(within(group('Reviewer comments')).getByRole('button', { name: 'Suggest fixes' })).toBeInTheDocument()
    expect(within(group('Claims without support')).getByRole('button', { name: 'Suggest fixes' })).toBeInTheDocument()
    expect(within(issues).getByText(/Conflicts with C5/)).toBeInTheDocument() // listed apart, no batch action for it
    expect(within(issues).getByRole('button', { name: 'Resolve all' })).toBeInTheDocument()
  })

  it('"Accept all" applies every waiting suggestion at once and says what it did', async () => {
    const { s } = await seed({}, (m) => ({ ...m, suggestions: [sg('sg1', '18 ms', '41 ms'), sg('sg2', 'under 20 ms', 'under 41 ms')] }))
    const box = await open(s)
    await userEvent.click(within(panel('Issues')).getByRole('button', { name: 'Accept all' }))
    await waitFor(() => expect(box.value).toContain('41 ms.'))
    expect(box.value).toContain('under 41 ms')
    expect(await within(panel('Issues')).findByText(/2 accepted/)).toBeInTheDocument()
  })

  it('a suggestion\'s replacement text is edited where it stands, and the edited text is what is accepted', async () => {
    const { s } = await seed({}, (m) => ({ ...m, suggestions: [sg('sg1', '18 ms', '41 ms')] }))
    const box = await open(s)
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
    const comments = within(panel('Issues')).getByText('Reviewer comments').closest('details') as HTMLElement
    await userEvent.click(within(comments).getByRole('button', { name: 'Suggest fixes' }))
    expect(await within(panel('Issues')).findByText(/1 suggested change/)).toBeInTheDocument()
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

describe('comments and sources under the text', () => {
  it('asks you to click in the text first, and shows what is under the cursor', async () => {
    const s = await services({}, MD)
    render(<WriteApp services={s} />)
    await waitForText()
    expect(screen.getByText(/Click in the text, or highlight some/)).toBeInTheDocument()
    expect(screen.getByLabelText('Add to this text', { selector: 'input' })).toBeDisabled()
    putCursor('18 ms')
    expect(screen.getByLabelText('Add to this text', { selector: 'input' })).toBeEnabled()
    expect(within(screen.getByLabelText('Comments and sources for this text')).getByText(/The p99 was 18 ms\./)).toBeInTheDocument()
  })

  it('adds a comment on the sentence with Enter, edits it where it stands, marks it dealt with and deletes it', async () => {
    const s = await services({}, MD)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    putCursor('18 ms')
    const dock = screen.getByLabelText('Comments and sources for this text')
    await userEvent.type(within(dock).getByLabelText('Add to this text', { selector: 'input' }), 'Is this the median?{Enter}')
    expect(await within(dock).findByText('Is this the median?')).toBeInTheDocument()
    expect((await s.service.get(id)).meta.comments[0].span?.quote).toBe('The p99 was 18 ms.')
    await userEvent.click(within(dock).getByText('Is this the median?'))
    const input = within(dock).getByLabelText('Comment', { selector: 'textarea' })
    await userEvent.clear(input)
    await userEvent.type(input, 'Is this p99 or the median?{Enter}')
    await waitFor(async () => expect((await s.service.get(id)).meta.comments[0].text).toBe('Is this p99 or the median?'))
    await userEvent.click(within(dock).getByRole('button', { name: 'Mark as dealt with' }))
    await waitFor(async () => expect((await s.service.get(id)).meta.comments[0].state).toBe('addressed'))
    await userEvent.click(within(dock).getByRole('button', { name: 'Delete the comment' }))
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
    await userEvent.type(screen.getByLabelText('Add to this text', { selector: 'input' }), 'Tighten this paragraph{Enter}')
    await waitFor(async () => expect((await s.service.get(id)).meta.comments[0].span?.quote).toBe(MD2.slice(start, end)))
  })

  it('a pasted passage or a link becomes a source for the text; the unit switch picks what is added; one icon removes it', async () => {
    const s = await services({}, MD)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    putCursor('18 ms')
    const dock = screen.getByLabelText('Comments and sources for this text')
    await userEvent.click(within(dock).getByRole('button', { name: 'Source' }))
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
    const dock = screen.getByLabelText('Comments and sources for this text')
    fireEvent.drop(dock, { dataTransfer: { files: [new File(['p99: 18 ms measured on 8 cores'], 'bench.txt', { type: 'text/plain' }), new File(['%PDF'], 'paper.pdf', { type: 'application/pdf' })] } })
    expect(await within(dock).findByText('bench.txt')).toBeInTheDocument()
    expect(await screen.findByText(/paper\.pdf: only text files can be read/)).toBeInTheDocument()
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
    const dock = screen.getByLabelText('Comments and sources for this text')
    expect(await within(dock).findByText('notes.txt')).toBeInTheDocument()
    expect(within(dock).getByText(/suggested 90%/)).toBeInTheDocument()
    await userEvent.click(within(dock).getByRole('button', { name: 'Use this source' }))
    await waitFor(() => expect(within(dock).queryByText(/suggested 90%/)).toBeNull())
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
    const dock = screen.getByLabelText('Comments and sources for this text')
    await userEvent.click(within(dock).getByRole('button', { name: 'Source' }))
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
    const dock = screen.getByLabelText('Comments and sources for this text')
    await userEvent.click(within(dock).getByRole('button', { name: 'Source' }))
    await userEvent.type(within(dock).getByLabelText('Add to this text', { selector: 'input' }), 'https://example.com/bench{Enter}')
    expect(await screen.findByText(/This browser cannot read web pages/)).toBeInTheDocument()
    expect((await s.service.get(id)).meta.sources[0]).toMatchObject({ kind: 'web', address: 'https://example.com/bench' })
  })
})

describe('ideas', () => {
  it('adds an idea with Enter, edits it where it stands, asks Aielia for more with Enter, and writes one or all into the article', async () => {
    const s = await services({
      capture: { articleId: null, ops: [] },
      ideas: { ideas: [{ text: 'Say what 18 ms means for users', sectionId: null }] },
      edits: { suggestions: [{ quote: 'The p99 was 18 ms.', replacement: 'The p99 was 18 ms, which users cannot notice.', reason: 'idea', ideaIds: ['id2'] }] },
    }, MD)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Ideas'))
    const ideas = panel('Ideas')
    await userEvent.type(within(ideas).getByLabelText('New idea'), 'Mention the re-run{Enter}')
    expect(await within(ideas).findByText('Mention the re-run')).toBeInTheDocument()
    await userEvent.click(within(ideas).getByRole('button', { name: 'Idea' }))
    const edit = screen.getByLabelText('Idea')
    await userEvent.clear(edit)
    await userEvent.type(edit, 'Mention the re-run on 15 October{Enter}')
    expect(await within(ideas).findByText('Mention the re-run on 15 October')).toBeInTheDocument()
    await userEvent.type(within(ideas).getByLabelText('Ask Aielia for ideas about'), '{Enter}')
    expect(await within(ideas).findByText('Say what 18 ms means for users')).toBeInTheDocument()
    expect(within(ideas).getByText(/Aielia · /)).toBeInTheDocument()
    expect(within(ideas).getByRole('button', { name: /Write all 2 into the article/ })).toBeInTheDocument()
    await userEvent.click(within(ideas).getAllByRole('button', { name: /Write this into the article with/ })[1])
    expect(await screen.findByText(/added 1 suggested change from your ideas/)).toBeInTheDocument()
    await userEvent.click(rail('Issues'))
    await userEvent.click(await within(panel('Issues')).findByRole('button', { name: 'Accept' }))
    await waitFor(async () => expect((await s.service.get(id)).meta.ideas.find((i) => i.id === 'id2')?.state).toBe('used'))
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
  it('fills the brief by clicking, saves a writing profile once and uses it in the article', async () => {
    const s = await services({}, MD)
    const id = (await s.service.list())[0].id
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Style'))
    const style = panel('Style')
    await userEvent.click(within(style).getByRole('button', { name: 'Audience' }))
    await userEvent.type(screen.getByLabelText('Audience'), 'SREs on call{Enter}')
    await waitFor(async () => expect((await s.service.get(id)).meta.brief).toEqual({ audience: 'SREs on call' }))
    await userEvent.click(within(style).getByRole('button', { name: 'New profile' }))
    await userEvent.type(within(style).getByLabelText('Profile name'), 'House')
    await userEvent.type(within(style).getByLabelText('Voice'), 'plain and direct')
    await userEvent.type(within(style).getByLabelText('Terms'), 'customer | user')
    await userEvent.click(within(style).getByRole('button', { name: 'Save profile' }))
    await waitFor(async () => expect((await s.service.get(id)).meta.style).toMatchObject({ name: 'House', voice: 'plain and direct', terms: [{ use: 'customer', instead: 'user' }] }))
    expect(await within(style).findByText(/plain and direct · 1 term/)).toBeInTheDocument()
    await userEvent.selectOptions(within(style).getByLabelText('Writing profile'), '')
    await waitFor(async () => expect((await s.service.get(id)).meta.style).toBeUndefined())
    expect((await s.service.profiles()).map((p) => p.name)).toEqual(['House'])
  })
})

describe('links, history', () => {
  it('Links: finds links, confirms one with an icon, and adding one by hand is tucked away', async () => {
    const reply = { links: [{ from: 's3', to: 's2', kind: 'repeats', reason: 'repeats the bound', confidence: 0.8 }] }
    const s = await services({ links: reply }, MD2)
    render(<WriteApp services={s} />)
    await waitForText()
    await userEvent.click(rail('Links'))
    const links = panel('Links')
    await userEvent.click(within(links).getByRole('button', { name: 'Find links' }))
    expect(await within(links).findByText(/suggested 80%/)).toBeInTheDocument()
    await userEvent.click(within(links).getByRole('button', { name: 'Confirm this link' }))
    expect(await within(links).findByText('confirmed')).toBeInTheDocument()
    const details = within(links).getByText('Add one yourself').closest('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
  })

  it('History: each version says what changed, icons are explained at the top, a saved version can be renamed in place, compared and restored', async () => {
    const s = await services({}, MD)
    const id = (await s.service.list())[0].id
    await s.service.saveVersion(id, 'First draft')
    await s.service.updateText(id, MD.replace('18 ms', '41 ms') + '\n## Memory\n\nIt uses 40 MB.\n', { analyze: false })
    await s.service.saveVersion(id, 'Added memory')
    render(<WriteApp services={s} />)
    const box = await waitForText()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await userEvent.click(rail('History'))
    const history = panel('History')
    const legend = within(history).getByLabelText('What the icons do')
    for (const word of [/View the text/, /Compare with now/, /Restore/]) expect(within(legend).getByText(word)).toBeInTheDocument()
    expect(await within(history).findByText('First version')).toBeInTheDocument()
    expect(within(history).getByText(/Latency, Memory/)).toBeInTheDocument()
    await userEvent.click(within(history).getAllByRole('button', { name: 'Version name' })[0])
    const input = screen.getByRole('textbox', { name: 'Version name' })
    await userEvent.clear(input)
    await userEvent.type(input, 'Memory added{Enter}')
    expect(await within(history).findByText('Memory added')).toBeInTheDocument()
    await userEvent.click(within(history).getAllByRole('button', { name: 'Compare with now' })[0])
    expect(await screen.findByLabelText('Version detail')).toBeInTheDocument()
    const restore = within(history).getAllByRole('button', { name: 'Restore' }).at(-1)!
    await userEvent.click(restore)
    await waitFor(() => expect(box.value).toContain('18 ms'))
    expect(await within(history).findByText('Before restoring an earlier version')).toBeInTheDocument()
  })
})
