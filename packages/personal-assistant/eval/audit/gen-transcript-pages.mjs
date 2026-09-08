#!/usr/bin/env node
/**
 * Feature Value Audit — transcript page generator (Plan A2,
 * plans/feature_audit_automation_plan.html).
 *
 * Turns a feature's `<feature>.multiseed.json` (see aggregate.ts `AuditMultiSeedReport`) plus its
 * per-run transcript files (`<arm>__<task>__seed<n>.json`, written by runner.ts under Plan A1) into
 * a browsable static surface under `<pages-root>/harness-evaluation/<feature>/`:
 *
 *   index.html                       feature hypothesis + verdict + N-seed number table +
 *                                    a filterable table of every arm x task x seed run
 *   <arm>-<task>-seed<n>.html        one page per run: prompt, conversation as <details> blocks,
 *                                    grader checks, metrics
 *   compare-<task>.html              both arms' runs of one task, side by side
 *
 * No dependencies beyond Node. No JS framework (the index has a ~10-line vanilla substring filter;
 * run pages work with JS disabled). Deterministic: same input -> byte-identical output, no clock
 * reads in the body beyond the report's own `generatedAt`.
 *
 * Usage:
 *   node gen-transcript-pages.mjs \
 *     --feature=<id> --report=<multiseed.json> --transcripts=<dir> --pages-root=<path> \
 *     [--full-pages=all|adv,injected]
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// ── secret scrub — a copy of transcript-capture.ts's patterns (that file is TS; this is .mjs).
// Belt-and-braces: the transcript files are already scrubbed twice upstream. Keep in sync by hand.
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{12,}/g, '[redacted]'],
  [/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/gh[oprsu]_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/ghp_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/AKIA[0-9A-Z]{16}/g, '[redacted]'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted]'],
  [/\b(api[_-]?key|secret|password|token|authorization|bearer)(["'\s:=]{1,4})([A-Za-z0-9._-]{16,})/gi, '$1$2[redacted]'],
]
export function scrubSecrets(text) {
  let out = String(text)
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep)
  return out
}

// ── analytics + consent header, copied from harness-evaluation.html so the pages are consistent.
const ANALYTICS_HEAD = `<!-- Klaro Consent Management -->
<script type="text/javascript">
  var klaroConfig = {
    storageMethod: 'cookie', cookieName: 'klaro', cookieExpiresAfterDays: 365,
    privacyPolicy: '/privacy.html', default: false, mustConsent: false, acceptAll: true,
    hideDeclineAll: false, hideLearnMore: false, noticeAsModal: false,
    translations: { en: { consentModal: { title: 'Build A Harness — We value your privacy', description: 'Here you can see and customize the information that we collect about you.' }, decline: 'Reject all', ok: 'Accept all', analytics: { description: 'Collection of information about how visitors use our website.' }, purposes: { analytics: 'Analytics' } } },
    services: [ { name: 'analytics', title: 'Analytics & Tracking', purposes: ['analytics'], required: false } ],
  };
</script>
<script defer src="https://cdn.kiprotect.com/klaro/v0.7.18/klaro.js"></script>
<script async type="text/plain" data-type="text/javascript" data-name="analytics" src="https://www.googletagmanager.com/gtag/js?id=G-HG3KMR8T0N"></script>
<script type="text/plain" data-type="text/javascript" data-name="analytics">
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-HG3KMR8T0N');
</script>`

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">`

// ── helpers ────────────────────────────────────────────────────────────────────────────────────
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtNum(metric, v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  if (metric.endsWith('Ms')) return `${Math.round(v)} ms`
  if (metric.endsWith('Usd')) return `$${v.toFixed(4)}`
  if (metric.endsWith('Rate') || metric.endsWith('Mean')) return v.toFixed(3)
  if (metric === 'totalTokens') return String(Math.round(v))
  return String(v)
}

function fmtPct(x) {
  if (x === null || x === undefined) return '—'
  return `${x > 0 ? '+' : ''}${(x * 100).toFixed(0)}%`
}

const VERDICT_CLASS = { KEEP: 'keep', CUT: 'cut', INCONCLUSIVE: 'inconclusive' }

function parseArgs(argv) {
  const args = {}
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a)
    if (m) args[m[1]] = m[2]
    else if (a.startsWith('--')) args[a.slice(2)] = true
  }
  return args
}

/** `<arm>__<task>__seed<n>.json` -> `{ arm, task, seed }`, else null. */
export function parseTranscriptFilename(name) {
  const m = /^(.+?)__(.+?)__seed(.+?)\.json$/.exec(name)
  if (!m) return null
  return { arm: m[1], task: m[2], seed: m[3] }
}

