import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeMailHtml } from './reader-html'
import { MailReader } from './MailReader'

afterEach(cleanup)
const srcdoc = (html: string): string => sanitizeMailHtml(html).srcdoc
const body = (html: string): string => srcdoc(html).split('<body>')[1]!

describe('basic formatting survives, harmful styling does not', () => {
  it('keeps colour, weight, alignment, size and padding that pass the checks', () => {
    const out = body('<p style="color:#cc0000; font-weight:700; text-align:center; font-size:18px; padding:4px 8px">Hi</p>')
    expect(out).toContain('color:#cc0000')
    expect(out).toContain('font-weight:700')
    expect(out).toContain('text-align:center')
    expect(out).toContain('font-size:18px')
    expect(out).toContain('padding:4px 8px')
  })
  it('maps align, bgcolor and font color attributes', () => {
    expect(body('<table bgcolor="#eeeeee"><tr><td align="right">x</td></tr></table>')).toMatch(/background-color:#eeeeee[\s\S]*text-align:right/)
    expect(body('<font color="#336699">x</font>')).toContain('color:#336699')
  })
  it('drops anything that could load, move or hide things', () => {
    for (const bad of [
      'background:url(https://t.example/p.gif)', 'background-image:url(x)', 'position:fixed', 'position:absolute;top:0', 'margin-left:-9999px', 'font-size:400px',
      'font-size:2px', 'color:expression(alert(1))', 'behavior:url(x)', 'width:100000px', 'display:block', 'z-index:9999', 'padding:900px',
    ]) {
      const out = body(`<p style="${bad}">x</p>`)
      expect(out, bad).not.toMatch(/url\(|position|expression|behavior|z-index|display|-9999|400px|2px|100000|900px/)
    }
  })
  it('still never runs or loads anything: scripts, handlers, remote images and links stay out', () => {
    const out = srcdoc('<p onclick="x()" style="color:red">a</p><script>alert(1)</script><img src="https://t.example/p.gif"><a href="javascript:alert(1)">j</a><iframe src="https://e.example"></iframe>')
    expect(out).not.toMatch(/<script|onclick|<iframe|javascript:/i)
    expect(out).not.toContain('src="https://t.example')
    expect(out).toContain("default-src 'none'")
  })
  it('hidden text (white on white, zero size) is still treated as hidden', () => {
    const s = sanitizeMailHtml('<p style="color:#ffffff;background:#ffffff">secret</p><p>shown</p>')
    expect(s.hiddenText).toContain('secret')
    expect(s.srcdoc).not.toContain('secret')
  })
})

describe('the reader uses the HTML when a message has it', () => {
  const msg = { id: 'm', accountId: 'a', threadId: 't', providerId: 'p', folderIds: ['in'], from: { address: 'n@shop.example', name: 'Shop' }, to: [], cc: [], subject: 'Sale', date: '2026-11-01T00:00:00.000Z', headers: {}, textBody: 'Plain fallback', attachments: [], flags: { read: false, starred: false, draft: false } }
  it('renders htmlBody in the sandboxed frame (bold kept), and the text when there is none', () => {
    const { container, rerender } = render(<MailReader message={{ ...msg, htmlBody: '<p><b>Bold</b> offer</p>' } as never} />)
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toContain('<b>Bold</b>')
    rerender(<MailReader message={msg as never} />)
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toContain('Plain fallback')
    expect(screen.getByRole('article')).toBeTruthy()
  })
})

describe('the resize handles', () => {
  it('Email places its own handles in the flow, overriding the shared Write rule that pins them to the top of the container', () => {
    const css = readFileSync(join(process.cwd(), 'src/email/email.css'), 'utf8')
    expect(css).toMatch(/\.email \.email__split--listy[^{]*\{[^}]*position: relative/)
    expect(css).toMatch(/\.email \.email__split--list[^-][^{]*\{[^}]*position: relative/)
  })
})
