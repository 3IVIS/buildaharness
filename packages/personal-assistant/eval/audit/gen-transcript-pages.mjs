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
  // Email addresses — synthetic corpus, so an email in a transcript is fixture data or ambient
  // PII the model pulled from the CLI's account context. Redact before publishing.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]'],
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

/** Percent change from a to b, e.g. pctDelta(0.01, 0.013) → "+30%". `—` if a is 0/absent. */
function pctDelta(a, b) {
  if (!a || a === 0 || a === null || a === undefined) return '—'
  const p = ((b - a) / a) * 100
  return `${p > 0 ? '+' : ''}${p.toFixed(0)}%`
}

function mean(arr, f) {
  const xs = arr.map(f).filter((v) => typeof v === 'number' && !Number.isNaN(v))
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0
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

// ── arm + model naming ─────────────────────────────────────────────────────────────────────────
// Human labels for the arm names that appear in the multiseed report (the report carries only the
// bare `control` / `candidate` arm names). Values condensed from eval/arms.ts's `Arm.label`.
// Keep in sync by hand — the same "hand-copied constant" pattern as SECRET_PATTERNS / ANALYTICS_HEAD.
const ARM_LABELS = {
  bare: 'Bare model loop — no harness',
  baseline: 'PersonalAssistant as shipped — harness runs post-hoc over the reply',
  flagOn: 'PersonalAssistant with the one-loop harness-driven proposer',
  supervisorOn: 'PersonalAssistant + trajectory supervisor on the stall edge',
  contradictionOff: 'PersonalAssistant with the semantic contradiction check disabled (lexical pass only)',
  injectionDetectOff: 'PersonalAssistant with LLM injection-detection on tool output disabled (regex pass only)',
  failureMatchOff: 'PersonalAssistant with the semantic failure-mode matcher disabled (exact-string match only)',
}
export function armLabel(name) {
  return ARM_LABELS[name] || name
}

// The single behavioural difference between a `control|candidate` pair, keyed by that pair.
const ARM_ONELINER = {
  'flagOn|supervisorOn': 'the candidate consults the trajectory supervisor on the cannot-make-progress stall edge — one extra LLM call',
  'bare|flagOn': 'the candidate wraps the same model in the full 11-layer harness',
  'baseline|flagOn': 'the candidate lets the harness drive tool calls in-loop instead of reviewing an already-finished reply',
  'flagOn|contradictionOff': 'the candidate disables the semantic contradiction backstop (lexical negation-pair check only)',
  'flagOn|injectionDetectOff': 'the candidate disables the LLM injection check on tool output (deterministic pattern pass only)',
  'flagOn|failureMatchOff': 'the candidate disables the semantic failure-mode matcher (exact-string overlap only)',
}
function armOneliner(control, candidate) {
  return (
    ARM_ONELINER[`${control}|${candidate}`] ||
    `control <code>${esc(control)}</code> vs candidate <code>${esc(candidate)}</code>`
  )
}

const FRIENDLY_MODEL = {
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-opus-5': 'Claude Opus 5',
}
function friendlyModel(id) {
  return FRIENDLY_MODEL[id] || id || 'unknown'
}

// Canonical harness-layer order for the trace table (matches CLAUDE.md's layer list).
const LAYER_ORDER = [
  'world_model', 'evidence_reasoning', 'hypothesis', 'contradiction', 'diagnostics', 'control_state',
  'planning', 'execution', 'verification', 'recovery', 'reviewer_pass', 'supervisor',
]

// ── event helpers ─────────────────────────────────────────────────────────────────────────────
function jsonBlock(obj) {
  return `<pre>${esc(scrubSecrets(JSON.stringify(obj, null, 2)))}</pre>`
}

function clampText(s, max) {
  s = String(s ?? '')
  return s.length > max ? `${s.slice(0, max)}\n…(truncated, ${s.length - max} more chars)` : s
}

/** A tool call's most telling argument (path / query / url), else '' . */
function toolArg(input) {
  if (!input || typeof input !== 'object') return ''
  return input.path || input.file || input.filename || input.query || input.url || input.q || ''
}

/** Strip the CLI reply prefix `[ok] (LOW) ` that debug/assistant_reply carries. */
function stripReplyPrefix(s) {
  return String(s ?? '').replace(/^\[[a-z_]+\]\s*(\([A-Z]+\)\s*)?/i, '')
}

/** llm_responses that are machinery, not prose: the risk/intent classifier and supervisor directives. */
function controlJsonKind(text) {
  if (!/^\s*\{/.test(text ?? '')) return null
  if (/"riskLevel"|"isTrivial"|"decomposedTasks"|"matchedPlanTemplate"/.test(text)) return 'classifier'
  if (/"action"\s*:/.test(text) && /"rationale"|"investigation"|"strategy_hint"|"plan_note"/.test(text)) return 'directive'
  return null
}

function firstUserMessage(events) {
  for (const e of events ?? []) {
    if (e.kind === 'debug' && e.tool === 'user_message' && e.result) return e.result
    if (e.kind === 'llm_request' && Array.isArray(e.messages)) {
      const u = e.messages.find((m) => m.role === 'user')
      if (u) return u.content
    }
  }
  return ''
}

function assistantReply(events) {
  for (let i = (events ?? []).length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.kind === 'debug' && e.tool === 'assistant_reply' && e.result) return e.result
  }
  return ''
}

function normReply(s) {
  return stripReplyPrefix(String(s ?? '')).replace(/\s+/g, ' ').trim()
}

function toolSeq(run) {
  return (run.data.events ?? [])
    .filter((e) => e.kind === 'tool_call')
    .map((e) => `${e.tool ?? '?'}(${toolArg(e.input)})`)
}

function firedLayers(run) {
  return [
    ...new Set(
      (run.data.events ?? [])
        .filter((e) => e.kind === 'trace' && e.detail?.kind === 'layer_activity' && e.detail.fired)
        .map((e) => e.detail.layer),
    ),
  ].sort()
}

/** Mechanical control-vs-candidate behaviour diff for one task (uses the first shown seed of each arm). */
function diffRuns(ctrl, cand) {
  const rc = normReply(ctrl.data.replyPreview || assistantReply(ctrl.data.events))
  const rd = normReply(cand.data.replyPreview || assistantReply(cand.data.events))
  const tc = toolSeq(ctrl)
  const td = toolSeq(cand)
  const lc = firedLayers(ctrl)
  const ld = firedLayers(cand)
  const layersOnlyCand = ld.filter((l) => !lc.includes(l))
  const layersOnlyCtrl = lc.filter((l) => !ld.includes(l))
  const gc = ctrl.data.grade ?? {}
  const gd = cand.data.grade ?? {}
  let grade = 'same'
  if (gc.success && !gd.success) grade = 'regressed'
  else if (!gc.success && gd.success) grade = 'fixed'
  const supC = ctrl.data.metrics?.supervisorConsults ?? 0
  const supD = cand.data.metrics?.supervisorConsults ?? 0
  const toolsIdentical = JSON.stringify(tc) === JSON.stringify(td)
  const replyIdentical = rc === rd
  return {
    replyIdentical,
    toolsIdentical,
    toolsCtrl: tc,
    toolsCand: td,
    layersOnlyCand,
    layersOnlyCtrl,
    grade,
    gradeCtrl: gc,
    gradeCand: gd,
    supC,
    supD,
    behaviourChanged:
      !replyIdentical || !toolsIdentical || layersOnlyCand.length > 0 || layersOnlyCtrl.length > 0 || supC !== supD,
  }
}

// ── curated conversation (run page + compare facets) ───────────────────────────────────────────
// One ordered walk of the events — user turns (turn 1 + every followup), turn-setup chips,
// tool calls, model text, harness directives — so a multi-turn task reads as a conversation.
function renderConversation(events, prompt, replyPreview) {
  events = events ?? []
  const parts = []
  const userTurn = (t) => parts.push(`<div class="turn user"><span class="who">user</span><pre>${esc(scrubSecrets(t))}</pre></div>`)
  const modelTurn = (t) => parts.push(`<div class="turn model"><span class="who">model</span><pre>${esc(scrubSecrets(t))}</pre></div>`)

  // If the transcript carries no user_message events at all, fall back to the passed prompt.
  const hasUserMsgEvents = events.some((e) => e.kind === 'debug' && e.tool === 'user_message')
  if (!hasUserMsgEvents && prompt) userTurn(prompt)

  let heldModel = null // last non-final model text, emitted when the next one arrives
  let pendingChips = []
  const flushChips = () => {
    if (pendingChips.length) parts.push(`<div class="chips">${pendingChips.map((c) => `<span class="chip">${c}</span>`).join('')}</div>`)
    pendingChips = []
  }

  for (const e of events) {
    if (e.kind === 'debug' && e.tool === 'user_message') {
      if (heldModel) { modelTurn(heldModel); heldModel = null }
      flushChips()
      userTurn(e.result ?? '')
    } else if (e.kind === 'trace') {
      const d = e.detail ?? {}
      if (d.kind === 'turn_boundary') {
        if (heldModel) { modelTurn(heldModel); heldModel = null }
        parts.push(`<div class="turn-divider">turn ${esc(String(d.turn ?? ''))}</div>`)
      } else if (d.kind === 'risk_classified' && d.riskLevel) pendingChips.push(`risk ${esc(d.riskLevel)}`)
      else if (d.kind === 'execution_mode_classified' && d.mode) pendingChips.push(`mode ${esc(d.mode)}`)
      else if (d.kind === 'proposer_selected' && d.proposerKind) pendingChips.push(`proposer ${esc(d.proposerKind)}`)
      else if (d.kind === 'triviality_classified') pendingChips.push(d.isTrivial ? 'trivial' : 'non-trivial')
    } else if (e.kind === 'tool_call') {
      flushChips()
      const arg = toolArg(e.input)
      const res = e.result === undefined ? '' : clampText(scrubSecrets(String(e.result)), 1600)
      parts.push(
        `<div class="turn tool"><span class="who">tool</span>` +
          `<div class="tool-head"><code>${esc(e.tool ?? '?')}</code>${arg ? ` <span class="tool-arg">${esc(String(arg))}</span>` : ''}</div>` +
          `${res ? `<pre>${esc(res)}</pre>` : ''}</div>`,
      )
    } else if (e.kind === 'llm_response' && e.reply) {
      flushChips()
      const kind = controlJsonKind(e.reply)
      if (kind === 'directive') {
        if (heldModel) { modelTurn(heldModel); heldModel = null }
        parts.push(`<div class="turn directive"><span class="who">harness directive</span><pre>${esc(scrubSecrets(e.reply))}</pre></div>`)
      } else if (!kind) {
        if (heldModel) modelTurn(heldModel)
        heldModel = e.reply
      }
      // classifier JSON: dropped (its content is in the turn-setup chips)
    }
  }
  flushChips()

  const finalText = stripReplyPrefix(replyPreview || heldModel || assistantReply(events))
  if (heldModel && normReply(heldModel) !== normReply(finalText)) modelTurn(heldModel)
  if (finalText) {
    parts.push(`<div class="turn model final"><span class="who">final reply</span><pre>${esc(scrubSecrets(finalText))}</pre></div>`)
  } else {
    parts.push(`<p class="muted">No natural-language reply — the run ended on a harness directive or an unrecovered stall. See the full harness trace below.</p>`)
  }

  return parts.length ? parts.join('\n') : '<p>(no transcript events recorded)</p>'
}

// ── aggregated harness trace (grouped, readable) ───────────────────────────────────────────────
const KNOWN_TRACE_KINDS = new Set([
  'layer_activity', 'tool_policy_decision', 'harness_node', 'plan_updated', 'plan_classified',
  'risk_classified', 'execution_mode_classified', 'proposer_selected', 'triviality_classified',
  'turn_start', 'turn_end',
])

function renderTrace(events) {
  const traces = (events ?? []).filter((e) => e.kind === 'trace').map((e) => e.detail ?? {})
  if (!traces.length) return ''

  const layerMap = new Map()
  for (const d of traces) {
    if (d.kind !== 'layer_activity') continue
    const key = `${d.layer}|${d.fired}|${d.reason}`
    const cur = layerMap.get(key) || { layer: d.layer, fired: !!d.fired, reason: d.reason || '', n: 0 }
    cur.n += 1
    layerMap.set(key, cur)
  }
  const layerRows = [...layerMap.values()]
    .sort((a, b) => {
      const ai = LAYER_ORDER.indexOf(a.layer)
      const bi = LAYER_ORDER.indexOf(b.layer)
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.layer.localeCompare(b.layer)
    })
    .map(
      (r) =>
        `<tr class="${r.fired ? 'fired' : 'skip'}"><td><span class="dot ${r.fired ? 'on' : 'off'}"></span>${esc(r.layer)}</td>` +
        `<td>${r.fired ? 'acted' : '—'}${r.n > 1 ? ` <span class="x">×${r.n}</span>` : ''}</td><td>${esc(r.reason)}</td></tr>`,
    )
    .join('')

  const policyRows = traces
    .filter((d) => d.kind === 'tool_policy_decision')
    .map(
      (d) =>
        `<tr class="${d.decision === 'ALLOW' ? 'skip' : 'fired'}"><td><code>${esc(d.tool ?? '?')}</code></td>` +
        `<td>${esc(d.decision ?? '')}</td><td>${esc(d.reason ?? '')}</td></tr>`,
    )
    .join('')

  const nodes = traces
    .filter((d) => d.kind === 'harness_node')
    .map((d) => `${esc(d.node)}${d.stepsUsed ? ` <span class="x">(${d.stepsUsed})</span>` : ''}`)

  const cls = {}
  for (const d of traces) {
    if (d.kind === 'risk_classified' && d.riskLevel) cls.risk = d.riskLevel
    if (d.kind === 'execution_mode_classified' && d.mode) cls.mode = d.mode
    if (d.kind === 'proposer_selected' && d.proposerKind) cls.proposer = d.proposerKind
    if (d.kind === 'plan_classified') cls.plan = d.matchedTemplate || (d.isCandidate ? 'candidate' : 'none')
  }

  const planUpdates = traces.filter((d) => d.kind === 'plan_updated')
  const unknown = traces.filter((d) => !KNOWN_TRACE_KINDS.has(d.kind))

  const s = []
  s.push(
    `<p class="trace-legend">The harness runs on every turn. Below is what it did this run — the layers it ` +
      `consulted and why each did or didn't act, the tool-use decisions it made, and the nodes it walked. ` +
      `Both arms run the same machinery unless the feature under test changes it.</p>`,
  )
  if (Object.keys(cls).length) {
    s.push(
      `<div class="chips">${Object.entries(cls)
        .map(([k, v]) => `<span class="chip">${esc(k)} ${esc(String(v))}</span>`)
        .join('')}</div>`,
    )
  }
  if (layerRows) {
    s.push(
      `<h4>Harness layers</h4><table class="trace-table"><thead><tr><th>Layer</th><th>Acted?</th><th>Why</th></tr></thead><tbody>${layerRows}</tbody></table>`,
    )
  }
  if (policyRows) {
    s.push(
      `<h4>Tool-policy decisions</h4><table class="trace-table"><thead><tr><th>Tool</th><th>Decision</th><th>Why</th></tr></thead><tbody>${policyRows}</tbody></table>`,
    )
  }
  if (nodes.length) s.push(`<h4>Node path</h4><p class="node-path">${nodes.join(' <span class="arr">&rarr;</span> ')}</p>`)
  if (planUpdates.length) {
    s.push(`<h4>Plan updates</h4><ul class="plain">${planUpdates.map((d) => `<li>${esc(JSON.stringify(d))}</li>`).join('')}</ul>`)
  }
  if (unknown.length) {
    s.push(`<h4>Other trace events</h4>${unknown.map((d) => jsonBlock(d)).join('')}`)
  }
  return s.join('\n')
}

/** Wrap renderTrace output in one collapsed disclosure. `''` if there is no trace. */
function traceDetails(events, summaryLabel) {
  const inner = renderTrace(events)
  if (!inner) return ''
  return `<details class="trace"><summary>${esc(summaryLabel)}</summary><div class="trace-body">${inner}</div></details>`
}

function renderGrade(grade) {
  if (!grade) return ''
  const rows = (grade.checks ?? [])
    .map((c) => `<tr><td>${esc(c.name)}</td><td><span class="verdict ${c.verdict === 'pass' ? 'pass' : 'fail'}">${esc(c.verdict)}</span></td></tr>`)
    .join('')
  return `<table class="cmp-table"><thead><tr><th>Check</th><th>Verdict</th></tr></thead><tbody>${rows || '<tr><td colspan="2">(none)</td></tr>'}</tbody></table>
<p class="grade-line"><strong>success</strong> ${grade.success ? 'yes' : 'no'} &nbsp;&middot;&nbsp; <strong>hallucination</strong> ${grade.hallucination ? 'yes' : 'no'} &nbsp;&middot;&nbsp; <strong>unauthorized effect</strong> ${grade.unauthorizedEffect ? 'yes' : 'no'} &nbsp;&middot;&nbsp; <strong>recovered</strong> ${grade.recovered === null || grade.recovered === undefined ? 'n/a' : grade.recovered ? 'yes' : 'no'}</p>`
}

/** One-line metrics summary: `$0.0131 · 9.9 s · 445 tokens · 0 supervisor consults`. */
function metricsLine(m) {
  if (!m) return '—'
  const secs = m.latencyMs === null || m.latencyMs === undefined ? '—' : `${(m.latencyMs / 1000).toFixed(1)} s`
  return `${fmtNum('costUsd', m.costUsd)} &middot; ${secs} &middot; ${fmtNum('totalTokens', m.totalTokens)} tokens &middot; ${m.supervisorConsults ?? 0} supervisor consult${(m.supervisorConsults ?? 0) === 1 ? '' : 's'}`
}

function renderMetricsTable(m) {
  if (!m) return '<p>—</p>'
  return `<table class="cmp-table"><tbody>
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
  const id = report.modelId || 'unknown'
  const j = report.judgeModelId ? `, judge <code>${esc(report.judgeModelId)}</code>` : ''
  return `<p class="model-line">Model: ${esc(friendlyModel(report.modelId))} (<code>${esc(id)}</code>)${j} &middot; ${report.seeds} seed${report.seeds === 1 ? '' : 's'} &middot; <span class="model-note">the arm-under-test model the CLI actually served, from the run report</span></p>`
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
  const anySupervisor = runs.some((r) => (r.data.metrics?.supervisorConsults ?? 0) > 0)

  // One row per task: control vs candidate rolled up across every seed, with a per-seed strip.
  const taskRows = tasks
    .map((task) => {
      const ctrlRuns = runs.filter((r) => r.task === task && r.arm === report.control)
      const candRuns = runs.filter((r) => r.task === task && r.arm === report.candidate)
      const seeds = [...new Set(runs.filter((r) => r.task === task).map((r) => r.seed))].sort()

      const pairs = seeds.map((seed) => {
        const c = ctrlRuns.find((r) => r.seed === seed)
        const d = candRuns.find((r) => r.seed === seed)
        return { seed, c, d, diff: c && d ? diffRuns(c, d) : null }
      })
      const paired = pairs.filter((p) => p.diff)
      const changedN = paired.filter((p) => p.diff.behaviourChanged).length
      const bhv =
        paired.length === 0
          ? '—'
          : changedN === 0
            ? '<span class="bhv same">no change</span>'
            : changedN === paired.length
              ? '<span class="bhv changed">changed</span>'
              : `<span class="bhv changed">changed ${changedN}/${paired.length}</span>`

      const cPass = ctrlRuns.filter((r) => r.data.grade?.success).length
      const dPass = candRuns.filter((r) => r.data.grade?.success).length
      const nFixed = paired.filter((p) => p.diff.grade === 'fixed').length
      const nRegressed = paired.filter((p) => p.diff.grade === 'regressed').length
      const gradeShift = nRegressed
        ? ` <span class="shift regressed">regressed${nRegressed > 1 ? ` &times;${nRegressed}` : ''}</span>`
        : nFixed
          ? ` <span class="shift">fixed${nFixed > 1 ? ` &times;${nFixed}` : ''}</span>`
          : ''

      const dCost = pctDelta(mean(ctrlRuns, (r) => r.data.metrics?.costUsd), mean(candRuns, (r) => r.data.metrics?.costUsd))
      const dLat = pctDelta(mean(ctrlRuns, (r) => r.data.metrics?.latencyMs), mean(candRuns, (r) => r.data.metrics?.latencyMs))
      const dTok = pctDelta(mean(ctrlRuns, (r) => r.data.metrics?.totalTokens), mean(candRuns, (r) => r.data.metrics?.totalTokens))
      const supTotal = candRuns.reduce((s, r) => s + (r.data.metrics?.supervisorConsults ?? 0), 0)

      const seedStripCell = pairs
        .map((p) => {
          const cs = p.c ? (p.c.data.grade?.success ? '&check;' : '&cross;') : '·'
          const ds = p.d ? (p.d.data.grade?.success ? '&check;' : '&cross;') : '·'
          const href = p.d && runGetsPage(p.d, fullPages) ? runPageName(p.d) : comparePageName(task)
          const klass = p.diff?.behaviourChanged ? 'seed-diff' : 'seed-same'
          return `<a href="${href}" class="${klass}" title="seed ${esc(p.seed)}: control ${p.c?.data.grade?.success ? 'pass' : 'fail'} &rarr; candidate ${p.d?.data.grade?.success ? 'pass' : 'fail'}">s${esc(p.seed)} ${cs}&rarr;${ds}</a>`
        })
        .join(' ')

      return `<tr>
<td><a href="${comparePageName(task)}">${esc(task)}</a></td>
<td>${bhv}</td>
<td class="num">${cPass}/${ctrlRuns.length}</td>
<td class="num">${dPass}/${candRuns.length}${gradeShift}</td>
${anySupervisor ? `<td class="num">${supTotal}</td>` : ''}
<td class="num">${dCost}</td><td class="num">${dLat}</td><td class="num">${dTok}</td>
<td class="seed-strip-cell">${seedStripCell}</td>
</tr>`
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

<h2>Runs <span class="sub">&mdash; ${tasks.length} task${tasks.length === 1 ? '' : 's'} &times; ${report.seeds} seed${report.seeds === 1 ? '' : 's'}, ${runs.length} runs, one row per task</span></h2>
<div class="filter-box"><input id="f" type="text" placeholder="filter by task…" oninput="filterRows()"></div>
<table class="cmp-table" id="runs"><thead><tr><th>Task</th><th>Behaviour</th><th>${esc(report.control)}<br><span class="th-sub">pass</span></th><th>${esc(report.candidate)}<br><span class="th-sub">pass</span></th>${anySupervisor ? '<th>Sup.</th>' : ''}<th>&Delta; cost</th><th>&Delta; lat</th><th>&Delta; tok</th><th>Seeds <span class="th-sub">ctrl&rarr;cand</span></th></tr></thead><tbody>${taskRows}</tbody></table>
<p><em>Behaviour</em> = did the candidate's reply / tool calls / harness layers differ from the control, across seeds. <em>Pass</em> columns count graded successes; <span class="shift">fixed</span> / <span class="shift regressed">regressed</span> flags a seed where the candidate changed the outcome. Each <em>Seeds</em> chip links to that seed's run (control&nbsp;&rarr;&nbsp;candidate outcome); the task name opens the side-by-side compare.</p>
<script>
function filterRows(){var q=document.getElementById('f').value.toLowerCase();var rows=document.querySelectorAll('#runs tbody tr');for(var i=0;i<rows.length;i++){rows[i].style.display=rows[i].textContent.toLowerCase().indexOf(q)>-1?'':'none';}}
</script>`

  return page(`${report.title} — transcripts`, css, body, esc(report.feature), report.generatedAt)
}

// ── run page ─────────────────────────────────────────────────────────────────────────────────
function renderRunPage(report, run, css) {
  const d = run.data
  const g = d.grade ?? {}
  const nChecks = (g.checks ?? []).length
  const nPass = (g.checks ?? []).filter((c) => c.verdict === 'pass').length
  const armDesc = armLabel(run.arm)
  const body = `<span class="eyebrow">${esc(report.title)}</span>
<h1>${esc(run.arm)} &middot; ${esc(run.task)} &middot; seed ${esc(run.seed)}</h1>
${modelLine(report)}
<p class="arm-desc">${esc(run.arm)} = ${esc(armDesc)}</p>

<div class="summary-box">
  <div class="sb-row"><span class="sb-key">Outcome</span><span class="sb-val">success <strong>${g.success ? 'yes' : 'no'}</strong> &middot; hallucination ${g.hallucination ? 'yes' : 'no'} &middot; unauthorized effect ${g.unauthorizedEffect ? 'yes' : 'no'} &middot; recovered ${g.recovered === null || g.recovered === undefined ? 'n/a' : g.recovered ? 'yes' : 'no'}${nChecks ? ` &middot; grader ${nPass}/${nChecks} checks pass` : ''}</span></div>
  <div class="sb-row"><span class="sb-key">Cost</span><span class="sb-val">${metricsLine(d.metrics)}</span></div>
</div>

<h2>Prompt</h2>
<pre>${esc(scrubSecrets(d.prompt ?? firstUserMessage(d.events)))}</pre>

<h2>Conversation</h2>
${renderConversation(d.events, d.prompt, d.replyPreview)}

<h2>Grader checks</h2>
${renderGrade(d.grade)}

${traceDetails(d.events, `Full harness trace — ${run.arm} · seed ${run.seed}`)}

<p><a href="index.html">&larr; index</a> &middot; <a href="${comparePageName(run.task)}">compare arms on this task</a></p>`
  return page(`${run.arm} / ${run.task} / seed ${run.seed}`, css, body, `<a href="index.html">${esc(report.feature)}</a><span>/</span>${esc(run.task)}`, report.generatedAt)
}

// ── compare page ─────────────────────────────────────────────────────────────────────────────
function facetRow(label, ctrlHtml, candHtml) {
  return `<div class="facet-label">${esc(label)}</div>
<div class="facet-cell">${ctrlHtml}</div>
<div class="facet-cell">${candHtml}</div>`
}

function toolListHtml(seq) {
  if (!seq.length) return '<p class="muted">no tool calls</p>'
  return `<ol class="tool-list">${seq.map((t) => `<li><code>${esc(t)}</code></li>`).join('')}</ol>`
}

function replyHtml(run) {
  const t = normReply(run.data.replyPreview || assistantReply(run.data.events))
  return t ? `<pre>${esc(scrubSecrets(t))}</pre>` : '<p class="muted">no natural-language reply — ended on a harness directive / unrecovered stall</p>'
}

function seedStrip(runs, shownSeed, fullPages) {
  const others = runs.filter((r) => r.seed !== shownSeed)
  if (!others.length) return ''
  const items = others
    .map((r) => {
      const g = r.data.grade ?? {}
      const m = r.data.metrics ?? {}
      const txt = `seed ${esc(r.seed)}: ${g.success ? 'pass' : 'fail'} &middot; ${fmtNum('costUsd', m.costUsd)} &middot; ${m.latencyMs === undefined ? '—' : (m.latencyMs / 1000).toFixed(1) + ' s'}`
      return runGetsPage(r, fullPages) ? `<a href="${runPageName(r)}">${txt}</a>` : `<span>${txt}</span>`
    })
    .join(' &nbsp; ')
  return `<p class="seed-strip">Other seeds — ${items}</p>`
}

function renderComparePage(report, task, taskRuns, css, fullPages) {
  const byArm = new Map()
  for (const r of taskRuns) {
    if (!byArm.has(r.arm)) byArm.set(r.arm, [])
    byArm.get(r.arm).push(r)
  }
  for (const list of byArm.values()) list.sort((a, b) => String(a.seed).localeCompare(String(b.seed)))

  const ctrlRuns = byArm.get(report.control) ?? []
  const candRuns = byArm.get(report.candidate) ?? []
  const ctrl = ctrlRuns[0]
  const cand = candRuns[0]
  const prompt = taskRuns[0]?.data?.prompt ?? ''

  let summary = ''
  let grid = ''
  let traces = ''

  if (ctrl && cand) {
    const diff = diffRuns(ctrl, cand)

    // per-task metric deltas from the shown seed (report-level deltas are matrix-wide, not per task)
    const mc = ctrl.data.metrics ?? {}
    const md = cand.data.metrics ?? {}
    const dPct = (a, b) => (a ? `${b - a > 0 ? '+' : ''}${(((b - a) / a) * 100).toFixed(0)}%` : '—')
    const impact =
      !diff.behaviourChanged
        ? `No behavioural change on this task — same reply, same tool calls, same harness layers. The candidate did the extra work for an identical result.`
        : diff.grade === 'fixed'
          ? `The candidate turned a failure into a pass here.`
          : diff.grade === 'regressed'
            ? `The candidate regressed a passing task to a failure here.`
            : `The candidate behaved differently but the graded outcome was the same.`

    const bhvRows = [
      ['Final reply', diff.replyIdentical ? '<span class="bhv same">identical</span>' : '<span class="bhv changed">differs</span>'],
      [
        'Tool calls',
        diff.toolsIdentical
          ? `<span class="bhv same">same ${diff.toolsCtrl.length} call${diff.toolsCtrl.length === 1 ? '' : 's'}</span>`
          : `<span class="bhv changed">differ</span> &mdash; control ${diff.toolsCtrl.length}, candidate ${diff.toolsCand.length}`,
      ],
      [
        'Supervisor consults',
        diff.supC === diff.supD ? `<span class="bhv same">${diff.supC} / ${diff.supD}</span>` : `<span class="bhv changed">${diff.supC} &rarr; ${diff.supD}</span>`,
      ],
      [
        'Harness layers',
        diff.layersOnlyCand.length === 0 && diff.layersOnlyCtrl.length === 0
          ? '<span class="bhv same">same set fired</span>'
          : `<span class="bhv changed">differ</span>${diff.layersOnlyCand.length ? ` &mdash; candidate also: ${diff.layersOnlyCand.map(esc).join(', ')}` : ''}${diff.layersOnlyCtrl.length ? ` &mdash; control only: ${diff.layersOnlyCtrl.map(esc).join(', ')}` : ''}`,
      ],
      [
        'Graded outcome',
        diff.grade === 'same'
          ? `<span class="bhv same">both ${diff.gradeCtrl.success ? 'pass' : 'fail'}</span>`
          : `<span class="bhv changed">${diff.grade === 'fixed' ? 'candidate fixed it' : 'candidate regressed it'}</span>`,
      ],
    ]
      .map(([k, v]) => `<div class="sb-row"><span class="sb-key">${k}</span><span class="sb-val">${v}</span></div>`)
      .join('\n')

    summary = `<div class="summary-box">
  <div class="sb-head">What changed</div>
  <div class="sb-row"><span class="sb-key">Arms</span><span class="sb-val"><code>${esc(report.control)}</code> ${esc(armLabel(report.control))} &nbsp;vs&nbsp; <code>${esc(report.candidate)}</code> ${esc(armLabel(report.candidate))}</span></div>
  <div class="sb-row"><span class="sb-key">The difference</span><span class="sb-val">${armOneliner(report.control, report.candidate)}</span></div>
  <div class="sb-head">Did behaviour change?</div>
${bhvRows}
  <div class="sb-head">Impact</div>
  <div class="sb-row"><span class="sb-key">This task</span><span class="sb-val">${esc(impact)}</span></div>
  <div class="sb-row"><span class="sb-key">Shown seed</span><span class="sb-val">cost ${dPct(mc.costUsd, md.costUsd)} &middot; latency ${dPct(mc.latencyMs, md.latencyMs)} &middot; tokens ${dPct(mc.totalTokens, md.totalTokens)} (candidate vs control, seed ${esc(ctrl.seed)})</span></div>
</div>`

    grid = `<h2>Side by side <span class="sub">&mdash; control (left) vs candidate (right), seed ${esc(ctrl.seed)}</span></h2>
<div class="cmp-grid">
<div class="facet-cell arm-head"><code>${esc(report.control)}</code> &mdash; control</div>
<div class="facet-cell arm-head"><code>${esc(report.candidate)}</code> &mdash; candidate</div>
${facetRow('Final reply', replyHtml(ctrl), replyHtml(cand))}
${facetRow('Tool calls', toolListHtml(diff.toolsCtrl), toolListHtml(diff.toolsCand))}
${facetRow('Grader checks', renderGrade(ctrl.data.grade), renderGrade(cand.data.grade))}
${facetRow('Metrics', renderMetricsTable(ctrl.data.metrics), renderMetricsTable(cand.data.metrics))}
</div>
${seedStrip(ctrlRuns, ctrl.seed, fullPages)}
${seedStrip(candRuns, cand.seed, fullPages)}

<h2>Read the full turn</h2>
<details class="trace"><summary>Conversation &mdash; ${esc(report.control)} (control) · seed ${esc(ctrl.seed)}</summary><div class="trace-body">${renderConversation(ctrl.data.events, ctrl.data.prompt, ctrl.data.replyPreview)}</div></details>
<details class="trace"><summary>Conversation &mdash; ${esc(report.candidate)} (candidate) · seed ${esc(cand.seed)}</summary><div class="trace-body">${renderConversation(cand.data.events, cand.data.prompt, cand.data.replyPreview)}</div></details>`

    traces = `<h2>Harness trace</h2>
${traceDetails(ctrl.data.events, `Full harness trace — ${report.control} · seed ${ctrl.seed}`)}
${traceDetails(cand.data.events, `Full harness trace — ${report.candidate} · seed ${cand.seed}`)}`
  } else {
    // Degenerate: only one arm present for this task.
    const only = ctrl || cand || taskRuns[0]
    grid = only
      ? `<h2>${esc(only.arm)} &middot; seed ${esc(only.seed)}</h2>${renderConversation(only.data.events, only.data.prompt, only.data.replyPreview)}${renderGrade(only.data.grade)}${traceDetails(only.data.events, `Full harness trace — ${only.arm}`)}`
      : '<p>(no runs for this task)</p>'
  }

  const body = `<span class="eyebrow">${esc(report.title)}</span>
<h1>Compare: ${esc(task)}</h1>
${modelLine(report)}
<h2>Prompt</h2>
<pre>${esc(scrubSecrets(prompt || firstUserMessage(taskRuns[0]?.data?.events)))}</pre>
${summary}
${grid}
${traces}
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
    write(comparePageName(task), renderComparePage(report, task, taskRuns, css, effFullPages))
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
