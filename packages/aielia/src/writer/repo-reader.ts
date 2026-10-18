import { isSkippedFolder, MAX_FILES, type FolderReader } from './local-folder.js'
import { sourceKindForFile } from './article-sources.js'

/**
 * A repository the writer hands to Write so claims about code can be found in it and verified: a folder on the writer's computer (the same
 * reader as for folder files) or a GitHub repository. Both only list and read; neither writes. A GitHub repository is read through GitHub's
 * own interfaces (the file list from the API, file text from raw.githubusercontent.com), which a browser may call directly. A private
 * repository needs the writer's own token, kept in this browser.
 */
export interface RepoReader extends FolderReader {
  /** The address a file of this repository is stored under as a source (a link for GitHub, `<folder>/<path>` for a folder). */
  addressOf?(path: string): string
}

const MAX_FILE_BYTES = 300_000

export interface GithubRepoSpec {
  owner: string
  repo: string
  /** A branch, tag or commit; the repository's default branch when absent. */
  ref?: string
  /** Only the files under this folder (from an address like github.com/o/r/tree/main/packages/x). */
  path?: string
}

/** The repository named by a GitHub address (github.com/o/r, with an optional /tree/<ref>), or `o/r`. Anything else is undefined. */
export function parseGithubRepoAddress(input: string): GithubRepoSpec | undefined {
  let text = input.trim().replace(/\.git$/i, '').replace(/\/+$/, '')
  if (text.toLowerCase().startsWith('github.com/') || text.toLowerCase().startsWith('www.github.com/')) text = `https://${text}`
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(text)
  if (short && !text.includes('://')) return { owner: short[1], repo: short[2] }
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return undefined
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return undefined
  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return undefined
  const [owner, repo, kind, ref, ...rest] = parts
  return { owner, repo: repo.replace(/\.git$/i, ''), ...(kind === 'tree' && ref ? { ref } : {}), ...(kind === 'tree' && ref && rest.length > 0 ? { path: rest.join('/') } : {}) }
}

export interface GithubReaderOptions {
  fetchImpl?: typeof fetch
  /** The writer's own GitHub token, for a private repository. Sent only to GitHub. */
  token?: string
}

export function githubRepoReader(spec: GithubRepoSpec, options: GithubReaderOptions = {}): RepoReader {
  const fetchImpl: typeof fetch = options.fetchImpl ?? ((...a) => fetch(...a))
  const ref = spec.ref ?? 'HEAD'
  const base = `https://api.github.com/repos/${spec.owner}/${spec.repo}`
  const auth: Record<string, string> = options.token ? { Authorization: `Bearer ${options.token}` } : {}
  const encode = (path: string): string => path.split('/').map(encodeURIComponent).join('/')
  return {
    name: spec.path ? `${spec.owner}/${spec.repo}/${spec.path}` : `${spec.owner}/${spec.repo}`,
    addressOf: (path) => `https://github.com/${spec.owner}/${spec.repo}/blob/${ref}/${path}`,
    async files() {
      const res = await fetchImpl(`${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers: { Accept: 'application/vnd.github+json', ...auth } })
      if (!res.ok) {
        const why = res.status === 404 ? 'not found (or private: add a GitHub token in Settings)' : res.status === 403 || res.status === 429 ? 'GitHub is limiting requests (add a GitHub token in Settings)' : `HTTP ${res.status}`
        throw new Error(`The repository ${spec.owner}/${spec.repo} could not be listed: ${why}.`)
      }
      const tree = ((await res.json()) as { tree?: { path?: string; type?: string; size?: number }[] }).tree ?? []
      const out: string[] = []
      for (const e of tree) {
        if (e.type !== 'blob' || typeof e.path !== 'string') continue
        const segments = e.path.split('/')
        if (segments.slice(0, -1).some(isSkippedFolder)) continue
        if (!sourceKindForFile({ name: segments[segments.length - 1] })) continue
        if (typeof e.size === 'number' && e.size > MAX_FILE_BYTES) continue
        if (spec.path && !e.path.startsWith(`${spec.path}/`)) continue
        out.push(e.path)
        if (out.length >= MAX_FILES) break
      }
      return out
    },
    async read(path) {
      try {
        const res = options.token
          ? await fetchImpl(`${base}/contents/${encode(path)}?ref=${encodeURIComponent(ref)}`, { headers: { Accept: 'application/vnd.github.raw+json', ...auth } })
          : await fetchImpl(`https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/${ref}/${encode(path)}`)
        return res.ok ? await res.text() : undefined
      } catch {
        return undefined
      }
    },
  }
}
