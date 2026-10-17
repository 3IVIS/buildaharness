/**
 * HTML to markdown for pulling a page in to edit: no DOM, so it runs in the shared code. It keeps the structure an article has (headings, paragraphs,
 * lists, quotes, code, links, emphasis) and drops what is not the article (scripts, styles, navigation, headers and footers outside the main text,
 * forms, comments). When the page has a <main> or <article>, only that is used. It is a reader, not a parser of every page on the web: odd markup
 * comes out as plain paragraphs.
 */

const DROPPED = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'form', 'select', 'button', 'head']
const CHROME = ['nav', 'footer', 'aside']
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', times: '×' }

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Removes every element named in `names` with its content (also nested copies of the same name). */
function dropElements(html: string, names: string[]): string {
  let out = html
  for (const n of names) {
    const re = new RegExp(`<${n}\\b[^>]*>[\\s\\S]*?</${n}\\s*>`, 'gi')
    let prev: string
    do {
      prev = out
      out = out.replace(re, '')
    } while (out !== prev)
    out = out.replace(new RegExp(`<${n}\\b[^>]*/?>`, 'gi'), '')
  }
  return out
}

const CHROME_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search'])
const CHROME_WORDS = new Set(['nav', 'navbar', 'navigation', 'navbox', 'ambox', 'sidebar', 'menu', 'breadcrumb', 'breadcrumbs', 'footer', 'cookie', 'cookies', 'skip', 'jump', 'toc', 'related', 'share', 'social', 'advert', 'ads', 'promo', 'newsletter', 'subscribe', 'popup', 'modal', 'comments', 'editsection', 'noprint', 'catlinks', 'pagination'])
const BLOCKS = new Set(['div', 'section', 'ul', 'ol', 'aside', 'table', 'span', 'a', 'li', 'p'])

function isChromeTag(attrs: string): boolean {
  const role = attr(attrs, 'role')?.toLowerCase()
  if (role && CHROME_ROLES.has(role)) return true
  const words = `${attr(attrs, 'class') ?? ''} ${attr(attrs, 'id') ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return words.some((w) => CHROME_WORDS.has(w))
}

/**
 * Removes page furniture that is not in a semantic tag: elements with a navigation-like role or class word (menu, sidebar, breadcrumb, cookie banner,
 * skip link...), with everything inside. Nested tags of the same name are matched. An element that holds most of the page, or the page heading, is
 * never removed, so "with-sidebar" on the main column does not delete the article.
 */
function dropChrome(html: string): string {
  let out = html
  let from = 0
  for (let guard = 0; guard < 2000; guard++) {
    const open = /<([a-z][a-z0-9]*)\b([^>]*)>/gi
    open.lastIndex = from
    let hit: RegExpExecArray | null = null
    for (let m = open.exec(out); m; m = open.exec(out)) {
      if (BLOCKS.has(m[1].toLowerCase()) && !m[2].trimEnd().endsWith('/') && isChromeTag(m[2])) { hit = m; break }
    }
    if (!hit) break
    const name = hit[1].toLowerCase()
    const tokens = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi')
    tokens.lastIndex = hit.index + hit[0].length
    let depth = 1
    let end = -1
    for (let t = tokens.exec(out); t; t = tokens.exec(out)) {
      if (t[1] === '/') depth--
      else if (!t[0].trimEnd().endsWith('/>')) depth++
      if (depth === 0) { end = t.index + t[0].length; break }
    }
    if (end === -1) { from = hit.index + hit[0].length; continue }
    const body = out.slice(hit.index, end)
    if (body.length > out.length * 0.5 || /<h1\b/i.test(body)) { from = hit.index + hit[0].length; continue }
    out = out.slice(0, hit.index) + out.slice(end)
    from = hit.index
  }
  return out
}

function inner(html: string, name: string): string | undefined {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*)</${name}\\s*>`, 'i').exec(html)
  return m?.[1]
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : undefined
}

/** True when the text is an HTML document or fragment (it has a structural tag near its start). */
export function looksLikeHtml(text: string): boolean {
  return /<(!doctype\s+html|html|body|head|article|main|section|p|h[1-6]|div|ul|ol|table)[\s>/]/i.test(text.slice(0, 3000))
}

/** A '>' inside a quoted attribute value is legal HTML but ends a tag for the readers below; it is written as an entity first. */
function quoteSafe(html: string): string {
  return html.replace(/<[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g, (tag) => tag.replace(/"[^"]*"|'[^']*'/g, (q) => q.replace(/>/g, '&gt;')))
}

export function htmlToMarkdown(html: string): string {
  let h = quoteSafe(html.replace(/<!--[\s\S]*?-->/g, ''))
  h = dropElements(h, DROPPED)
  const main = inner(h, 'main') ?? inner(h, 'article')
  h = main ?? inner(h, 'body') ?? h
  h = dropElements(h, CHROME)
  // A <header> is page furniture, unless it holds the article's own heading.
  h = h.replace(/<header\b[^>]*>[\s\S]*?<\/header\s*>/gi, (m) => (/<h1\b/i.test(m) ? m : ''))
  h = dropChrome(h)

  // Code blocks first, so their content is kept as written.
  const blocks: string[] = []
  h = h.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, body: string) => {
    blocks.push('\n\n```\n' + decode(body.replace(/<[^>]+>/g, '')).replace(/\n+$/, '') + '\n```\n\n')
    return `\u0000${blocks.length - 1}\u0000`
  })

  // HTML treats line breaks and runs of spaces in the source as one space; real breaks come from tags. (Code blocks were taken out above.)
  h = h.replace(/\s+/g, ' ')
  h = h
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, a: string, text: string) => {
      const href = attr(a, 'href')
      const label = text.replace(/<[^>]+>/g, '').trim()
      return href && label && !href.startsWith('#') && !href.toLowerCase().startsWith('javascript:') ? `[${label}](${href})` : label
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t: string, x: string) => (x.trim() ? `**${x.trim()}**` : ''))
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t: string, x: string) => (x.trim() ? `*${x.trim()}*` : ''))
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_m, x: string) => (x.trim() ? `\`${x.replace(/<[^>]+>/g, '')}\`` : ''))
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, n: string, x: string) => `\n\n${'#'.repeat(Number(n))} ${x.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n\n`)
    .replace(/<li\b[^>]*>\s*/gi, '\n- ')
    .replace(/<blockquote\b[^>]*>/gi, '\n\n> ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|ul|ol|table|tr|blockquote|figure|figcaption|dd|dt|dl)\s*>/gi, '\n\n')
    .replace(/<\/(td|th)\s*>/gi, ' | ')
    .replace(/<[^>]+>/g, '')

  // Whitespace is tidied before the code blocks go back, so their indentation stays as written.
  const text = decode(h)
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/( \| )+\n/g, '\n')
    .replace(/^(- ?)+$/gm, '')
    .replace(/^\|( \|)*$/gm, '')
    .replace(/(^- .*)\n\n(?=- )/gm, '$1\n')
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)])
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text ? `${text}\n` : ''
}

/** The page's own title from its <title>, with a trailing site name (after a pipe, dash or colon) removed; undefined when it has none. */
export function htmlTitle(html: string): string | undefined {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)
  if (!m) return undefined
  const t = decode(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
  const cut = t.split(/\s+[|–—-]\s+/)[0].trim()
  return cut || t || undefined
}
