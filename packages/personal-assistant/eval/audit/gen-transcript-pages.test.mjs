/**
 * Plan A2 — gen-transcript-pages.mjs against a committed fixture
 * (__fixtures__/mini-report/: 1 feature, 2 arms, 2 tasks, 1 seed, one planted secret).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate, parseTranscriptFilename, runGetsPage, esc } from './gen-transcript-pages.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '__fixtures__', 'mini-report')
const REPORT = join(FIXTURE, 'mini.multiseed.json')
const TRANSCRIPTS = join(FIXTURE, 'transcripts')
const PLANTED_SECRET = 'sk-ant-PLANTEDSECRETVALUE0123456789'

function run(fullPages) {
  const root = mkdtempSync(join(tmpdir(), 'audit-pages-'))
  const res = generate({ reportPath: REPORT, transcriptsDir: TRANSCRIPTS, pagesRoot: root, fullPages })
  return { root, ...res }
}

describe('gen-transcript-pages — full pages (default)', () => {
  let out
  beforeAll(() => {
    out = run(undefined)
  })

  it('emits the expected file set', () => {
    expect(out.written.sort()).toEqual(
      [
        'index.html',
        'armA-task-one-seed1.html',
        'armB-task-one-seed1.html',
        'armA-adv-task-two-seed1.html',
        'armB-adv-task-two-seed1.html',
        'compare-task-one.html',
        'compare-adv-task-two.html',
      ].sort(),
    )
  })

  it('writes into harness-evaluation/<feature>/', () => {
    expect(out.outDir.endsWith(join('harness-evaluation', 'mini'))).toBe(true)
    for (const f of out.written) expect(existsSync(join(out.outDir, f))).toBe(true)
  })

  it('every internal .html link in index.html resolves to a written file', () => {
    const idx = readFileSync(join(out.outDir, 'index.html'), 'utf8')
    const links = [...idx.matchAll(/href="([^"]+\.html)"/g)].map((m) => m[1]).filter((h) => !h.startsWith('/'))
    expect(links.length).toBeGreaterThan(0)
    for (const l of links) expect(existsSync(join(out.outDir, l)), `missing ${l}`).toBe(true)
  })

  it('carries the Model line — friendly name + the id the report actually recorded, never a hardcoded family', () => {
    for (const f of out.written) {
      const html = readFileSync(join(out.outDir, f), 'utf8')
      expect(html, f).toContain('Model: Claude Sonnet 5 (<code>claude-sonnet-5</code>)')
      // regression guard: the old generator printed "Claude Sonnet" regardless of modelId
      expect(html, f).not.toMatch(/Model: Claude Sonnet \(<code>claude-haiku/)
    }
  })

  it('compare page leads with the what-changed / behaviour / impact summary', () => {
    const cmp = readFileSync(join(out.outDir, 'compare-task-one.html'), 'utf8')
    expect(cmp).toContain('class="summary-box"')
    expect(cmp).toContain('What changed')
    expect(cmp).toContain('Did behaviour change?')
    expect(cmp).toContain('Impact')
    // armB adds a tool call armA doesn't → behaviour differs
    expect(cmp).toMatch(/Tool calls[\s\S]{0,120}differ/)
  })

  it('compare page aligns the arms in a row-wise grid, not free-flowing columns', () => {
    const cmp = readFileSync(join(out.outDir, 'compare-task-one.html'), 'utf8')
    expect(cmp).toContain('class="cmp-grid"')
    expect(cmp).toContain('class="facet-label"')
    expect(cmp).not.toContain('class="col"')
  })

  it('demotes the raw event trace into one collapsed disclosure per arm', () => {
    const run = readFileSync(join(out.outDir, 'armA-adv-task-two-seed1.html'), 'utf8')
    // the curated conversation is inline; the trace (if any) is behind <details class="trace">
    expect(run).toContain('<h2>Conversation</h2>')
    const cmp = readFileSync(join(out.outDir, 'compare-adv-task-two.html'), 'utf8')
    expect(cmp).toContain('<details class="trace">')
  })

  it('index carries a Behaviour column driven by the mechanical diff', () => {
    const idx = readFileSync(join(out.outDir, 'index.html'), 'utf8')
    expect(idx).toContain('<th>Behaviour</th>')
    expect(idx).toMatch(/class="bhv (changed|same)"/)
  })

  it('renders every user turn of a multi-turn transcript, with a turn divider', () => {
    // armB__task-one is a 2-turn fixture (a followup + a turn_boundary event)
    const run = readFileSync(join(out.outDir, 'armB-task-one-seed1.html'), 'utf8')
    const userTurns = [...run.matchAll(/<div class="turn user">/g)]
    expect(userTurns.length).toBe(2)
    expect(run).toContain('class="turn-divider"')
    expect(run).toContain('And is it also the largest city?')
  })

  it('shows the feature verdict and hypothesis on the index', () => {
    const idx = readFileSync(join(out.outDir, 'index.html'), 'utf8')
    expect(idx).toContain('INCONCLUSIVE')
    expect(idx).toContain('exercise gen-transcript-pages.mjs')
  })

  it('scrubs a planted secret from every output file', () => {
    for (const f of out.written) {
      const html = readFileSync(join(out.outDir, f), 'utf8')
      expect(html, f).not.toContain(PLANTED_SECRET)
      expect(html, f).not.toContain('sk-ant-PLANTED')
    }
    // and it really was in the source transcript
    expect(readFileSync(join(TRANSCRIPTS, 'armA__adv-task-two__seed1.json'), 'utf8')).toContain(PLANTED_SECRET)
  })

  it('is deterministic — same input twice → byte-identical output', () => {
    const a = run(undefined)
    const b = run(undefined)
    for (const f of a.written) {
      expect(readFileSync(join(a.outDir, f), 'utf8')).toEqual(readFileSync(join(b.outDir, f), 'utf8'))
    }
    rmSync(a.root, { recursive: true, force: true })
    rmSync(b.root, { recursive: true, force: true })
  })

  it('emits well-formed HTML (balanced core tags)', () => {
    for (const f of out.written) {
      const html = readFileSync(join(out.outDir, f), 'utf8')
      for (const tag of ['html', 'head', 'body', 'table', 'details']) {
        const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length
        const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length
        expect(open, `${f}: <${tag}> balance`).toBe(close)
      }
      expect(html.startsWith('<!doctype html>')).toBe(true)
    }
  })
})

describe('gen-transcript-pages — full-pages=adv,injected', () => {
  it('only gives adversarial / injected runs a dedicated page', () => {
    const out = run('adv,injected')
    expect(out.written.sort()).toEqual(
      [
        'index.html',
        'armA-adv-task-two-seed1.html',
        'armB-adv-task-two-seed1.html',
        'compare-task-one.html',
        'compare-adv-task-two.html',
      ].sort(),
    )
    // task-one rows still appear in the index table, just without a link
    const idx = readFileSync(join(out.outDir, 'index.html'), 'utf8')
    expect(idx).toContain('task-one')
    expect(idx).not.toContain('href="armA-task-one-seed1.html"')
    rmSync(out.root, { recursive: true, force: true })
  })
})

describe('helpers', () => {
  it('parseTranscriptFilename splits arm/task/seed, tolerating dashes in the task id', () => {
    expect(parseTranscriptFilename('armB__adv-task-two__seed1.json')).toEqual({ arm: 'armB', task: 'adv-task-two', seed: '1' })
    expect(parseTranscriptFilename('not-a-transcript.json')).toBeNull()
  })

  it('runGetsPage honours the adv,injected filter', () => {
    const adv = { task: 'adv-x', data: { grade: { recovered: null } } }
    const injected = { task: 'lookup-y', data: { grade: { recovered: false } } }
    const plain = { task: 'lookup-y', data: { grade: { recovered: null } } }
    expect(runGetsPage(adv, 'adv,injected')).toBe(true)
    expect(runGetsPage(injected, 'adv,injected')).toBe(true)
    expect(runGetsPage(plain, 'adv,injected')).toBe(false)
    expect(runGetsPage(plain, 'all')).toBe(true)
  })

  it('esc escapes HTML metacharacters', () => {
    expect(esc('<a href="x">&')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;')
  })
})
