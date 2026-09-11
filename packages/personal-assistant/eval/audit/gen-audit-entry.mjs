/**
 * Plan A3 — finalize step, text half.
 *
 * Reads a feature's `<feature>.multiseed.json` (the `AuditMultiSeedReport` that
 * `eval/audit/cli.ts build-multiseed` wrote from the N seed reports) and folds its verdict into
 * the two hand-readable surfaces:
 *
 *   docs/harness_comparative_benchmark.md   — a dated "Audit — <title>" section
 *   plans/feature_value_audit.html          — an "Audit — <title>" entry (`<h2 id="audit-<feature>">`)
 *
 * Both edits are marker-delimited and idempotent: a re-run replaces the feature's own block in
 * place rather than appending a duplicate. The transcript pages (`gen-transcript-pages.mjs`) are
 * the other half of finalize and are generated separately by the driver.
 *
 * Deterministic given the same multiseed report — no clock reads (the "date" is the report's own
 * `generatedAt`), sorted output.
 *
 *   node eval/audit/gen-audit-entry.mjs --report=<multiseed.json> --repo-root=<path>
 *
 * Test/tooling only.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const VERDICT_BADGE = { KEEP: 'keep', CUT: 'cut', INCONCLUSIVE: 'med' }

/** How far a task-success delta must move before it reads as "better"/"worse" rather than "no measurable difference". */
const MATERIAL_SUCCESS_DELTA = 0.05 // ±5 points
const MATERIAL_COST_INCREASE = 0.1 // ±10% — mirrors aggregate.ts's own threshold

/**
 * The short, plain-language headline every verdict badge shows, in place of the bare
 * KEEP/CUT/INCONCLUSIVE word. Mirrors `aggregate.ts`'s `observationLabel` — duplicated rather than
 * imported because this script runs as a build-free `.mjs` and that file is TypeScript.
 */
function observationLabel(r) {
  const success = r.metrics.find((m) => m.metric === 'taskSuccessRate')
  const successDelta = success?.deltaMean ?? 0
  const direction = successDelta > MATERIAL_SUCCESS_DELTA ? 'better' : successDelta < -MATERIAL_SUCCESS_DELTA ? 'worse' : 'flat'

  const cost = r.costDeltaPct
  const costDirection =
    cost !== null && cost > MATERIAL_COST_INCREASE ? 'costlier' : cost !== null && cost < -MATERIAL_COST_INCREASE ? 'cheaper' : 'similar'

  if (direction === 'flat') {
    if (costDirection === 'costlier') return 'No measurable improvement, at extra cost'
    if (costDirection === 'cheaper') return 'No measurable difference, but cheaper'
    return 'No measurable difference'
  }
  const results = direction === 'better' ? 'Better results' : 'Worse results'
  if (costDirection === 'costlier') return `${results}, at higher cost`
  if (costDirection === 'cheaper') return `${results}, and cheaper`
  return `${results}, no added cost`
}

function fmtPct(x) {
  if (x === null || x === undefined) return '—'
  return `${x > 0 ? '+' : ''}${(x * 100).toFixed(0)}%`
}

