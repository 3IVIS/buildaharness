/**
 * HTML to markdown for pulling a page in to edit: no DOM, so it runs in the shared code. It keeps the structure an article has (headings, paragraphs,
 * lists, quotes, code, links, emphasis) and drops what is not the article (scripts, styles, navigation, headers and footers outside the main text,
 * forms, comments). When the page has a <main> or <article>, only that is used. It is a reader, not a parser of every page on the web: odd markup
 * comes out as plain paragraphs.
 */

const DROPPED = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'form', 'select', 'button', 'head']
const CHROME = ['nav', 'header', 'footer', 'aside']
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

export function htmlToMarkdown(html: string): string {
  let h = html.replace(/<!--[\s\S]*?-->/g, '')
  h = dropElements(h, DROPPED)
  const main = inner(h, 'main') ?? inner(h, 'article')
  h = main ?? inner(h, 'body') ?? h
  h = dropElements(h, CHROME)

  // Code blocks first, so their content is kept as written.
  const blocks: string[] = []
  h = h.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, body: string) => {
    blocks.push('\n\n```\n' + decode(body.replace(/<[^>]+>/g, '')).replace(/\n+$/, '') + '\n```\n\n')
    return `\u0000${blocks.length - 1}\u0000`
  })

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
    .replace(/<li\b[^>]*>/gi, '\n- ')
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
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)])
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text ? `${text}\n` : ''
}
