import { describe, it, expect } from 'vitest'
import { realpathSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { entryArgMatchesModule } from './cli.js'

/**
 * Regression for the npx-launch bug: `isEntryModule()` compared a raw
 * `pathToFileURL(process.argv[1])` against `import.meta.url`. Under `npx
 * @buildaharness/personal-assistant` (and every other npm-bin path) argv[1] is
 * the `node_modules/.bin/personal-assistant` symlink, so the two never matched
 * and `main()` was skipped — the CLI exited 0 with no REPL.
 */
describe('entryArgMatchesModule', () => {
  const moduleReal = join(tmpdir(), 'pa-fake', 'dist', 'cli.js')
  const moduleHref = pathToFileURL(moduleReal).href

  it('matches when argv[1] is the module file itself', () => {
    expect(entryArgMatchesModule(moduleReal, moduleHref, (p) => p)).toBe(true)
  })

  it('matches when argv[1] is a symlink to the module (the npm-bin / npx case)', () => {
    const binShim = join(tmpdir(), 'pa-fake', 'node_modules', '.bin', 'personal-assistant')
    const resolveReal = (p: string) => (p === binShim ? moduleReal : p)
    expect(entryArgMatchesModule(binShim, moduleHref, resolveReal)).toBe(true)
  })

  it('does not match a different file', () => {
    const other = join(tmpdir(), 'pa-fake', 'dist', 'other.js')
    expect(entryArgMatchesModule(other, moduleHref, (p) => p)).toBe(false)
  })

  it('returns false when argv[1] is undefined (imported as a library)', () => {
    expect(entryArgMatchesModule(undefined, moduleHref)).toBe(false)
  })

  it('returns false instead of throwing when argv[1] cannot be resolved', () => {
    expect(
      entryArgMatchesModule('/no/such/path', moduleHref, () => {
        throw new Error('ENOENT')
      }),
    ).toBe(false)
  })

  it('resolves a real on-disk symlink through the default realpathSync', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-entry-'))
    try {
      const real = join(dir, 'cli.js')
      writeFileSync(real, '// fake cli\n')
      const link = join(dir, 'bin-link')
      symlinkSync(real, link)
      const href = pathToFileURL(realpathSync(real)).href
      expect(entryArgMatchesModule(link, href)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
