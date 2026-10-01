#!/usr/bin/env node
// Node-level TS-vs-Python conformance: runs every fixtures-nodes/*.json through the named harness node on both
// runtimes (one process per language) and diffs the full post-state projection (see run-ts-nodes.mts).
// A fixture listed in known-discrepancies-nodes.json is a tracked discrepancy (exit 0); any other mismatch exits 1.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const dir = dirname(fileURLToPath(import.meta.url))
const known = JSON.parse(readFileSync(join(dir, 'known-discrepancies-nodes.json'), 'utf-8'))
const run = (cmd, args) => JSON.parse(execFileSync(cmd, args, { cwd: dir, encoding: 'utf-8', maxBuffer: 1 << 28 }))
const ts = run('npx', ['tsx', join(dir, 'run-ts-nodes.mts')])
const py = run(process.env.PYTHON ?? 'python3', [join(dir, 'run_py_nodes.py')])

function diff(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return []
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].flatMap((k) => diff(a[k], b[k], `${path}/${k}`))
  }
  return [`${path}: TS=${JSON.stringify(a)} PY=${JSON.stringify(b)}`]
}

let pass = 0, tracked = 0, bad = 0
for (const id of [...new Set([...Object.keys(ts), ...Object.keys(py)])].sort()) {
  const d = diff(ts[id], py[id])
  if (d.length === 0) { pass++; console.log(`PASS  ${id}`) }
  else if (known[id]) { tracked++; console.log(`TRACKED  ${id}: ${known[id]}`) }
  else { bad++; console.log(`FAIL  ${id}`); d.slice(0, 12).forEach((l) => console.log('   ' + l)) }
}
console.log(`\n${pass} pass, ${tracked} tracked, ${bad} untracked (${pass + tracked + bad} fixtures)`)
process.exit(bad ? 1 : 0)
