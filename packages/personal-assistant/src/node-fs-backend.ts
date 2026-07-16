import { mkdir, readFile, writeFile, readdir, unlink, realpath, stat } from 'node:fs/promises'
import type { FsBackend } from '@buildaharness/runtime'

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/**
 * node:fs/promises-backed FsBackend for the CLI. Deliberately not exported from
 * this package's index — only cli.ts imports it, so a browser build (chat-ui)
 * that only ever imports the package root never pulls a Node builtin into its
 * bundle.
 */
export function createNodeFsBackend(): FsBackend {
  return {
    async readTextFile(path) {
      try {
        return await readFile(path, 'utf-8')
      } catch (err) {
        if (isEnoent(err)) return undefined
        throw err
      }
    },
    async writeTextFile(path, contents) {
      await writeFile(path, contents, 'utf-8')
    },
    async removeFile(path) {
      try {
        await unlink(path)
      } catch (err) {
        if (!isEnoent(err)) throw err
      }
    },
    async mkdir(path) {
      await mkdir(path, { recursive: true })
    },
    async readDir(path) {
      try {
        return await readdir(path)
      } catch (err) {
        if (isEnoent(err)) return []
        throw err
      }
    },
    async realpath(path) {
      return realpath(path)
    },
    async stat(path) {
      try {
        const info = await stat(path)
        return { isDirectory: info.isDirectory(), size: info.size }
      } catch (err) {
        if (isEnoent(err)) return undefined
        throw err
      }
    },
  }
}
