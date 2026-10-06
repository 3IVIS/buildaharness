import { existsSync, mkdirSync, readFileSync, statSync, appendFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Directories Aielia keeps inside the workspace for its own state. */
export const AIELIA_STATE_DIRS = ['.pending-actions', '.undo-log', '.buildaharness'] as const

/** The git directory of the repository containing `start` (walking up), following a `.git` file (worktrees/submodules). */
function findGitDir(start: string): string | undefined {
  let dir = resolve(start)
  for (;;) {
    const dotGit = join(dir, '.git')
    if (existsSync(dotGit)) {
      const stat = statSync(dotGit)
      if (stat.isDirectory()) return dotGit
      const line = readFileSync(dotGit, 'utf8').split('\n').find((l) => l.startsWith('gitdir:'))
      if (!line) return undefined
      const target = line.slice('gitdir:'.length).trim()
      const gitDir = isAbsolute(target) ? target : resolve(dir, target)
      // A linked worktree's info/exclude lives in the shared (common) git directory.
      const commonFile = join(gitDir, 'commondir')
      if (existsSync(commonFile)) return resolve(gitDir, readFileSync(commonFile, 'utf8').trim())
      return gitDir
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Keeps Aielia's own state directories out of version control when the workspace is inside a git repo, by adding them to
 * `<gitdir>/info/exclude` — the per-clone ignore file git itself provides for this. The user's tracked `.gitignore` is never
 * touched, and a non-git directory is left exactly as it was. Idempotent and best-effort: returns the entries it added and
 * never throws (a read-only .git must not stop the assistant from starting).
 */
export function excludeAieliaStateFromGit(workspaceRoot: string): string[] {
  try {
    const gitDir = findGitDir(workspaceRoot)
    if (!gitDir) return []
    const excludeFile = join(gitDir, 'info', 'exclude')
    const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : ''
    const present = new Set(existing.split('\n').map((l) => l.trim()))
    const missing = AIELIA_STATE_DIRS.map((d) => `${d}/`).filter((entry) => !present.has(entry) && !present.has(entry.slice(0, -1)))
    if (missing.length === 0) return []
    mkdirSync(dirname(excludeFile), { recursive: true })
    const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n'
    appendFileSync(excludeFile, `${prefix}# Aielia state (added automatically)\n${missing.join('\n')}\n`)
    return missing
  } catch {
    return []
  }
}
