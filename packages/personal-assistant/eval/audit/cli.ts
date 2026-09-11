#!/usr/bin/env -S npx tsx
/**
 * Feature Value Audit — the thin TS entrypoint `~/clam/feature_audit_driver.py` shells out to.
 *
 * The driver is Python (it lives in `~/clam` with the other scheduler drivers and reuses
 * `claude_pipeline`), but the audit's decision logic — which cell runs next, how N seed reports
 * fold into a verdict — is TS and must stay in one place (`select.ts`, `aggregate.ts`). Rather
 * than reimplement it in Python, the driver calls these subcommands and reads back one JSON object
 * on stdout (the `run_json_script` pattern the other drivers use).
 *
 *   npx tsx eval/audit/cli.ts next-cell   --manifest=<p> --progress=<p>
 *   npx tsx eval/audit/cli.ts build-multiseed --feature=<id> --manifest=<p> --reports-dir=<dir> --out=<p>
 *
 * `next-cell`   → { cell: AuditCell | null, blocked: boolean, matrixComplete: boolean }
 * `build-multiseed` → the AuditMultiSeedReport it just wrote to `--out` (also printed to stdout).
 *
 * Test/tooling only — nothing under `eval/audit/` is imported by product code.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseManifest, parseProgress } from './types.js'
import { nextCell, matrixComplete } from './select.js'
import { buildMultiSeedReport } from './aggregate.js'
import type { BenchmarkReport } from '../runner.js'

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
}

function requireArg(name: string): string {
  const v = arg(name)
  if (v === undefined || v === '') {
    console.error(`missing required --${name}=<value>`)
    process.exit(2)
  }
  return v
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** `null`-safe progress read — a not-yet-created progress.json is an empty matrix. */
function loadProgress(path: string): unknown {
  return existsSync(path) ? readJson(path) : { features: {} }
}

function cmdNextCell(): void {
  const manifest = parseManifest(readJson(requireArg('manifest')))
  const progress = parseProgress(loadProgress(requireArg('progress')))
  const { cell, blocked } = nextCell(manifest, progress)
  process.stdout.write(
    JSON.stringify({ cell, blocked, matrixComplete: matrixComplete(manifest, progress) }, null, 2) + '\n',
  )
}

/** All `seed*.json` seed reports for a feature, in seed order, from its reports dir. */
function loadSeedReports(dir: string): BenchmarkReport[] {
  const files = readdirSync(dir)
    .filter((f) => /^seed\d+\.json$/.test(f))
    .sort((a, b) => Number.parseInt(a.slice(4), 10) - Number.parseInt(b.slice(4), 10))
  if (files.length === 0) {
    console.error(`no seedN.json reports found in ${dir}`)
    process.exit(2)
  }
  return files.map((f) => readJson(join(dir, f)) as BenchmarkReport)
}

function cmdBuildMultiseed(): void {
  const featureId = requireArg('feature')
  const manifest = parseManifest(readJson(requireArg('manifest')))
  const feature = manifest.features.find((f) => f.id === featureId)
  if (!feature) {
    console.error(`feature "${featureId}" not in manifest`)
    process.exit(2)
  }
  const reports = loadSeedReports(requireArg('reports-dir'))
  const out = requireArg('out')
  const report = buildMultiSeedReport(
    reports,
    { id: feature.id, title: feature.title, hypothesis: feature.hypothesis },
    feature.arms[0],
    feature.arms[1],
  )
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
}

function main(): void {
  const sub = process.argv[2]
  switch (sub) {
    case 'next-cell':
      return cmdNextCell()
    case 'build-multiseed':
      return cmdBuildMultiseed()
    default:
      console.error(`unknown subcommand: ${sub ?? '(none)'}\nexpected: next-cell | build-multiseed`)
      process.exit(2)
  }
}

// Run only when invoked directly (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}

export { arg, loadSeedReports }
