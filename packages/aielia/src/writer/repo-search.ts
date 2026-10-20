import type { FolderReader } from './local-folder.js'

/**
 * A searchable copy of a repository held in memory for one session, so a model can look things up (search, read some lines, list a folder) instead of being
 * shown a path list and asked to guess. Built from any reader (a local folder or a GitHub repository); nothing is written anywhere. Pure: no node or DOM imports.
 */

/** Files bigger than this are left out (generated or data files that would only drown the search). */
export const MAX_INDEXED_FILE_CHARS = 300_000
/** The most characters of text a single search or read answers with. */
export const MAX_ANSWER_CHARS = 4000
export const MAX_MATCHES = 30
const MAX_LINE_CHARS = 220
const READ_CONCURRENCY = 16

export interface RepoIndex {
  /** Number of files held. */
  readonly fileCount: number
  /** Lines matching a pattern (case-insensitive regular expression; an invalid one is searched as plain text), as `path:line: text`. `glob` narrows the paths (`*.ts`, a folder, or a part of a path). */
  search(pattern: string, glob?: string): string
  /** The lines `from`..`to` (1-based, inclusive) of a file, numbered; at most MAX_ANSWER_CHARS characters. */
  readLines(path: string, from?: number, to?: number): string
  /** The files and folders directly under a folder ('' for the top). */
  list(folder?: string): string
  /** The whole text of a file, or undefined. */
  text(path: string): string | undefined
  /** Whether the file exists in the index. */
  has(path: string): boolean
}

function globTest(glob: string | undefined): (path: string) => boolean {
  const g = (glob ?? '').trim()
  if (!g) return () => true
  if (g.includes('*')) {
    const re = new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i')
    return (p) => re.test(p) || re.test(p.slice(p.lastIndexOf('/') + 1))
  }
  const lower = g.toLowerCase()
  return (p) => p.toLowerCase().includes(lower)
}

function compile(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
}

export function createRepoIndex(files: ReadonlyMap<string, string>): RepoIndex {
  const paths = [...files.keys()].sort()
  return {
    fileCount: paths.length,
    has: (path) => files.has(path),
    text: (path) => files.get(path),
    search(pattern, glob) {
      if (!pattern.trim()) return 'Give a pattern to search for.'
      const re = compile(pattern)
      const inScope = globTest(glob)
      const out: string[] = []
      let total = 0
      for (const path of paths) {
        if (!inScope(path)) continue
        const lines = (files.get(path) as string).split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue
          total++
          if (out.length < MAX_MATCHES) out.push(`${path}:${i + 1}: ${lines[i].trim().slice(0, MAX_LINE_CHARS)}`)
        }
      }
      if (total === 0) return `No lines match "${pattern}"${glob ? ` in ${glob}` : ''}.`
      const text = out.join('\n')
      const more = total > out.length ? `\n(${total - out.length} more matching lines; narrow the pattern or use glob)` : ''
      return (text.length > MAX_ANSWER_CHARS ? text.slice(0, MAX_ANSWER_CHARS) + '\n(cut)' : text) + more
    },
    readLines(path, from = 1, to) {
      const text = files.get(path)
      if (text === undefined) return `No file ${path} in the repository.`
      const lines = text.split('\n')
      const start = Math.max(1, Math.floor(from))
      const end = Math.min(lines.length, Math.floor(to ?? start + 79))
      let out = ''
      for (let i = start; i <= end; i++) {
        const next = `${i}: ${lines[i - 1]}\n`
        if (out.length + next.length > MAX_ANSWER_CHARS) { out += `(cut at line ${i - 1} of ${lines.length}; ask for a later range)`; return out }
        out += next
      }
      return out + (end < lines.length ? `(file has ${lines.length} lines)` : '')
    },
    list(folder = '') {
      const prefix = folder.replace(/^\/+|\/+$/g, '')
      const base = prefix ? prefix + '/' : ''
      const entries = new Map<string, number>()
      for (const p of paths) {
        if (!p.startsWith(base)) continue
        const rest = p.slice(base.length)
        const slash = rest.indexOf('/')
        const name = slash === -1 ? rest : rest.slice(0, slash + 1)
        entries.set(name, (entries.get(name) ?? 0) + 1)
      }
      if (entries.size === 0) return `No folder ${folder} in the repository.`
      const text = [...entries].map(([n, c]) => (n.endsWith('/') ? `${n} (${c} files)` : n)).join('\n')
      return text.length > MAX_ANSWER_CHARS ? text.slice(0, MAX_ANSWER_CHARS) + '\n(cut)' : text
    },
  }
}

/** Reads every file the reader lists (skipping the oversized and the empty) into an index. */
export async function buildRepoIndex(reader: FolderReader): Promise<RepoIndex> {
  const paths = await reader.files()
  const files = new Map<string, string>()
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const path = paths[next++]
      let text: string | undefined
      try { text = await reader.read(path) } catch { text = undefined }
      if (text && text.trim() && text.length <= MAX_INDEXED_FILE_CHARS) files.set(path, text)
    }
  }
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker))
  return createRepoIndex(files)
}
