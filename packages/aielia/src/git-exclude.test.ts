import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { excludeAieliaStateFromGit } from './git-exclude.js'
import { createNodeFsBackend } from './node-fs-backend.js'
import { stagePendingAction, applyPendingAction } from './file-tools.js'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aielia-git-'))
  dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 't')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  writeFileSync(join(dir, '.gitignore'), 'build/\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return dir
}
const status = (dir: string) => execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })

describe('excludeAieliaStateFromGit (benchmark 08/09/14: Aielia state showed up in git status)', () => {
  it('after a staged write is approved, git status shows no Aielia directories and the user .gitignore is untouched', async () => {
    const dir = tempRepo()
    const ignoreBefore = readFileSync(join(dir, '.gitignore'), 'utf8')
    expect(excludeAieliaStateFromGit(dir)).toEqual(['.pending-actions/', '.undo-log/', '.buildaharness/'])

    const backend = createNodeFsBackend()
    const { id } = await stagePendingAction(backend, dir, { kind: 'write', path: 'a.txt', content: 'two\n' })
    await applyPendingAction(backend, dir, id, {})
    mkdirSync(join(dir, '.buildaharness', 'goals'), { recursive: true })
    writeFileSync(join(dir, '.buildaharness', 'goals', 'x.json'), '{}')
    mkdirSync(join(dir, '.undo-log'), { recursive: true })
    writeFileSync(join(dir, '.undo-log', 'e.json'), '{}')
    mkdirSync(join(dir, '.pending-actions'), { recursive: true })
    writeFileSync(join(dir, '.pending-actions', 'p.json'), '{}')

    expect(status(dir)).toBe(' M a.txt\n')
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(ignoreBefore)
  })

  it('is idempotent, keeps existing exclude content, and adds only what is missing', () => {
    const dir = tempRepo()
    mkdirSync(join(dir, '.git', 'info'), { recursive: true })
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '*.log\n.undo-log/')
    expect(excludeAieliaStateFromGit(dir)).toEqual(['.pending-actions/', '.buildaharness/'])
    expect(excludeAieliaStateFromGit(dir)).toEqual([])
    const text = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')
    expect(text.startsWith('*.log\n.undo-log/\n')).toBe(true)
    expect(text.match(/\.pending-actions\//g)).toHaveLength(1)
  })

  it('works from a subdirectory of the repo and from a linked worktree', () => {
    const dir = tempRepo()
    const sub = join(dir, 'pkg')
    mkdirSync(sub)
    expect(excludeAieliaStateFromGit(sub)).toHaveLength(3)

    const wt = mkdtempSync(join(tmpdir(), 'aielia-wt-'))
    dirs.push(wt)
    rmSync(wt, { recursive: true, force: true })
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt', wt], { cwd: dir, stdio: 'pipe' })
    expect(excludeAieliaStateFromGit(wt)).toEqual([]) // shared exclude file already has them
    mkdirSync(join(wt, '.undo-log'))
    writeFileSync(join(wt, '.undo-log', 'e.json'), '{}')
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' })).toBe('')
  })

  it('leaves a non-git directory untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aielia-nogit-'))
    dirs.push(dir)
    expect(excludeAieliaStateFromGit(dir)).toEqual([])
    expect(existsSync(join(dir, '.git'))).toBe(false)
  })
})
