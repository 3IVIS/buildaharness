import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { FirstRun } from './FirstRun'
import { SampleMailboxView } from './SampleMailboxView'
import { createSampleMailbox, SAMPLE_BACKEND, SAMPLE_MESSAGE } from './sample-mode'
import { nextFirstRunStep, loadEmailConnection, saveEmailConnection, clearEmailConnection } from './email-config'

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

describe('first-run steps', () => {
  it('asks for the mail account first, then the AI, then is ready', () => {
    expect(nextFirstRunStep({ account: false, connection: false })).toBe('account')
    expect(nextFirstRunStep({ account: false, connection: true })).toBe('account')
    expect(nextFirstRunStep({ account: true, connection: false })).toBe('ai')
    expect(nextFirstRunStep({ account: true, connection: true })).toBe('ready')
  })

  it('shows the mail step with sign-in buttons that call the host, and the sample one click away', () => {
    const onConnectAccount = vi.fn()
    const onSample = vi.fn()
    render(<FirstRun state={{ account: false, connection: false }} onConnectAccount={onConnectAccount} onSaveConnection={vi.fn()} onSample={onSample} />)
    expect(screen.getByRole('heading', { name: 'Connect your mail' })).toBeTruthy()
    fireEvent.click(screen.getByText('Connect Gmail'))
    expect(onConnectAccount).toHaveBeenCalledWith('gmail')
    fireEvent.click(screen.getByText('Look around a sample mailbox first'))
    expect(onSample).toHaveBeenCalled()
  })

  it('says plainly that sign-in is unavailable when the build has none, instead of a dead button', () => {
    render(<FirstRun state={{ account: false, connection: false }} onSaveConnection={vi.fn()} onSample={vi.fn()} />)
    expect((screen.getByText('Connect Gmail') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('note').textContent).toMatch(/not available in this build/)
  })

  it('shows the AI step (OpenRouter first) once the mail account is connected', () => {
    render(<FirstRun state={{ account: true, connection: false }} onSaveConnection={vi.fn()} onSample={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Connect your AI' })).toBeTruthy()
    expect((screen.getByLabelText('Provider') as HTMLSelectElement).value).toBe('openrouter')
  })
})

describe('the model connection', () => {
  it('is kept under Email\'s own storage key and never reads the Chat or Write key', () => {
    localStorage.setItem('aielia-write.connection', JSON.stringify({ provider: 'openrouter', apiKey: 'write-key' }))
    expect(loadEmailConnection()).toBeUndefined()
    saveEmailConnection({ provider: 'openrouter', apiKey: 'email-key' })
    expect(loadEmailConnection()?.apiKey).toBe('email-key')
    expect(JSON.parse(localStorage.getItem('aielia-write.connection')!).apiKey).toBe('write-key')
    clearEmailConnection()
    expect(loadEmailConnection()).toBeUndefined()
  })

  it('refuses an incomplete connection', () => {
    saveEmailConnection({ provider: 'openrouter', apiKey: '' })
    expect(loadEmailConnection()).toBeUndefined()
  })
})

describe('the sample mailbox', () => {
  it('holds an Inbox of invented messages, newest first, with no network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const s = await createSampleMailbox()
    expect(s.inbox.length).toBeGreaterThan(0)
    expect(s.inbox.every((m) => m.from.address.length > 0)).toBe(true)
    const dates = s.inbox.map((m) => m.date)
    expect([...dates].sort().reverse()).toEqual(dates)
    expect(s.folders.some((f) => f.kind === 'inbox')).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('answers every chat message with the sample message, and every model call refuses with it', async () => {
    const s = await createSampleMailbox()
    expect(await s.ask('Summarise my inbox')).toEqual({ reply: `${SAMPLE_MESSAGE}.`, model: SAMPLE_BACKEND })
    await expect(s.llm!.callChatSync([], {} as never)).rejects.toThrow(SAMPLE_MESSAGE)
    await expect(s.llm!.callChatStructured([], {} as never)).rejects.toThrow(SAMPLE_MESSAGE)
  })

  it('renders the Inbox, opens a message, shows the sample notice, and chat says it is a sample', async () => {
    const s = await createSampleMailbox()
    const onConnect = vi.fn()
    render(<SampleMailboxView sample={s} onConnect={onConnect} />)
    expect(screen.getByRole('note').textContent).toMatch(/Sample/)
    const first = s.inbox[0]
    fireEvent.click(screen.getByText(new RegExp(first.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))))
    expect(screen.getByLabelText('Message').textContent).toContain(first.subject)
    fireEvent.change(screen.getByLabelText('Ask Aielia'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send', hidden: true }))
    await waitFor(() => expect(screen.getByText(`${SAMPLE_MESSAGE}.`)).toBeTruthy())
    fireEvent.click(screen.getByText('Connect'))
    expect(onConnect).toHaveBeenCalled()
  })
})
