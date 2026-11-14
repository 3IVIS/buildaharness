import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { buildHostileSet, hostileMessages } from '@buildaharness/aielia'
import { MailReader } from './MailReader'
import { sanitizeMailHtml } from './reader-html'

afterEach(() => { cleanup() })
const items = buildHostileSet()
const byId = (id: string) => items.find((i) => i.id === id)!

describe('safe mail HTML', () => {
  it('runs no script and keeps no handler, frame, form or javascript: link', () => {
    const r = sanitizeMailHtml('<p onclick="x()">hi</p><script>window.pwned=1</script><iframe src="https://a.example"></iframe><form action="https://a.example"><input></form><a href="javascript:alert(1)">go</a><img src="x" onerror="y()">')
    expect(r.srcdoc).not.toMatch(/<script|<iframe|<form|onclick|onerror|javascript:/i)
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined()
  })
  it('makes no remote request: images are replaced until allowed', () => {
    const html = '<img src="https://track.example.net/p.gif" alt="logo">'
    const blocked = sanitizeMailHtml(html)
    expect(blocked.srcdoc).not.toContain('<img')
    expect(blocked.blockedImages).toEqual(['https://track.example.net/p.gif'])
    expect(sanitizeMailHtml(html, { allowRemoteImages: true }).srcdoc).toContain('<img src="https://track.example.net/p.gif"')
    expect(blocked.srcdoc).toContain("default-src 'none'")
  })
  it('removes hidden text from the visible text (zero size, white on white)', () => {
    for (const id of ['hidden-zero-size', 'hidden-white-on-white']) {
      const item = byId(id)
      const r = sanitizeMailHtml(item.message.htmlBody!)
      expect(r.hiddenText.length).toBeGreaterThan(0)
      for (const s of item.expected.mustNotAppearInSummary ?? ['collector@example.com']) {
        expect(r.visibleText).not.toContain(s)
        expect(r.srcdoc).not.toContain(s)
      }
    }
  })
  it('flags a link whose text shows another address than its target', () => {
    const r = sanitizeMailHtml(byId('link-mismatch').message.htmlBody!)
    expect(r.links.some((l) => l.mismatch && l.href.includes('collect.example.net'))).toBe(true)
    expect(r.srcdoc).toContain('(https://collect.example.net/steal?u=me)')
  })
})

describe('MailReader', () => {
  it('renders every hostile message in a sandboxed frame with an empty sandbox', () => {
    for (const m of hostileMessages(items)) {
      const { container, unmount } = render(<MailReader message={m} />)
      const frame = container.querySelector('iframe')!
      expect(frame.getAttribute('sandbox')).toBe('')
      expect(frame.getAttribute('srcdoc')).not.toMatch(/<script/i)
      unmount()
    }
  })
  it('flags the sender mismatch and the link mismatch', () => {
    const { container, unmount } = render(<MailReader message={byId('spoof-display-name').message} />)
    expect(container.querySelector('[data-flag="sender_mismatch"]')).not.toBeNull()
    unmount()
    render(<MailReader message={byId('link-mismatch').message} />)
    expect(screen.getByRole('alert').textContent).toContain('collect.example.net')
  })
  it('notes hidden text and offers images on request', () => {
    const m = { ...byId('hidden-zero-size').message, htmlBody: '<img src="https://t.example.net/a.png"><span style="font-size:0">secret</span>' }
    const { container } = render(<MailReader message={m} />)
    expect(container.querySelector('[data-flag="hidden_text"]')).not.toBeNull()
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).not.toContain('<img')
    fireEvent.click(screen.getByText('Show images'))
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toContain('<img src="https://t.example.net/a.png"')
  })
  it('lists attachments and opens only on the user\'s click', () => {
    const onOpen = vi.fn()
    const m = { ...byId('inject-ignore-previous').message, attachments: [{ id: 'att1', filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 2048 }] }
    render(<MailReader message={m} onOpenAttachment={onOpen} />)
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open a.pdf' }))
    expect(onOpen).toHaveBeenCalledWith('att1')
  })
  it('shows a plain-text body escaped', () => {
    const m = { ...byId('inject-ignore-previous').message, htmlBody: undefined, textBody: '<script>x</script> hello' }
    const { container } = render(<MailReader message={m} />)
    const doc = container.querySelector('iframe')!.getAttribute('srcdoc')!
    expect(doc).toContain('&lt;script&gt;')
  })
})