function loadRuns(dir) {
  const runs = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue
    const meta = parseTranscriptFilename(name)
    if (!meta) continue
    const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    runs.push({ ...meta, file: name, data: raw })
  }
  // Deterministic order: task, then arm, then seed.
  runs.sort((a, b) => a.task.localeCompare(b.task) || a.arm.localeCompare(b.arm) || String(a.seed).localeCompare(String(b.seed)))
  return runs
}

/** Which runs get a dedicated page. `all` -> every run; `adv,injected` -> adversarial task ids
 * (prefix `adv-`) or runs with an injected failure (grade.recovered is non-null). */
export function runGetsPage(run, fullPages) {
  if (fullPages !== 'adv,injected') return true
  if (run.task.startsWith('adv-')) return true
  const rec = run.data?.grade?.recovered
  return rec === true || rec === false
}

function runPageName(run) {
  return `${run.arm}-${run.task}-seed${run.seed}.html`
}
function comparePageName(task) {
  return `compare-${task}.html`
}

// ── event rendering (run page + compare page) ──────────────────────────────────────────────────
function jsonBlock(obj) {
  return `<pre>${esc(scrubSecrets(JSON.stringify(obj, null, 2)))}</pre>`
}

function renderEvent(ev) {
  const k = ev.kind
  let label = k
  let body = ''
  if (k === 'llm_request') {
    label = `llm_request${ev.model ? ` (${esc(ev.model)})` : ''}`
    const msgs = (ev.messages ?? [])
      .map((m) => `<pre><strong>${esc(m.role)}</strong>\n${esc(scrubSecrets(m.content ?? ''))}</pre>`)
      .join('')
    body = msgs || '<p>(no messages)</p>'
  } else if (k === 'llm_response') {
    label = `llm_response${ev.model ? ` (${esc(ev.model)})` : ''}`
    body = ev.reply ? `<pre>${esc(scrubSecrets(ev.reply))}</pre>` : '<p>(no text)</p>'
    if (ev.toolCalls && ev.toolCalls.length) body += jsonBlock(ev.toolCalls)
    if (ev.usage) body += jsonBlock(ev.usage)
  } else if (k === 'tool_call') {
    label = `tool_call: ${esc(ev.tool ?? ev.toolCalls?.[0]?.name ?? '?')}`
    if (ev.input) body += jsonBlock(ev.input)
    if (ev.toolCalls) body += jsonBlock(ev.toolCalls)
    if (ev.result !== undefined) body += `<pre>${esc(scrubSecrets(ev.result))}</pre>`
  } else if (k === 'debug') {
    label = `debug${ev.tool ? `: ${esc(ev.tool)}` : ''}`
    body = ev.result !== undefined ? `<pre>${esc(scrubSecrets(ev.result))}</pre>` : jsonBlock(ev.detail ?? {})
  } else if (k === 'trace') {
    label = 'trace'
    body = jsonBlock(ev.detail ?? {})
  } else {
    body = jsonBlock(ev)
  }
  return `<details class="evt"><summary><span class="tag">${esc(label)}</span></summary><div class="body">${body}</div></details>`
}

function renderConversation(events) {
  if (!events || !events.length) return '<p>(no transcript events recorded)</p>'
  return events.map(renderEvent).join('\n')
}

