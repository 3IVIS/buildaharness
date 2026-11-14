import type { Message } from '@buildaharness/aielia'

/**
 * Safe mail HTML (U5). The reader shows mail HTML only inside a sandboxed frame (`sandbox=""`: no scripts, no forms,
 * no same-origin) whose srcdoc is produced here. The sanitiser is an allow-list: unknown elements are unwrapped,
 * every attribute not on the list is dropped (all `on*` handlers, `style` included), remote images are replaced by a
 * placeholder until the user allows them, and every link target is kept as visible data. Text a human cannot see
 * (zero size, display:none, text colour equal to its background) is removed from what is shown and reported, so the
 * displayed text and any summary built from it match what the reader sees.
 */

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'i', 'img', 'li', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'u', 'ul', 'body', 'html', 'center', 'font',
])
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'form', 'head', 'title', 'link', 'meta', 'base', 'audio', 'video', 'canvas', 'applet', 'frame', 'frameset'])

export interface SanitizedMail {
  /** Complete document for the sandboxed frame's srcdoc. */
  srcdoc: string
  /** Text a person can see. */
  visibleText: string
  /** Text that was in the mail but hidden from view; never shown, never summarised. */
  hiddenText: string[]
  /** Every link: the text shown, the real destination, and whether they disagree. */
  links: Array<{ text: string; href: string; mismatch: boolean }>
  /** Remote images that were blocked (their addresses). */
  blockedImages: string[]
}

export interface SanitizeOptions {
  allowRemoteImages?: boolean
}

const WHITE = new Set(['white', '#fff', '#ffffff', 'rgb(255,255,255)'])
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, '')

function styleProps(el: Element): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (el.getAttribute('style') ?? '').split(';')) {
    const i = part.indexOf(':')
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = norm(part.slice(i + 1))
  }
  return out
}

function bgOf(el: Element | null): string {
  for (let e = el; e; e = e.parentElement) {
    const s = styleProps(e)
    const bg = s['background-color'] ?? (s['background'] && !s['background'].includes('url(') ? s['background'] : undefined)
    if (bg) return bg
    const attr = e.getAttribute('bgcolor')
    if (attr) return norm(attr.startsWith('#') ? attr : attr)
  }
  return 'white'
}

function isHidden(el: Element): boolean {
  if (el.hasAttribute('hidden')) return true
  const s = styleProps(el)
  if (s['display'] === 'none' || s['visibility'] === 'hidden' || s['visibility'] === 'collapse') return true
  if (s['opacity'] !== undefined && parseFloat(s['opacity']) === 0) return true
  const fs = s['font-size']
  if (fs !== undefined && /^0(\.0+)?(px|pt|em|rem|%)?$/.test(fs)) return true
  if (s['max-height'] === '0' || s['max-height'] === '0px') return true
  if ((s['width'] === '0' || s['width'] === '0px') && (s['height'] === '0' || s['height'] === '0px')) return true
  if (s['text-indent'] !== undefined && /^-\d{3,}/.test(s['text-indent'])) return true
  const color = s['color'] ?? (el.tagName === 'FONT' ? norm(el.getAttribute('color') ?? '') : undefined)
  if (color) {
    const bg = bgOf(el)
    if (color === bg || (WHITE.has(color) && WHITE.has(bg))) return true
  }
  return false
}

