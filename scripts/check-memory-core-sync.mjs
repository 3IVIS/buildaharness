#!/usr/bin/env node
/**
 * Agent memory framework M8: sync check for spec/memory-core.json.
 *
 * 1. Runs `node spec/gen-memory-core.mjs --check` (generated files are fresh).
 * 2. Runs the TS contract test (packages/aielia/src/memory-core-contract.test.ts): TS constants,
 *    tier rules, write-route table, gate rules and undo messages equal the contract.
 * 3. Python side, when adapter/harness/agent_memory/model.py exists: every contract fact field with
 *    port = yes is a field of the Python Fact dataclass (via python3.12).
 * 4. No file under adapter/harness/agent_memory/ (other than _core_generated.py) hand-types a
 *    contract literal (budget header, store key names, unconfirmed suffix).
 *
 * Python-side checks 3 and 4 skip with a note while the package is not yet populated.
 * Exit 1 on any failure.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const core = JSON.parse(readFileSync(join(root, 'spec/memory-core.json'), 'utf8'))
let failed = false
const fail = (m) => { console.error('FAIL ' + m); failed = true }
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts })

// 1. generator freshness
{
  const r = run('node', ['spec/gen-memory-core.mjs', '--check'])
  process.stdout.write(r.stdout)
  process.stderr.write(r.stderr)
  if (r.status !== 0) fail('generated memory-core files are stale')
}

// 2. TS contract test
{
  const r = run('npx', ['vitest', 'run', 'src/memory-core-contract.test.ts'], { cwd: join(root, 'packages/aielia') })
  if (r.status !== 0) {
    process.stdout.write(r.stdout)
    process.stderr.write(r.stderr)
    fail('memory-core-contract.test.ts failed')
  } else console.log('ok   TS memory-core contract test')
}

const pkg = join(root, 'adapter/harness/agent_memory')

// 3. Python Fact dataclass fields
if (existsSync(join(pkg, 'model.py'))) {
  const ported = core.fact_fields.fields.filter((f) => f.port === 'yes').map((f) => f.name)
  const code = [
    'import dataclasses, json, sys',
    "sys.path.insert(0, 'adapter')",
    'from harness.agent_memory.model import Fact',
    'print(json.dumps([f.name for f in dataclasses.fields(Fact)]))',
  ].join('\n')
  const r = run('python3.12', ['-c', code])
  if (r.status !== 0) fail('could not import Python Fact dataclass:\n' + r.stderr)
  else {
    const have = new Set(JSON.parse(r.stdout.trim().split('\n').pop()))
    // The Python dataclass may be snake_case internally; accept either spelling of the wire name.
    const snake = (k) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
    const missing = ported.filter((n) => !have.has(n) && !have.has(snake(n)))
    if (missing.length) fail('Python Fact is missing contract fields: ' + missing.join(', '))
    else console.log('ok   Python Fact has every ported contract field')
  }
} else console.log('skip Python Fact check (adapter/harness/agent_memory/model.py not present)')

// 4. no hand-typed contract literals outside _core_generated.py
{
  const literals = [
    core.budget.header.trim(),
    core.budget.unconfirmed_suffix,
    ...Object.entries(core.store_keys).filter(([k]) => k !== '_README').map(([, v]) => v.key).filter((k) => k.includes(':') && !k.endsWith(':')),
  ]
  const files = existsSync(pkg) ? readdirSync(pkg).filter((f) => f.endsWith('.py') && f !== '_core_generated.py') : []
  let bad = 0
  for (const f of files) {
    const text = readFileSync(join(pkg, f), 'utf8')
    for (const lit of literals) {
      if (text.includes(lit)) { fail(`adapter/harness/agent_memory/${f} hand-types contract literal ${JSON.stringify(lit)}; import it from _core_generated`); bad++ }
    }
  }
  if (!bad) console.log(`ok   no hand-typed contract literals in ${files.length} Python file(s)`)
}

process.exit(failed ? 1 : 0)
