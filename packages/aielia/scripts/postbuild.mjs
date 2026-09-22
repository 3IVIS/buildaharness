#!/usr/bin/env node
/**
 * Cross-platform replacement for the `cp`/`mkdir -p`/`&&` chain `npm run build` used to run
 * directly in package.json — those are Unix shell builtins with no cmd.exe equivalent, so the
 * chain silently broke ("The syntax of the command is incorrect.") the first time anything built
 * this package on a Windows runner (desktop-v0.1.0's `windows-latest` job, which depends on
 * `npm run build:aielia` — see build-desktop.yml). Every step here uses only node:fs, so it
 * behaves identically on Linux/macOS/Windows regardless of the invoking shell.
 *
 * Runs after `vite build` has already produced dist/. Mirrors, in order, what the old inline
 * shell chain did:
 *   1. copy src/file-tools-mcp-server.mjs → dist/file-tools-mcp-server.mjs
 *   2. mkdir -p dist/lexical/patterns
 *   3. copy every src/lexical/patterns/*.json → dist/lexical/patterns/
 *   4. prepend a `#!/usr/bin/env node` shebang to dist/cli.js if vite's own output didn't already
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

copyFileSync(join(pkgDir, 'src/file-tools-mcp-server.mjs'), join(pkgDir, 'dist/file-tools-mcp-server.mjs'))

const patternsSrcDir = join(pkgDir, 'src/lexical/patterns')
const patternsDistDir = join(pkgDir, 'dist/lexical/patterns')
mkdirSync(patternsDistDir, { recursive: true })
for (const file of readdirSync(patternsSrcDir).filter((f) => f.endsWith('.json'))) {
  copyFileSync(join(patternsSrcDir, file), join(patternsDistDir, file))
}

const cliPath = join(pkgDir, 'dist/cli.js')
const cliContents = readFileSync(cliPath, 'utf-8')
if (!cliContents.startsWith('#!')) {
  writeFileSync(cliPath, `#!/usr/bin/env node\n${cliContents}`)
}
