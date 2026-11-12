import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { effectiveSourceStatus } from '@buildaharness/aielia'
import { WriteApp, failureText, CHAT_LINES_KEY } from './WriteApp'
import { createSampleServices, SAMPLE_MESSAGE, SAMPLE_BACKEND } from './sample-services'
import { SAMPLE_ARTICLE_ID, buildSampleChat } from './sample-article'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('the keyless sample', () => {
  it('holds one recorded article with something in every pane, and every record points at real text', async () => {
    const s = await createSampleServices()
    expect((await s.service.list()).map((a) => a.id)).toEqual([SAMPLE_ARTICLE_ID])
    const { meta, markdown, snapshots } = await s.service.get(SAMPLE_ARTICLE_ID)
    // Issues: claims without support, a suggestion to review, an open comment, a section to look at, a link to confirm.
    const status = (id: string): string => effectiveSourceStatus(meta.claims.find((c) => c.id === id)!, meta.sources)
    expect(meta.claims.filter((c) => status(c.id) === 'none').length).toBeGreaterThanOrEqual(3)
    expect(meta.claims.some((c) => status(c.id) === 'supported')).toBe(true)
    expect(meta.suggestions.filter((x) => x.state === 'pending').length).toBeGreaterThanOrEqual(1)
    expect(meta.comments.some((c) => c.state === 'open')).toBe(true)
    expect(meta.sections.some((x) => x.review.state === 'needs_review')).toBe(true)
    expect(meta.links.some((l) => l.origin === 'proposed')).toBe(true)
    // Sources, Ideas, Style, History.
    expect(meta.sources.length).toBeGreaterThanOrEqual(2)
    for (const src of meta.sources) expect(src.passage?.trim()).toBeTruthy()
    expect(meta.ideas.filter((i) => i.state === 'open').length).toBeGreaterThanOrEqual(3)
    expect(meta.brief?.audience).toBeTruthy()
    expect(meta.style?.voice).toBeTruthy()
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
    // Every pointer into the text still lands on what it quotes.
    for (const c of meta.claims) expect(markdown).toContain(c.quote)
    for (const x of meta.suggestions.filter((y) => y.state === 'pending')) expect(markdown.slice(x.span.start, x.span.end)).toBe(x.span.quote)
  })

  it('has a recorded chat, behind a line that says it was recorded, and no model was asked', async () => {
    const lines = buildSampleChat()
    expect(lines[0].text).toMatch(/recorded/)
    expect(lines.filter((l) => l.from === 'you').length).toBeGreaterThanOrEqual(4)
    expect(lines.filter((l) => l.from === 'aielia').length).toBeGreaterThanOrEqual(5)
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length)
    const s = await createSampleServices()
    expect(await s.store.getSetting(CHAT_LINES_KEY)).toEqual(lines)
  })

  it('never makes a network call, and a new chat message gets the sample message', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const s = await createSampleServices()
    expect(s.backend).toBe(SAMPLE_BACKEND)
    expect((await s.chat('Check my claims', SAMPLE_ARTICLE_ID)).reply).toBe(`${SAMPLE_MESSAGE}.`)
    // A step that needs a model fails and changes nothing: the pending suggestion that was recorded is still the only one.
    const before = (await s.service.get(SAMPLE_ARTICLE_ID)).meta.suggestions.length
    const r = await s.service.suggest(SAMPLE_ARTICLE_ID, 'Make the intro shorter')
    expect(r.status).toBe('failed')
    expect(r.added).toEqual([])
    expect((await s.service.get(SAMPLE_ARTICLE_ID)).meta.suggestions).toHaveLength(before)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('lets the writer edit by hand, and says it is a sample (not "check your key") when a step needs a model', async () => {
    const s = await createSampleServices()
    const { markdown } = await s.service.get(SAMPLE_ARTICLE_ID)
    const edited = `${markdown}\nOne more line.\n`
    await s.service.updateText(SAMPLE_ARTICLE_ID, edited, { analyze: false })
    expect((await s.service.get(SAMPLE_ARTICLE_ID)).markdown).toBe(edited)
    const text = failureText('The check could not finish', new Error(SAMPLE_MESSAGE), SAMPLE_BACKEND)
    expect(text).toBe(`The check could not finish: ${SAMPLE_MESSAGE}.`)
    expect(text).not.toMatch(/key and the model/)
  })

  it('shows a one-line sample notice with a way to add a key, and shows the recorded chat', async () => {
    const onAddKey = vi.fn()
    const s = await createSampleServices()
    render(<WriteApp services={s} sample={{ onAddKey }} />)
    expect(await screen.findByText('Sample.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Reset sample' })).toBeNull()
    expect(await screen.findByDisplayValue(/# Introducing Aielia Write/)).toBeTruthy()
    expect(await screen.findByText(/These are real cases I ran on this article earlier/)).toBeTruthy()
    expect((await screen.findAllByText(/Added 1 suggestion/)).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Add your key' }))
    expect(onAddKey).toHaveBeenCalledTimes(1)
  })

  it('shows no sample notice on a normal page', async () => {
    const s = await createSampleServices()
    render(<WriteApp services={s} />)
    expect(await screen.findByDisplayValue(/# Introducing Aielia Write/)).toBeTruthy()
    expect(screen.queryByText('Sample.')).toBeNull()
  })
})