function renderGrade(grade) {
  if (!grade) return ''
  const rows = (grade.checks ?? [])
    .map((c) => `<tr><td>${esc(c.name)}</td><td><span class="verdict ${c.verdict === 'pass' ? 'pass' : 'fail'}">${esc(c.verdict)}</span></td></tr>`)
    .join('')
  return `<h3>Grader checks</h3>
<table class="cmp-table"><thead><tr><th>Check</th><th>Verdict</th></tr></thead><tbody>${rows || '<tr><td colspan="2">(none)</td></tr>'}</tbody></table>
<p><strong>success</strong> ${grade.success ? 'yes' : 'no'} &nbsp;&middot;&nbsp; <strong>hallucination</strong> ${grade.hallucination ? 'yes' : 'no'} &nbsp;&middot;&nbsp; <strong>unauthorized effect</strong> ${grade.unauthorizedEffect ? 'yes' : 'no'} &nbsp;&middot;&nbsp; <strong>recovered</strong> ${grade.recovered === null || grade.recovered === undefined ? 'n/a' : grade.recovered ? 'yes' : 'no'}</p>`
}

function renderMetrics(m) {
  if (!m) return ''
  return `<h3>Metrics</h3>
<table class="cmp-table"><tbody>
<tr><td>latency</td><td class="num">${fmtNum('latencyMs', m.latencyMs)}</td></tr>
<tr><td>cost</td><td class="num">${fmtNum('costUsd', m.costUsd)}</td></tr>
<tr><td>tokens</td><td class="num">${fmtNum('totalTokens', m.totalTokens)}</td></tr>
<tr><td>supervisor consults</td><td class="num">${m.supervisorConsults ?? '—'}</td></tr>
</tbody></table>`
}

// ── page shell ────────────────────────────────────────────────────────────────────────────────
function page(title, css, bodyHtml, crumbTail, generatedAt) {
  return `<!doctype html>
<html lang="en">
<head>
${ANALYTICS_HEAD}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | Build A Harness</title>
<meta name="robots" content="noindex, follow">
${FONTS}
<style>
${css}
</style>
</head>
<body>
<div class="wrap">
<nav class="breadcrumb"><a href="/harness-evaluation">harness-evaluation</a><span>/</span>${crumbTail}</nav>
${bodyHtml}
<footer>Generated by eval/audit/gen-transcript-pages.mjs &middot; report generatedAt ${esc(generatedAt || 'unknown')}</footer>
</div>
</body>
</html>
`
}

function modelLine(report) {
  const m = report.modelId || 'unknown'
  const j = report.judgeModelId ? `, judge ${report.judgeModelId}` : ''
  return `<p class="model-line">Model: Claude Sonnet (<code>${esc(m)}</code>)${j ? esc(j) : ''} &middot; ${report.seeds} seed${report.seeds === 1 ? '' : 's'}</p>`
}

