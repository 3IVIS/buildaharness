/**
 * Small, dependency-free helpers for Gmail's wire formats: base64 and base64url over UTF-8, RFC 2047 encoded words in
 * headers, address-list parsing and a minimal RFC 822 builder for drafts. No `node:*`, no DOM imports.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2]
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : B64[c & 63]
  }
  return out
}

export function base64ToUtf8(data: string): string {
  const clean = data.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '')
  const bytes: number[] = []
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => (i + k < clean.length ? B64.indexOf(clean[i + k]) : -1))
    bytes.push((n[0] << 2) | (n[1] >> 4))
    if (n[2] >= 0) bytes.push(((n[1] & 15) << 4) | (n[2] >> 2))
    if (n[3] >= 0) bytes.push(((n[2] & 3) << 6) | n[3])
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

export function toBase64Url(text: string): string {
  return utf8ToBase64(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode RFC 2047 encoded words (`=?UTF-8?B?...?=`, `=?UTF-8?Q?...?=`); other charsets are read as UTF-8. */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?[^?]+\?([bBqQ])\?([^?]*)\?=/g, (_m, enc: string, body: string) => {
      if (enc.toLowerCase() === 'b') return base64ToUtf8(body)
      const bytes: number[] = []
      const s = body.replace(/_/g, ' ')
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
          bytes.push(parseInt(s.slice(i + 1, i + 3), 16))
          i += 2
        } else bytes.push(s.charCodeAt(i) & 0xff)
      }
      return new TextDecoder().decode(new Uint8Array(bytes))
    })
}

export function encodeHeaderValue(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ')
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${utf8ToBase64(clean)}?=`
}

export interface ParsedAddress { address: string; name?: string }

/** Split a header address list on commas outside quotes and angle brackets. */
export function parseAddressList(value: string | undefined): ParsedAddress[] {
  if (!value) return []
  const parts: string[] = []
  let cur = ''
  let quoted = false
  let angle = false
  for (const ch of value) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '<') angle = true
    else if (!quoted && ch === '>') angle = false
    if (ch === ',' && !quoted && !angle) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  const out: ParsedAddress[] = []
  for (const raw of parts) {
    const p = raw.trim()
    if (!p) continue
    const m = /^(.*)<([^<>]*)>\s*$/.exec(p)
    if (m) {
      const name = decodeEncodedWords(m[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1')).trim()
      const address = m[2].trim()
      if (address) out.push(name ? { address, name } : { address })
    } else out.push({ address: p })
  }
  return out
}

export function formatAddress(a: ParsedAddress): string {
  const addr = a.address.replace(/[\r\n<>,]/g, '')
  if (!a.name) return addr
  const name = encodeHeaderValue(a.name).replace(/["\\]/g, '')
  return `"${name}" <${addr}>`
}

export interface RawDraft {
  to: ParsedAddress[]
  cc?: ParsedAddress[]
  subject: string
  textBody: string
  from?: ParsedAddress
  inReplyTo?: string
  references?: string
}

/** Build an RFC 822 message (UTF-8 text, base64 body) for the Gmail `raw` field. Header values lose CR and LF. */
export function buildRawMessage(d: RawDraft): string {
  const lines: string[] = []
  if (d.from) lines.push(`From: ${formatAddress(d.from)}`)
  lines.push(`To: ${d.to.map(formatAddress).join(', ')}`)
  if (d.cc?.length) lines.push(`Cc: ${d.cc.map(formatAddress).join(', ')}`)
  lines.push(`Subject: ${encodeHeaderValue(d.subject)}`)
  if (d.inReplyTo) lines.push(`In-Reply-To: ${d.inReplyTo.replace(/[\r\n]+/g, ' ')}`)
  if (d.references) lines.push(`References: ${d.references.replace(/[\r\n]+/g, ' ')}`)
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64')
  const body = utf8ToBase64(d.textBody).replace(/(.{76})/g, '$1\r\n')
  return `${lines.join('\r\n')}\r\n\r\n${body}`
}

/** Parse a raw RFC 822 message produced by `buildRawMessage` (used by the fixture server). */
export function parseRawMessage(raw: string): { headers: Record<string, string>; textBody: string } {
  const split = raw.indexOf('\r\n\r\n')
  const head = split < 0 ? raw : raw.slice(0, split)
  const body = split < 0 ? '' : raw.slice(split + 4)
  const headers: Record<string, string> = {}
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':')
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  const textBody = (headers['content-transfer-encoding'] ?? '').toLowerCase() === 'base64' ? base64ToUtf8(body) : body
  return { headers, textBody }
}
