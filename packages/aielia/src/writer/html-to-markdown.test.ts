import { describe, it, expect } from 'vitest'
import { htmlToMarkdown, looksLikeHtml } from './html-to-markdown.js'
import { pageToArticle } from './article-sources.js'
import { ArticleService, createMemoryArticleStore } from './article-service.js'
import type { ILLMClient } from '@buildaharness/runtime'

const PAGE = `<!doctype html><html><head><title>Site</title><style>p{}</style><script>var x = "<p>no</p>"</script></head>
<body><nav><a href="/">Home</a></nav><header>Site header</header>
<main><h1>Caching &amp; speed</h1><p>The cache holds <strong>100</strong> items, see <a href="https://x.test/doc">the doc</a>.</p>
<h2>Details</h2><ul><li>first</li><li>second <em>one</em></li></ul><blockquote>Quoted</blockquote>
<pre><code>if (a &lt; b) {\n  go()\n}</code></pre><!-- hidden --><p>Use <code>LIMIT</code> here.<br>Next line</p></main><footer>© site</footer></body></html>`

describe('HTML to markdown', () => {
  it('keeps the article structure and leaves out the page chrome, scripts and comments', () => {
    const md = htmlToMarkdown(PAGE)
    expect(md).toContain('# Caching & speed')
    expect(md).toContain('The cache holds **100** items, see [the doc](https://x.test/doc).')
    expect(md).toContain('## Details')
    expect(md).toContain('- first')
    expect(md).toContain('- second *one*')
    expect(md).toContain('> Quoted')
    expect(md).toContain('```\nif (a < b) {\n  go()\n}\n```')
    expect(md).toContain('Use `LIMIT` here.\nNext line')
    for (const gone of ['Home', 'Site header', 'hidden', 'var x', '© site', 'no</p>']) expect(md).not.toContain(gone)
  })
  it('uses the body when there is no main or article, and handles a fragment', () => {
    expect(htmlToMarkdown('<html><body><h2>Hi</h2><p>There</p></body></html>')).toBe('## Hi\n\nThere\n')
    expect(htmlToMarkdown('<p>One</p><p>Two &#8212; &#x41;</p>')).toBe('One\n\nTwo — A\n')
  })
  it('recognises HTML by its structure only', () => {
    expect(looksLikeHtml('<!DOCTYPE html><html>')).toBe(true)
    expect(looksLikeHtml('# A heading\n\nText with a < b and <b>bold</b>')).toBe(false)
  })
  it('makes an article of a page: the heading is the title', () => {
    expect(pageToArticle(PAGE, 'https://x.test/p')).toMatchObject({ title: 'Caching & speed' })
  })
})

describe('HTML as found on real pages', () => {
  it('joins the lines of a hard-wrapped paragraph, so a sentence is not cut at the source line breaks', () => {
    expect(htmlToMarkdown('<p>The cache holds\n   100 items. It is\nquick.</p>')).toBe('The cache holds 100 items. It is quick.\n')
  })
  it('drops navigation, menus and cookie banners that are plain divs, but never the column that holds the article', () => {
    const page = '<body><div class="site-nav"><ul><li><a href="/">Home</a></li></ul></div><div id="cookie-banner">We use cookies</div><div class="content with-sidebar"><h1>Title</h1><p>Real text here.</p><div class="sidebar"><p>Related stuff</p></div></div></body>'
    const md = htmlToMarkdown(page)
    expect(md).toBe('# Title\n\nReal text here.\n')
  })
  it('keeps a header that holds the article heading and drops one that does not', () => {
    expect(htmlToMarkdown('<article><header><h1>Post</h1><p class="by">By me</p></header><p>Body.</p></article>')).toBe('# Post\n\nBy me\n\nBody.\n')
    expect(htmlToMarkdown('<body><header><a href="/">Logo</a></header><p>Body.</p></body>')).toBe('Body.\n')
  })
  it('reads past a ">" inside an attribute value', () => {
    expect(htmlToMarkdown('<p>One <span data-x="a > b</code>">two</span> three</p>')).toBe('One two three\n')
  })
  it('makes tight lists without empty bullets', () => {
    expect(htmlToMarkdown('<ul>\n <li>\n  <a href="/a">one</a>\n </li>\n <li></li>\n <li>two</li>\n</ul>')).toBe('- [one](/a)\n- two\n')
  })
  it('titles the article from its heading, else the page title without the site name, else the first line', () => {
    expect(pageToArticle('<html><head><title>Post | Site</title></head><body><h1>The Post</h1><p>x</p></body></html>', 'https://s.test').title).toBe('The Post')
    expect(pageToArticle('<html><head><title>Example Domain - Site</title></head><body><p>No heading here.</p></body></html>', 'https://s.test').title).toBe('Example Domain')
    expect(pageToArticle('Just a line\n\nMore.', 'https://s.test').title).toBe('Just a line')
  })
})

describe('opening a file to edit', () => {
  const svc = new ArticleService({ store: createMemoryArticleStore(), llm: {} as unknown as ILLMClient })
  it('turns MDX, markdown and HTML files into articles and refuses other kinds', async () => {
    const mdx = await svc.importTextFile('post.mdx', '# Post\n\nimport X from "x"\n\n<X />\n\nBody.\n')
    const html = await svc.importTextFile('page.html', '<html><body><h1>Page</h1><p>Body.</p></body></html>')
    if (!mdx.ok || !html.ok) throw new Error('not imported')
    expect((await svc.get(mdx.id)).markdown).toContain('import X from "x"')
    expect((await svc.get(html.id)).markdown).toBe('# Page\n\nBody.\n')
    expect(await svc.importTextFile('pic.png', 'x')).toMatchObject({ ok: false })
    expect(await svc.importTextFile('empty.md', '  ')).toMatchObject({ ok: false })
  })
})