// ── index.html ────────────────────────────────────────────────────────────────────────────────
function renderIndex(report, runs, fullPages, css) {
  const vClass = VERDICT_CLASS[report.verdict] ?? 'inconclusive'

  const metricRows = report.metrics
    .map((d) => {
      const cls = d.regressed ? 'regressed' : d.positive ? 'positive' : ''
      return `<tr class="${cls}"><td>${esc(d.metric)}</td><td class="num">${fmtNum(d.metric, d.control)}</td><td class="num">${fmtNum(d.metric, d.candidate)}</td><td class="num">${d.deltaMean === null ? '—' : (d.deltaMean > 0 ? '+' : '') + fmtNum(d.metric, d.deltaMean)}</td><td class="num">${d.deltaCi95 === null ? '—' : '±' + fmtNum(d.metric, d.deltaCi95)}</td></tr>`
    })
    .join('')

  const tasks = [...new Set(runs.map((r) => r.task))].sort()
  const runRows = runs
    .map((r) => {
      const g = r.data.grade ?? {}
      const m = r.data.metrics ?? {}
      const hasPage = runGetsPage(r, fullPages)
      const runCell = hasPage ? `<a href="${runPageName(r)}">${esc(r.arm)} / seed ${esc(r.seed)}</a>` : `${esc(r.arm)} / seed ${esc(r.seed)}`
      return `<tr><td>${runCell}</td><td>${esc(r.task)}</td><td>${g.success ? 'yes' : 'no'}</td><td>${g.recovered === null || g.recovered === undefined ? '—' : g.recovered ? 'yes' : 'no'}</td><td class="num">${m.supervisorConsults ?? '—'}</td><td class="num">${fmtNum('costUsd', m.costUsd)}</td><td class="num">${fmtNum('latencyMs', m.latencyMs)}</td><td class="num">${fmtNum('totalTokens', m.totalTokens)}</td><td><a href="${comparePageName(r.task)}">compare</a></td></tr>`
    })
    .join('')

  const body = `<span class="eyebrow">Feature Value Audit</span>
<h1>${esc(report.title)}</h1>
<p><span class="verdict ${vClass}">${esc(report.verdict)}</span></p>
${modelLine(report)}
<p><strong>Hypothesis.</strong> ${esc(report.hypothesis)}</p>
<div class="callout ${vClass === 'keep' ? 'keep' : vClass === 'cut' ? 'cut' : ''}"><p>${esc(report.rationale)}</p></div>

<h2>${report.seeds}-seed numbers</h2>
<p>Arms: <code>${esc(report.control)}</code> (control) vs <code>${esc(report.candidate)}</code> (candidate). Green row = candidate ahead with CI clearing 0; red = gating regression.</p>
<table class="cmp-table"><thead><tr><th>Metric</th><th>${esc(report.control)}</th><th>${esc(report.candidate)}</th><th>&Delta;mean</th><th>&plusmn;CI95</th></tr></thead><tbody>${metricRows}</tbody></table>
<p>Cost ${fmtPct(report.costDeltaPct)} &middot; latency ${fmtPct(report.latencyDeltaPct)} &middot; tokens ${fmtPct(report.tokenDeltaPct)} (candidate vs control).</p>

<h2>Runs (${runs.length})</h2>
<div class="filter-box"><input id="f" type="text" placeholder="filter by task / arm…" oninput="filterRows()"></div>
<table class="cmp-table" id="runs"><thead><tr><th>Run</th><th>Task</th><th>Success</th><th>Recovered</th><th>Sup.</th><th>Cost</th><th>Latency</th><th>Tokens</th><th></th></tr></thead><tbody>${runRows}</tbody></table>
<p>${tasks.length} task${tasks.length === 1 ? '' : 's'}. Each row's <em>compare</em> link puts both arms side by side.</p>
<script>
function filterRows(){var q=document.getElementById('f').value.toLowerCase();var rows=document.querySelectorAll('#runs tbody tr');for(var i=0;i<rows.length;i++){rows[i].style.display=rows[i].textContent.toLowerCase().indexOf(q)>-1?'':'none';}}
</script>`

  return page(`${report.title} — transcripts`, css, body, esc(report.feature), report.generatedAt)
}

// ── run page ─────────────────────────────────────────────────────────────────────────────────
function renderRunPage(report, run, css) {
  const d = run.data
  const body = `<span class="eyebrow">${esc(report.title)}</span>
<h1>${esc(run.arm)} &middot; ${esc(run.task)} &middot; seed ${esc(run.seed)}</h1>
${modelLine(report)}
<h3>Prompt</h3>
<pre>${esc(scrubSecrets(d.prompt ?? ''))}</pre>
<details class="evt"><summary><span class="tag">reply preview</span></summary><div class="body"><pre>${esc(scrubSecrets(d.replyPreview ?? ''))}</pre></div></details>
<h2>Conversation</h2>
${renderConversation(d.events)}
${renderGrade(d.grade)}
${renderMetrics(d.metrics)}
<p><a href="index.html">&larr; index</a> &middot; <a href="${comparePageName(run.task)}">compare arms on this task</a></p>`
  return page(`${run.arm} / ${run.task} / seed ${run.seed}`, css, body, `<a href="index.html">${esc(report.feature)}</a><span>/</span>${esc(run.task)}`, report.generatedAt)
}

