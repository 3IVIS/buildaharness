import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { resolveConfig, FixtureLocalSource, generateSyntheticMailbox } from '@buildaharness/aielia'
import type { ILLMClient } from '@buildaharness/runtime'

const config = resolveConfig({ llmBackend: 'anthropic', apiKey: 'k' }).config
const seen: Array<{ system: string; user: string }> = []
let chatCalls = 0
// A scripted model: it answers each kind of call by what it is asked, and records everything it was sent.
const llm: ILLMClient = {
  async *callChat() { /* unused */ },
  async callChatStructured() { throw new Error('unused') },
  callChatSync: async (messages) => {
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    const user = messages.find((m) => m.role === 'user')?.content ?? ''
    seen.push({ system, user })
    const ids = [...user.matchAll(/^Thread ("(?:[^"\\]|\\.)*")/gm)].map((m) => JSON.parse(m[1]!) as string)
    if (system.includes('label mail folders')) return '{"folders":[]}'
    if (system.includes('You write an email reply')) return JSON.stringify({ body: 'Thank you, I will look into it.', statesDatePriceOrCommitment: false })
    if (system.includes('profile the senders')) return JSON.stringify({ senders: [...user.matchAll(/^Sender ("(?:[^"\\]|\\.)*")/gm)].map((m) => ({ sender: JSON.parse(m[1]!), kind: 'business_newsletter', reason: 'a company newsletter' })) })
    if (system.includes('answer questions about the user')) return ++chatCalls === 1 ? '{"tool":"mail_count","args":{}}' : '{"answer":"Scripted answer about your mail."}'
    if (ids.length > 0 && /spam/i.test(system) && /junk/i.test(system)) return JSON.stringify({ junk: ids.map((threadId) => ({ threadId, verdict: 'not_spam', reason: 'ordinary mail' })) })
    return JSON.stringify({ triage: ids.map((threadId) => ({ threadId, category: 'person', needsReply: true, priority: 'high', urgency: 'soon', reason: 'asks you something' })) })
  },
}
vi.mock('./desktop-platform', async (orig) => ({ ...(await orig<typeof import('./desktop-platform')>()), desktopEmailPlatform: async () => ({ llm }) }))
afterEach(() => { cleanup(); seen.length = 0; chatCalls = 0 })

async function openLive() {
  // jsdom has no matchMedia, which reads as a phone (the chat is a separate tab there): ask for the desktop layout.
  window.matchMedia = ((q: string) => ({ matches: Number(/min-width: (\d+)px/.exec(q)?.[1] ?? Infinity) <= 1400, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  const { default: EmailHost } = await import('./EmailHost')
  const source = new FixtureLocalSource(generateSyntheticMailbox({ seed: 2 }))
  render(<EmailHost config={config} onClose={() => undefined} localKit={{ source }} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Use these accounts' }))
  await screen.findByText(/Apple Mail on this computer\./)
}

const pick = (value: string): void => { fireEvent.change(screen.getByLabelText('Aielia task'), { target: { value } }) }

describe('Email host: the capabilities on a live mailbox with a model', () => {
  it('offers the tasks in a dropdown in the chat, and no panel above the mail list', async () => {
    await openLive()
    const select = await screen.findByLabelText('Aielia task')
    expect(select.closest('.achat__bar')).toBeTruthy()
    expect(document.querySelector('.wb')).toBeNull()
    for (const label of ['Catch up: last 7 days', 'Sort senders: last 30 days', 'Spam check: last 7 days', 'Propose rules from my folders', 'Update my To do list']) {
      expect(screen.getByRole('option', { name: label })).toBeTruthy()
    }
    // A draft needs an open message.
    expect(screen.queryByRole('option', { name: 'Draft a reply to the open message' })).toBeNull()
  })
  it('a catch-up task answers in the chat with what needs a response, and feeds To do', async () => {
    await openLive()
    pick('catchup:90')
    expect(await screen.findByText(/What needs a response\? \(last 90 days\)/)).toBeTruthy()
    await vi.waitFor(() => expect(document.querySelector('.achat__line--rich .wb__list')).toBeTruthy())
    expect(screen.getByRole('button', { name: /^To do, \d+ open$/ })).toBeTruthy()
  })
  it('shows every model call in the activity log, with what was sent and what came back', async () => {
    await openLive()
    pick('catchup:90')
    await vi.waitFor(() => expect(document.querySelector('.achat__line--rich')).toBeTruthy())
    const activity = screen.getByText(/What Aielia is doing/).closest('details')!
    expect(activity.querySelectorAll('.wb__event summary').length).toBeGreaterThan(0)
    expect(seen.length).toBeGreaterThan(0)
  })
  it('the spam group is read-only: no move button, and spam is only ever proposed', async () => {
    await openLive()
    pick('spam:30')
    await vi.waitFor(() => expect(document.querySelector('.achat__line--rich')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Move to Junk' })).toBeNull()
  })
  it('the chat answers through the read-only mail tools and says what it drew on', async () => {
    await openLive()
    fireEvent.click(await screen.findByRole('button', { name: 'Summarise my unread mail' }))
    expect(await screen.findByText(/Scripted answer about your mail\./)).toBeTruthy()
    expect(chatCalls).toBe(2)
  })
  it('the dropdown is unavailable while a task runs', async () => {
    await openLive()
    pick('catchup:90')
    await vi.waitFor(() => expect(screen.getByLabelText('Aielia task')).toBeDisabled())
    await vi.waitFor(() => expect(screen.getByLabelText('Aielia task')).not.toBeDisabled())
  })
})

describe('a live mailbox is labelled live', () => {
  it('the chat column does not call a real mailbox a sample', async () => {
    await openLive()
    expect(screen.queryByText('Sample mailbox')).toBeNull()
    expect(screen.getAllByText(/Apple Mail on this computer/).length).toBeGreaterThan(0)
  })
})

describe('sender profiles and opening a result', () => {
  it('Sort senders groups the senders by kind in the chat and says newsletters are not spam', async () => {
    await openLive()
    pick('senders:90')
    expect(await screen.findByText(/Business newsletters and promotions \(\d+\)/)).toBeTruthy()
  })
  it('a "needs a response" item opens that thread in the reader', async () => {
    await openLive()
    pick('catchup:90')
    await vi.waitFor(() => expect(document.querySelector('.achat__line--rich button.wb__link')).toBeTruthy())
    const link = document.querySelector('.achat__line--rich button.wb__link') as HTMLButtonElement
    const subject = link.textContent!
    fireEvent.click(link)
    await vi.waitFor(() => expect(document.querySelector('.email__reader')?.textContent ?? '').toContain(subject.slice(0, 20)))
  })
  it('with a message open, the dropdown offers a draft, shown in the chat and not saved', async () => {
    await openLive()
    pick('catchup:90')
    await vi.waitFor(() => expect(document.querySelector('.achat__line--rich button.wb__link')).toBeTruthy())
    fireEvent.click(document.querySelector('.achat__line--rich button.wb__link') as HTMLButtonElement)
    await vi.waitFor(() => expect(screen.getByRole('option', { name: 'Draft a reply to the open message' })).toBeTruthy())
    pick('draft:0')
    expect(await screen.findByText(/Shown here only\. It is not saved to Mail and not sent\./)).toBeTruthy()
  })
})
