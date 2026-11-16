/**
 * IMAP wire helpers shared by the provider and the fixture server (Email, phase H6a): quoting, the response tokenizer,
 * UID sets and the modified UTF-7 used in mailbox names. Pure functions, no node:* or DOM imports. The Rust side
 * (mail_imap.rs) returns raw response text; every meaning is read here, in shared code.
 */

/** A parsed token: an atom, quoted string or literal (all strings), NIL (null) or a parenthesised list. */
export type ImapToken = string | null | ImapToken[]

export interface ImapUntagged {
  /** Leading message number, as in `* 4 FETCH`. */
  num?: number
  /** `OK`, `LIST`, `FETCH`, `SEARCH`, `STATUS`, `CAPABILITY`, `EXISTS` ... upper-cased. */
  name: string
  rest: ImapToken[]
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/** A quoted string for a command. Refuses control characters and non-ASCII (no UTF-8 literals are sent). */
export function imapQuote(s: string): string {
  if (/[\r\n\0]/.test(s)) throw new Error('imap: control characters in a command argument')
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Modified UTF-7 (RFC 3501 5.1.3) for mailbox names. */
export function encodeMailboxName(name: string): string {
  let out = ''
  let run = ''
  const flush = () => {
    if (!run) return
    const bytes: number[] = []
    for (let i = 0; i < run.length; i++) bytes.push(run.charCodeAt(i) >> 8, run.charCodeAt(i) & 255)
    const b64 = btoa(String.fromCharCode(...bytes)).replace(/=+$/, '').replace(/\//g, ',')
    out += `&${b64}-`
    run = ''
  }
  for (const ch of name) {
    const c = ch.codePointAt(0)!
    if (c >= 0x20 && c <= 0x7e) {
      flush()
      out += ch === '&' ? '&-' : ch
    } else run += ch
  }
  flush()
  return out
}

export function decodeMailboxName(name: string): string {
  return name.replace(/&([^-]*)-/g, (_m, b: string) => {
    if (b === '') return '&'
    const bin = atob(b.replace(/,/g, '/') + '='.repeat((4 - (b.length % 4)) % 4))
    let s = ''
    for (let i = 0; i + 1 < bin.length; i += 2) s += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1))
    return s
  })
}

/** Compress UIDs to a set string: `[1,2,3,7]` becomes `1:3,7`. */
export function uidSet(uids: number[]): string {
  const s = [...new Set(uids)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < s.length; ) {
    let j = i
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++
    parts.push(j > i ? `${s[i]}:${s[j]}` : `${s[i]}`)
    i = j + 1
  }
  return parts.join(',')
}

/** IMAP date for SINCE and BEFORE: `5-Nov-2026` (UTC). */
export function imapDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) throw new Error('imap: invalid date')
  return `${d.getUTCDate()}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}-${d.getUTCFullYear()}`
}

/** Parse every untagged response in a raw command response. Literals are read by byte count. */
export function parseUntagged(raw: string): ImapUntagged[] {
  const b = enc.encode(raw)
  const out: ImapUntagged[] = []
  let i = 0
  const isSp = (c: number) => c === 32 || c === 9
  const readLiteral = (): string | undefined => {
    // at '{': {n}\r\n then n bytes
    const m = /^\{(\d+)\+?\}\r?\n/.exec(dec.decode(b.subarray(i, Math.min(b.length, i + 24))))
    if (!m) return undefined
    const n = Number(m[1])
    const start = i + m[0].length
    i = start + n
    return dec.decode(b.subarray(start, start + n))
  }
  const token = (): ImapToken | undefined => {
    while (i < b.length && isSp(b[i])) i++
    if (i >= b.length || b[i] === 13 || b[i] === 10) return undefined
    const c = b[i]
    if (c === 40) {
      i++
      const list: ImapToken[] = []
      for (;;) {
        while (i < b.length && isSp(b[i])) i++
        if (i >= b.length) return list
        if (b[i] === 41) {
          i++
          return list
        }
        const t = token()
        if (t === undefined) return list
        list.push(t)
      }
    }
    if (c === 34) {
      i++
      const bytes: number[] = []
      while (i < b.length && b[i] !== 34) {
        if (b[i] === 92) i++
        bytes.push(b[i])
        i++
      }
      i++
      return dec.decode(new Uint8Array(bytes))
    }
    if (c === 123) {
      const lit = readLiteral()
      if (lit !== undefined) return lit
    }
    const start = i
    let depth = 0
    while (i < b.length) {
      const ch = b[i]
      if (ch === 91) depth++
      else if (ch === 93) depth = Math.max(0, depth - 1)
      else if (depth === 0 && (isSp(ch) || ch === 13 || ch === 10 || ch === 40 || ch === 41)) break
      i++
    }
    const atom = dec.decode(b.subarray(start, i))
    return atom.toUpperCase() === 'NIL' ? null : atom
  }
  while (i < b.length) {
    // line start
    if (b[i] === 42 && b[i + 1] === 32) {
      i += 2
      const first = token()
      let num: number | undefined
      let name = typeof first === 'string' ? first : ''
      let rest: ImapToken[] = []
      if (/^\d+$/.test(name)) {
        num = Number(name)
        const second = token()
        name = typeof second === 'string' ? second : ''
      }
      for (;;) {
        const t = token()
        if (t === undefined) break
        rest.push(t)
      }
      out.push({ num, name: name.toUpperCase(), rest })
    }
    while (i < b.length && b[i] !== 10) i++
    i++
  }
  return out
}

/** `* n FETCH (k v k v ...)` as a map with upper-cased keys. */
export function fetchItems(u: ImapUntagged): Map<string, ImapToken> {
  const m = new Map<string, ImapToken>()
  const list = u.rest[0]
  if (!Array.isArray(list)) return m
  for (let k = 0; k + 1 < list.length; k += 2) {
    const key = list[k]
    if (typeof key === 'string') m.set(key.toUpperCase().replace(/<\d+>$/, ''), list[k + 1])
  }
  return m
}

/** First `[CODE value]` response code in a text, e.g. UIDVALIDITY or UIDNEXT. */
export function responseCode(raw: string, code: string): string | undefined {
  return new RegExp(`\\[${code} ([^\\]]+)\\]`, 'i').exec(raw)?.[1]
}

export interface ListEntry { attrs: string[]; delimiter: string | null; path: string }

export function parseList(raw: string): ListEntry[] {
  const out: ListEntry[] = []
  for (const u of parseUntagged(raw)) {
    if (u.name !== 'LIST' && u.name !== 'LSUB') continue
    const [attrs, delim, path] = u.rest
    if (!Array.isArray(attrs) || typeof path !== 'string') continue
    out.push({ attrs: attrs.filter((a): a is string => typeof a === 'string').map((a) => a.toLowerCase()), delimiter: typeof delim === 'string' ? delim : null, path })
  }
  return out
}
