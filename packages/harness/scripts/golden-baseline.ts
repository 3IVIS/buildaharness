/**
 * AL0b — checks (default) or regenerates (`--update-golden`) the harness-level static golden
 * baseline `src/golden/static-baseline.json`. Regenerating is deliberate: the commit that does it must say why.
 *
 *   npx tsx scripts/golden-baseline.ts                  # exit 1 on any difference
 *   npx tsx scripts/golden-baseline.ts --update-golden  # rewrite the file
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { reconcileGolden, runHarnessStaticBaseline, serializeHarnessBaseline } from '../src/golden/static-baseline.js'

const file = fileURLToPath(new URL('../src/golden/static-baseline.json', import.meta.url))
const actual = serializeHarnessBaseline(await runHarnessStaticBaseline())
const verdict = reconcileGolden(existsSync(file) ? readFileSync(file, 'utf8') : undefined, actual, process.argv.includes('--update-golden'))
if (verdict.write) {
  writeFileSync(file, actual)
  console.log(`golden baseline written: ${file}`)
} else if (verdict.ok) {
  console.log('golden baseline unchanged')
} else {
  console.error(`golden baseline differs from ${file}. If the change is intended, re-run with --update-golden and say why in the commit.`)
  process.exit(1)
}
