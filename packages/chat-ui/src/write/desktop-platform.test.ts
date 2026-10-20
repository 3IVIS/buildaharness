import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pickDesktopFolder } from './desktop-platform'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

beforeEach(() => invoke.mockReset())

describe('picking a folder in the desktop app', () => {
  it('gives undefined when the writer cancels the dialog', async () => {
    invoke.mockResolvedValueOnce(null)
    expect(await pickDesktopFolder(() => { throw new Error('should not be used') })).toBeUndefined()
  })
  it('reads only inside the chosen folder, named after it, listing text and code files and skipping dependency folders', async () => {
    invoke.mockResolvedValueOnce('/Users/me/code/my-repo/')
    const roots: string[] = []
    const tree: Record<string, { name: string; directory: boolean }[]> = {
      '/Users/me/code/my-repo': [{ name: 'README.md', directory: false }, { name: 'src', directory: true }, { name: 'node_modules', directory: true }],
      '/Users/me/code/my-repo/src': [{ name: 'a.ts', directory: false }],
    }
    const text: Record<string, string> = { '/Users/me/code/my-repo/src/a.ts': 'export const x = 1\n' }
    const reader = await pickDesktopFolder((root) => {
      roots.push(root)
      return {
        listDir: async (p) => tree[p] ?? [],
        readTextFile: async (p) => text[p],
      }
    })
    expect(roots).toEqual(['/Users/me/code/my-repo'])
    expect(reader?.name).toBe('my-repo')
    expect(await reader?.files()).toEqual(['README.md', 'src/a.ts'])
    expect(await reader?.read('src/a.ts')).toBe('export const x = 1\n')
  })
})
