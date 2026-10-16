import { ARTICLE_META_VERSION, parseArticleMeta, type ArticleMeta } from './article-model.js'
import type { Snapshot } from './article-rules.js'

/**
 * The portable form of one article (article-model plan, section 2): a small folder, represented here as a map from
 * path to text so the browser database, an exported folder and the terminal runner all use the same layout.
 *
 *   article.md              the text, ordinary Markdown
 *   article.meta.json       everything else, with its own format version
 *   sources/<id>.txt        stored source passages, kept out of the main metadata file
 *   versions/<n>.json       published snapshots and checkpoints
 *
 * Loading either succeeds completely or refuses with a message naming what could not be read. Nothing is partly loaded.
 */

export type ArticleFolder = Record<string, string>

export interface ArticleBundle {
  markdown: string
  meta: ArticleMeta
  snapshots: Snapshot[]
}

export type FolderLoad = { ok: true; bundle: ArticleBundle } | { ok: false; reason: string }

const META_PATH = 'article.meta.json'
const TEXT_PATH = 'article.md'
const sourcePath = (id: string): string => `sources/${id}.txt`
const versionPath = (n: number): string => `versions/${String(n).padStart(4, '0')}.json`

export function serializeArticle(bundle: ArticleBundle): ArticleFolder {
  const folder: ArticleFolder = { [TEXT_PATH]: bundle.markdown }
  const lean: ArticleMeta = {
    ...bundle.meta,
    sources: bundle.meta.sources.map((s) => {
      if (s.passage !== undefined) folder[sourcePath(s.id)] = s.passage
      const { passage: _passage, ...rest } = s
      return rest
    }),
  }
  folder[META_PATH] = JSON.stringify(lean, null, 2)
  bundle.snapshots.forEach((snap, i) => {
    folder[versionPath(i + 1)] = JSON.stringify(snap)
  })
  return folder
}

export function loadArticleFolder(folder: ArticleFolder): FolderLoad {
  if (typeof folder[TEXT_PATH] !== 'string') return { ok: false, reason: 'The folder has no article.md.' }
  if (typeof folder[META_PATH] !== 'string') return { ok: false, reason: 'The folder has no article.meta.json.' }
  let raw: unknown
  try {
    raw = JSON.parse(folder[META_PATH])
  } catch {
    return { ok: false, reason: 'article.meta.json is not valid JSON.' }
  }
  const parsed = parseArticleMeta(raw)
  if (!parsed.ok) return parsed

  // Passages: every source that had one when saved must have its file. A missing file is reported, not skipped.
  const missing: string[] = []
  const sources = parsed.meta.sources.map((s) => {
    if (s.fingerprint === undefined) return s
    const passage = folder[sourcePath(s.id)]
    if (typeof passage !== 'string') {
      missing.push(sourcePath(s.id))
      return s
    }
    return { ...s, passage }
  })
  if (missing.length > 0) return { ok: false, reason: `Stored source passages are missing: ${missing.join(', ')}.` }

  const snapshots: Snapshot[] = []
  const versionPaths = Object.keys(folder).filter((p) => p.startsWith('versions/') && p.endsWith('.json')).sort()
  for (const path of versionPaths) {
    let snap: unknown
    try {
      snap = JSON.parse(folder[path])
    } catch {
      return { ok: false, reason: `${path} is not valid JSON.` }
    }
    const s = snap as Partial<Snapshot> | null
    if (!s || typeof s.markdown !== 'string' || typeof s.at !== 'string' || (s.kind !== 'published' && s.kind !== 'checkpoint')) return { ok: false, reason: `${path} is not a readable snapshot.` }
    const inner = parseArticleMeta(s.meta)
    if (!inner.ok) return { ok: false, reason: `${path}: ${inner.reason}` }
    snapshots.push({ kind: s.kind, label: s.label, at: s.at, markdown: s.markdown, meta: inner.meta, readiness: s.readiness as Snapshot['readiness'] })
  }
  return { ok: true, bundle: { markdown: folder[TEXT_PATH], meta: { ...parsed.meta, sources }, snapshots } }
}

export { ARTICLE_META_VERSION }
