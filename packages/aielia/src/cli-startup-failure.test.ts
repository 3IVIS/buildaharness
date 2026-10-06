import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tsx = resolve(here, '../../../node_modules/.bin/tsx')
// The real process imports the built @buildaharness/runtime; CI jobs that run the tests before the build step do not have it.
const runtimeBuilt = existsSync(resolve(here, '../../runtime/dist/index.js'))

// Real process: an invalid persisted config (enableWeb without a Brave key) must print its reason on stderr and exit 1.
describe('aielia process with an invalid persisted config', () => {
  it.skipIf(!runtimeBuilt)('prints the reason on stderr and exits non-zero (REPL mode)', () => {
    const home = mkdtempSync(join(tmpdir(), 'aielia-badcfg-'))
    try {
      const dir = join(home, '.buildaharness', 'personal-assistant')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ enableWeb: true, tuiMode: 'disabled', updateCheck: 'disabled' }))
      const result = spawnSync(tsx, [resolve(here, 'cli.ts')], {
        cwd: resolve(here, '..'),
        env: { ...process.env, HOME: home, ASSISTANT_API_KEY: 'x', ASSISTANT_LLM_BACKEND: 'openrouter' },
        input: '',
        encoding: 'utf8',
        timeout: 60_000,
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('enableWeb requires braveApiKey')
      expect(result.stderr).toContain('Fix it by')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 90_000)
})