function fmtNum(x) {
  if (x === null || x === undefined) return '—'
  if (Number.isInteger(x)) return String(x)
  return x.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

/** Replace the region between `startMark` and `endMark` with `block`, or — if the markers are
 * absent — splice `startMark + block + endMark` in at `fallbackInsert(text)` (an index). */
function spliceMarked(text, startMark, endMark, block, fallbackInsert) {
  const wrapped = `${startMark}\n${block}\n${endMark}`
  const s = text.indexOf(startMark)
  const e = text.indexOf(endMark)
  if (s !== -1 && e !== -1 && e > s) {
    return text.slice(0, s) + wrapped + text.slice(e + endMark.length)
  }
  const at = fallbackInsert(text)
  return text.slice(0, at) + wrapped + '\n\n' + text.slice(at)
}

function mdSection(r) {
  const date = (r.generatedAt || '').slice(0, 10)
  const rows = r.metrics
    .map(
      (m) =>
        `| ${m.metric} | ${fmtNum(m.control)} | ${fmtNum(m.candidate)} | ${fmtNum(m.deltaMean)} | ±${fmtNum(m.deltaCi95)} | ${m.regressed ? 'regressed' : m.positive ? 'positive' : '—'} |`,
    )
    .join('\n')
  return [
    `## Audit — ${r.title}`,
    '',
    `- **Verdict:** ${observationLabel(r)} — ${r.rationale}`,
    `- **Arms:** \`${r.control}\` (control) vs \`${r.candidate}\` (candidate) · ${r.seeds} seeds · ${date}`,
    `- **Model:** ${r.modelId ?? 'unknown'} · judge ${r.judgeModelId ?? 'unknown'}`,
    `- **Hypothesis:** ${r.hypothesis}`,
    '',
    '| metric | control | candidate | Δ mean | CI95 | verdict |',
    '|---|---|---|---|---|---|',
    rows,
    '',
    `Candidate vs control: cost ${fmtPct(r.costDeltaPct)}, latency ${fmtPct(r.latencyDeltaPct)}, tokens ${fmtPct(r.tokenDeltaPct)}.`,
    '',
  ].join('\n')
}

function htmlEntry(r) {
  const date = (r.generatedAt || '').slice(0, 10)
  const badge = VERDICT_BADGE[r.verdict] ?? 'med'
  const rows = r.metrics
    .map(
      (m) =>
        `    <tr><td><code>${esc(m.metric)}</code></td><td>${fmtNum(m.control)}</td><td>${fmtNum(m.candidate)}</td>` +
        `<td>${fmtNum(m.deltaMean)} &plusmn; ${fmtNum(m.deltaCi95)}</td><td>${m.regressed ? 'regressed' : m.positive ? 'positive' : '&mdash;'}</td></tr>`,
    )
    .join('\n')
  return [
    `<h2 id="audit-${esc(r.feature)}">Audit &mdash; ${esc(r.title)} <span class="badge ${badge}">${esc(observationLabel(r))}</span></h2>`,
    `<p><strong>Hypothesis.</strong> ${esc(r.hypothesis)}</p>`,
    `<p><strong>Verdict.</strong> ${esc(r.rationale)}</p>`,
    `<p>Arms <code>${esc(r.control)}</code> (control) vs <code>${esc(r.candidate)}</code> (candidate) &middot; ` +
      `${r.seeds} seeds &middot; ${esc(date)} &middot; model <code>${esc(r.modelId ?? 'unknown')}</code>, ` +
      `judge <code>${esc(r.judgeModelId ?? 'unknown')}</code>. ` +
      `<a href="/harness-evaluation/${esc(r.feature)}/">Read the actual runs &rarr;</a></p>`,
    '<table>',
    '    <tr><th>Metric</th><th>Control</th><th>Candidate</th><th>&Delta; (CI95)</th><th>Verdict</th></tr>',
    rows,
    '</table>',
    `<p>Candidate vs control: cost ${fmtPct(r.costDeltaPct)}, latency ${fmtPct(r.latencyDeltaPct)}, ` +
      `tokens ${fmtPct(r.tokenDeltaPct)}.</p>`,
  ].join('\n')
}

export function generate({ reportPath, repoRoot }) {
  const r = JSON.parse(readFileSync(reportPath, 'utf8'))
  const written = []

  // ── docs/harness_comparative_benchmark.md ────────────────────────────────
  const mdPath = join(repoRoot, 'docs', 'harness_comparative_benchmark.md')
  const startMd = `<!-- audit-entry:${r.feature} start -->`
  const endMd = `<!-- audit-entry:${r.feature} end -->`
  let md = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : '# Comparative Harness Benchmark\n'
  md = spliceMarked(md, startMd, endMd, mdSection(r), (t) => {
    // after the top header paragraph (first blank line past the first heading), else end of file
    const h = t.indexOf('\n', t.indexOf('# '))
    const nl = t.indexOf('\n\n', h)
    return nl === -1 ? t.length : nl + 2
  })
  if (!md.endsWith('\n')) md += '\n'
  writeFileSync(mdPath, md)
  written.push(mdPath)

  // ── plans/feature_value_audit.html ──────────────────────────────────────
  const htmlPath = join(repoRoot, 'plans', 'feature_value_audit.html')
  const startH = `<!-- audit-entry:${r.feature} start -->`
  const endH = `<!-- audit-entry:${r.feature} end -->`
  let html = readFileSync(htmlPath, 'utf8')
  html = spliceMarked(html, startH, endH, htmlEntry(r), (t) => {
    const f = t.indexOf('<footer>')
    return f === -1 ? t.indexOf('</body>') : f
  })
  writeFileSync(htmlPath, html)
  written.push(htmlPath)

  return { written, verdict: r.verdict, feature: r.feature }
}

function argOf(name) {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reportPath = argOf('report')
  const repoRoot = argOf('repo-root')
  if (!reportPath || !repoRoot) {
    console.error('usage: node gen-audit-entry.mjs --report=<multiseed.json> --repo-root=<path>')
    process.exit(2)
  }
  const res = generate({ reportPath, repoRoot })
  console.log(`audit entry for "${res.feature}" (${res.verdict}) → ${res.written.join(', ')}`)
}
