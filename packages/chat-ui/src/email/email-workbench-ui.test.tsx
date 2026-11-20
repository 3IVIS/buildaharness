import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
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

describe('Email host: the capabilities on a live mailbox with a model', () => {
  it('shows the review controls, read-only, and a catch-up lists what needs a response', async () => {
    await openLive()
    expect(await screen.findByText(/Aielia review/)).toBeTruthy()
    expect(screen.getByText(/read-only: nothing is changed or sent/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Window'), { target: { value: '90' } })
    fireEvent.click(screen.getByRole('button', { name: 'What needs a response?' }))
    expect(await screen.findByText('Last 90 days')).toBeTruthy()
    expect(screen.getAllByText(/need a response/).length).toBeGreaterThan(0)
    // The To do entry is fed by what was reviewed.
    expect(screen.getByRole('button', { name: /^To do, \d+ open$/ })).toBeTruthy()
  })
  it('shows every model call with what was sent and what came back', async () => {
    await openLive()
    fireEvent.change(screen.getByLabelText('Window'), { target: { value: '90' } })
    fireEvent.click(screen.getByRole('button', { name: 'What needs a response?' }))
    await screen.findByText('Last 90 days')
    const activity = screen.getByText(/What Aielia is doing/).closest('details')!
    expect(within(activity).getAllByText(/^model #\d+ · /).length).toBeGreaterThan(0)
    expect(seen.length).toBeGreaterThan(0)
  })
  it('the spam group is read-only: no move button, and spam is only ever proposed', async () => {
    await openLive()
    fireEvent.click(screen.getByRole('button', { name: 'Spam check' }))
    await screen.findByText(/Aielia review/)
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Spam check' })).not.toBeDisabled())
    expect(screen.queryByRole('button', { name: 'Move to Junk' })).toBeNull()
  })
  it('the chat answers through the read-only mail tools and says what it drew on', async () => {
    await openLive()
    fireEvent.click(await screen.findByRole('button', { name: 'Summarise my unread mail' }))
    expect(await screen.findByText(/Scripted answer about your mail\./)).toBeTruthy()
    expect(chatCalls).toBe(2)
  })
})
