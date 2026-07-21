// Loads a conformance fixture and runs it through the TS harness's own
// resolveControlState(), printing the resulting ControlState as JSON on stdout.
// Invoked by compare.mjs via `npx tsx run-ts.mts <fixture.json>`; never wired
// into `packages/harness`'s own vitest suite, since this is a cross-language
// comparison, not a unit test of either implementation in isolation.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  Diagnostics,
  WorldModel,
  FailureDiagnostics,
  resolveControlState,
} from '../../packages/harness/src/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const fixturePath = process.argv[2]
if (!fixturePath) {
  console.error('usage: tsx run-ts.mts <fixture.json>')
  process.exit(2)
}

const fixture = JSON.parse(readFileSync(resolve(__dirname, fixturePath), 'utf-8'))

// Constructed via the plain constructors (not the strict `fromJSON` schema
// parse) so a fixture only needs to specify the fields relevant to
// resolveControlState() — the same partial-data convention both languages'
// own dataclass/class defaults already follow.
const diagnostics = new Diagnostics(fixture.diagnostics)
const worldModel = new WorldModel({
  generation_id: fixture.world_model?.generation_id ?? 0,
  contradictions: fixture.world_model?.contradictions ?? [],
})
const failureDiagnostics = new FailureDiagnostics({
  matched_pattern: fixture.ts_matched_pattern ?? null,
})

const controlState = resolveControlState(diagnostics, worldModel, failureDiagnostics)
console.log(JSON.stringify(controlState.toJSON()))
