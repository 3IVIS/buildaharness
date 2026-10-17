import type { Source } from './article-model.js'
import { htmlToMarkdown, looksLikeHtml } from './html-to-markdown.js'

/**
 * Stored source passages (T6): the passage as read, its address, the date and a fingerprint, so a later recheck can tell
 * whether the source changed. Whether a difference MATTERS is a model judgement and is not made here.
 * Source text is data, never instructions; callers must wrap it as untrusted before showing it to a model.
 */

/** A fast, stable 53-bit hash (cyrb53) as hex. Not cryptographic: it only detects change. Whitespace differences do not count as change. */
export function fingerprintPassage(passage: string): string {
  const text = passage.replace(/\s+/g, ' ').trim()
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

export type LineRange = { from: number; to: number }

/**
 * A line range from the text a writer types into a field or from a link fragment: "40-60", "40–60", "L40-L60", "lines 40 to 60", "40".
 * It reads the numbers only; the first is the start and the second (if any) the end. Nothing is parsed from the meaning of words.
 */
export function parseLineRange(text: string): LineRange | undefined {
  const nums = text.match(/\d+/g)?.map(Number).filter((n) => n >= 1)
  if (!nums || nums.length === 0 || nums.length > 2) return undefined
  const from = nums[0]
  const to = nums[1] ?? from
  return to >= from ? { from, to } : { from: to, to: from }
}

/** Only the given lines (1-based, inclusive) of a text; a range past the end is cut at the end, and an empty result means the range misses the text. */
export function sliceLines(text: string, range: LineRange): string {
  return text.split('\n').slice(range.from - 1, range.to).join('\n')
}

/** What a stored passage holds when the source keeps only some lines: the whole text otherwise. */
export function excerptFor(source: Pick<Source, 'lines'>, text: string): string {
  return source.lines ? sliceLines(text, source.lines) : text
}

/**
 * A link to one file in a GitHub repository (github.com/o/r/blob/ref/path, or raw.githubusercontent.com), with the line range of an #L10-L20 fragment.
 * `rawUrl` is where the file's text is fetched from. Anything else is undefined: such a link is an ordinary web page.
 */
export function parseRepoFileLink(address: string): { rawUrl: string; path: string; lines?: LineRange } | undefined {
  let u: URL
  try {
    u = new URL(address)
  } catch {
    return undefined
  }
  if (u.protocol !== 'https:') return undefined
  const lines = u.hash.startsWith('#L') ? parseLineRange(u.hash) : undefined
  const parts = u.pathname.split('/').filter(Boolean)
  if (u.hostname === 'github.com' && parts.length >= 5 && parts[2] === 'blob') {
    const [owner, repo, , ref, ...rest] = parts
    return { rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join('/')}`, path: rest.join('/'), lines }
  }
  if (u.hostname === 'raw.githubusercontent.com' && parts.length >= 4) return { rawUrl: `https://raw.githubusercontent.com${u.pathname}`, path: parts.slice(3).join('/'), lines }
  return undefined
}

export function createSource(input: { id: string; kind: Source['kind']; address?: string; passage?: string; note?: string; lines?: LineRange; now: string }): Source {
  const base: Source = { id: input.id, kind: input.kind, address: input.address, trust: input.kind === 'say_so' ? 'lower' : 'normal', freshness: 'unchecked', note: input.note, ...(input.lines ? { lines: input.lines } : {}) }
  if (input.passage === undefined) return base
  const passage = excerptFor(base, input.passage)
  return { ...base, passage, readAt: input.now, fingerprint: fingerprintPassage(passage), freshness: 'current' }
}

/**
 * Records the result of reading a source again. Same fingerprint: current. Different: changed (the stored passage is
 * kept as read until the writer accepts the new one, so a check never silently moves to new text). Unreadable: unreachable.
 */
export function applyRecheck(source: Source, result: { passage: string } | { unreachable: true }, now: string): Source {
  if ('unreachable' in result) return { ...source, freshness: 'unreachable' }
  const fp = fingerprintPassage(result.passage)
  return fp === source.fingerprint ? { ...source, freshness: 'current', readAt: now } : { ...source, freshness: 'changed' }
}

/** The writer accepts the newly read text: it replaces the stored passage and the fingerprint. */
export function acceptNewPassage(source: Source, passage: string, now: string): Source {
  return { ...source, passage, readAt: now, fingerprint: fingerprintPassage(passage), freshness: 'current' }
}

const TEXT_EXTENSIONS = ['.txt', '.md', '.mdx', '.markdown', '.rst', '.csv', '.tsv', '.json', '.log']
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.sql', '.yaml', '.yml', '.toml', '.ini', '.xml', '.html', '.css', '.scss', '.lua', '.r', '.scala']

/**
 * What kind of source a dropped file is, from its name and type: code (program text, so claims about what it does are checked against the
 * code itself), an uploaded text document, or undefined when it cannot be read as text. The caller reads the file's text.
 */
export function sourceKindForFile(file: { name: string; type?: string }): 'code' | 'upload' | undefined {
  const name = file.name.toLowerCase()
  if (CODE_EXTENSIONS.some((e) => name.endsWith(e))) return 'code'
  if (TEXT_EXTENSIONS.some((e) => name.endsWith(e)) || (file.type ?? '').startsWith('text/')) return 'upload'
  return undefined
}

/**
 * The text of a fetched page made ready to edit: line endings normalised, runs of blank lines cut to one, trailing spaces dropped. The title is the first
 * heading or, failing that, the first short line; the page's host if there is no text line to use.
 */
export function pageToArticle(text: string, address: string): { title: string; markdown: string } {
  const readable = looksLikeHtml(text) ? htmlToMarkdown(text) : text
  const markdown = readable.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const first = markdown.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find((l) => l.length > 0 && l.length <= 120)
  let host = address
  try {
    host = new URL(address).hostname
  } catch {
    // keep the address as given
  }
  return { title: first ?? host, markdown: markdown ? `${markdown}\n` : '' }
}
