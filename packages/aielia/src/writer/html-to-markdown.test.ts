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
