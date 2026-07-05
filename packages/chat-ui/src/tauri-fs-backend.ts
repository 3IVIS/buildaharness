import { exists, mkdir, readDir, readTextFile, remove, writeTextFile } from '@tauri-apps/plugin-fs'
import type { FsBackend } from '@buildaharness/runtime'

/**
 * @tauri-apps/plugin-fs-backed FsBackend for the desktop build. Only imported
 * from a dynamic import() gated on isTauriEnv() in App.tsx, so a plain browser
 * build never has to resolve this at runtime (Vite still resolves the
 * specifier at build time to code-split it, which is why @tauri-apps/plugin-fs
 * is a real dependency of this package rather than something injected).
 */
export function createTauriFsBackend(): FsBackend {
  return {
    async readTextFile(path) {
      if (!(await exists(path))) return undefined
      return await readTextFile(path)
    },
    async writeTextFile(path, contents) {
      await writeTextFile(path, contents)
    },
    async removeFile(path) {
      if (await exists(path)) await remove(path)
    },
    async mkdir(path) {
      if (!(await exists(path))) await mkdir(path, { recursive: true })
    },
    async readDir(path) {
      const entries = await readDir(path)
      return entries.filter(e => e.isFile).map(e => e.name)
    },
  }
}
