import type { MemoryAdapter } from '@buildaharness/runtime'
import { loadArticleFolder, serializeArticle, type ArticleBundle, type ArticleFolder } from './article-folder.js'
import type { ArticleStore } from './article-service.js'
import type { ArticleRef } from './writer-chat-state.js'

/**
 * An ArticleStore on any MemoryAdapter (IndexedDB in the browser, files on the desktop, in-memory in tests). Each article is
 * saved as its portable folder map, so what is stored is exactly what an export holds and a damaged record is refused
 * with a reason instead of being half-loaded.
 */

const INDEX_KEY = 'writer:index'
const articleKey = (id: string): string => `writer:article:${id}`
const settingKey = (key: string): string => `writer:setting:${key}`

export function createMemoryAdapterArticleStore(memory: MemoryAdapter): ArticleStore {
  async function readIndex(): Promise<ArticleRef[]> {
    const raw = await memory.get(INDEX_KEY)
    return Array.isArray(raw) ? (raw as ArticleRef[]).filter((r) => r && typeof r.id === 'string' && typeof r.title === 'string') : []
  }
  return {
    list: readIndex,
    async load(id) {
      const raw = await memory.get(articleKey(id))
      if (!raw || typeof raw !== 'object') return undefined
      const loaded = loadArticleFolder(raw as ArticleFolder)
      if (!loaded.ok) throw new Error(`Article ${id} could not be read: ${loaded.reason}`)
      return loaded.bundle
    },
    async save(id: string, bundle: ArticleBundle) {
      await memory.set(articleKey(id), serializeArticle(bundle))
      const index = await readIndex()
      const next = index.some((r) => r.id === id) ? index.map((r) => (r.id === id ? { id, title: bundle.meta.title, name: bundle.meta.name } : r)) : [...index, { id, title: bundle.meta.title, name: bundle.meta.name }]
      await memory.set(INDEX_KEY, next)
    },
    async remove(id) {
      await memory.delete(articleKey(id))
      await memory.set(INDEX_KEY, (await readIndex()).filter((r) => r.id !== id))
    },
    async getSetting(key) {
      return memory.get(settingKey(key))
    },
    async setSetting(key, value) {
      if (value === undefined) await memory.delete(settingKey(key))
      else await memory.set(settingKey(key), value)
    },
  }
}
