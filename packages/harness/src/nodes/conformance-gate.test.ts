import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Diagnostics } from '../state/diagnostics.js'
import { WorldModel } from '../state/world-model.js'
import { FailureDiagnostics } from '../state/failure-diagnostics.js'
import { resolveControlState } from './resolve-control-state.js'

// INV-13 (docs/adr/004-shared-semantic-core.md): "the ~40 shared fixtures produce
// byte-identical ControlState output on both runtimes, asserted in both the pytest and
// vitest suites (not only in compare.mjs), so a one-side drift fails a unit run too."
//
// scripts/harness-conformance/compare.mjs runs the TS and Python resolvers against each
// other, but it needs both toolchains and is slow — `npm test` in this package never runs
// it. This file is the TS half of the in-suite gate: it feeds every
// scripts/harness-conformance/fixtures/*.json fixture through resolveControlState() the way
// run-ts.mts does, and asserts the result equals the committed golden in
// scripts/harness-conformance/goldens/.
//
// The goldens are the PYTHON resolver's output (captured by
// `node scripts/harness-conformance/gen-goldens.mjs --write`); compare.mjs proves — as a CI
// gate — that TS matches Python byte-for-byte for every committed fixture, so asserting TS
// against the Python-derived golden here is exactly INV-13: if the TS resolver drifts from
// the Python one without the goldens being regenerated in lockstep, this suite fails.
//
// Regenerating goldens (resolver legitimately changed AND compare.mjs still green):
//   node scripts/harness-conformance/compare.mjs
//   node scripts/harness-conformance/gen-goldens.mjs --write

const CONFORMANCE_DIR = join(__dirname, '..', '..', '..', '..', 'scripts', 'harness-conformance')
const FIXTURES_DIR = join(CONFORMANCE_DIR, 'fixtures')
const GOLDENS_DIR = join(CONFORMANCE_DIR, 'goldens')

const fixtureFiles = readdirSync(FIXTURES_DIR)
  .filter(f => f.endsWith('.json'))
  .sort()

interface Fixture {
  diagnostics?: Record<string, unknown>
  world_model?: { generation_id?: number; contradictions?: unknown[] }
  ts_matched_pattern?: { failure_class: string; confidence: number; matched_pattern: string } | null
}

// Mirrors scripts/harness-conformance/run-ts.mts exactly.
function runFixture(fixture: Fixture): unknown {
  const diagnostics = new Diagnostics(fixture.diagnostics as never)
  const worldModel = new WorldModel({
    generation_id: fixture.world_model?.generation_id ?? 0,
    contradictions: (fixture.world_model?.contradictions ?? []) as never,
  })
  const failureDiagnostics = new FailureDiagnostics({
    matched_pattern: fixture.ts_matched_pattern ?? null,
  })
  return resolveControlState(diagnostics, worldModel, failureDiagnostics).toJSON()
}

describe('INV-13 — shared resolver conformance fixtures (in-suite gate)', () => {
  it('has the ~40 shared fixtures INV-13 names', () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(40)
  })

  it('every fixture has a matching golden and vice versa', () => {
    const fixtureIds = new Set(fixtureFiles.map(f => f.replace(/\.json$/, '')))
    const goldenIds = new Set(
      readdirSync(GOLDENS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace(/\.json$/, '')),
    )
    const missing = [...fixtureIds].filter(id => !goldenIds.has(id))
    const orphaned = [...goldenIds].filter(id => !fixtureIds.has(id))
    expect({ missing, orphaned }).toEqual({ missing: [], orphaned: [] })
  })

  for (const file of fixtureFiles) {
    const id = file.replace(/\.json$/, '')
    it(`${id}: TS resolver output matches the golden`, () => {
      const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf-8')) as Fixture
      const goldenPath = join(GOLDENS_DIR, `${id}.json`)
      expect(
        existsSync(goldenPath),
        `missing golden for ${id} — run \`node scripts/harness-conformance/gen-goldens.mjs --write\``,
      ).toBe(true)

      const expected = JSON.parse(readFileSync(goldenPath, 'utf-8'))
      const actual = runFixture(fixture)

      // Deep equality over parsed JSON == byte-identical output modulo JSON number
      // formatting (1.0 vs 1) — the same normalisation compare.mjs itself relies on.
      expect(actual).toEqual(expected)
    })
  }
})