// ── compare page ─────────────────────────────────────────────────────────────────────────────
function renderComparePage(report, task, taskRuns, css) {
  const byArm = new Map()
  for (const r of taskRuns) {
    if (!byArm.has(r.arm)) byArm.set(r.arm, [])
    byArm.get(r.arm).push(r)
  }
  const cols = [report.control, report.candidate]
    .filter((arm) => byArm.has(arm))
    .map((arm) => {
      const inner = byArm
        .get(arm)
        .map((r) => {
          return `<h3>seed ${esc(r.seed)} — ${r.data.grade?.success ? 'success' : 'fail'}${r.data.grade?.recovered === true ? ', recovered' : r.data.grade?.recovered === false ? ', not recovered' : ''}</h3>
${renderConversation(r.data.events)}
${renderGrade(r.data.grade)}
${renderMetrics(r.data.metrics)}`
        })
        .join('\n')
      return `<div class="col"><h3>${esc(arm)}</h3>${inner}</div>`
    })
    .join('\n')

  const body = `<span class="eyebrow">${esc(report.title)}</span>
<h1>Compare: ${esc(task)}</h1>
${modelLine(report)}
<p>Prompt: <code>${esc(scrubSecrets(taskRuns[0]?.data?.prompt ?? ''))}</code></p>
<div class="cols">${cols}</div>
<p><a href="index.html">&larr; index</a></p>`
  return page(`compare ${task}`, css, body, `<a href="index.html">${esc(report.feature)}</a><span>/</span>compare ${esc(task)}`, report.generatedAt)
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────
export function generate({ reportPath, transcriptsDir, pagesRoot, feature, fullPages }) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const featureId = feature || report.feature
  if (!featureId) throw new Error('no feature id (pass --feature= or set it in the report)')
  const css = readFileSync(join(HERE, '_transcript.css'), 'utf8').trimEnd()
  const runs = loadRuns(transcriptsDir)
  // `all` (default) → a page per run; `adv,injected` → only adversarial / injected-failure runs
  // get a dedicated page (the rest live in the index table). The manifest sets this per feature.
  const effFullPages = fullPages === 'adv,injected' ? 'adv,injected' : 'all'

  const outDir = join(pagesRoot, 'harness-evaluation', featureId)
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const written = []
  const write = (name, html) => {
    writeFileSync(join(outDir, name), html)
    written.push(name)
  }

  write('index.html', renderIndex(report, runs, effFullPages, css))

  for (const run of runs) {
    if (!runGetsPage(run, effFullPages)) continue
    write(runPageName(run), renderRunPage(report, run, css))
  }

  const tasks = [...new Set(runs.map((r) => r.task))].sort()
  for (const task of tasks) {
    const taskRuns = runs.filter((r) => r.task === task)
    write(comparePageName(task), renderComparePage(report, task, taskRuns, css))
  }

  written.sort()
  return { outDir, written }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const reportPath = args.report && resolve(args.report)
  const transcriptsDir = args.transcripts && resolve(args.transcripts)
  const pagesRoot = args['pages-root'] && resolve(args['pages-root'])
  if (!reportPath || !transcriptsDir || !pagesRoot) {
    console.error('usage: gen-transcript-pages.mjs --feature=<id> --report=<multiseed.json> --transcripts=<dir> --pages-root=<path> [--full-pages=all|adv,injected]')
    process.exit(2)
  }
  const { outDir, written } = generate({
    reportPath,
    transcriptsDir,
    pagesRoot,
    feature: typeof args.feature === 'string' ? args.feature : undefined,
    fullPages: typeof args['full-pages'] === 'string' ? args['full-pages'] : undefined,
  })
  console.error(`wrote ${written.length} files to ${outDir}`)
  for (const f of written) console.error(`  ${f}`)
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || '')) {
  main()
}
