import { sourceKindForFile } from './article-sources.js'

/**
 * A folder on the writer's own computer (a checkout of a repository, say) that the writer has allowed the page to read.
 * The page reads from it only what the writer picks, and never writes to it. The reader is held for the session; nothing about it is stored
 * in the article except the file's address, written as `<folder name>/<path>`, which is how a file is found again.
 */
export interface FolderReader {
  /** The folder's own name, the first part of every file's address. */
  name: string
  /** Paths of the readable files under the folder, relative and with `/` separators. */
  files(): Promise<string[]>
  /** The file's text, or undefined when it is gone or cannot be read. */
  read(path: string): Promise<string | undefined>
}

/** Folders that hold other people's code, builds or history: never listed. */
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.next', '.venv', '__pycache__', 'vendor'])
/** The most files a listing keeps; a repository with more is listed level by level and the deepest are left out. */
export const MAX_FILES = 20000
const MAX_DEPTH = 8

export function isSkippedFolder(name: string): boolean {
  return SKIPPED_FOLDERS.has(name)
}

/** The address a folder file is stored under. */
export function folderFileAddress(folderName: string, path: string): string {
  return `${folderName}/${path}`
}

/** The path inside the folder for an address stored by folderFileAddress, or undefined when the address belongs to another folder. */
export function pathInFolder(folderName: string, address: string): string | undefined {
  return address.startsWith(`${folderName}/`) ? address.slice(folderName.length + 1) : undefined
}

/**
 * Walks a folder through a lister that says, for a directory path, its entries and which are folders. Skipped folders are left out, only files the
 * Write page can read as text or code are kept, and the walk stops at a fixed depth and file count.
 */
export async function walkFolder(list: (dir: string) => Promise<{ name: string; directory: boolean }[]>): Promise<string[]> {
  const found: string[] = []
  // Level by level, so that when a very large folder hits the file limit it is the deepest files that are left out, not whole top-level folders.
  let level: string[] = ['']
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0 && found.length < MAX_FILES; depth++) {
    const next: string[] = []
    for (const dir of level) {
      let entries: { name: string; directory: boolean }[]
      try {
        entries = await list(dir)
      } catch {
        continue
      }
      for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
        const path = dir ? `${dir}/${e.name}` : e.name
        if (e.directory) {
          if (depth < MAX_DEPTH && !isSkippedFolder(e.name)) next.push(path)
        } else if (sourceKindForFile({ name: e.name }) && found.length < MAX_FILES) found.push(path)
      }
    }
    level = next
  }
  return found
}

/**
 * A reader over a file system that can list a directory with each entry marked as a file or a folder (the desktop app's `workspace_list_dir`),
 * so subfolders are walked into without guessing which names are folders. `root` is the folder's absolute path.
 */
export function folderFromListing(fs: { readTextFile(path: string): Promise<string | undefined>; listDir(path: string): Promise<{ name: string; directory: boolean }[]> }, root: string, name: string): FolderReader {
  const base = root.replace(/[\\/]+$/, '')
  const abs = (p: string): string => (p ? `${base}/${p}` : base)
  return {
    name,
    files: () => walkFolder((dir) => fs.listDir(abs(dir))),
    read: async (path) => {
      try {
        return await fs.readTextFile(abs(path))
      } catch {
        return undefined
      }
    },
  }
}

/**
 * A reader over a file-system backend that has only readTextFile and readDir (the desktop app's). It cannot tell a folder from a file by name, so a
 * path that cannot be listed as a directory is taken to be a file.
 */
export function folderFromFsBackend(fs: { readTextFile(path: string): Promise<string | undefined>; readDir(path: string): Promise<string[]> }, root: string, name: string): FolderReader {
  const abs = (p: string): string => (p ? `${root.replace(/\/$/, '')}/${p}` : root)
  return {
    name,
    files: () =>
      walkFolder(async (dir) => {
        const names = await fs.readDir(abs(dir))
        const entries: { name: string; directory: boolean }[] = []
        for (const n of names) {
          let directory = true
          try {
            await fs.readDir(abs(dir ? `${dir}/${n}` : n))
          } catch {
            directory = false
          }
          entries.push({ name: n, directory })
        }
        return entries
      }),
    read: async (path) => {
      try {
        return await fs.readTextFile(abs(path))
      } catch {
        return undefined
      }
    },
  }
}

/** The files whose path contains every word typed (any case), shortest path first; at most `limit`. A plain filter, no meaning is read from the words. */
export function matchFolderFiles(files: string[], query: string, limit = 8): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return files
    .filter((f) => words.every((w) => f.toLowerCase().includes(w)))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, limit)
}
