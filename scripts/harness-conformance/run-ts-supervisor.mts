// Loads a supervisor conformance fixture and runs its `directive_in` / `digest_in`
// blobs through the TS harness's own SupervisorDirective.fromJSON() /
// TrajectoryDigest.fromJSON(), printing the normalised toJSON() results as JSON on
// stdout. Invoked by compare-supervisor.mjs via `npx tsx run-ts-supervisor.mts
// <fixture.json>`; the companion to compare.mjs / compare-verify.mjs.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { SupervisorDirective, TrajectoryDigest, validateInvestigationTools } from '../../packages/harness/src/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const fixturePath = process.argv[2]
if (!fixturePath) {
  console.error('usage: tsx run-ts-supervisor.mts <fixture.json>')
  process.exit(2)
}

const fixture = JSON.parse(readFileSync(resolve(__dirname, fixturePath), 'utf-8'))

const out: Record<string, unknown> = {}
if ('directive_in' in fixture) {
  out.directive = SupervisorDirective.fromJSON(fixture.directive_in).toJSON()
}
if ('digest_in' in fixture) {
  out.digest = TrajectoryDigest.fromJSON(fixture.digest_in).toJSON()
}
if ('tools_in' in fixture) {
  const { allowed, rejected } = validateInvestigationTools(fixture.tools_in)
  out.tools = { allowed, rejected }
}

console.log(JSON.stringify(out))
