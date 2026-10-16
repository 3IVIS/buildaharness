import { describe, it, expect } from 'vitest'
import { InMemoryAdapter } from '@buildaharness/runtime'
import { ArticleService } from './article-service.js'
import { createMemoryAdapterArticleStore } from './article-memory-store.js'

const mem = () => new InMemoryAdapter({ scope: 'thread', namespace: 'store-test' })
const llm = {} as never

describe('createMemoryAdapterArticleStore', () => {
  it('saves and loads articles through the portable folder form, and keeps an index', async () => {
    const memory = mem()
    const s = new ArticleService({ store: createMemoryAdapterArticleStore(memory), llm, newId: () => 'a1' })
    const id = await s.create('Post', '# Post\n\nText.\n')
    await s.addSource(id, { kind: 'upload', passage: 'a passage' })
    // a second service on the same memory sees it (a new page load)
    const again = new ArticleService({ store: createMemoryAdapterArticleStore(memory), llm })
    expect(await again.list()).toEqual([{ id, title: 'Post', name: 'Post' }])
    expect((await again.get(id)).meta.sources[0].passage).toBe('a passage')
  })

  it('removes an article and its index entry, and stores settings apart', async () => {
    const store = createMemoryAdapterArticleStore(mem())
    const s = new ArticleService({ store, llm, newId: () => 'a1' })
    const id = await s.create('Post', '# Post\n')
    await store.setSetting('x', 42)
    expect(await store.getSetting('x')).toBe(42)
    await store.setSetting('x', undefined)
    expect(await store.getSetting('x')).toBeUndefined()
    await store.remove(id)
    expect(await store.list()).toEqual([])
    expect(await store.load(id)).toBeUndefined()
  })

  it('refuses a damaged record with a reason instead of loading it partly', async () => {
    const memory = mem()
    const store = createMemoryAdapterArticleStore(memory)
    await memory.set('writer:article:bad', { 'article.md': 'x' })
    await expect(store.load('bad')).rejects.toThrow('could not be read')
  })
})
