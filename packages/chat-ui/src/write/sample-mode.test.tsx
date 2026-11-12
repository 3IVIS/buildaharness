import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { effectiveSourceStatus } from '@buildaharness/aielia'
import { WriteApp, failureText } from './WriteApp'
import { createSampleServices, SAMPLE_MESSAGE, SAMPLE_BACKEND } from './sample-services'
import { SAMPLE_ARTICLE_ID, SAMPLE_ARTICLE_MARKDOWN } from './sample-article'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('the keyless sample', () => {
  it('holds one article with claims, a source and a suggestion already recorded, and every claim quote is in the text', async () => {
    const s = await createSampleServices()
    expect((await s.service.list()).map((a) => a.id)).toEqual([SAMPLE_ARTICLE_ID])
    const { meta, markdown } = await s.service.get(SAMPLE_ARTICLE_ID)
    expect(markdown).toBe(SAMPLE_ARTICLE_MARKDOWN)
    for (const c of meta.claims) expect(markdown).toContain(c.quote)
    const status = (id: string): string => effectiveSourceStatus(meta.claims.find((c) => c.id === id)!, meta.sources)
    expect(status('c1')).toBe('none')
    expect(status('c3')).toBe('supported')
    expect(meta.suggestions.filter((x) => x.state === 'pending')).toHaveLength(1)
    expect(meta.ideas).toHaveLength(1)
    for (const x of meta.suggestions) expect(markdown.slice(x.span.start, x.span.end)).toBe(x.span.quote)
  })

  it('never makes a network call, and a chat message gets the sample message', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const s = await createSampleServices()
    expect(s.backend).toBe(SAMPLE_BACKEND)
    expect((await s.chat('Check my claims', SAMPLE_ARTICLE_ID)).reply).toBe(`${SAMPLE_MESSAGE}.`)
    // A step that needs a model fails and changes nothing: the one suggestion that was recorded is still the only one.
    const r = await s.service.suggest(SAMPLE_ARTICLE_ID, 'Make the intro shorter')
    expect(r.status).toBe('failed')
    expect(r.added).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('lets the writer edit by hand, and says it is a sample (not "check your key") when a step needs a model', async () => {
    const s = await createSampleServices()
    const edited = SAMPLE_ARTICLE_MARKDOWN.replace('Introducing Aielia Write', 'Introducing Aielia Write today')
    await s.service.updateText(SAMPLE_ARTICLE_ID, edited, { analyze: false })
    expect((await s.service.get(SAMPLE_ARTICLE_ID)).markdown).toBe(edited)
    const text = failureText('The check could not finish', new Error(SAMPLE_MESSAGE), SAMPLE_BACKEND)
    expect(text).toBe(`The check could not finish: ${SAMPLE_MESSAGE}.`)
    expect(text).not.toMatch(/key and the model/)
  })

  it('shows the sample notice with a way to add a key and a way to start over, over the real editor', async () => {
    const onAddKey = vi.fn()
    const onReset = vi.fn()
    const s = await createSampleServices()
    render(<WriteApp services={s} sample={{ onAddKey, onReset }} />)
    expect(await screen.findByText('This is a sample.')).toBeTruthy()
    expect(await screen.findByDisplayValue(/# Introducing Aielia Write/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add your key' }))
    expect(onAddKey).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Reset sample' }))
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('shows no sample notice on a normal page', async () => {
    const s = await createSampleServices()
    render(<WriteApp services={s} />)
    expect(await screen.findByDisplayValue(/# Introducing Aielia Write/)).toBeTruthy()
    expect(screen.queryByText('This is a sample.')).toBeNull()
  })
})
