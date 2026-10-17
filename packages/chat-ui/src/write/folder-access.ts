import { walkFolder, type FolderReader } from '@buildaharness/aielia'

/** The part of the browser's folder-access feature this page uses (Chromium browsers only; read access, never write). */
interface DirHandle {
  kind: 'directory'
  name: string
  entries(): AsyncIterable<[string, DirHandle | FileHandle]>
  getFileHandle(name: string): Promise<FileHandle>
  getDirectoryHandle(name: string): Promise<DirHandle>
}
interface FileHandle {
  kind: 'file'
  getFile(): Promise<{ text(): Promise<string> }>
}

export type PickDirectory = (options: { mode: 'read' }) => Promise<DirHandle>

/** The browser's folder picker, when it has one. */
export function browserFolderPicker(): (() => Promise<FolderReader | undefined>) | undefined {
  const pick = (window as unknown as { showDirectoryPicker?: PickDirectory }).showDirectoryPicker
  return pick ? () => pickFolder(pick.bind(window)) : undefined
}

/** Asks for a folder. Cancelling the picker is not an error: it gives undefined. */
export async function pickFolder(pick: PickDirectory): Promise<FolderReader | undefined> {
  let root: DirHandle
  try {
    root = await pick({ mode: 'read' })
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return undefined
    throw e
  }
  return readerFor(root)
}

async function dirAt(root: DirHandle, path: string): Promise<DirHandle> {
  let dir = root
  for (const part of path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part)
  return dir
}

export function readerFor(root: DirHandle): FolderReader {
  return {
    name: root.name,
    files: () =>
      walkFolder(async (dir) => {
        const out: { name: string; directory: boolean }[] = []
        for await (const [name, handle] of (await dirAt(root, dir)).entries()) out.push({ name, directory: handle.kind !== 'file' })
        return out
      }),
    read: async (path) => {
      try {
        const parts = path.split('/')
        const file = await (await dirAt(root, parts.slice(0, -1).join('/'))).getFileHandle(parts[parts.length - 1])
        return await (await file.getFile()).text()
      } catch {
        return undefined
      }
    },
  }
}