const isRemote = (src: string): boolean => /^\s*(https?:)?\/\//i.test(src)
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:'])
function linkTarget(href: string): string | undefined {
  try {
    const u = new URL(href.trim(), 'https://invalid.example/')
    return SAFE_SCHEMES.has(u.protocol) && !/^\s*(\/(?!\/)|#)/.test(href) ? href.trim() : undefined
  } catch {
    return undefined
  }
}
const hostOf = (s: string): string => {
  try { return new URL(s).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' }
}
function shownHost(text: string): string {
  const t = text.trim().replace(/^https?:\/\//i, '').split(/[/?#\s]/)[0]?.toLowerCase() ?? ''
  return t.includes('.') ? t.replace(/^www\./, '') : ''
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function sanitizeMailHtml(html: string, opts: SanitizeOptions = {}): SanitizedMail {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const hiddenText: string[] = []
  const links: SanitizedMail['links'] = []
  const blockedImages: string[] = []
  const visible: string[] = []

  const walk = (node: Node, hidden: boolean): string => {
    if (node.nodeType === 3) {
      const t = node.textContent ?? ''
      if (hidden) { if (t.trim()) hiddenText.push(t.trim()) } else visible.push(t)
      return hidden ? '' : esc(t)
    }
    if (node.nodeType !== 1) return ''
    const el = node as Element
    const tag = el.tagName.toLowerCase()
    if (DROP_WITH_CONTENT.has(tag)) return ''
    const nowHidden = hidden || isHidden(el)
    const inner = (): string => Array.from(el.childNodes).map((c) => walk(c, nowHidden)).join('')
    if (nowHidden) { inner(); return '' }
    if (!ALLOWED_TAGS.has(tag)) return inner()
    if (tag === 'body' || tag === 'html') return inner()
    if (tag === 'br' || tag === 'hr') return `<${tag}>`
    if (tag === 'img') {
      const src = el.getAttribute('src') ?? ''
      const alt = el.getAttribute('alt') ?? ''
      const remoteOk = opts.allowRemoteImages && /^https:\/\//i.test(src)
      if (remoteOk) return `<img src="${esc(src)}" alt="${esc(alt)}" referrerpolicy="no-referrer">`
      if (isRemote(src) || !src.startsWith('data:image/')) {
        if (src) blockedImages.push(src)
        return `<span class="img-blocked" data-blocked-image>${esc(alt || '[image blocked]')}</span>`
      }
      return `<img src="${esc(src)}" alt="${esc(alt)}">`
    }
    if (tag === 'a') {
      const href = linkTarget(el.getAttribute('href') ?? '')
      const text = el.textContent ?? ''
      const content = inner()
      if (!href) return content
      const sh = shownHost(text)
      const th = hostOf(href)
      const mismatch = !!sh && !!th && sh !== th
      links.push({ text: text.trim(), href, mismatch })
      // No href is emitted: the frame cannot navigate. The destination is shown as text next to the link text.
      return `<span class="mail-link${mismatch ? ' mail-link--mismatch' : ''}">${content} <small class="mail-link__dest">(${esc(href)})</small></span>`
    }
    const attrs = tag === 'td' || tag === 'th' ? ['colspan', 'rowspan'].filter((a) => el.hasAttribute(a)).map((a) => ` ${a}="${esc(el.getAttribute(a) ?? '')}"`).join('') : ''
    return `<${tag}${attrs}>${inner()}</${tag}>`
  }

  const body = walk(doc.documentElement, false)
  const srcdoc =
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:${opts.allowRemoteImages ? ' https:' : ''}; style-src 'unsafe-inline'">` +
    `<style>body{font:14px system-ui,sans-serif;margin:8px;word-wrap:break-word}.img-blocked{color:#666;border:1px dashed #999;padding:0 4px}` +
    `.mail-link{text-decoration:underline;color:#06c}.mail-link--mismatch{color:#b00;background:#fee}.mail-link__dest{color:#555}</style></head><body>${body}</body></html>`
  return { srcdoc, visibleText: visible.join('').replace(/\s+/g, ' ').trim(), hiddenText, links, blockedImages }
}

/** Plain-text bodies: escaped, shown pre-wrapped, link destinations listed from the shared mismatch finder's rules. */
export function sanitizeMailText(text: string): SanitizedMail {
  return sanitizeMailHtml(`<pre style="white-space:pre-wrap;font:inherit">${esc(text)}</pre>`)
}

export interface SenderCheck {
  mismatch: boolean
  detail?: string
}

/** The display name claims an address on another domain than the real one. */
export function senderMismatch(from: Message['from']): SenderCheck {
  if (!from.name) return { mismatch: false }
  const dom = (a: string): string => a.slice(a.lastIndexOf('@') + 1).toLowerCase()
  for (const raw of from.name.split(/[\s<>()[\],;:"']+/)) {
    const at = raw.indexOf('@')
    if (at > 0 && raw.slice(at + 1).includes('.') && dom(raw) !== dom(from.address)) {
      return { mismatch: true, detail: `The name shows ${raw}, but the mail came from ${from.address}.` }
    }
  }
  return { mismatch: false }
}
