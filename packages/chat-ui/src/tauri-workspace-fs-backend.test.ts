import { describe, it, expect, vi, afterEach } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))

const { createTauriWorkspaceFsBackend } = await import('./tauri-workspace-fs-backend.js')

const WORKSPACE_ROOT = '/Users/alice/project'

afterEach(() => {
  vi.clearAllMocks()
})

describe('createTauriWorkspaceFsBackend', () => {
  it('readTextFile invokes workspace_read_text_file with workspaceRoot + path', async () => {
    invokeMock.mockResolvedValue('hello world')
    const backend = createTauriWorkspaceFsBackend(WORKSPACE_ROOT)

    const result = await backend.readTextFile('notes.txt')

    expect(result).toBe('hello world')
    expect(invokeMock).toHaveBeenCalledWith('workspace_read_text_file', { workspaceRoot: WORKSPACE_ROOT, path: 'notes.txt' })
  })

  it('readTextFile resolves undefined (not null) when the Rust side returns null for a missing file', async () => {
    invokeMock.mockResolvedValue(null)
    const backend = createTauriWorkspaceFsBackend(WORKSPACE_ROOT)

    expect(await backend.readTextFile('missing.txt')).toBeUndefined()
  })

  it('writeTextFile invokes workspace_write_text_file with contents', async () => {
    invokeMock.mockResolvedValue(undefined)
    const backend = createTauriWorkspaceFsBackend(WORKSPACE_ROOT)

    await backend.writeTextFile('notes.txt', 'new content')

    expect(invokeMock).toHaveBeenCalledWith('workspace_write_text_file', {
      workspaceRoot: WORKSPACE_ROOT,
      path: 'notes.txt',
      contents: 'new content',
    })
  })

  it('removeFile invokes workspace_remove_file', async () => {
    const backend = createTauriWorkspaceFsBackend(WORKSPACE_ROOT)
    await backend.removeFile('notes.txt')
    expect(invokeMock).toHaveBeenCalledWith('workspace_remove_file', { workspaceRoot: WORKSPACE_ROOT, path: 'notes.txt' })
  })

  it('mkdir invokes workspace_mkdir', async () => {
    const backend = createTauriWorkspaceFsBackend(WORKSPACE_ROOT)
    await backend.mkdir('.pending-actions')
    expect(invokeMock).toHaveBeenCalledWith('workspace_mkdir', { workspaceRoot: WORKSPACE_ROOT, path: '.pending-actions' })
  })

  it('readDir invokes workspace_read_dir and returns the file name list', async () => {
    invokeMock.mockResolvedValue(['a.txt', 'b.txt'])
    const backend = createTauriWorkspaceFsBackend(WORKSPACE_ROOT)

    const result = await backend.readDir('.')

    expect(result).toEqual(['a.txt', 'b.txt'])
    expect(invokeMock).toHaveBeenCalledWith('workspace_read_dir', { workspaceRoot: WORKSPACE_ROOT, path: '.' })
  })

  it('realpath invokes workspace_realpath and returns the resolved path', async () => {
    invokeMock.mockResolvedValue('/Users/alice/project/notes.txt')
    const backend = createTauriWorkspaceFsBackend(WORKSPACE_ROOT)

    const result = await backend.realpath?.('notes.txt')

    expect(result).toBe('/Users/alice/project/notes.txt')
    expect(invokeMock).toHaveBeenCalledWith('workspace_realpath', { workspaceRoot: WORKSPACE_ROOT, path: 'notes.txt' })
  })
})
