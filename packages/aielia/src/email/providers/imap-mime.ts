import { decodeEncodedWords, parseAddressList, type ParsedAddress } from './mime.js'

/**
 * A small RFC 5322 / MIME reader for IMAP messages (Email, phase H6a): unfolded headers, multipart walking, base64 and
 * quoted-printable bodies, charsets through TextDecoder, and attachment listing. It never executes or renders anything:
 * the text body is untrusted data. HTML is not passed on (no sanitiser runs here); a message with only HTML gets its
 * tags stripped into plain text.
 */

export interface ParsedMail {
  headers: Record<string, string>
  from: ParsedAddress
  to: ParsedAddress[]
  cc: ParsedAddress[]
  subject: string
  textBody: string
  /** The HTML part as received (decoded), when there is one. Never given to a model; the reader sanitises it before showing it. Capped at `MAX_HTML_CHARS`. */
  htmlBody?: string
  attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number; inline?: boolean }>
}

/** The longest HTML part kept (a larger one is dropped, and the text part is shown instead). */
export const MAX_HTML_CHARS = 400_000

function splitHead(raw: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(raw)
  if (!m) return { head: raw, body: '' }
  return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) }
}

export function parseHeaders(head: string): Record<string, string> {
  const out: Record<string, string> = {}
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const k = line.slice(0, i).trim().toLowerCase()
    if (!(k in out)) out[k] = line.slice(i + 1).trim()
  }
  return out
}

function param(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined
  const m = new RegExp(`${name}\\*?=\\s*(?:"([^"]*)"|([^;\\s]*))`, 'i').exec(value)
  return m ? (m[1] ?? m[2]) : undefined
}

function bytesFromBinary(s: string): Uint8Array {
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255
  return b
}

function decodeQuotedPrintable(s: string): Uint8Array {
  const joined = s.replace(/=\r?\n/g, '')
  const out: number[] = []
  const enc = new TextEncoder()
  for (let i = 0; i < joined.length; i++) {
    const c = joined[i]
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      out.push(parseInt(joined.slice(i + 1, i + 3), 16))
      i += 2
    } else out.push(...enc.encode(c))
  }
  return new Uint8Array(out)
}

function decodeBody(body: string, encoding: string, charset: string): string {
  let bytes: Uint8Array
  const e = encoding.toLowerCase()
  if (e === 'base64') {
    try {
      bytes = bytesFromBinary(atob(body.replace(/[^A-Za-z0-9+/=]/g, '')))
    } catch {
      return ''
    }
  } else if (e === 'quoted-printable') bytes = decodeQuotedPrintable(body)
  else bytes = new TextEncoder().encode(body)
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

interface Walk { text?: string; html?: string; attachments: ParsedMail['attachments'] }

function walk(raw: string, acc: Walk, path: string, depth: number): void {
  const { head, body } = splitHead(raw)
  const h = parseHeaders(head)
  const ctype = (h['content-type'] ?? 'text/plain').toLowerCase()
  const mime = ctype.split(';')[0].trim()
  const disp = (h['content-disposition'] ?? '').toLowerCase()
  if (mime.startsWith('multipart/') && depth < 8) {
    const boundary = param(h['content-type'], 'boundary')
    if (!boundary) return
    const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`))
    // parts[0] is the preamble; the closing delimiter leaves an empty or epilogue tail.
    parts.slice(1).forEach((p, i) => { if (p.trim()) walk(p, acc, `${path}.${i + 1}`, depth + 1) })
    return
  }
  const filename = decodeEncodedWords(param(h['content-disposition'], 'filename') ?? param(h['content-type'], 'name') ?? '')
  const encoding = h['content-transfer-encoding'] ?? '7bit'
  const charset = param(h['content-type'], 'charset') ?? 'utf-8'
  const isAttachment = disp.startsWith('attachment') || (filename !== '' && !mime.startsWith('text/')) || (!mime.startsWith('text/') && mime !== 'message/rfc822')
  if (isAttachment) {
    const approx = encoding.toLowerCase() === 'base64' ? Math.floor((body.replace(/\s/g, '').length * 3) / 4) : body.length
    acc.attachments.push({ id: path, filename: filename || `part-${path}`, mimeType: mime, sizeBytes: approx, ...(disp.startsWith('inline') ? { inline: true } : {}) })
    return
  }
  const text = decodeBody(body, encoding, charset)
  if (mime === 'text/html') acc.html ??= text
  else if (mime === 'text/plain') acc.text ??= text
}

export function parseMail(raw: string): ParsedMail {
  const { head } = splitHead(raw)
  const headers = parseHeaders(head)
  const acc: Walk = { attachments: [] }
  walk(raw, acc, '1', 0)
  const decoded: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) decoded[k] = decodeEncodedWords(v)
  return {
    headers: decoded,
    from: parseAddressList(headers['from'])[0] ?? { address: 'unknown@invalid' },
    to: parseAddressList(headers['to']),
    cc: parseAddressList(headers['cc']),
    subject: decodeEncodedWords(headers['subject'] ?? ''),
    textBody: acc.text ?? (acc.html ? stripHtml(acc.html) : ''),
    ...(acc.html && acc.html.length <= MAX_HTML_CHARS ? { htmlBody: acc.html } : {}),
    attachments: acc.attachments,
  }
}
