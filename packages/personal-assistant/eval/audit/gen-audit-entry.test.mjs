/**
 * Plan A3 — gen-audit-entry.mjs: fold a multiseed report into the benchmark md + registry HTML.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generate, esc } from './gen-audit-entry.mjs'

const MD_SEED = '# Comparative Harness Benchmark\n\nNewest run first.\n\n## Existing run\n\nold content\n'
const HTML_SEED =
  '<!DOCTYPE html>\n<html><body>\n<h2>Candidate registry</h2>\n<p>rows...</p>\n<footer>\n<p>Working doc.</p>\n</footer>\n</body></html>\n'

function report(over = {}) {
  return {
    feature: 'semantic-contradiction',
    title: 'Semantic contradiction check',
    hypothesis: 'The lexical pass misses paraphrased conflicts.',
    control: 'contradictionOff',
    candidate: 'flagOn',
    seeds: 3,
    verdict: 'CUT',
    rationale: 'Neutral with a real cost increase.',
    modelId: 'claude-sonnet-5',
    judgeModelId: 'claude-sonnet-5',
    generatedAt: '2026-09-08T12:00:00.000Z',
    metrics: [
      { metric: 'taskSuccessRate', control: 0.6, candidate: 0.62, deltaMean: 0.02, deltaCi95: 0.1, positive: false, regressed: false },
      { metric: 'meanCostUsd', control: 0.01, candidate: 0.014, deltaMean: 0.004, deltaCi95: 0.001, positive: false, regressed: false },
    ],
    costDeltaPct: 0.4,
    latencyDeltaPct: 0.1,
    tokenDeltaPct: 0.25,
    ...over,
  }
}

let root
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'audit-entry-'))
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'plans'), { recursive: true })
  writeFileSync(join(root, 'docs', 'harness_comparative_benchmark.md'), MD_SEED)
  writeFileSync(join(root, 'plans', 'feature_value_audit.html'), HTML_SEED)
})

function write(rep) {
  const p = join(root, 'r.multiseed.json')
  writeFileSync(p, JSON.stringify(rep))
  return generate({ reportPath: p, repoRoot: root })
}

function md() {
  return readFileSync(join(root, 'docs', 'harness_comparative_benchmark.md'), 'utf8')
}
function html() {
  return readFileSync(join(root, 'plans', 'feature_value_audit.html'), 'utf8')
}

describe('gen-audit-entry', () => {
  it('writes both surfaces and reports the verdict', () => {
    const res = write(report())
    expect(res.verdict).toBe('CUT')
    expect(res.written).toHaveLength(2)
  })

  it('adds a marker-delimited md section with the verdict and metric table', () => {
    write(report())
    const t = md()
    expect(t).toContain('<!-- audit-entry:semantic-contradiction start -->')
    expect(t).toContain('<!-- audit-entry:semantic-contradiction end -->')
    expect(t).toContain('## Audit — Semantic contradiction check')
    expect(t).toContain('**Verdict:** CUT')
    expect(t).toContain('| taskSuccessRate | 0.6 | 0.62 |')
    expect(t).toContain('cost +40%, latency +10%, tokens +25%')
    // the pre-existing content survives
    expect(t).toContain('## Existing run')
  })

  it('adds an HTML entry before <footer> with the verdict badge and a runs link', () => {
    write(report())
    const t = html()
    expect(t).toContain('<h2 id="audit-semantic-contradiction">Audit &mdash; Semantic contradiction check <span class="badge cut">CUT</span></h2>')
    expect(t).toContain('href="/harness-evaluation/semantic-contradiction/"')
    expect(t.indexOf('audit-entry:semantic-contradiction start')).toBeLessThan(t.indexOf('<footer>'))
  })

  it('is idempotent — running twice produces byte-identical files', () => {
    write(report())
    const md1 = md()
    const html1 = html()
    write(report())
    expect(md()).toEqual(md1)
    expect(html()).toEqual(html1)
  })

  it('a re-run with a changed verdict replaces the block in place, no duplication', () => {
    write(report())
    write(report({ verdict: 'KEEP', rationale: 'It clears CI now.' }))
    const t = html()
    expect(t.match(/audit-entry:semantic-contradiction start/g)).toHaveLength(1)
    expect(t).toContain('<span class="badge keep">KEEP</span>')
    expect(t).not.toContain('badge cut">CUT')
  })

  it('a second feature is added without clobbering the first', () => {
    write(report())
    write(report({ feature: 'llm-injection-detect', title: 'LLM injection detection', verdict: 'INCONCLUSIVE' }))
    const t = html()
    expect(t).toContain('audit-entry:semantic-contradiction start')
    expect(t).toContain('audit-entry:llm-injection-detect start')
    expect(t).toContain('<span class="badge med">INCONCLUSIVE</span>')
  })

  it('esc escapes HTML metacharacters', () => {
    expect(esc('<a "x">&')).toBe('&lt;a &quot;x&quot;&gt;&amp;')
  })
})
