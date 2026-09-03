import { describe, it, expect, vi } from 'vitest'
import {
  createResendSender,
  formatEmailApprovalReason,
  isLikelyEmailAddress,
  EmailDeliveryError,
} from './email.js'

describe('isLikelyEmailAddress', () => {
  it.each([
    ['a@b.co', true],
    ['first.last@sub.example.com', true],
    ['  spaced@example.com  ', true],
    ['no-at-sign', false],
    ['missing@tld', false],
    ['two @spaces.com', false],
    ['', false],
  ])('%s → %s', (value, expected) => {
    expect(isLikelyEmailAddress(value)).toBe(expected)
  })
})

describe('createResendSender', () => {
  const opts = { apiKey: 'test-key', from: 'me@example.com' }

  type FetchArgs = [input: string | URL | Request, init?: RequestInit]

  it('POSTs to the Resend API with auth and the staged message, returns the provider id', async () => {
    const fetchImpl = vi.fn(
      (..._args: FetchArgs) =>
        Promise.resolve(
          new Response(JSON.stringify({ id: 'resend-123' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        ),
    )
    const send = createResendSender({ ...opts, fetchImpl: fetchImpl as unknown as typeof fetch })

    const result = await send({ to: 'boss@example.com', subject: 'I quit', body: 'Effective today.' })

    expect(result).toEqual({ provider: 'resend', id: 'resend-123' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' })
    expect(JSON.parse(init?.body as string)).toEqual({
      from: 'me@example.com',
      to: ['boss@example.com'],
      subject: 'I quit',
      text: 'Effective today.',
    })
  })

  it('uses the per-message from when provided, and threads cc/bcc', async () => {
    const fetchImpl = vi.fn((..._args: FetchArgs) => Promise.resolve(new Response('{}', { status: 200 })))
    const send = createResendSender({ ...opts, fetchImpl: fetchImpl as unknown as typeof fetch })

    await send({ to: 'a@example.com', subject: 's', body: 'b', from: 'other@example.com', cc: 'c@example.com', bcc: 'd@example.com' })

    const body = JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)
    expect(body.from).toBe('other@example.com')
    expect(body.cc).toEqual(['c@example.com'])
    expect(body.bcc).toEqual(['d@example.com'])
  })

  it('throws EmailDeliveryError on a non-2xx response, carrying the status', async () => {
    const fetchImpl = vi.fn((..._args: FetchArgs) => Promise.resolve(new Response('nope', { status: 422 })))
    const send = createResendSender({ ...opts, fetchImpl: fetchImpl as unknown as typeof fetch })

    await expect(send({ to: 'a@example.com', subject: 's', body: 'b' })).rejects.toBeInstanceOf(EmailDeliveryError)
  })

  it('throws EmailDeliveryError when fetch itself rejects', async () => {
    const fetchImpl = vi.fn((..._args: FetchArgs): Promise<Response> => Promise.reject(new Error('network down')))
    const send = createResendSender({ ...opts, fetchImpl: fetchImpl as unknown as typeof fetch })

    await expect(send({ to: 'a@example.com', subject: 's', body: 'b' })).rejects.toThrow(/network down/)
  })
})

describe('formatEmailApprovalReason', () => {
  it('shows recipient, subject, and body', () => {
    const reason = formatEmailApprovalReason({ to: 'boss@example.com', subject: 'I quit', body: 'Bye.' })
    expect(reason).toContain('boss@example.com')
    expect(reason).toContain('I quit')
    expect(reason).toContain('Bye.')
  })

  it('truncates a long body', () => {
    const reason = formatEmailApprovalReason({ to: 'a@b.co', subject: 's', body: 'x'.repeat(2000) })
    expect(reason).toContain('…')
    expect(reason.length).toBeLessThan(2000)
  })
})
