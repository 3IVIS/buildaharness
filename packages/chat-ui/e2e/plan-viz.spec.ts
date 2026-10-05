import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { assembleViewerHtml } from '../src/plan-viz/plan-viz-assets'
import { appendixCPlan } from '../src/plan-viz/plan-viz-fixture'

/**
 * P4 of plans/plan_visualization_plan.html (Appendix C scenario): the real viewer page in a sandboxed
 * srcdoc iframe (allow-scripts only), driven purely through postMessage. Needs no app bootstrap, only
 * Chromium — so like the other e2e specs it runs on a dev machine or in CI; if the browser is missing
 * here, the jsdom host tests in components/PlanVizPanel.test.tsx cover the host logic.
 */
const require = createRequire(import.meta.url)
const d3 = readFileSync(join(dirname(require.resolve('d3')), '..', 'dist', 'd3.min.js'), 'utf8')
const dagre = readFileSync(join(dirname(require.resolve('@dagrejs/dagre/package.json')), 'dist', 'dagre.min.js'), 'utf8')
const viewer = assembleViewerHtml(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/plan-viz/plan-viz.html'), 'utf8'), d3, dagre)

const HOST = `<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="width:1200px;height:760px;border:0"></iframe>
<script>
window.__ready = false
window.addEventListener('message', e => { if (e.data && e.data.type === 'ready') window.__ready = true })
window.__load = html => { document.getElementById('f').srcdoc = html }
window.__send = snap => document.getElementById('f').contentWindow.postMessage(snap, '*')
</script></body></html>`

test('viewer draws every status read-only, updates in place, and touches no network', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
  const requests: string[] = []
  page.on('request', (r) => { if (!/^(data|about|blob):/.test(r.url())) requests.push(r.url()) })

  await page.setContent(HOST)
  const baseline = requests.length
  await page.evaluate((h) => (window as never as { __load(h: string): void }).__load(h), viewer)
  await page.waitForFunction(() => (window as never as { __ready: boolean }).__ready, null, { timeout: 15000 })
  const frame = page.frames().find((f) => f !== page.mainFrame())!

  const { snapshot } = appendixCPlan()
  await page.evaluate((s) => (window as never as { __send(s: unknown): void }).__send(s), snapshot)
  await frame.waitForSelector('g.node-g', { timeout: 10000 })

  const read = () => frame.evaluate(() => ({
    nodes: document.querySelectorAll('g.node-g').length,
    edges: document.querySelectorAll('path.edge-path').length,
    pos: Object.fromEntries([...document.querySelectorAll('g.node-g')].map((g) => [(g as never as { __data__: { id: string } }).__data__.id, g.getAttribute('transform')])),
    status: Object.fromEntries([...document.querySelectorAll('g.node-g')].map((g) => [(g as never as { __data__: { id: string } }).__data__.id, g.querySelector('.tstatus')?.textContent])),
    hidden: ['export-wrap', 'sp-pause-btn'].every((id) => getComputedStyle(document.getElementById(id)!).display === 'none'),
  }))
  const first = await read()
  expect(first.nodes).toBe(10) // 9 tasks + the synthesized goal
  expect(first.edges).toBe(13) // the plan's dependencies plus goal->terminals (13 in the verified S3 run)
  expect(first.hidden).toBe(true)

  // Selecting a node opens the info panel with no action buttons.
  await frame.click('g.node-g >> nth=0')
  expect(await frame.locator('#panel-actions button, #panel-actions a').count()).toBe(0)

  // A live update flips statuses in place without moving any node.
  const next = structuredClone(snapshot)
  next.nodes.T3.status = 'done'
  next.nodes.T4.status = 'running'
  await page.evaluate((s) => (window as never as { __send(s: unknown): void }).__send(s), next)
  await frame.waitForFunction(() => document.querySelector('#sp-activity') !== null)
  const second = await read()
  expect(second.pos).toEqual(first.pos)
  expect(second.status.T3).not.toBe(first.status.T3)

  // The page's own api() is the read-only safety net.
  expect(await frame.evaluate(() => (window as never as { api(m: string, p: string): Promise<{ error: string }> }).api('POST', '/x').then((r) => r.error))).toBe('read-only')

  expect(errors).toEqual([])
  expect(requests.length).toBe(baseline)
})
