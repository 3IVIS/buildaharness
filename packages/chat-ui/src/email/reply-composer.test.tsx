import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { FakeEmailProvider, generateSyntheticMailbox, SendCoordinator, suggestDraftEdit, type EmailReplyDraft } from '@buildaharness/aielia'
import { ReplyComposer } from './ReplyComposer'
import { createArticleMeta } from '@buildaharness/aielia'

afterEach(() => { cleanup() })

async function setup(body = 'Hi Pat, yes. See you Monday.') {
  const provider = new FakeEmailProvider(generateSyntheticMailbox({ seed: 3, perCategory: 2 }))
  const m = provider.deliver({ from: { address: 'pat@example.com', name: 'Pat' }, subject: 'Meeting', textBody: 'Can we meet?' })
  const draft: EmailReplyDraft = { subject: 'Meeting', to: [{ address: 'pat@example.com' }], threadId: m.threadId, body, gaps: [], flags: [], facts: { state: 'skipped' }, meta: createArticleMeta('d1', 'Meeting') }
  const coordinator = new SendCoordinator(provider)
  return { provider, draft, coordinator }
}

describe('ReplyComposer', () => {
  it('nothing is sent until the approval is given', async () => {
    const { draft, coordinator } = await setup()


    const seen: string[] = []
    render(<ReplyComposer initial={draft} coordinator={coordinator} onSent={(r) => seen.push(r.status)} />)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(screen.getByText('Review and send'))
    await screen.findByRole('alertdialog')
    expect(seen).toEqual([])
    expect(coordinator.status('send-1')).toBe('staged')
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(seen).toEqual(['sent']))
    expect(coordinator.status('send-1')).toBe('sent')
  })
  it('the approval lists every recipient, Cc and Bcc included, subject and text', async () => {
    const { draft, coordinator } = await setup()
    render(<ReplyComposer initial={draft} coordinator={coordinator} />)
    fireEvent.change(screen.getByLabelText(/^Cc/), { target: { value: 'c@x.org' } })
    fireEvent.change(screen.getByLabelText(/^Bcc/), { target: { value: 'b@x.org' } })
    fireEvent.click(screen.getByText('Review and send'))
    const dlg = await screen.findByRole('alertdialog')
    for (const t of ['pat@example.com', 'c@x.org', 'b@x.org', 'Meeting', 'See you Monday']) expect(dlg.textContent).toContain(t)
  })
  it('a recipient not on the thread gets the extra warning; one on the thread does not', async () => {
    const { draft, coordinator } = await setup()
    render(<ReplyComposer initial={draft} coordinator={coordinator} />)
    fireEvent.click(screen.getByText('Review and send'))
    await screen.findByRole('alertdialog')
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByText('Back to editing'))
    fireEvent.change(screen.getByLabelText(/^Bcc/), { target: { value: 'stranger@elsewhere.org' } })
    fireEvent.click(screen.getByText('Review and send'))
    const w = await screen.findByRole('alert')
    expect(w.textContent).toContain('stranger@elsewhere.org was not on this thread')
  })
  it('a bad address stops the send and shows why', async () => {
    const { draft, coordinator } = await setup()
    render(<ReplyComposer initial={draft} coordinator={coordinator} />)
    fireEvent.change(screen.getByLabelText(/^Cc/), { target: { value: 'nope' } })
    fireEvent.click(screen.getByText('Review and send'))
    expect((await screen.findByRole('alert')).textContent).toContain('not a valid email address')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
  it('accepting a suggestion changes the text; rejecting leaves it', async () => {
    const { draft, coordinator } = await setup()
    let d = suggestDraftEdit(draft, { quote: 'See you Monday.', replacement: 'See you Tuesday.', reason: 'Pat said Tuesday' })
    if (!d.ok) throw new Error(d.reason)
    d = suggestDraftEdit(d.draft, { quote: 'Hi Pat', replacement: 'Dear Pat', reason: 'formal' })
    if (!d.ok) throw new Error(d.reason)
    render(<ReplyComposer initial={d.draft} coordinator={coordinator} />)
    expect(screen.getAllByText('Accept')).toHaveLength(2)
    fireEvent.click(screen.getAllByText('Accept')[0]!)
    expect((screen.getByLabelText('Reply text') as HTMLTextAreaElement).value).toContain('See you Tuesday.')
    fireEvent.click(screen.getByText('Reject'))
    expect((screen.getByLabelText('Reply text') as HTMLTextAreaElement).value).toContain('Hi Pat')
    expect(screen.queryByText('Accept')).toBeNull()
  })
  it('editing after the approval is shown requires a fresh approval, and full screen is a class on phones', async () => {
    const { draft, coordinator } = await setup()
    const { container } = render(<ReplyComposer initial={draft} coordinator={coordinator} fullScreen />)
    expect(container.querySelector('.reply--full')).toBeTruthy()
    fireEvent.click(screen.getByText('Review and send'))
    await screen.findByRole('alertdialog')
    fireEvent.click(screen.getByText('Back to editing'))
    fireEvent.change(screen.getByLabelText('Reply text'), { target: { value: 'changed' } })
    fireEvent.click(screen.getByText('Review and send'))
    await screen.findByRole('alertdialog')
    expect(screen.getByRole('alertdialog').textContent).toContain('changed')
  })
})
