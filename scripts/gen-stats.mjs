#!/usr/bin/env node
/**
 * Phase 4 (accuracy & reliability plan): stop hand-typing test/node-type/
 * service counts that drift out of sync across README.md, README_CN.md,
 * CLAUDE.md, docs/getting-started.md and docs/architecture.md.
 *
 * This script computes those counts from the actual sources of truth
 * (vitest's own JSON reporter, `pytest --collect-only`, the Node/HarnessNode
 * discriminated unions in spec/schema.ts, and docker-compose.yml's services
 * block), writes a canonical summary to docs/stats.md, and rewrites the same
 * numbers in place wherever they're quoted in the doc files below.
 *
 * Deliberately NOT using `<!-- marker -->`-style comments: several of these
 * numbers live inside fenced ```bash code blocks (quickstart commands), and
 * an HTML comment inside a code fence renders as literal visible text, not
 * a hidden marker — it would show up in the copy-pasteable command itself.
 * Instead each target is a small anchored regex keyed to stable surrounding
 * text (the same approach spec/scripts/gen-json-schema.mjs uses for whole
 * files, just scoped to a substring here).
 *
 * Usage:
 *   node scripts/gen-stats.mjs           # recompute and rewrite all targets
 *   node scripts/gen-stats.mjs --check   # recompute, diff against what's on
 *                                         # disk, exit 1 on any mismatch
 *                                         # (doesn't write) — this is the CI gate
 *
 * The pytest-derived numbers require adapter/requirements-dev.txt to be
 * installed (pytest-asyncio in particular). If pytest can't be collected —
 * e.g. running this locally without the adapter's Python deps — those
 * specific replacements are skipped, with a loud warning, rather than
 * guessing or clobbering a correct on-disk value with nothing.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { spawnSync } from 'child_process'

const ROOT = new URL('..', import.meta.url).pathname
const CHECK = process.argv.includes('--check')

function readRel(path) {
  return readFileSync(new URL(path, `file://${ROOT}`), 'utf8')
}

function writeRel(path, content) {
  writeFileSync(new URL(path, `file://${ROOT}`), content)
}

// ---------------------------------------------------------------------------
// Node type counts — from spec/schema.ts's Node/HarnessNode unions directly,
// not a blanket regex over every `type: z.literal(...)` in the file (that
// also matches edge types and unrelated JSON-schema-shaped literals — see
// StateSchema's `type: z.literal('object')`, which isn't a node at all).
// ---------------------------------------------------------------------------

function extractUnionMembers(src, constName, unionPrefix) {
  const startMarker = `export const ${constName} = ${unionPrefix}[`
  const start = src.indexOf(startMarker)
  if (start === -1) {
    throw new Error(`gen-stats: could not find "${startMarker}" in spec/schema.ts`)
  }
  const arrStart = start + startMarker.length
  const arrEnd = src.indexOf('])', arrStart)
  if (arrEnd === -1) {
    throw new Error(`gen-stats: could not find closing "])" for ${constName} in spec/schema.ts`)
  }
  return src
    .slice(arrStart, arrEnd)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function computeNodeTypeCounts() {
  const src = readRel('spec/schema.ts')
  const execution = extractUnionMembers(src, 'Node', 'z.union(').length
  const harness = extractUnionMembers(src, 'HarnessNode', "z.discriminatedUnion('type', ").length
  return { execution, harness, total: execution + harness }
}

// ---------------------------------------------------------------------------
// Docker Compose service count — top-level keys under `services:`, excluding
// one-shot init jobs (`restart: "no"`) since those aren't long-running
// services in the "N services" sense the docs use (matches the existing,
// already-correct "12 services" figure: 13 top-level keys minus minio-init).
// ---------------------------------------------------------------------------

function computeDockerServiceCount() {
  const lines = readRel('docker-compose.yml').split('\n')
  const servicesIdx = lines.findIndex((l) => l.trim() === 'services:')
  if (servicesIdx === -1) throw new Error('gen-stats: no top-level "services:" key in docker-compose.yml')

  let end = lines.length
  for (let i = servicesIdx + 1; i < lines.length; i++) {
    if (/^[a-zA-Z]/.test(lines[i])) { end = i; break }
  }
  const block = lines.slice(servicesIdx + 1, end)

  const serviceStarts = []
  block.forEach((l, i) => { if (/^ {2}[a-zA-Z0-9_.-]+:\s*$/.test(l)) serviceStarts.push(i) })

  let persistent = 0
  for (let i = 0; i < serviceStarts.length; i++) {
    const from = serviceStarts[i]
    const to = i + 1 < serviceStarts.length ? serviceStarts[i + 1] : block.length
    const body = block.slice(from, to).join('\n')
    if (!/restart:\s*["']?no["']?/.test(body)) persistent++
  }
  return persistent
}

// ---------------------------------------------------------------------------
// Vitest counts — root `vitest run` already aggregates every workspace
// package (verified: one run covers src/ and all packages/*), so this is a
// single command, not one per package.
// ---------------------------------------------------------------------------

function computeVitestStats() {
  const outFile = new URL('.gen-stats-vitest.json', `file://${ROOT}`)
  const result = spawnSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${outFile.pathname}`], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`gen-stats: vitest run failed:\n${result.stdout}\n${result.stderr}`)
  }
  const data = JSON.parse(readFileSync(outFile, 'utf8'))
  unlinkSync(outFile)
  return { tests: data.numTotalTests, files: data.testResults.length }
}

// ---------------------------------------------------------------------------
// Pytest counts — collect-only (fast, no DB/services needed; conftest.py
// sets its own env-var defaults at import time). Requires
// adapter/requirements-dev.txt (pytest-asyncio) to be installed; if it
// isn't, we can't get a real number and must not guess one.
// ---------------------------------------------------------------------------

function collectPytestCount(args) {
  const result = spawnSync('python3', ['-m', 'pytest', ...args, '--collect-only', '-q'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const out = result.stdout || ''
  const m = out.match(/(\d+) tests? collected/)
  if (!m) {
    throw new Error(`pytest collection did not report a count (is adapter/requirements-dev.txt installed?):\n${out}\n${result.stderr || ''}`)
  }
  return parseInt(m[1], 10)
}

function computePytestStats() {
  return {
    full: collectPytestCount(['adapter/tests/']),
    maf: collectPytestCount(['adapter/tests/test_maf_adapter.py']),
  }
}

function formatThousands(n) {
  return n.toLocaleString('en-US')
}

// ---------------------------------------------------------------------------
// Anchored replacements — one entry per number (or small cluster of numbers)
// quoted in the docs, keyed to stable surrounding text. `apply(content)`
// returns the rewritten content, or `null` if the anchor text wasn't found
// (doc prose changed — surfaced as a warning, not a silent no-op).
// `pytest: true` means this replacement is skipped when pytest stats aren't
// available (adapter/requirements-dev.txt not installed).
// ---------------------------------------------------------------------------

function single(pattern, replacer) {
  return (content) => {
    if (!pattern.test(content)) return null
    return content.replace(pattern, replacer)
  }
}

function buildReplacements(stats) {
  const { nodeTypes, dockerServices, vitest, pytest } = stats
  const totalTests = pytest ? vitest.tests + pytest.full : null

  return [
    // --- README.md ---------------------------------------------------------
    {
      file: 'README.md',
      pytest: true,
      apply: single(
        /(!\[Tests\]\(https:\/\/img\.shields\.io\/badge\/tests-)([^-]+)(-brightgreen\.svg\))/,
        (_m, pre, _num, post) => `${pre}${formatThousands(totalTests).replace(/,/g, '%2C')}%20passing${post}`,
      ),
    },
    {
      file: 'README.md',
      apply: single(
        /(\| \*prompt in → answer out\* \| \*)(\d+)( nodes · 11 layers · 759 harness-layer tests\* \|)/,
        (_m, pre, _num, post) => `${pre}${nodeTypes.total}${post}`,
      ),
    },
    {
      file: 'README.md',
      apply: single(
        /(Canvas with )(\d+ node types \(\d+ execution \+ \d+ harness\))/,
        (_m, pre) => `${pre}${nodeTypes.total} node types (${nodeTypes.execution} execution + ${nodeTypes.harness} harness)`,
      ),
    },
    {
      file: 'README.md',
      apply: single(
        /(built from \*\*)(\d+)( core nodes\*\* and \*\*)(\d+)( harness-layer nodes\*\*)/,
        (_m, p1, _n1, p2, _n2, p3) => `${p1}${nodeTypes.execution}${p2}${nodeTypes.harness}${p3}`,
      ),
    },
    {
      file: 'README.md',
      apply: single(
        /(docker compose up(?: {2,})?# start all )(\d+)( services)/,
        (_m, pre, _num, post) => `${pre}${dockerServices}${post}`,
      ),
    },
    {
      file: 'README.md',
      pytest: true,
      apply: single(
        /(# MAF suite \()(\d+)( tests\))/,
        (_m, pre, _num, post) => `${pre}${pytest.maf}${post}`,
      ),
    },
    {
      file: 'README.md',
      apply: single(
        /(all )(\d+)( node types, edges, fields)/,
        (_m, pre, _num, post) => `${pre}${nodeTypes.total}${post}`,
      ),
    },

    // --- README_CN.md -------------------------------------------------------
    {
      file: 'README_CN.md',
      pytest: true,
      apply: single(
        /(!\[Tests\]\(https:\/\/img\.shields\.io\/badge\/测试-)([^-]+)(-brightgreen\.svg\))/,
        (_m, pre, _num, post) => `${pre}${formatThousands(totalTests).replace(/,/g, '%2C')}%20通过${post}`,
      ),
    },
    {
      file: 'README_CN.md',
      apply: single(
        /(\| \*提示输入 → 答案输出\* \| \*)(\d+)( 个节点 · 11 层 · 759 个线束层测试\* \|)/,
        (_m, pre, _num, post) => `${pre}${nodeTypes.total}${post}`,
      ),
    },
    {
      file: 'README_CN.md',
      apply: single(
        /(画布，含 )(\d+)( 种节点类型（)(\d+)( 个执行节点 \+ )(\d+)( 个线束节点）)/,
        (_m, p1, _n1, p2, _n2, p3, _n3, p4) => `${p1}${nodeTypes.total}${p2}${nodeTypes.execution}${p3}${nodeTypes.harness}${p4}`,
      ),
    },
    {
      file: 'README_CN.md',
      apply: single(
        /(线束由 \*\*)(\d+)( 个核心节点\*\*和 \*\*)(\d+)( 个线束层节点\*\*构建)/,
        (_m, p1, _n1, p2, _n2, p3) => `${p1}${nodeTypes.execution}${p2}${nodeTypes.harness}${p3}`,
      ),
    },
    {
      file: 'README_CN.md',
      apply: single(
        /(docker compose up(?: {2,})?# 启动全部 )(\d+)( 个服务)/,
        (_m, pre, _num, post) => `${pre}${dockerServices}${post}`,
      ),
    },
    {
      file: 'README_CN.md',
      pytest: true,
      apply: single(
        /(# MAF 套件（)(\d+)( 个测试）)/,
        (_m, pre, _num, post) => `${pre}${pytest.maf}${post}`,
      ),
    },

    // --- CLAUDE.md (private overlay — absent in a public-only checkout) ----
    {
      file: 'CLAUDE.md',
      apply: single(
        /(docker compose up(?: {2,})?# all )(\d+)( services)/,
        (_m, pre, _num, post) => `${pre}${dockerServices}${post}`,
      ),
    },
    {
      file: 'CLAUDE.md',
      pytest: true,
      apply: single(
        /(pytest adapter\/tests\/ -v(?: {2,})?# full suite \()(\d+)( tests\))/,
        (_m, pre, _num, post) => `${pre}${pytest.full}${post}`,
      ),
    },

    // --- docs/getting-started.md --------------------------------------------
    {
      file: 'docs/getting-started.md',
      pytest: true,
      apply: single(
        /(# Adapter \()(\d+)( tests\))/,
        (_m, pre, _num, post) => `${pre}${pytest.full}${post}`,
      ),
    },

    // --- docs/architecture.md -----------------------------------------------
    {
      file: 'docs/architecture.md',
      apply: single(
        /(field-by-field reference for all )(\d+)( node types)/,
        (_m, pre, _num, post) => `${pre}${nodeTypes.total}${post}`,
      ),
    },
  ]
}

function renderStatsDoc(stats) {
  const { nodeTypes, dockerServices, vitest, pytest } = stats
  const pytestRow = pytest
    ? `| Adapter tests (pytest) | ${pytest.full} | \`pytest adapter/tests/ -v\` |\n| MAF adapter tests | ${pytest.maf} | \`pytest adapter/tests/test_maf_adapter.py -v\` |\n| Project-wide tests | ${formatThousands(vitest.tests + pytest.full)} | pytest + vitest combined |`
    : `| Adapter tests (pytest) | _unavailable — adapter/requirements-dev.txt not installed when this was generated_ | \`pytest adapter/tests/ -v\` |`

  return `<!-- Generated by scripts/gen-stats.mjs — do not hand-edit. Run \`node scripts/gen-stats.mjs\` to refresh, or \`node scripts/gen-stats.mjs --check\` to verify it's current (this is what CI runs). -->

# Repo stats

Canonical source for the counts quoted elsewhere in the docs (README.md, README_CN.md, CLAUDE.md,
docs/getting-started.md, docs/architecture.md) — those files are rewritten in place by this same script,
not transcluded, since GitHub-rendered markdown has no include mechanism.

| Metric | Count | Source |
|---|---|---|
| Frontend tests (vitest) | ${vitest.tests} across ${vitest.files} files | \`npm test\` (root — aggregates src/ and every packages/* workspace) |
${pytestRow}
| Node types | ${nodeTypes.total} (${nodeTypes.execution} execution + ${nodeTypes.harness} harness) | \`Node\`/\`HarnessNode\` discriminated unions in \`spec/schema.ts\` |
| Docker Compose services | ${dockerServices} | \`docker-compose.yml\` top-level \`services:\` keys, excluding one-shot \`restart: "no"\` init jobs |
`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const nodeTypes = computeNodeTypeCounts()
  const dockerServices = computeDockerServiceCount()
  const vitest = computeVitestStats()

  let pytest = null
  try {
    pytest = computePytestStats()
  } catch (err) {
    console.warn(`⚠️   Skipping pytest-derived stats: ${err.message}`)
  }

  const stats = { nodeTypes, dockerServices, vitest, pytest }
  const replacements = buildReplacements(stats)
  const statsDoc = renderStatsDoc(stats)

  let ok = true

  // docs/stats.md
  {
    const existing = existsSync(new URL('docs/stats.md', `file://${ROOT}`)) ? readRel('docs/stats.md') : null
    if (CHECK) {
      if (existing !== statsDoc) {
        console.error('❌  docs/stats.md is out of date. Run `node scripts/gen-stats.mjs`.')
        ok = false
      } else {
        console.log('✅  docs/stats.md is up to date.')
      }
    } else {
      writeRel('docs/stats.md', statsDoc)
      console.log('✅  Wrote docs/stats.md')
    }
  }

  // Anchored in-place replacements, grouped by file so each file is read/written once.
  const byFile = new Map()
  for (const r of replacements) {
    if (r.pytest && !pytest) continue
    if (!byFile.has(r.file)) byFile.set(r.file, [])
    byFile.get(r.file).push(r)
  }

  for (const [file, rs] of byFile) {
    if (!existsSync(new URL(file, `file://${ROOT}`))) continue // e.g. CLAUDE.md absent in a public-only checkout
    const original = readRel(file)
    let content = original
    for (const r of rs) {
      const next = r.apply(content)
      if (next === null) {
        console.warn(`⚠️   ${file}: an anchor pattern was not found — doc text may have changed; update gen-stats.mjs.`)
        continue
      }
      content = next
    }
    if (content === original) continue
    if (CHECK) {
      console.error(`❌  ${file} has stale stats. Run \`node scripts/gen-stats.mjs\`.`)
      ok = false
    } else {
      writeRel(file, content)
      console.log(`✅  Updated stats in ${file}`)
    }
  }

  if (!pytest) {
    console.warn('⚠️   pytest-derived numbers (test badge, MAF/full suite counts) were not checked/updated this run — adapter/requirements-dev.txt was not importable.')
  }

  if (CHECK && !ok) {
    process.exit(1)
  }
}

main()
