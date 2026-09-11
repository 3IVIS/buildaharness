import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `eval/audit/` is test/tooling only — the audit manifest, the next-cell picker, the verdict
 * aggregator. Product code (`src/`) must never import it, or a `tsx`/vite build would pull the
 * benchmark queue into the shipped assistant.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (p.endsWith('.ts') || p.endsWith('.mts') || p.endsWith('.mjs')) yield p
  }
}

describe('eval/audit boundary', () => {
  it('no file under src/ imports from eval/audit', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8')
      if (/\bfrom\s+['"][^'"]*eval\/audit/.test(text) || /\brequire\(\s*['"][^'"]*eval\/audit/.test(text)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
